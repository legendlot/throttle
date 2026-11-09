// File → { kind, lines | rows } for the parsers in ./index.js. Browser side of Import PO.
//
// Both libraries load on demand (dynamic import), so the Orders page pays nothing until someone
// actually imports a file.
//   · PDF  → pdf.js text items → itemsToLines() per page. The pdf.js worker is BUNDLED as an
//     ordinary module (see pdfLines), never loaded from a URL: the usual
//     `new URL('pdfjs-dist/…/pdf.worker.min.mjs', import.meta.url)` asset breaks `next build` —
//     Next's minifier treats the emitted .mjs as a classic script ("'import', and 'export' cannot
//     be used outside of module code"). Bundled, it ships in the same lazy chunk, so it can never
//     drift from the API version and there is no public/ copy to keep in step.
//     The LEGACY build is used on purpose: the modern one needs Promise.withResolvers
//     (Safari 17.4+); the legacy build polyfills it, so an older Safari still reads POs.
//   · xlsx → exceljs (already the estate's xlsx library — Garage's BOM export), first sheet,
//     rows of plain values. Merged-cell SLAVES are skipped: exceljs reports the master's value on
//     every slave, which would make "the next cell to the right of the label" the label again.
import { itemsToLines } from './lines.js';

export async function extractFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return { kind: 'pdf', lines: await pdfLines(buf) };
  if (name.endsWith('.xlsx')) return { kind: 'xlsx', rows: await xlsxRows(buf) };
  if (name.endsWith('.xls') || name.endsWith('.csv')) throw new Error('Save the sheet as .xlsx and import that.');
  throw new Error('Choose a PDF or an .xlsx purchase order.');
}

async function pdfLines(buf) {
  // Importing the worker MODULE sets globalThis.pdfjsWorker, and pdf.js then runs its parser on
  // the main thread ("fake worker") instead of spawning a Worker from a URL — fine for a 1–5 page
  // PO, and nothing to serve from out/.
  await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  try {
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      out.push(...itemsToLines(tc.items));
    }
    return out;
  } finally {
    doc.destroy();
  }
}

export function cellPlain(v) {
  if (v == null) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (Array.isArray(v.richText)) return v.richText.map(t => t.text || '').join('');
  if ('result' in v) return cellPlain(v.result);          // formula
  if ('text' in v) return cellPlain(v.text);              // hyperlink
  return null;
}

// exceljs Worksheet → rows of plain values (0-based columns).
export function worksheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const arr = [];
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cell.isMerged && cell.master && cell.master !== cell && cell.master.address !== cell.address) return;
      arr[c - 1] = cellPlain(cell.value);
    });
    rows[r - 1] = arr;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

async function xlsxRows(buf) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheets.');
  return worksheetRows(ws);
}
