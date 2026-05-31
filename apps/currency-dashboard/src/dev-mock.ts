/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const ORDERS: any[] = [];
const curs = ["JMD", "USD", "KYD"];
const titles = ["Afro Fade", "Colour Treatment", "Hot Towel Shave", "Wash & Style"];
let id = 2400;
for (let i = 0; i < 60; i++) {
  const c = curs[i % 3 === 0 ? 0 : i % 5 === 0 ? 1 : i % 7 === 0 ? 2 : 0];
  const paid = Math.random() > 0.2;
  ORDERS.push({
    id: id++, reference_id: "ORD-" + (id), title: titles[i % 4],
    total: c === "USD" ? Math.round(20 + Math.random() * 120) : c === "KYD" ? Math.round(15 + Math.random() * 90) : Math.round(2000 + Math.random() * 12000),
    currency: { code: c }, status: paid ? 3 : i % 11 === 0 ? 11 : 1,
    customer: { first_name: "Customer", last_name: String(i) },
    inserted_at: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
  });
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.origin);
    const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));

    if (u.pathname === "/api/balances") return json({ available: true, balances: [
      { currency: "JMD", available: 184500, pending: 12000 },
      { currency: "USD", available: 920.5, pending: 140 },
      { currency: "KYD", available: 310, pending: 0 },
    ] });
    if (u.pathname === "/api/summary") {
      const days = u.searchParams.get("range") === "7d" ? 7 : u.searchParams.get("range") === "90d" ? 90 : 30;
      const since = Date.now() - days * 86400000;
      const inR = ORDERS.filter((o) => new Date(o.inserted_at).getTime() >= since);
      const byCur = new Map<string, any>(); const byDay = new Map<string, any>();
      for (const o of inR) {
        const c = o.currency.code; const m = byCur.get(c) || { currency: c, revenue: 0, paid: 0, orders: 0, refunds: 0 };
        m.orders++; if (o.status === 11) m.refunds++;
        if (o.status === 3) { m.paid++; m.revenue = Math.round((m.revenue + o.total) * 100) / 100; const d = o.inserted_at.slice(0, 10); const day = byDay.get(d) || {}; day[c] = Math.round((day[c] || 0) + o.total); byDay.set(d, day); }
        byCur.set(c, m);
      }
      const RATES: Record<string, number> = { JMD: 1, USD: 0.0065, KYD: 0.0054 };
      const toBase = (amt: number, c: string) => Math.round((c === "JMD" ? amt : amt / (RATES[c] || 1)) * 100) / 100;
      const currencies = [...byCur.values()].map((m) => ({ ...m, aov: m.paid ? Math.round(m.revenue / m.paid) : 0, converted: toBase(m.revenue, m.currency) })).sort((a, b) => b.converted - a.converted);
      const trend = [...byDay.entries()].sort().map(([date, vals]) => ({ date, ...vals }));
      const consolidated = Math.round(currencies.reduce((s, c) => s + c.converted, 0) * 100) / 100;
      return json({ range: u.searchParams.get("range") || "30d", base: "JMD", rates_ok: true, rates: RATES, consolidated, consolidated_delta: 9, currencies, trend, currency_codes: currencies.map((c) => c.currency) });
    }
    if (u.pathname === "/api/payouts") return json({ available: true, payouts: [{ currency: "JMD", paid: 142000, pending: 18500 }, { currency: "USD", paid: 640, pending: 80 }] });
    if (u.pathname === "/api/rates" && (init.method || "GET").toUpperCase() === "GET") return json({ base: "JMD", rates: { JMD: 1, USD: 0.0065, KYD: 0.0054 }, as_of: new Date().toISOString().slice(0, 10), overrides: [{ quote: "USD", rate: 0.0064 }] });
    if (u.pathname === "/api/rates/override") return json({ ok: true });
    if (u.pathname === "/api/orders") {
      const cur = u.searchParams.get("currency");
      let os = ORDERS.map((o) => ({ id: o.id, ref: o.reference_id, total: o.total, currency: o.currency.code, status: o.status === 3 ? "paid" : o.status === 11 ? "refunded" : "pending", customer: "Customer " + o.id, created_at: o.inserted_at }));
      if (cur) os = os.filter((o) => o.currency === cur);
      return json({ orders: os.slice(0, 100) });
    }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read", "wallet:read"],
  };
}
