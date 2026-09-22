// src/flipkart-sellout.mjs — pure parsing for the Flipkart daily sell-out email (no I/O, no env).
// The report: HTML "Platform Summary" table (National / Minutes / Total × ATP, MTD, D-1, D-2; GMV in Rs. lakhs)
// + an xlsx (27 FSN rows, same blocks split National/Minutes/Total) — the xlsx is Phase 2.

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

export function b64urlDecode(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s || '').length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
