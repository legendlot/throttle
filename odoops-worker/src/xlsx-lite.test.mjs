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

// ---- hand-built archives (stored entries, CRC unchecked by the reader) for the edge cases the fixture cannot show
function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], cen = [];
  let off = 0;
  const u16 = n => [n & 255, (n >> 8) & 255], u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of Object.entries(entries)) {
    const nb = enc.encode(name), db = enc.encode(text);
    const loc = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(db.length), ...u32(db.length), ...u16(nb.length), ...u16(0), ...nb, ...db]);
    cen.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(db.length), ...u32(db.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...nb]));
    parts.push(loc); off += loc.length;
  }
  const cenOff = off, cenLen = cen.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(cen.length), ...u16(cen.length), ...u32(cenLen), ...u32(cenOff), ...u16(0)]);
  const all = new Uint8Array(off + cenLen + 22);
  let p = 0;
  for (const b of [...parts, ...cen, eocd]) { all.set(b, p); p += b.length; }
  return all;
}
const sheetWrap = inner => `<?xml version="1.0"?><worksheet><sheetData>${inner}</sheetData></worksheet>`;

test('readXlsxSheet keeps an out-of-range numeric entity verbatim instead of throwing RangeError', async () => {
  const z = makeZip({
    'xl/sharedStrings.xml': '<sst><si><t>a&#x110000;b</t></si><si><t>&#65;</t></si></sst>',
    'xl/worksheets/sheet1.xml': sheetWrap('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'),
  });
  const rows = await readXlsxSheet(z);
  assert.equal(rows[1].A, 'a&#x110000;b');
  assert.equal(rows[1].B, 'A');
});

test('readXlsxSheet derives the row number from the cell refs when <row> has no r= attribute', async () => {
  const z = makeZip({ 'xl/worksheets/sheet1.xml': sheetWrap('<row><c r="A3" t="inlineStr"><is><t>hi</t></is></c><c r="B3"><v>7</v></c></row>') });
  const rows = await readXlsxSheet(z);
  assert.equal(rows[3].A, 'hi');
  assert.equal(rows[3].B, 7);
});

test('readXlsxSheet does not let an empty self-closed <row/> swallow the row after it', async () => {
  const z = makeZip({ 'xl/worksheets/sheet1.xml': sheetWrap('<row r="1"/><row r="2"><c r="A2"><v>2</v></c></row>') });
  const rows = await readXlsxSheet(z);
  assert.equal(rows[1], undefined);
  assert.equal(rows[2].A, 2);
});

test('readXlsxSheet resolves a <sheet …></sheet> (non-self-closing) workbook entry through the rels', async () => {
  const z = makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Report" sheetId="1" r:id="rId9"></sheet></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId9" Type="x" Target="worksheets/custom.xml"></Relationship></Relationships>',
    'xl/worksheets/custom.xml': sheetWrap('<row r="1"><c r="A1"><v>42</v></c></row>'),
  });
  const rows = await readXlsxSheet(z);
  assert.equal(rows[1].A, 42);
});

test('unzipEntries names zip64 instead of failing with a DataView RangeError', async () => {
  const z = makeZip({ 'xl/worksheets/sheet1.xml': sheetWrap('') });
  z.set([0xff, 0xff, 0xff, 0xff], z.length - 6); // EOCD central-directory offset -> the zip64 sentinel
  await assert.rejects(() => unzipEntries(z), /zip64 archives are not supported/);
});
