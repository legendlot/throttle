// pdf.js text items → text lines, the input the PDF parsers read. Pure (the browser calls it per
// page in extract.js; the test fixtures were produced by this same function on the samples).
//
// An item is { str, transform:[a,b,c,d,x,y], width, height }. PDF y grows UPWARD, so a page reads
// top-down by DESCENDING y. Items within ~⅓ of a line height share a line (Zepto prints one row's
// cells 0.4pt apart); wrapped cells sit a full ~3.5–8pt off, so they stay separate lines — which
// is what lets the parsers find the numeric item row on its own.
// ⚠️ Whitespace-only items are dropped: Zepto's carry bogus widths (" " 1,798pt wide) that would
// wreck any gap maths. Cells are joined with TWO spaces when there is a real gap, one when the
// items touch, so "column break" survives as /\s{2,}/ exactly as `pdftotext -layout` prints it.
export function itemsToLines(items) {
  const its = [];
  for (const it of items || []) {
    if (!it || typeof it.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const h = Math.abs(Number(it.height) || Number(it.transform[3]) || 6);
    its.push({ s: it.str.trim(), x: Number(it.transform[4]) || 0, y: Number(it.transform[5]) || 0, w: Number(it.width) || 0, h });
  }
  its.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of its) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= Math.max(1, row.h * 0.35)) row.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const it of r.items) {
      if (end != null) out += (it.x - end > Math.max(1.5, it.h * 0.25)) ? '  ' : ' ';
      out += it.s;
      end = it.x + it.w;
    }
    return out;
  });
}
