import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, orderStatusName, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[currency-dashboard] Missing env: ${k}`); process.exit(1); }
}

// Local cache of daily FX rates + per-merchant manual overrides.
const db = await openPg("currency_dashboard", `
  CREATE TABLE IF NOT EXISTS fx_rates (
    base TEXT NOT NULL, quote TEXT NOT NULL, rate NUMERIC NOT NULL, as_of DATE NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto', PRIMARY KEY (base, quote, as_of)
  );
  CREATE TABLE IF NOT EXISTS overrides (
    merchant_id BIGINT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate NUMERIC NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (merchant_id, base, quote)
  );
`);

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const RANGES = { "7d": 7, "30d": 30, "90d": 90 };
const curOf = (o) => o.currency?.code || o.currency_code || "JMD";
const today = () => new Date().toISOString().slice(0, 10);

// Paginated/windowed order fetch (page param) — complete coverage for 90d.
async function fetchOrdersSince(session, since, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await inkressApi(core.cfg, session.accessToken, `orders?limit=200&page=${page}&order=id desc`);
    const entries = r?.result?.entries || [];
    out.push(...entries);
    if (!entries.length) break;
    const oldest = new Date(entries[entries.length - 1].inserted_at || entries[entries.length - 1].created_at || 0).getTime();
    if (oldest < since) break;
  }
  return out;
}

// --- FX: base->quote rate (1 base = rate quote). Cache daily; Inkress first, external fallback. ---
async function loadRates(session, base) {
  const d = today();
  const cached = await db.q(`SELECT quote, rate FROM fx_rates WHERE base=$1 AND as_of=$2`, [base, d]);
  if (cached.length) return Object.fromEntries(cached.map((r) => [r.quote, Number(r.rate)]));
  let rates = null, source = "auto";
  // 1) Inkress native exchange_rates (if OAuth-reachable)
  try {
    const r = await inkressApi(core.cfg, session.accessToken, `exchange_rates?limit=200`);
    const rows = r?.result?.entries || r?.result || [];
    if (Array.isArray(rows) && rows.length) {
      const map = {};
      for (const x of rows) { const from = x.from || x.base || x.from_code; const to = x.to || x.quote || x.to_code; const rate = Number(x.rate ?? x.value); if (from === base && to && rate) map[to] = rate; }
      if (Object.keys(map).length) { rates = map; source = "inkress"; }
    }
  } catch { /* fall through */ }
  // 2) external free feed
  if (!rates) {
    try { const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); if (j?.rates) { rates = j.rates; source = "open.er-api"; } } catch { /* */ }
  }
  if (!rates) return null;
  rates[base] = 1;
  for (const [quote, rate] of Object.entries(rates)) await db.run(`INSERT INTO fx_rates (base, quote, rate, as_of, source) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (base, quote, as_of) DO UPDATE SET rate=$3, source=$5`, [base, quote, rate, d, source]).catch(() => {});
  return rates;
}
async function ratesWithOverrides(session, base, mid) {
  const rates = (await loadRates(session, base)) || { [base]: 1 };
  const ov = await db.q(`SELECT quote, rate FROM overrides WHERE merchant_id=$1 AND base=$2`, [mid, base]);
  for (const o of ov) rates[o.quote] = Number(o.rate);
  return rates;
}
const toBase = (amt, from, base, rates) => from === base ? round2(amt) : (rates[from] ? round2(amt / rates[from]) : null);

// --- Wallet balances (best-effort) ---
app.get("/api/balances", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, "merchants/account/balances", { method: "POST", body: JSON.stringify({}) });
    const raw = r?.result || r || {};
    const balances = Array.isArray(raw) ? raw.map((b) => ({ currency: b.currency_code || b.currency, available: round2(b.available), pending: round2(b.pending) }))
      : (raw.currency || raw.available != null) ? [{ currency: raw.currency_code || raw.currency || "JMD", available: round2(raw.available), pending: round2(raw.pending) }] : [];
    res.json({ balances, available: true });
  } catch (err) { res.json({ balances: [], available: false, reason: err?.message }); }
});

// --- Payouts (best-effort; proper payouts resource only, never ledger internals) ---
app.get("/api/payouts", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `payouts?limit=50&order=id desc`);
    const rows = r?.result?.entries || [];
    const byCur = new Map();
    for (const p of rows) { const c = p.currency?.code || p.currency_code || "JMD"; const m = byCur.get(c) || { currency: c, paid: 0, pending: 0 }; const amt = round2(p.total ?? p.amount ?? 0); if ((p.status || "").toLowerCase().includes("pend")) m.pending = round2(m.pending + amt); else m.paid = round2(m.paid + amt); byCur.set(c, m); }
    res.json({ payouts: [...byCur.values()], available: true });
  } catch (err) { res.json({ payouts: [], available: false }); }
});

// --- Per-currency summary + FX consolidation + comparison ---
app.get("/api/summary", core.requireSession, async (req, res) => {
  const days = RANGES[req.query.range] || 30;
  const base = (req.query.base || req.session.data?.merchant?.currency_code || "JMD").toUpperCase();
  const since = Date.now() - days * 86400 * 1000;
  const prevSince = since - days * 86400 * 1000;
  try {
    const all = await fetchOrdersSince(req.session, prevSince);
    const rates = await ratesWithOverrides(req.session, base, req.session.merchantId);
    const ratesOk = Object.keys(rates).length > 1;

    const inWin = (o, from, to) => { const t = new Date(o.inserted_at || o.created_at || 0).getTime(); return t >= from && t < to; };
    const agg = (from, to) => {
      const byCur = new Map(); const byDay = new Map(); let consolidated = 0;
      for (const o of all) { if (!inWin(o, from, to)) continue; const c = curOf(o);
        const m = byCur.get(c) || { currency: c, revenue: 0, paid: 0, orders: 0, refunds: 0 };
        m.orders++; if (orderStatusName(o) === "refunded") m.refunds++;
        if (isPaidStatus(o)) { m.paid++; m.revenue = round2(m.revenue + Number(o.total || 0));
          const conv = toBase(Number(o.total || 0), c, base, rates); if (conv != null) consolidated = round2(consolidated + conv);
          const d = new Date(o.inserted_at || o.created_at || 0).toISOString().slice(0, 10); const day = byDay.get(d) || {}; day[c] = round2((day[c] || 0) + Number(o.total || 0)); byDay.set(d, day); }
        byCur.set(c, m);
      }
      return { byCur, byDay, consolidated };
    };
    const cur = agg(since, Date.now());
    const prev = agg(prevSince, since);
    const currencies = [...cur.byCur.values()].map((m) => ({ ...m, aov: m.paid ? round2(m.revenue / m.paid) : 0, converted: toBase(m.revenue, m.currency, base, rates) })).sort((a, b) => (b.converted ?? b.revenue) - (a.converted ?? a.revenue));
    const trend = [...cur.byDay.entries()].sort().map(([date, vals]) => ({ date, ...vals }));
    const pct = (a, b) => b ? Math.round(((a - b) / b) * 100) : (a ? 100 : 0);
    res.json({
      range: req.query.range || "30d", base, rates_ok: ratesOk, rates,
      consolidated: cur.consolidated, consolidated_delta: pct(cur.consolidated, prev.consolidated),
      currencies, trend, currency_codes: currencies.map((c) => c.currency),
    });
  } catch (err) { res.status(502).json({ error: "summary_failed", message: err?.message }); }
});

// --- Manual FX override ---
app.get("/api/rates", core.requireSession, async (req, res) => {
  const base = (req.query.base || req.session.data?.merchant?.currency_code || "JMD").toUpperCase();
  const rates = await ratesWithOverrides(req.session, base, req.session.merchantId);
  const ov = await db.q(`SELECT quote, rate FROM overrides WHERE merchant_id=$1 AND base=$2`, [req.session.merchantId, base]);
  res.json({ base, rates, as_of: today(), overrides: ov.map((o) => ({ quote: o.quote, rate: Number(o.rate) })) });
});
app.post("/api/rates/override", core.requireSession, async (req, res) => {
  const base = String(req.body?.base || "JMD").toUpperCase(); const quote = String(req.body?.quote || "").toUpperCase();
  if (!quote) return res.status(400).json({ error: "no_quote" });
  if (req.body?.rate == null || req.body.rate === "") { await db.run(`DELETE FROM overrides WHERE merchant_id=$1 AND base=$2 AND quote=$3`, [req.session.merchantId, base, quote]); }
  else await db.run(`INSERT INTO overrides (merchant_id, base, quote, rate) VALUES ($1,$2,$3,$4) ON CONFLICT (merchant_id, base, quote) DO UPDATE SET rate=$4, updated_at=now()`, [req.session.merchantId, base, quote, round2(req.body.rate)]);
  res.json({ ok: true });
});

// --- Orders (cross-currency) ---
app.get("/api/orders", core.requireSession, async (req, res) => {
  const cur = req.query.currency ? String(req.query.currency) : null;
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `orders?limit=100&order=id desc`);
    let orders = (r?.result?.entries || []).map((o) => ({ id: o.id, ref: o.reference_id || String(o.id), total: round2(o.total), currency: curOf(o), status: orderStatusName(o), customer: o.customer ? ([o.customer.first_name, o.customer.last_name].filter(Boolean).join(" ") || o.customer.email) : null, created_at: o.inserted_at || o.created_at || null }));
    if (cur) orders = orders.filter((o) => o.currency === cur);
    res.json({ orders });
  } catch (err) { res.status(502).json({ error: "orders_failed", message: err?.message }); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[currency-dashboard] listening on ${HOST}:${PORT}`));
