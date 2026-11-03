import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRejectLines, groupReasons } from '../src/lib/bulkReject.mjs';

test('comma and spreadsheet columns both parse, code upper-cased', () => {
  assert.deepEqual(parseRejectLines('lot-00000001, Paint chipped\nLOT-00000002\tTop scratch').map(l => [l.code, l.reason, l.problem]),
    [['LOT-00000001', 'Paint chipped', null], ['LOT-00000002', 'Top scratch', null]]);
});

test('a line with no reason takes the common one, blank lines are ignored', () => {
  const [a, ...rest] = parseRejectLines('LOT-00000001\n\n  \n', 'Sticker damage');
  assert.equal(a.reason, 'Sticker damage');
  assert.equal(a.problem, null);
  assert.equal(rest.length, 0);
  assert.match(parseRejectLines('LOT-00000001')[0].problem, /no reason/);
});

test('a QC result column is refused, a real reason containing the word is not', () => {
  for (const r of ['Pass', 'passed', 'OK', 'Good', 'fine', 'QC Pass', 'qc passed.'])
    assert.ok(parseRejectLines(`LOT-00000001\t${r}`)[0].problem, r);
  assert.equal(parseRejectLines('LOT-00000001, Good paint but cracked roof')[0].problem, null);
});

test('a clean result in any column is refused, in any wording', () => {
  for (const l of ['LOT-00000001\tFlare Race Grey\tPass', 'LOT-00000001, Flare Race Grey, OK', 'LOT-00000001\t"Pass"',
    'LOT-00000001\tPassed QC', 'LOT-00000001\tNo issue', 'LOT-00000001\tN/A', 'LOT-00000001\tNil', 'LOT-00000001\tApproved'])
    assert.match(parseRejectLines(l)[0].problem, /says the unit passed/, l);
  assert.equal(parseRejectLines('LOT-00000001\tFlare Race Grey\tPaint chipped')[0].problem, null);
  assert.equal(parseRejectLines('LOT-00000001, No issue with paint but roof cracked')[0].problem, null);
});

test('a second label on the line is refused', () => {
  for (const l of ['LOT-00000001, LOT-00000002, paint', 'LOT-00000001\tLOT-00000002', 'LOT-00000001 is fine but LOT00000002 has a chip'])
    assert.match(parseRejectLines(l)[0].problem, /more than one label/, l);
});

test('reasons group biggest first', () => {
  assert.deepEqual(groupReasons(parseRejectLines('A1, Paint\nA2, Paint\nA3, Scratch')), [['Paint', 2], ['Scratch', 1]]);
});
