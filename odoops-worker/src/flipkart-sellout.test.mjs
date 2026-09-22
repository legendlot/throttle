// src/flipkart-sellout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReportDate, parseReportHtml, toDailyFacts, b64urlDecode, parseDMY,
         parseReportGrid, parseReportXlsx, toFsnFacts, toSkuSnapshot, stageSelloutRows } from './flipkart-sellout.mjs';
import { readXlsxSheet } from './xlsx-lite.mjs';

const html = readFileSync(new URL('./fixtures/flipkart-report-2026-09-22.html', import.meta.url), 'utf8');
const xlsxBytes = new Uint8Array(readFileSync(new URL('./fixtures/flipkart-report-2026-09-22.xlsx', import.meta.url)));

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

// ---- xlsx (FSN-level breakup) --------------------------------------------------------------

test('parseReportXlsx reads 27 FSNs, the block layout and dates', async () => {
  const p = await parseReportXlsx(xlsxBytes);
  assert.equal(p.fsns.length, 27);
  assert.equal(p.fsn_count, 27);
  assert.deepEqual(p.blocks.map(b => b.key), ['mtd', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
  assert.deepEqual(p.blocks.map(b => b.date), [null, '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15']);
  assert.equal(p.blocks.find(b => b.key === 'mtd').label, 'Sep 2026');
});

test('parseReportXlsx reads the first FSN row correctly', async () => {
  const p = await parseReportXlsx(xlsxBytes);
  const f = p.fsns[0];
  assert.equal(f.fsn, 'RCTHJH5PNXD6WQFY');
  assert.equal(f.atp_qty, 460);
  assert.deepEqual(f.blocks.mtd, { national_units: 559, minutes_units: 81, total_units: 640, national_gmv: 1257000, minutes_gmv: 168000, total_gmv: 1425000 });
  assert.equal(f.blocks.d1.total_units, 27);
});

test('parseReportXlsx reads the TOTAL row', async () => {
  const p = await parseReportXlsx(xlsxBytes);
  assert.equal(p.total.blocks.mtd.total_units, 1810);
  assert.equal(p.total.blocks.d3.total_units, 108);
  assert.ok(p.total.blocks.d7.total_units > 0, 'd7 populated');
});

test('toFsnFacts emits one row per FSN + one "*" total row, per dated block, per platform — never MTD', async () => {
  const p = await parseReportXlsx(xlsxBytes);
  const facts = toFsnFacts(p, { source: 'flipkart_xlsx', channel_id: 'chan', report_id: 'msg1' });
  assert.equal(facts.length, 27 * 7 * 3 + 7 * 3);
  const sample = facts.find(r => r.channel_sku === 'RCTHJH5PNXD6WQFY' && r.platform === 'total' && r.sale_date === '2026-09-21');
  assert.deepEqual(sample, { source: 'flipkart_xlsx', channel_id: 'chan', platform: 'total', sale_date: '2026-09-21', channel_sku: 'RCTHJH5PNXD6WQFY', units: 27, gmv: 60000, report_id: 'msg1' });
  assert.ok(facts.every(r => r.sale_date !== null));
});

test('toSkuSnapshot emits one row per FSN with MTD figures', async () => {
  const p = await parseReportXlsx(xlsxBytes);
  const snap = toSkuSnapshot(p, { source: 'flipkart_xlsx', channel_id: 'chan', report_id: 'msg1', report_date: '2026-09-22' });
  assert.equal(snap.length, 27);
  const row = snap.find(r => r.channel_sku === 'RCTHK8CF2NAYEHUT');
  assert.ok(row, 'RCTHK8CF2NAYEHUT present');
  assert.ok(row.title.includes('Modes & Multi'), row.title);
  assert.equal(row.mtd_label, 'Sep 2026');
});

test('parseReportGrid throws when national + minutes != total on an FSN block', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated[9].N += 5; // row 9 = first FSN, N = d1 block's "Total Units" column
  assert.throws(() => parseReportGrid(mutated), /national .* \+ minutes .* != total/);
});

test('parseReportGrid throws when the TOTAL row no longer sums its FSN column', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated[36].H += 1; // TOTAL row, H = mtd block's Total Units column
  assert.throws(() => parseReportGrid(mutated), /sum/i);
});

test('parseReportGrid throws when a sub-header is renamed (column layout changed)', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated[8].S = 'Foo Units'; // d2 block's "Minutes Units" sub-header
  assert.throws(() => parseReportGrid(mutated), /column layout changed|sub-header/);
});

test('parseReportGrid throws on a duplicated FSN row', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated[10].A = mutated[9].A; // second FSN row re-uses the first FSN
  assert.throws(() => parseReportGrid(mutated), /duplicate FSN row RCTHJH5PNXD6WQFY/);
});

test('parseReportGrid skips a formatted spacer row before TOTAL', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated.splice(36, 0, undefined); // blank row between the last FSN and TOTAL
  const p = parseReportGrid(mutated);
  assert.equal(p.fsns.length, 27);
  assert.equal(p.total.blocks.mtd.total_units, 1810);
});

test('parseReportGrid throws when there is no TOTAL row', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  mutated.length = 36; // drop the TOTAL row entirely
  assert.throws(() => parseReportGrid(mutated), /TOTAL row not found/);
});

test('parseReportHtml reads a numeric cell that carries a <br> (strip inserts a space, which must not make it null)', () => {
  assert.equal((html.match(/6,126/g) || []).length, 2);
  const p = parseReportHtml(html.replace(/6,126/g, '6,<br>126'));
  assert.equal(p.platforms.find(x => x.platform === 'national').atp_qty, 6126);
});

test('parseReportGrid throws when a D-n block title carries a date it cannot parse (the day must not vanish silently)', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  const titleRow = mutated[7];
  const col = Object.keys(titleRow).find(k => /^D-1 /.test(String(titleRow[k])));
  assert.ok(col, 'D-1 title cell not found in row 7');
  titleRow[col] = titleRow[col].replace(/-([A-Za-z]{3})-/, '-Sxp-');
  assert.throws(() => parseReportGrid(mutated), /unparseable date/);
});

// ---- stageSelloutRows: the ordering rules, against an in-memory Supabase ----------------------------
function fakeIo({ reports = [], skuMaxDate = null, failInsert = null, failPatch = false } = {}) {
  const calls = [];
  const db = { reports: [...reports] };
  const io = {
    parserVersion: 2,
    nowISO: () => '2026-09-22T05:00:00.000Z',
    queueUnmappedFsns: async (channelId, snap) => { calls.push(['queue', channelId, snap.length]); },
    sbSales: async (path, init) => {
      calls.push([init?.method || 'GET', path]);
      if (init?.method === 'PATCH') {
        if (failPatch) return { ok: false, data: { message: 'boom' } };
        const rd = /report_date=eq\.([^&]+)/.exec(path)[1], me = decodeURIComponent(/message_id=neq\.([^&]+)/.exec(path)[1]);
        for (const x of db.reports) if (x.report_date === rd && x.message_id !== me && !x.superseded_by) x.superseded_by = JSON.parse(init.body).superseded_by;
        return { ok: true, data: [] };
      }
      if (path.startsWith('/rest/v1/sellout_report?')) {
        const rd = /report_date=eq\.([^&]+)/.exec(path)[1], me = decodeURIComponent(/message_id=neq\.([^&]+)/.exec(path)[1]);
        const hits = db.reports.filter(x => x.report_date === rd && x.message_id !== me).sort((a, b) => a.received_at < b.received_at ? 1 : -1);
        return { ok: true, data: hits.slice(0, 1) };
      }
      if (path.startsWith('/rest/v1/sellout_sku?')) return { ok: true, data: skuMaxDate ? [{ report_date: skuMaxDate }] : [] };
      throw new Error('fakeIo: unexpected read ' + path);
    },
    sbInsertChunked: async (path, rows) => {
      calls.push(['INSERT', path, rows.length]);
      if (failInsert && path.includes(failInsert)) throw new Error('fakeIo: insert failed ' + failInsert);
      if (path.startsWith('/rest/v1/sellout_report?')) for (const x of rows) db.reports.push({ ...x });
    },
  };
  return { io, calls, db };
}
const parsedFor = (d1, d2) => ({ d1_date: d1, d2_date: d2, mtd_label: 'Sep 2026', platforms: [
  { platform: 'total', atp_qty: 10, mtd_units: 5, mtd_gmv: 1000, d1_units: 2, d1_gmv: 400, d2_units: 3, d2_gmv: 600 }] });
const row = (message_id, report_date, received_at, extra = {}) => ({
  message_id, report_date, received_at, channel_id: 'chan-1', parsed: parsedFor('2026-09-21', '2026-09-20'),
  html_path: 'h', xlsx_path: null, sha256: 'x', xlsx: null, ...extra,
});
const inserts = calls => calls.filter(c => c[0] === 'INSERT').map(c => c[1].split('?')[0]);

test('stageSelloutRows: a throwing fact insert leaves NO report row behind (the dedup key never exists without its facts)', async () => {
  const { io, calls, db } = fakeIo({ failInsert: 'sellout_fact' });
  await assert.rejects(() => stageSelloutRows([row('m1', '2026-09-22', '2026-09-22T04:00:00Z')], io), /insert failed sellout_fact/);
  assert.equal(db.reports.length, 0);
  assert.ok(!inserts(calls).includes('/rest/v1/sellout_report'));
});

test('stageSelloutRows: an OLDER report for a date that already has a newer one writes no facts and lands superseded', async () => {
  const { io, calls, db } = fakeIo({ reports: [{ message_id: 'new', platform: 'total', report_date: '2026-09-22', received_at: '2026-09-22T09:00:00+00:00' }] });
  const res = await stageSelloutRows([row('old', '2026-09-22', '2026-09-22T04:00:00Z')], io);
  assert.deepEqual(inserts(calls), ['/rest/v1/sellout_report']);           // no sellout_fact write at all
  assert.equal(db.reports.find(x => x.message_id === 'old').superseded_by, 'new');
  assert.ok(!calls.some(c => c[0] === 'PATCH'));                            // the older one supersedes nothing
  assert.ok(res.subreqs >= 2);
});

test('stageSelloutRows: arrival order does not matter — the later-received report wins and supersedes the earlier', async () => {
  const { io, calls, db } = fakeIo();
  await stageSelloutRows([row('later', '2026-09-22', '2026-09-22T09:00:00Z'), row('earlier', '2026-09-22', '2026-09-22T04:00:00Z')], io);
  assert.deepEqual(inserts(calls), ['/rest/v1/sellout_fact', '/rest/v1/sellout_report', '/rest/v1/sellout_fact', '/rest/v1/sellout_report']);
  assert.equal(db.reports.find(x => x.message_id === 'earlier').superseded_by, 'later');
  assert.equal(db.reports.find(x => x.message_id === 'later').superseded_by, null);
});

test('stageSelloutRows: a failing supersede PATCH throws before the report row is written', async () => {
  const { io, calls } = fakeIo({ failPatch: true });
  await assert.rejects(() => stageSelloutRows([row('m1', '2026-09-22', '2026-09-22T04:00:00Z')], io), /supersede PATCH failed for 2026-09-22/);
  assert.ok(!inserts(calls).includes('/rest/v1/sellout_report'));
});

test('stageSelloutRows: the FSN snapshot is only written by a report at least as new as the current one; unmapped queue follows it', async () => {
  const xlsx = parseReportGrid(await readXlsxSheet(xlsxBytes));
  const older = fakeIo({ skuMaxDate: '2026-09-23' });
  await stageSelloutRows([row('m1', '2026-09-22', '2026-09-22T04:00:00Z', { xlsx })], older.io);
  assert.ok(!inserts(older.calls).includes('/rest/v1/sellout_sku'));
  assert.ok(!older.calls.some(c => c[0] === 'queue'));
  assert.equal(older.calls.filter(c => c[0] === 'INSERT' && c[1].startsWith('/rest/v1/sellout_fact')).length, 2); // HTML facts + FSN facts still land
  const same = fakeIo({ skuMaxDate: '2026-09-22' });
  const res = await stageSelloutRows([row('m1', '2026-09-22', '2026-09-22T04:00:00Z', { xlsx })], same.io);
  assert.ok(inserts(same.calls).includes('/rest/v1/sellout_sku'));
  assert.deepEqual(same.calls.find(c => c[0] === 'queue'), ['queue', 'chan-1', 27]);
  assert.ok(res.subreqs >= 8, String(res.subreqs));
});

test('stageSelloutRows: empty input is a no-op that reports zero subrequests', async () => {
  const { io, calls } = fakeIo();
  assert.deepEqual(await stageSelloutRows([], io), { subreqs: 0 });
  assert.equal(calls.length, 0);
});

test('parseReportHtml returns null (not a fused number) for a cell holding two numeric tokens', () => {
  const p = parseReportHtml(html.replace(/6,126/g, '6,126<br>7'));
  assert.equal(p.platforms.find(x => x.platform === 'national').atp_qty, null);
});

test('parseReportGrid throws on a D-n title in an unexpected shape (D-3 21/09/2026), not just a bad month', async () => {
  const rows = await readXlsxSheet(xlsxBytes);
  const mutated = structuredClone(rows);
  const titleRow = mutated[7];
  const col = Object.keys(titleRow).find(k => /^D-3 /.test(String(titleRow[k])));
  titleRow[col] = 'D-3 21/09/2026';
  assert.throws(() => parseReportGrid(mutated), /unrecognised D-n block title/);
});
