// Minimal, dependency-free .xlsx writer for Odo's flat table exports.
//
// WHY NOT SheetJS: the `xlsx` package is ~800KB minified and is not a dependency
// anywhere in this monorepo. Odo's whole shared first-load JS is ~87KB, and every
// export here is a flat array of objects — headers, strings, numbers, dates as text.
// A real .xlsx is just a ZIP of five small XML parts, so writing it directly costs
// ~200 lines, adds no dependency and no bundle weight. Correctness is not assumed:
// see scripts/verify-xlsx.mjs, which generates a workbook and validates it with
// openpyxl (the check that matters is that Excel's own parser accepts it).
//
// Scope, deliberately: one sheet, inline strings (no sharedStrings table), bold
// frozen header row, auto-ish column widths. No formulas, no merges, no styling
// beyond the header. Extend only if a caller genuinely needs it.

/* ── ZIP container (store-only; no compression) ──────────────────────────────
   Store-only is a valid ZIP and Excel accepts it. It keeps this file free of a
   DEFLATE implementation, which is the only genuinely fiddly part of writing a
   ZIP by hand. Export sizes here are tens of KB, so compression buys nothing. */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

// Fixed DOS timestamp (1980-01-01 00:00). Deliberately constant: a wall-clock
// stamp would make two exports of identical data differ byte-for-byte, which
// makes the output impossible to diff or golden-test.
const DOS_TIME = 0;
const DOS_DATE = 33;

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const { name, data } of files) {
    const nameBytes = utf8(name);
    const crc = crc32(data);

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
      ...Array.from(nameBytes),
    ]);

    offset += local.length + nameBytes.length + data.length;
  }

  const cd = new Uint8Array(central.flat());
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(cd.length), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...chunks, cd, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ── XLSX parts ──────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s)
    // Strip control characters Excel rejects outright (keep tab/LF/CR).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Column names whose values must stay TEXT even when they look numeric.
// An EAN is 13 digits: as a number Excel renders it in scientific notation and
// silently drops leading zeros, which corrupts the identifier. Same for SKUs,
// part codes, UPCs, HSN, GSTIN, pincodes and phone numbers.
const ID_COL = /(^|_)(ean|sku|upc|code|id|hsn|gstin|pin|pincode|phone|mobile|barcode|order_no|invoice)(_|$)/i;

function isNumeric(value, column) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (ID_COL.test(column)) return false;
  const s = value.trim();
  if (!s) return false;
  // Strict decimal only. Reject leading zeros ("007" is an identifier, not 7)
  // and anything over 15 significant digits (beyond IEEE-754 exact integers).
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return false;
  if (s.replace(/[-.]/g, '').length > 15) return false;
  return Number.isFinite(Number(s));
}

function sheetXml(cols, rows) {
  const widths = cols.map((c, i) => {
    let max = String(c).length;
    for (const r of rows) {
      const v = r[c];
      const len = v == null ? 0 : String(v).length;
      if (len > max) max = len;
    }
    // +2 for padding, clamped so one long free-text cell can't produce a
    // 300-character-wide column.
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(max + 2, 8), 46)}" customWidth="1"/>`;
  }).join('');

  const header = cols.map((c, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${esc(c)}</t></is></c>`
  ).join('');

  const body = rows.map((r, ri) => {
    const n = ri + 2;
    const cells = cols.map((c, ci) => {
      const v = r[c];
      if (v == null || v === '') return '';
      const ref = `${colName(ci)}${n}`;
      if (isNumeric(v, c)) return `<c r="${ref}"><v>${Number(v)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${n}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths}</cols>
<sheetData><row r="1">${header}</row>${body}</sheetData>
</worksheet>`;
}

// Two fonts / two cellXfs: index 0 plain, index 1 bold — used only by the header.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Excel rejects a sheet name containing : \ / ? * [ ] or longer than 31 chars.
function safeSheetName(name) {
  const s = String(name || 'Sheet1').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return s || 'Sheet1';
}

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/** Build an .xlsx Blob from a flat array of objects. Columns come from the
 *  union of all row keys, so a sparse row doesn't silently drop a column. */
export function buildXlsx(rows, sheetName = 'Sheet1') {
  const list = Array.isArray(rows) ? rows : [];
  const cols = [];
  const seen = new Set();
  for (const r of list) {
    for (const k of Object.keys(r || {})) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return zip([
    { name: '[Content_Types].xml',        data: utf8(CONTENT_TYPES) },
    { name: '_rels/.rels',                data: utf8(ROOT_RELS) },
    { name: 'xl/workbook.xml',            data: utf8(workbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(WB_RELS) },
    { name: 'xl/styles.xml',              data: utf8(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml',   data: utf8(sheetXml(cols, list)) },
  ]);
}

/** Mirrors downloadCsv's contract: no-op on empty input, click-to-download. */
export function downloadXlsx(rows, filename, sheetName) {
  if (!rows || !rows.length) return;
  const blob = buildXlsx(rows, sheetName || 'Export');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
