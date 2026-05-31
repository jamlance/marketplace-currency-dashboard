// Light server-side PDF generation (pdf-lib — pure JS, NO Chromium/puppeteer).
// A reusable single-page "business document" used by invoices, receipts, and
// donation receipts: accent bar, brand header, title + number, meta rows, an
// optional line-item table, a totals breakdown, a note, and a footer.
//
//   import { documentPdf } from "@inkress/apps-core/pdf";
//   const bytes = await documentPdf({ brand:{name,accent}, title:"Invoice", number:"INV-0007",
//     meta:[{label:"Date",value:"2026-05-31"}], items:[{description:"Cut",qty:1,amount:"JMD 5,000"}],
//     totals:[{label:"Subtotal",value:"JMD 5,000"},{label:"Total",value:"JMD 5,000",bold:true}],
//     note:"Thank you", footer:"shop · via Marketplace" });
//   // bytes: Uint8Array — email attach or send as application/pdf

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

function hexToRgb(hex, fallback = [0.23, 0.36, 0.86]) {
  const m = String(hex || "").match(/^#?([0-9a-f]{6})$/i);
  if (!m) return rgb(...fallback);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * @param {{ brand?:{name?:string,accent?:string}, title:string, number?:string,
 *   meta?:{label:string,value:string}[], items?:{description:string,qty?:number,amount:string}[],
 *   totals?:{label:string,value:string,bold?:boolean}[], note?:string, footer?:string,
 *   badge?:string }} o
 * @returns {Promise<Uint8Array>}
 */
export async function documentPdf(o) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToRgb(o.brand?.accent);
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.45, 0.47, 0.52);
  const line = rgb(0.88, 0.9, 0.93);
  const M = 54;               // margin
  const W = 612;
  let y = 792;

  // accent bar
  page.drawRectangle({ x: 0, y: y - 6, width: W, height: 6, color: accent });
  y -= 52;

  // brand + badge
  page.drawText(o.brand?.name || "", { x: M, y, size: 16, font: bold, color: ink });
  if (o.badge) {
    const bw = bold.widthOfTextAtSize(o.badge, 9) + 16;
    page.drawRectangle({ x: W - M - bw, y: y - 3, width: bw, height: 20, color: accent, opacity: 0.12 });
    page.drawText(o.badge, { x: W - M - bw + 8, y: y + 2, size: 9, font: bold, color: accent });
  }
  y -= 30;

  // title + number
  page.drawText(o.title, { x: M, y, size: 22, font: bold, color: ink });
  if (o.number) {
    const nw = font.widthOfTextAtSize(o.number, 11);
    page.drawText(o.number, { x: W - M - nw, y: y + 4, size: 11, font, color: muted });
  }
  y -= 28;

  // meta rows
  for (const m of o.meta || []) {
    page.drawText(m.label, { x: M, y, size: 10, font, color: muted });
    page.drawText(String(m.value ?? ""), { x: M + 110, y, size: 10, font, color: ink });
    y -= 16;
  }
  y -= 10;

  // items table
  if (o.items?.length) {
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
    y -= 18;
    page.drawText("Description", { x: M, y, size: 9, font: bold, color: muted });
    page.drawText("Amount", { x: W - M - 80, y, size: 9, font: bold, color: muted });
    y -= 16;
    for (const it of o.items) {
      const desc = `${it.qty && it.qty !== 1 ? `${it.qty}× ` : ""}${it.description || ""}`.slice(0, 70);
      page.drawText(desc, { x: M, y, size: 10.5, font, color: ink });
      const aw = font.widthOfTextAtSize(String(it.amount), 10.5);
      page.drawText(String(it.amount), { x: W - M - aw, y, size: 10.5, font, color: ink });
      y -= 18;
      if (y < 140) break;
    }
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: line });
    y -= 18;
  }

  // totals
  for (const t of o.totals || []) {
    const f = t.bold ? bold : font, sz = t.bold ? 13 : 11, col = t.bold ? ink : muted;
    page.drawText(t.label, { x: W - M - 230, y, size: sz, font: f, color: col });
    const vw = f.widthOfTextAtSize(String(t.value), sz);
    page.drawText(String(t.value), { x: W - M - vw, y, size: sz, font: f, color: t.bold ? accent : ink });
    y -= t.bold ? 24 : 18;
  }

  // note
  if (o.note) {
    y -= 14;
    for (const ln of wrap(o.note, font, 10, W - 2 * M)) { page.drawText(ln, { x: M, y, size: 10, font, color: muted }); y -= 14; }
  }

  // footer
  page.drawText(o.footer || "via Marketplace", { x: M, y: 40, size: 8.5, font, color: muted });
  return doc.save();
}

function wrap(text, font, size, maxW) {
  const words = String(text).split(/\s+/);
  const out = []; let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out.slice(0, 6);
}
