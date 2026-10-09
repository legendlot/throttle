// Vendor BOM export — one product's BOM with part pictures, as a PDF or an Excel file, with an
// option to leave prices out (Joseph, #bugs 1791268297.969389 / spec 1791540340.923109).
// Prices are each part's LAST PO price, already filtered by the worker per §S403-POPrices
// (getBOM with_price=1); a blank price here means no PO price on record or not visible to this
// login. jsPDF and ExcelJS are loaded on click only, so the Downloads page stays light.

const THUMB_PX = 240;      // longest side of the embedded picture — sharp in print, small file
const IMG_CONCURRENCY = 6;

// The columns both files share. `price` columns drop out when prices are hidden.
export function vendorBomColumns(showPrices) {
  const cols = [
    { key: 'idx',       label: '#',         pdfW: 8,  xlsW: 5 },
    { key: 'img',       label: 'Picture',   pdfW: 26, xlsW: 16 },
    { key: 'part_code', label: 'Part Code', pdfW: 28, xlsW: 16 },
    { key: 'part_name', label: 'Part Name', pdfW: 58, xlsW: 34 },
    { key: 'category',  label: 'Category',  pdfW: 30, xlsW: 18 },
    { key: 'variant',   label: 'Variant',   pdfW: 30, xlsW: 18 },
    { key: 'format',    label: 'Format',    pdfW: 15, xlsW: 9 },
    { key: 'qty',       label: 'Qty / Unit', pdfW: 22, xlsW: 12 },
    { key: 'uom',       label: 'UOM',       pdfW: 14, xlsW: 8 },
    { key: 'hsn',       label: 'HSN',       pdfW: 20, xlsW: 12 },
  ];
  if (showPrices) cols.push({ key: 'price', label: 'Unit Price', pdfW: 24, xlsW: 14 });
  return cols;
}

// qty_per_unit is the per-unit quantity; a channel-split packaging row (RULE-012) carries it NULL
// with qty_ecomm / qty_retail / qty_export set, so name each non-zero channel instead.
export function qtyText(r) {
  if (r.qty_per_unit != null) return Number(r.qty_per_unit);
  const parts = [['Ecomm', r.qty_ecomm], ['Retail', r.qty_retail], ['Export', r.qty_export]]
    .filter(([, q]) => Number(q) > 0)
    .map(([ch, q]) => `${ch} ${Number(q)}`);
  return parts.length ? parts.join(' · ') : '';
}

// A PO line priced per kg (or per set) against a per-piece BOM row must say so. POs write a piece
// as "pcs" (and 6 lines as "1") where the BOM says "EA" — all the same unit, so no suffix.
const PIECE = new Set(['', '1', 'ea', 'each', 'pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'unit', 'units']);
const unitKey = (u) => { const k = String(u ?? '').trim().toLowerCase().replace(/\.$/, ''); return PIECE.has(k) ? 'piece' : k; };
export function perUnit(r) {
  const pu = String(r.price_unit || '').trim();
  return pu && unitKey(pu) !== unitKey(r.issue_uom) ? pu : '';
}

function priceText(r) {
  if (r.last_unit_price == null) return '';
  const n = Number(r.last_unit_price);
  const pu = perUnit(r);
  return `${r.price_currency || 'INR'} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
    + (pu ? ` / ${pu}` : '');
}

// One display row per BOM line, in the order getBOM returns (Common → Model → Colour tiers).
export function vendorBomRows(rows) {
  return rows.map((r, i) => ({
    idx:       i + 1,
    image_url: r.image_url || null,
    part_code: r.part_code || '',
    part_name: r.part_name || '',
    category:  [r.part_category, r.part_type].filter(Boolean).join(' · '),
    variant:   r.variant_model || r.common_variant || '',
    // CKD/SKD/FBU rows sit in one BOM (lib/bomformat.js); ANY = used in every format.
    format:    r.bom_format && r.bom_format !== 'ANY' ? r.bom_format : 'All',
    qty:       qtyText(r),
    uom:       r.issue_uom || '',
    hsn:       r.hsn_code || '',
    price:     priceText(r),
    price_num: r.last_unit_price == null ? null : Number(r.last_unit_price),
    currency:  r.price_currency || null,
    price_per: perUnit(r),
  }));
}

// Fetch a part picture and shrink it to a JPEG data URL. null on any failure — a missing picture
// leaves its cell blank rather than failing the whole file.
async function thumb(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';                 // transparent PNGs → white, not black, in JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), w, h };
  } catch {
    return null;
  }
}

// { [image_url]: thumb } for every distinct picture, IMG_CONCURRENCY at a time.
export async function loadThumbs(rows, onProgress) {
  const urls = [...new Set(rows.map((r) => r.image_url).filter(Boolean))];
  const out = {};
  let next = 0, done = 0;
  async function worker() {
    while (next < urls.length) {
      const u = urls[next++];
      out[u] = await thumb(u);
      done += 1;
      onProgress?.(done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMG_CONCURRENCY, urls.length) }, worker));
  return out;
}

function fitBox(t, maxW, maxH) {
  const s = Math.min(maxW / t.w, maxH / t.h);
  return { w: t.w * s, h: t.h * s };
}

export function vendorBomFilename(product, ext, showPrices) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const safe = String(product).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `LOT-BOM-${safe}-${showPrices ? 'with-prices' : 'vendor'}-${stamp}.${ext}`;
}

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────
export async function buildVendorBomPdf({ product, rows, thumbs, showPrices }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const cols = vendorBomColumns(showPrices);
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 10;
  const tableW = cols.reduce((s, c) => s + c.pdfW, 0);
  const scaleX = (pageW - margin * 2) / tableW;            // stretch the grid to the page width
  const widths = cols.map((c) => c.pdfW * scaleX);
  const IMG_BOX = 20, PAD = 1.8, LINE = 3.6, HEAD_H = 8;
  let y = margin;

  function header() {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(0);
    doc.text(`Bill of Materials — ${product}`, margin, y + 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
    doc.text(`Legend of Toys · ${rows.length} lines · ${todayLabel()}${showPrices ? ' · prices = last purchase order' : ''}`,
      margin, y + 10);
    y += 14;
    doc.setFillColor(242, 205, 26); doc.rect(margin, y, pageW - margin * 2, HEAD_H, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0);
    let x = margin;
    cols.forEach((c, i) => { doc.text(c.label, x + PAD, y + 5.3); x += widths[i]; });
    y += HEAD_H;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  }

  header();
  rows.forEach((r, ri) => {
    const cells = cols.map((c, i) => (c.key === 'img' ? null
      : doc.splitTextToSize(String(r[c.key] ?? ''), widths[i] - PAD * 2)));
    const textH = Math.max(1, ...cells.filter(Boolean).map((l) => l.length)) * LINE + PAD * 2;
    const t = r.image_url ? thumbs[r.image_url] : null;
    const rowH = t ? Math.max(IMG_BOX + PAD * 2, textH) : Math.max(8, textH);   // no picture → a short row
    if (y + rowH > pageH - margin) { doc.addPage(); y = margin; header(); }
    if (ri % 2 === 1) { doc.setFillColor(247, 247, 247); doc.rect(margin, y, pageW - margin * 2, rowH, 'F'); }
    let x = margin;
    cols.forEach((c, i) => {
      if (c.key === 'img') {
        if (t) {
          const box = fitBox(t, widths[i] - PAD * 2, IMG_BOX);
          doc.addImage(t.dataUrl, 'JPEG', x + (widths[i] - box.w) / 2, y + (rowH - box.h) / 2, box.w, box.h);
        } else {
          doc.setTextColor(160); doc.text('no picture', x + PAD, y + PAD + 3); doc.setTextColor(0);
        }
      } else {
        doc.text(cells[i], x + PAD, y + PAD + 3);
      }
      x += widths[i];
    });
    doc.setDrawColor(220); doc.line(margin, y + rowH, pageW - margin, y + rowH);
    y += rowH;
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p); doc.setFontSize(7.5); doc.setTextColor(140);
    doc.text(`${product} · page ${p} of ${pages}`, pageW - margin, pageH - 4, { align: 'right' });
  }
  return doc.output('blob');
}

// ── Excel ────────────────────────────────────────────────────────────────────────────────────
export async function buildVendorBomXlsx({ product, rows, thumbs, showPrices }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Legend of Toys — Garage';
  // Excel refuses * ? : \ / [ ] and a leading/trailing apostrophe in a sheet name.
  const sheetName = String(product).replace(/[*?:\\/[\]]/g, '-').replace(/^'+|'+$/g, '').slice(0, 31) || 'BOM';
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const cols = vendorBomColumns(showPrices);
  ws.columns = cols.map((c) => ({ key: c.key, width: c.xlsW }));

  ws.getCell('A1').value = `Bill of Materials — ${product}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `Legend of Toys · ${rows.length} lines · ${todayLabel()}${showPrices ? ' · prices = last purchase order' : ''}`;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FF666666' } };

  const head = ws.getRow(3);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CD1A' } };
    cell.alignment = { vertical: 'middle' };
  });
  head.height = 20;

  const ROW_PT = 66;                                   // ~88 px — room for an 80 px picture
  const imgCol = cols.findIndex((c) => c.key === 'img');
  const imageIds = {};                                 // one embedded copy per picture
  rows.forEach((r, ri) => {
    const rowNo = ri + 4;
    const row = ws.getRow(rowNo);
    cols.forEach((c, i) => {
      if (c.key === 'img') return;
      const cell = row.getCell(i + 1);
      if (c.key === 'price') {
        cell.value = r.price_num;
        if (r.price_num != null) {
          const unit = r.price_per ? ` "/ ${r.price_per.replace(/"/g, '')}"` : '';
          cell.numFmt = `"${(r.currency || 'INR').replace(/"/g, '')}" #,##0.00##${unit}`;
        }
      } else {
        cell.value = r[c.key] === '' ? null : r[c.key];
      }
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    const t = r.image_url ? thumbs[r.image_url] : null;
    row.height = t ? ROW_PT : 20;
    if (t && imgCol >= 0) {
      const id = imageIds[r.image_url] ??= wb.addImage({ base64: t.dataUrl, extension: 'jpeg' });
      const box = fitBox(t, 100, 80);
      ws.addImage(id, { tl: { col: imgCol + 0.05, row: rowNo - 1 + 0.05 }, ext: { width: box.w, height: box.h }, editAs: 'oneCell' });
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
