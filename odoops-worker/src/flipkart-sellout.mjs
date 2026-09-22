// src/flipkart-sellout.mjs — pure parsing for the Flipkart daily sell-out email (no I/O, no env).
// The report: HTML "Platform Summary" table (National / Minutes / Total × ATP, MTD, D-1, D-2; GMV in Rs. lakhs)
// + an xlsx (27 FSN rows, same blocks split National/Minutes/Total).

import { readXlsxSheet } from './xlsx-lite.mjs';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDMY(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export function parseReportDate(subject) {
  // \b not $: a correction may carry a suffix ("… | 22-Sep-2026 (revised)") and must still be ingested.
  const m = /\|\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\b/.exec(String(subject || ''));
  return m ? parseDMY(m[1]) : null;
}

const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = s => {
  const t = strip(s).replace(/,/g, '');
  if (!t || t === '—' || t === '-' || t === '–') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const lakh = s => { const n = num(s); return n == null ? null : Math.round(n * 100000 * 100) / 100; };
const int = s => { const n = num(s); return n == null ? null : Math.round(n); };

// Returns the <td>/<th> inner strings of every <tr> in the first table whose header mentions "Platform".
function tableRows(html) {
  const tables = String(html).match(/<table[\s\S]*?<\/table>/gi) || [];
  const t = tables.find(x => /Platform/i.test(x) && /Month till Date/i.test(x));
  if (!t) throw new Error('Flipkart report: summary table not found');
  return (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(tr => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(td => td.replace(/^<t[dh][^>]*>/i, '').replace(/<\/t[dh]>$/i, '')));
}

// The value columns are read by POSITION (cells[1..7]); assert the two header rows still say what we
// assume, so an upstream column insert/reorder fails the run instead of silently re-mapping ATP/MTD/D-1/D-2.
const HEADER_1 = [/^Platform$/i, /^ATP/i, /^Month till Date/i, /^D-1 Sale/i, /^D-2 Sale/i];
const HEADER_2 = [/^Units$/i, /^GMV/i, /^Units$/i, /^GMV/i, /^Units$/i, /^GMV/i];
function assertLayout(rows) {
  const h1 = (rows[0] || []).map(strip), h2 = (rows[1] || []).map(strip);
  const ok = h1.length === HEADER_1.length && HEADER_1.every((re, i) => re.test(h1[i]))
          && h2.length === HEADER_2.length && HEADER_2.every((re, i) => re.test(h2[i]));
  if (!ok) throw new Error(`Flipkart report: column layout changed — header rows: [${h1.join(' | ')}] / [${h2.join(' | ')}]`);
}

export function parseReportHtml(html) {
  const rows = tableRows(html);
  assertLayout(rows);
  const headerText = rows.slice(0, 2).flat().map(strip).join(' | ');
  const d1 = /D-1 Sale \((\d{1,2}-[A-Za-z]{3}-\d{4})\)/.exec(headerText);
  const d2 = /D-2 Sale \((\d{1,2}-[A-Za-z]{3}-\d{4})\)/.exec(headerText);
  const mtd = /Month till Date \(([^)]+)\)/.exec(headerText);
  const platforms = [];
  for (const cells of rows) {
    if (cells.length < 8) continue;
    const label = strip(cells[0]).toLowerCase();
    const platform = label === 'flipkart national' ? 'national' : label === 'flipkart minutes' ? 'minutes' : label === 'flipkart total' ? 'total' : null;
    if (!platform) continue;
    platforms.push({
      platform,
      atp_qty: int(cells[1]),
      mtd_units: int(cells[2]), mtd_gmv: lakh(cells[3]),
      d1_units: int(cells[4]),  d1_gmv: lakh(cells[5]),
      d2_units: int(cells[6]),  d2_gmv: lakh(cells[7]),
    });
  }
  if (!platforms.length) throw new Error('Flipkart report: summary table has no platform rows');
  // Total = National + Minutes on every unit column (held on every live report to date). A mismatch means a
  // shifted column or a new platform — fail the run rather than store a number the tile presents as fact.
  const by = Object.fromEntries(platforms.map(p => [p.platform, p]));
  if (by.national && by.minutes && by.total) {
    for (const k of ['mtd_units', 'd1_units', 'd2_units']) {
      const a = by.national[k], b = by.minutes[k], t = by.total[k];
      if (a != null && b != null && t != null && a + b !== t) throw new Error(`Flipkart report: ${k} national ${a} + minutes ${b} != total ${t}`);
    }
  }
  return { d1_date: d1 ? parseDMY(d1[1]) : null, d2_date: d2 ? parseDMY(d2[1]) : null, mtd_label: mtd ? mtd[1].trim() : null, platforms };
}

export function toDailyFacts(parsed, { source, channel_id, report_id }) {
  const out = [];
  for (const p of parsed.platforms) {
    if (parsed.d1_date) out.push({ source, channel_id, platform: p.platform, sale_date: parsed.d1_date, channel_sku: '*', units: p.d1_units, gmv: p.d1_gmv, report_id });
    if (parsed.d2_date) out.push({ source, channel_id, platform: p.platform, sale_date: parsed.d2_date, channel_sku: '*', units: p.d2_units, gmv: p.d2_gmv, report_id });
  }
  return out;
}

// ---- xlsx (FSN-level breakup) --------------------------------------------------------------
// Phase 2: the daily xlsx attachment, 27 FSN rows × (MTD + D-1..D-7) National/Minutes/Total.
// parseReportGrid is pure/sync over the `rows` shape readXlsxSheet returns; parseReportXlsx
// wires the xlsx reader in front of it.

// Grid cells carry literal newlines inside headers ("ATP\n(Current)") — collapse those too, on
// top of the HTML-table `strip` above (harmless no-op here since grid cells have no tags).
const gstrip = s => strip(s).replace(/\s+/g, ' ').trim();

// A..Z, AA..AZ, ... <-> 1-based column index.
function colToIdx(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function idxToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const BLOCK_SUBHEADERS = [/^National Units$/, /^Minutes Units$/, /^Total Units$/, /^National GMV/, /^Minutes GMV/, /^Total GMV/];

export function parseReportGrid(rows) {
  let h = null;
  for (let r = 1; r < rows.length; r++) {
    if (gstrip(rows[r]?.A) === 'FSN') { h = r; break; }
  }
  if (h == null) throw new Error('Flipkart xlsx: FSN header row not found');

  const header = rows[h];
  const COLS = [[/^FSN$/, 'A'], [/^Product Title$/, 'B'], [/^Brand$/, 'C'], [/^Vertical$/, 'D'], [/^ATP/, 'E']];
  for (const [re, col] of COLS) {
    if (!re.test(gstrip(header[col]))) {
      throw new Error(`Flipkart xlsx: column layout changed — ${col}${h} is "${gstrip(header[col])}", expected to match ${re}`);
    }
  }

  // Block titles live one row above the headers, one cell per 6-column block.
  const titleRow = rows[h - 1] || {};
  const blocks = [];
  const seenKeys = new Set();
  for (const [colLetter, val] of Object.entries(titleRow)) {
    const text = gstrip(val);
    let key = null, label = null, date = null;
    const mtdM = /^Month till Date \((.+)\)$/.exec(text);
    const dM = /^D-(\d)\s+(\d{1,2}-[A-Za-z]{3}-\d{4})$/.exec(text);
    if (mtdM) { key = 'mtd'; label = mtdM[1]; }
    else if (dM) { key = `d${dM[1]}`; date = parseDMY(dM[2]); }
    else continue;
    if (seenKeys.has(key)) throw new Error(`Flipkart xlsx: duplicate block key "${key}"`);
    seenKeys.add(key);
    const col = colToIdx(colLetter);
    blocks.push({ key, label, date, col });
  }
  blocks.sort((a, b) => a.col - b.col);
  if (!blocks.some(b => b.key === 'mtd')) throw new Error('Flipkart xlsx: "mtd" block not found');
  if (!blocks.some(b => b.key === 'd1')) throw new Error('Flipkart xlsx: "d1" block not found');

  for (const b of blocks) {
    for (let i = 0; i < 6; i++) {
      const col = idxToCol(b.col + i);
      const text = gstrip(header[col]);
      if (!BLOCK_SUBHEADERS[i].test(text)) {
        throw new Error(`Flipkart xlsx: column layout changed — block "${b.key}" sub-header ${col}${h} is "${text}", expected to match ${BLOCK_SUBHEADERS[i]}`);
      }
    }
  }

  function readBlockValues(row) {
    const out = {};
    for (const b of blocks) {
      const c0 = idxToCol(b.col), c1 = idxToCol(b.col + 1), c2 = idxToCol(b.col + 2);
      const c3 = idxToCol(b.col + 3), c4 = idxToCol(b.col + 4), c5 = idxToCol(b.col + 5);
      out[b.key] = {
        national_units: int(row[c0]), minutes_units: int(row[c1]), total_units: int(row[c2]),
        national_gmv: lakh(row[c3]), minutes_gmv: lakh(row[c4]), total_gmv: lakh(row[c5]),
      };
    }
    return out;
  }

  const fsns = [];
  let totalRowIdx = null, fsnCount = null;
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r];
    const a = gstrip(row?.A);
    if (/^TOTAL/.test(a)) {
      totalRowIdx = r;
      const m = /\((\d+)\s*FSNs?\)/.exec(a);
      fsnCount = m ? Number(m[1]) : null;
      break;
    }
    if (!row || !a) continue;   // a formatted spacer row (style-only cells) — the TOTAL row is still ahead
    fsns.push({
      fsn: a,
      title: gstrip(row.B),
      brand: gstrip(row.C),
      vertical: gstrip(row.D),
      atp_qty: int(row.E),
      blocks: readBlockValues(row),
    });
  }
  if (totalRowIdx == null) throw new Error('Flipkart xlsx: TOTAL row not found');
  // A duplicated FSN row would collide on the sellout_sku / sellout_fact PKs inside one upsert (SQLSTATE 21000,
  // not transient) and wedge the connector on that message — refuse it here, where the message says why.
  const dup = fsns.map(f => f.fsn).find((x, i, arr) => arr.indexOf(x) !== i);
  if (dup) throw new Error(`Flipkart xlsx: duplicate FSN row ${dup}`);

  const total = { atp_qty: int(rows[totalRowIdx].E), blocks: readBlockValues(rows[totalRowIdx]) };

  // Invariants — fail the run rather than store a silently mis-summed number.
  for (const f of fsns) {
    for (const b of blocks) {
      const v = f.blocks[b.key];
      if (v.national_units != null && v.minutes_units != null && v.total_units != null
          && v.national_units + v.minutes_units !== v.total_units) {
        throw new Error(`Flipkart xlsx: FSN ${f.fsn} block ${b.key} national ${v.national_units} + minutes ${v.minutes_units} != total ${v.total_units}`);
      }
    }
  }
  for (const b of blocks) {
    const sum = fsns.reduce((acc, f) => acc + (f.blocks[b.key].total_units || 0), 0);
    const tv = total.blocks[b.key].total_units;
    if (tv != null && sum !== tv) {
      throw new Error(`Flipkart xlsx: block ${b.key} sum of FSN total_units ${sum} != TOTAL row ${tv}`);
    }
  }
  if (fsnCount != null && fsns.length !== fsnCount) {
    throw new Error(`Flipkart xlsx: TOTAL row says ${fsnCount} FSNs but ${fsns.length} FSN rows were read`);
  }

  return { title: gstrip(rows[1]?.A) || null, blocks: blocks.map(({ key, label, date }) => ({ key, label, date })), fsns, total, fsn_count: fsnCount };
}

export async function parseReportXlsx(bytes) {
  return parseReportGrid(await readXlsxSheet(bytes));
}

export function toFsnFacts(parsed, { source, channel_id, report_id }) {
  const out = [];
  for (const block of parsed.blocks) {
    if (!block.date) continue; // MTD never lands in the daily facts table
    for (const f of parsed.fsns) {
      const v = f.blocks[block.key];
      out.push({ source, channel_id, platform: 'national', sale_date: block.date, channel_sku: f.fsn, units: v.national_units, gmv: v.national_gmv, report_id });
      out.push({ source, channel_id, platform: 'minutes', sale_date: block.date, channel_sku: f.fsn, units: v.minutes_units, gmv: v.minutes_gmv, report_id });
      out.push({ source, channel_id, platform: 'total', sale_date: block.date, channel_sku: f.fsn, units: v.total_units, gmv: v.total_gmv, report_id });
    }
    const tv = parsed.total.blocks[block.key];
    out.push({ source, channel_id, platform: 'national', sale_date: block.date, channel_sku: '*', units: tv.national_units, gmv: tv.national_gmv, report_id });
    out.push({ source, channel_id, platform: 'minutes', sale_date: block.date, channel_sku: '*', units: tv.minutes_units, gmv: tv.minutes_gmv, report_id });
    out.push({ source, channel_id, platform: 'total', sale_date: block.date, channel_sku: '*', units: tv.total_units, gmv: tv.total_gmv, report_id });
  }
  return out;
}

export function toSkuSnapshot(parsed, { source, channel_id, report_id, report_date }) {
  const mtd = parsed.blocks.find(b => b.key === 'mtd');
  return parsed.fsns.map(f => ({
    source, channel_id, channel_sku: f.fsn,
    title: f.title, brand: f.brand, vertical: f.vertical, atp_qty: f.atp_qty,
    mtd_units: f.blocks.mtd.total_units, mtd_gmv: f.blocks.mtd.total_gmv, mtd_label: mtd ? mtd.label : null,
    report_date, report_id,
  }));
}

export function b64urlDecode(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s || '').length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
