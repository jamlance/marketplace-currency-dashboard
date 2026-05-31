import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface CurStat { currency: string; revenue: number; paid: number; orders: number; refunds: number; aov: number; converted: number | null; }
interface Summary { range: string; base: string; rates_ok: boolean; rates: Record<string, number>; consolidated: number; consolidated_delta: number; currencies: CurStat[]; trend: Record<string, any>[]; currency_codes: string[]; }
interface Balance { currency: string; available: number; pending: number; }
interface Payout { currency: string; paid: number; pending: number; }
interface Order { id: number; ref: string; total: number; currency: string; status: string; customer: string | null; created_at: string | null; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let baseCurrency = "JMD";
let range = "30d";
let orderCur = "";
let converted = true;
let shell: ReturnType<typeof mountShell>;
const RANGES: [string, string][] = [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"]];
const ACCENTS = ["var(--accent)", "oklch(0.6 0.14 155)", "oklch(0.62 0.14 70)", "oklch(0.55 0.2 25)", "oklch(0.55 0.16 295)"];

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  baseCurrency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "coins",
    brandLogo: "/logo.svg",
    title: "Currency Dashboard",
    subtitle: `${merchantName} · money across every currency`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "pie", render: renderOverview },
      { id: "orders", label: "Orders", icon: "list", render: renderOrders },
      { id: "rates", label: "Rates", icon: "coins", render: renderRates },
    ],
  });
})();

const deltaStr = (p: number) => `${p > 0 ? "▲" : p < 0 ? "▼" : "–"} ${Math.abs(p)}% vs prev`;

/* ------------------------------------------------------------------ Overview */
async function renderOverview(host: HTMLElement) {
  const rangeBar = h("div", { class: "cd-ranges" },
    ...RANGES.map(([v, l]) => h("button", { class: "cd-range" + (range === v ? " is-on" : ""), onClick: () => { range = v; shell.select("overview"); } }, l)));

  const balHost = h("div");
  const sumHost = h("div");
  host.append(card({ title: "Wallet", body: balHost }), card({ title: "Sales by currency", action: rangeBar, body: sumHost }));

  balHost.append(h("div", { class: "bv-muted", style: { padding: "8px 2px" } }, "Loading…"));
  Promise.all([bvApi<{ balances: Balance[]; available: boolean }>("/api/balances"), bvApi<{ payouts: Payout[]; available: boolean }>("/api/payouts").catch(() => ({ payouts: [], available: false }))]).then(([b, p]) => {
    balHost.innerHTML = "";
    if ((!b.available || !b.balances.length) && !p.payouts.length) { balHost.append(h("div", { class: "bv-muted", style: { padding: "6px 2px" } }, "Wallet balance isn't available for this account.")); return; }
    const grid = h("div", { class: "cd-balances" });
    for (const bal of b.balances) grid.append(h("div", { class: "cd-balance" },
      h("div", { class: "cd-cur" }, bal.currency), h("div", { class: "cd-amt" }, fmtMoney(bal.available, bal.currency)),
      h("div", { class: "bv-muted" }, `${fmtMoney(bal.pending, bal.currency)} pending`)));
    for (const po of p.payouts) grid.append(h("div", { class: "cd-balance is-payout" },
      h("div", { class: "cd-cur" }, `${po.currency} payouts`), h("div", { class: "cd-amt" }, fmtMoney(po.paid, po.currency)),
      h("div", { class: "bv-muted" }, `${fmtMoney(po.pending, po.currency)} pending`)));
    balHost.append(grid);
  }).catch(() => { balHost.innerHTML = ""; balHost.append(h("div", { class: "bv-muted" }, "Wallet balance unavailable.")); });

  sumHost.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let s: Summary;
  try { s = await bvApi(`/api/summary?range=${range}`); }
  catch (err: any) { sumHost.innerHTML = ""; sumHost.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  sumHost.innerHTML = "";
  if (!s.currencies.length) { sumHost.append(emptyState({ icon: "coins", title: "No sales in this range", text: "Pick a wider range or take some orders." })); return; }

  // Consolidated headline
  sumHost.append(statRow([
    { k: `Total (${s.base})`, v: s.rates_ok ? fmtMoney(s.consolidated, s.base) : "—", d: s.rates_ok ? deltaStr(s.consolidated_delta) : "FX rates unavailable", tone: "ok", icon: "coins" },
    { k: "Currencies", v: String(s.currencies.length), icon: "pie" },
    { k: "Paid orders", v: String(s.currencies.reduce((a, c) => a + c.paid, 0)), icon: "receipt" },
    { k: "Refunds", v: String(s.currencies.reduce((a, c) => a + c.refunds, 0)), tone: s.currencies.some((c) => c.refunds) ? "bad" : undefined, icon: "wallet" },
  ]));

  // currency mix (share of consolidated)
  if (s.rates_ok && s.currencies.length > 1 && s.consolidated > 0) {
    const mix = h("div", { class: "cd-mix" });
    s.currencies.forEach((c, i) => { const share = Math.round(((c.converted ?? 0) / s.consolidated) * 100); if (share > 0) mix.append(h("div", { class: "cd-mix-seg", style: { width: `${share}%`, background: ACCENTS[i % ACCENTS.length] }, title: `${c.currency}: ${share}%` })); });
    sumHost.append(h("div", { class: "cd-mixwrap" }, mix, h("div", { class: "cd-legend" }, ...s.currencies.map((c, i) => h("span", { class: "cd-leg" }, h("i", { style: { background: ACCENTS[i % ACCENTS.length] } }), `${c.currency} ${s.consolidated ? Math.round(((c.converted ?? 0) / s.consolidated) * 100) : 0}%`)))));
  }

  // native ↔ converted toggle
  const toggle = h("div", { class: "cd-toggle" },
    h("button", { class: "cd-tg" + (!converted ? " is-on" : ""), onClick: () => { converted = false; shell.select("overview"); } }, "Native"),
    h("button", { class: "cd-tg" + (converted ? " is-on" : ""), onClick: () => { converted = true; shell.select("overview"); } }, `Converted (${s.base})`));
  sumHost.append(toggle);

  if (s.trend.length > 1) sumHost.append(h("div", { class: "cd-chart" }, trendChart(s.trend, s.currency_codes)));

  sumHost.append(dataTable<CurStat>({
    columns: [
      { head: "Currency", cell: (c) => h("strong", null, c.currency) },
      { head: "Revenue", num: true, cell: (c) => converted && c.converted != null ? h("span", null, fmtMoney(c.converted, s.base), h("span", { class: "cd-native" }, `${fmtMoney(c.revenue, c.currency)}`)) : fmtMoney(c.revenue, c.currency) },
      { head: "Paid", num: true, cell: (c) => String(c.paid) },
      { head: "Avg order", num: true, cell: (c) => fmtMoney(c.aov, c.currency) },
      { head: "Refunds", num: true, cell: (c) => c.refunds ? pill(String(c.refunds), "bad") : "—" },
    ],
    rows: s.currencies,
    onRowClick: (c) => { orderCur = c.currency; shell.select("orders"); },
  }));
}

function trendChart(trend: Record<string, any>[], codes: string[]) {
  const max = Math.max(...trend.map((d) => codes.reduce((a, c) => a + (d[c] || 0), 0)), 1);
  const wrap = h("div", { class: "cd-bars" });
  for (const d of trend) {
    const stack = h("div", { class: "cd-bar-stack" });
    codes.forEach((c, i) => { const v = d[c] || 0; if (!v) return; stack.append(h("div", { class: "cd-seg", title: `${d.date} · ${c}: ${fmtMoney(v, c)}`, style: { height: `${Math.round((v / max) * 100)}%`, background: ACCENTS[i % ACCENTS.length] } })); });
    wrap.append(h("div", { class: "cd-bar" }, stack, h("div", { class: "cd-bar-label" }, String(d.date).slice(5))));
  }
  return h("div", null, wrap, codes.length > 1 ? h("div", { class: "cd-legend" }, ...codes.map((c, i) => h("span", { class: "cd-leg" }, h("i", { style: { background: ACCENTS[i % ACCENTS.length] } }), c))) : null);
}

/* --------------------------------------------------------------------- Rates */
async function renderRates(host: HTMLElement) {
  let data: { base: string; rates: Record<string, number>; as_of: string; overrides: { quote: string; rate: number }[] };
  try { data = await bvApi("/api/rates"); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load rates", text: err?.message })); return; }
  const ovMap = Object.fromEntries(data.overrides.map((o) => [o.quote, o.rate]));
  const quotes = Object.keys(data.rates).filter((q) => q !== data.base).sort();

  const rows = quotes.map((q) => {
    const input = h("input", { type: "number", step: "0.0001", value: ovMap[q] != null ? String(ovMap[q]) : "", placeholder: String(data.rates[q]) }) as HTMLInputElement;
    const saveBtn = h("button", { class: "ghost sm", onClick: async () => {
      try { await bvApi("/api/rates/override", { method: "POST", body: JSON.stringify({ base: data.base, quote: q, rate: input.value || null }) }); flash(input.value ? `Pinned ${data.base}/${q}` : `Cleared ${q} override`, "success"); shell.select("rates"); }
      catch (err: any) { toast(err?.message || "error", "error"); }
    } }, ovMap[q] != null ? "Update" : "Pin");
    return h("tr", null,
      h("td", null, h("strong", null, `1 ${data.base}`), " = "),
      h("td", null, `${q}`),
      h("td", { class: "num" }, ovMap[q] != null ? h("span", { class: "cd-ov" }, String(ovMap[q]), h("span", { class: "bv-muted" }, ` (live ${data.rates[q]})`)) : String(data.rates[q])),
      h("td", null, h("div", { class: "cd-rateedit" }, input, saveBtn)));
  });

  host.append(card({ title: `Exchange rates · base ${data.base}`, body: h("div", null,
    h("div", { class: "bv-muted", style: { marginBottom: "10px", fontSize: "0.8125rem" } }, `Rates as of ${data.as_of}. Pin your own rate for accounting, or leave blank to use the live rate.`),
    quotes.length ? h("table", { class: "bv-table cd-rates" }, h("tbody", null, ...rows)) : h("div", { class: "bv-muted" }, "No foreign currencies in your sales yet.")) }));
}

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { orders: Order[] };
  let codes: string[] = [];
  try { data = await bvApi<{ orders: Order[] }>(`/api/orders${orderCur ? `?currency=${orderCur}` : ""}`); codes = [...new Set((await bvApi<{ orders: Order[] }>("/api/orders")).orders.map((o) => o.currency))]; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load orders", text: err?.message })); return; }
  host.innerHTML = "";

  const filters = h("div", { class: "cd-filters" },
    h("button", { class: "cd-filter" + (orderCur === "" ? " is-on" : ""), onClick: () => { orderCur = ""; shell.select("orders"); } }, "All"),
    ...codes.map((c) => h("button", { class: "cd-filter" + (orderCur === c ? " is-on" : ""), onClick: () => { orderCur = c; shell.select("orders"); } }, c)));

  host.append(card({ title: "Orders", action: filters,
    body: data.orders.length ? dataTable<Order>({
      columns: [
        { head: "Order", cell: (o) => h("div", null, h("strong", null, `#${o.ref}`), o.customer ? h("div", { class: "bv-muted" }, o.customer) : null) },
        { head: "Amount", num: true, cell: (o) => h("span", null, fmtMoney(o.total, o.currency), h("span", { class: "cd-tag" }, o.currency)) },
        { head: "Status", cell: (o) => pill(o.status, o.status === "paid" || o.status === "completed" ? "ok" : o.status === "refunded" || o.status === "cancelled" ? "bad" : undefined) },
        { head: "When", cell: (o) => h("span", { class: "bv-muted" }, o.created_at ? relTime(o.created_at) : "—") },
      ], rows: data.orders,
    }) : emptyState({ icon: "receipt", title: "No orders", text: "No orders in this currency yet." }) }));
}

function fatal(msg?: string) {
  return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Currency Dashboard couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard."));
}
