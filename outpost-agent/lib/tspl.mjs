// TSPL builders for the Outpost print agent (TSC printers).
// batch_label + ean_label are the in-house line print server's layouts (line_printserver/printserver.js v2.3), so a
// vendor-packed box carries exactly the labels LOT's own line prints. ctn_label + upc_stickers are new.
// Every text field goes through clean(): a " inside a TSPL string ends the command early.

export const DEFAULTS = {
  label: { width_mm: 50, height_mm: 25, gap_mm: 2, darkness: 8, speed: 4 },
  // 13 mm QR stickers on a multi-across roll. The roll spec is set per site in config.json (stickers.*).
  stickers: { dpi: 300, across: 3, size_mm: 13, gap_x_mm: 2, gap_y_mm: 2, left_mm: 1, darkness: 10, speed: 3, cell: 5 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function clean(v, max = 60) {
  const s = String(v ?? '').replace(/["\\]/g, "'").replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '.' : s;
}

// dd-Mon-yyyy in IST (the floor's date, whatever the laptop's zone).
export function istDate(iso) {
  const t = Date.parse(iso || '');
  const d = new Date((Number.isNaN(t) ? Date.now() : t) + 330 * 60_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function header(l) {
  return [`SIZE ${l.width_mm} mm, ${l.height_mm} mm`, `GAP ${l.gap_mm} mm, 0 mm`, 'DIRECTION 0',
    `SET DARKNESS ${l.darkness}`, `SET SPEED ${l.speed}`];
}

// The PKG box label: batch label as Code 128 + text, product line, channel + pack date.
export function batchLabel(p, l = DEFAULTS.label) {
  const productLine = clean([p.product, p.model, p.color].filter(Boolean).join(' '), 38);
  const footer = `${clean(p.channel || 'ecom').toUpperCase()}  ${istDate(p.packed_at)}`;
  const bl = clean(p.batch_label, 40);
  if (!bl) throw new Error('batch_label missing');
  return [...header(l), 'CLS',
    `BARCODE 24,3,"128",52,1,0,2,2,"${bl}"`,
    `TEXT 24,60,"2",0,1,1,"${bl}"`,
    `TEXT 24,82,"1",0,1,1,"${productLine}"`,
    `TEXT 24,96,"1",0,1,1,"${footer}"`,
    'PRINT 1,1', ''].join('\r\n');
}

// Product name on top, EAN-13 below. TSPL "EAN13" takes 12 digits and adds the check digit itself.
export function eanLabel(p, l = DEFAULTS.label) {
  const name = clean([p.product, p.model, p.color].filter(Boolean).join(' '), 46);
  const digits = String(p.ean || '').replace(/\D/g, '');
  if (digits.length !== 13) throw new Error('ean must be 13 digits');   // the pack refuses a bad EAN; never print a blank
  const big = name.length <= 23;
  return [...header(l), 'CLS',
    `TEXT 10,12,"${big ? '2' : '1'}",0,1,1,"${big ? name : clean(name, 46)}"`,
    `BARCODE 60,45,"EAN13",110,1,0,3,3,"${digits.slice(0, 12)}"`,
    'PRINT 1,1', ''].join('\r\n');
}

// The carton label: CTN number as Code 128 (LOT receiving scans it), what is inside, and the manifest version — a
// carton that lost a unit after closing gets v2, v3 … and a fresh label.
export function ctnLabel(p, l = DEFAULTS.label) {
  const ctn = clean(p.ctn_no, 20);
  if (!/^CTN-\d{7,}$/.test(ctn)) throw new Error('ctn_no missing');
  const what = clean([p.product, p.model, p.color].filter(Boolean).join(' ') + (p.sku ? ` (${p.sku})` : ''), 38);
  const v = Number(p.manifest_version) > 1 ? `  v${Number(p.manifest_version)}` : '';
  const count = `${Number(p.unit_count) || 0} units  ${clean(p.channel || '').toUpperCase()}  ${istDate(p.closed_at)}`;
  return [...header(l), 'CLS',
    `BARCODE 24,3,"128",52,1,0,2,2,"${ctn}"`,
    `TEXT 24,60,"2",0,1,1,"${ctn}${v}"`,
    `TEXT 24,82,"1",0,1,1,"${what}"`,
    `TEXT 24,96,"1",0,1,1,"${clean(count, 38)}"`,
    'PRINT 1,1', ''].join('\r\n');
}

// UPC stickers: one TSPL "label" per row of `across` stickers; each sticker = the QR of its LOT-NNNNNNNN id with the
// id printed under it. Coordinates in dots at the sticker printer's dpi.
export function stickerRows(p, s = DEFAULTS.stickers) {
  const upcs = Array.isArray(p.upcs) ? p.upcs.map(u => clean(u, 20)) : [];
  if (!upcs.length) throw new Error('no stickers in this job');
  for (const u of upcs) if (!/^LOT-\d{8}$/.test(u)) throw new Error(`bad sticker id ${u}`);
  const dot = mm => Math.round((mm * s.dpi) / 25.4);
  const width = s.left_mm + s.across * s.size_mm + (s.across - 1) * s.gap_x_mm;
  const qr = 21 * s.cell;                                  // version 1 QR = 21 modules (fits LOT-NNNNNNNN, ECC M)
  const textW = 12 * 8;                                    // font "1" is 8 dots wide
  const out = [`SIZE ${width} mm, ${s.size_mm} mm`, `GAP ${s.gap_y_mm} mm, 0 mm`, 'DIRECTION 0',
    `SET DARKNESS ${s.darkness}`, `SET SPEED ${s.speed}`];
  for (let i = 0; i < upcs.length; i += s.across) {
    out.push('CLS');
    upcs.slice(i, i + s.across).forEach((u, k) => {
      const x0 = dot(s.left_mm + k * (s.size_mm + s.gap_x_mm));
      const cellW = dot(s.size_mm);
      out.push(`QRCODE ${x0 + Math.max(0, Math.floor((cellW - qr) / 2))},${dot(0.6)},M,${s.cell},A,0,"${u}"`);
      out.push(`TEXT ${x0 + Math.max(0, Math.floor((cellW - textW) / 2))},${dot(0.6) + qr + 4},"1",0,1,1,"${u}"`);
    });
    out.push('PRINT 1,1');
  }
  out.push('');
  return out.join('\r\n');
}

export function build(job, cfg = DEFAULTS) {
  const p = job.payload || {};
  switch (job.kind) {
    case 'batch_label': return batchLabel(p, cfg.label);
    case 'ean_label': return eanLabel(p, cfg.label);
    case 'ctn_label': return ctnLabel(p, cfg.label);
    case 'upc_stickers': return stickerRows(p, cfg.stickers);
    default: throw new Error(`unknown job kind ${job.kind}`);
  }
}
