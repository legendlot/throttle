// src/flipkart-sellout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReportDate, parseReportHtml, toDailyFacts, b64urlDecode, parseDMY } from './flipkart-sellout.mjs';

const html = readFileSync(new URL('./fixtures/flipkart-report-2026-09-22.html', import.meta.url), 'utf8');

test('parseReportDate reads the subject suffix', () => {
  assert.equal(parseReportDate('L.O.T CARS x Flipkart Sales Report | 22-Sep-2026'), '2026-09-22');
  assert.equal(parseReportDate('Re: something else'), null);
  assert.equal(parseReportDate('L.O.T CARS x Flipkart Sales Report | 22-Sep-2026 (revised)'), '2026-09-22', 'a corrected re-send keeps its date');
  assert.equal(parseReportDate('Re: L.O.T CARS x Flipkart Sales Report | 15-Sep-2026'), '2026-09-15');
});

test('parseDMY handles DD-Mon-YYYY', () => {
  assert.equal(parseDMY('21-Sep-2026'), '2026-09-21');
  assert.equal(parseDMY('01-Jan-2027'), '2027-01-01');
  assert.equal(parseDMY('garbage'), null);
});

test('parseReportHtml extracts the three platform rows with rupee GMV and D-1/D-2 dates', () => {
  const p = parseReportHtml(html);
  assert.equal(p.d1_date, '2026-09-21');
  assert.equal(p.d2_date, '2026-09-20');
  assert.equal(p.mtd_label, 'Sep 2026');
  assert.equal(p.platforms.length, 3);
  const nat = p.platforms.find(x => x.platform === 'national');
  assert.deepEqual(nat, { platform: 'national', atp_qty: 6126, mtd_units: 1482, mtd_gmv: 3223000, d1_units: 81, d1_gmv: 174000, d2_units: 75, d2_gmv: 160000 });
  const min = p.platforms.find(x => x.platform === 'minutes');
  assert.equal(min.atp_qty, null);            // "—"
  assert.equal(min.mtd_gmv, 647000);
  const tot = p.platforms.find(x => x.platform === 'total');
  assert.equal(tot.mtd_units, 1810);
  assert.equal(tot.d2_gmv, 209000);
});

test('parseReportHtml throws on a body without the summary table', () => {
  assert.throws(() => parseReportHtml('<html><body>hello</body></html>'), /summary table/);
});

test('parseReportHtml throws when a column is inserted (positional read must not silently re-map)', () => {
  // Insert a "Growth %" column after ATP in both header rows and every data row.
  const shifted = html
    .replace(/(<t[dh][^>]*>\s*ATP[^<]*<\/t[dh]>)/i, '$1<th>Growth %</th>')
    .replace(/(<t[dh][^>]*>\s*Units\s*<\/t[dh]>)/i, '<th>%</th>$1');
  assert.throws(() => parseReportHtml(shifted), /column layout changed/);
});

test('parseReportHtml throws when National + Minutes != Total on a unit column', () => {
  // Bump the Total row's MTD units (1,810 → 1,811) so it no longer equals 1,482 + 328.
  const bad = html.replace(/1,810/, '1,811');
  assert.notEqual(bad, html, 'fixture must contain the total MTD units 1,810');
  assert.throws(() => parseReportHtml(bad), /mtd_units national 1482 \+ minutes 328 != total 1811/);
});

test('toDailyFacts emits one row per platform per reported day, never MTD', () => {
  const p = parseReportHtml(html);
  const rows = toDailyFacts(p, { source: 'flipkart_email', channel_id: 'chan', report_id: 'msg1' });
  assert.equal(rows.length, 6);
  const natD1 = rows.find(r => r.platform === 'national' && r.sale_date === '2026-09-21');
  assert.deepEqual(natD1, { source: 'flipkart_email', channel_id: 'chan', platform: 'national', sale_date: '2026-09-21', channel_sku: '*', units: 81, gmv: 174000, report_id: 'msg1' });
  assert.ok(rows.every(r => r.sale_date === '2026-09-21' || r.sale_date === '2026-09-20'));
});

test('toDailyFacts skips a day whose header date is missing', () => {
  const p = parseReportHtml(html); p.d2_date = null;
  assert.equal(toDailyFacts(p, { source: 's', channel_id: 'c', report_id: 'm' }).length, 3);
});

test('b64urlDecode decodes Gmail body encoding', () => {
  assert.equal(new TextDecoder().decode(b64urlDecode('aGVsbG8-Xw')), 'hello>_');
});
