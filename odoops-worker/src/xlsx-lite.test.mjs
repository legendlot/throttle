// src/xlsx-lite.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsxSheet, unzipEntries } from './xlsx-lite.mjs';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/flipkart-report-2026-09-22.xlsx', import.meta.url)));

test('readXlsxSheet reads the report title, the summary rows, headers and the TOTAL row', async () => {
  const rows = await readXlsxSheet(bytes);
  assert.ok(rows[1].A.startsWith('L.O.T CARS x Flipkart'), rows[1].A);
  assert.equal(rows[3].B, 6126);
  assert.equal(rows[8].A, 'FSN');
  assert.equal(rows[36].A, 'TOTAL (27 FSNs)');
});

test('readXlsxSheet decodes shared-string entities (&amp; -> &)', async () => {
  const rows = await readXlsxSheet(bytes);
  assert.ok(rows[21].B.includes('Modes & Multi'), rows[21].B);
});

test('unzipEntries lists the xlsx package entries', async () => {
  const entries = await unzipEntries(bytes);
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  assert.ok(entries.has('xl/sharedStrings.xml'));
});

test('readXlsxSheet throws on a non-zip buffer', async () => {
  await assert.rejects(() => readXlsxSheet(new Uint8Array([1, 2, 3, 4, 5])), /not a zip file/);
});
