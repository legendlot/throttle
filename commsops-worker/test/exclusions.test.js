// The shared exclusion block (S338b) — the reader campaigns and journeys both use, plus the
// server-side coercion saveJourney applies to what the UI sends.
// Run: node test/exclusions.test.js
//
// WHY THIS FILE EXISTS SEPARATELY from campaign-exclusions.test.js: those tests own the campaign
// fan-out's USE of the rules. These own the rules themselves, now that a second caller (the journey
// engine) reads them off a different table whose columns only happen to be named the same.
const assert = require('assert');
const EX = require('../src/exclusions.js');
const CAMP = require('../src/campaigns.js');
const { exclusionPatch } = require('../src/journeys.js');
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

t('exclusionArgs maps a row onto the RPC param names', () => {
  assert.deepEqual(EX.exclusionArgs({ exclude_segment_ids: [U1], exclude_campaign_ids: [U2], exclude_contacted_hours: 24 }),
    { p_exclude_segments: [U1], p_exclude_campaigns: [U2], p_exclude_contacted_hours: 24 });
});

t('a row predating the migration degrades to "no rules", never to undefined', () => {
  // `undefined` in the JSON body is dropped by JSON.stringify — PostgREST would then see a
  // MISSING argument rather than an empty one, which is a 404 on the RPC, not a no-op.
  assert.deepEqual(EX.exclusionArgs({}),
    { p_exclude_segments: [], p_exclude_campaigns: [], p_exclude_contacted_hours: null });
  assert.deepEqual(EX.exclusionArgs({ exclude_segment_ids: null, exclude_campaign_ids: 'nope' }),
    { p_exclude_segments: [], p_exclude_campaigns: [], p_exclude_contacted_hours: null });
});

t('campaigns.js still exports the same reader (the extraction changed no behaviour)', () => {
  assert.equal(CAMP.exclusionArgs, EX.exclusionArgs);
});

t('hasExclusions truth table — any one rule is enough, 0 hours is OFF', () => {
  const H = (o) => EX.hasExclusions(EX.exclusionArgs(o));
  assert.equal(H({}), false);
  assert.equal(H({ exclude_segment_ids: [U1] }), true);
  assert.equal(H({ exclude_campaign_ids: [U2] }), true);
  assert.equal(H({ exclude_contacted_hours: 24 }), true);
  // 0 and null both mean "rule off". A 0 read as "on" would ask the RPC for everyone contacted
  // in the last zero hours on every single send — a subrequest per step that can never exclude.
  assert.equal(H({ exclude_contacted_hours: 0 }), false);
  assert.equal(H({ exclude_contacted_hours: null }), false);
  assert.equal(H({ exclude_segment_ids: [], exclude_campaign_ids: [], exclude_contacted_hours: null }), false);
});

t('saveJourney coercion: uuids only, positive integer hours, everything else off', () => {
  assert.deepEqual(exclusionPatch({ exclude_segment_ids: [U1, U2], exclude_campaign_ids: [U1], exclude_contacted_hours: 24 }),
    { exclude_segment_ids: [U1, U2], exclude_campaign_ids: [U1], exclude_contacted_hours: 24 });
  // Non-uuids are DROPPED, not passed through: the columns are uuid[] and a junk member fails the
  // whole PATCH with a 22P02, silently losing the rest of the journey's settings with it.
  assert.deepEqual(exclusionPatch({ exclude_segment_ids: [U1, 'SEG-X', '', null, 7], exclude_campaign_ids: 'nope' }),
    { exclude_segment_ids: [U1], exclude_campaign_ids: [], exclude_contacted_hours: null });
  // '' (the UI's "Off" option), 0, a negative and a junk string all mean the rule is off.
  for (const v of ['', 0, -5, 'soon', null, undefined]) {
    assert.equal(exclusionPatch({ exclude_contacted_hours: v }).exclude_contacted_hours, null, `hours=${String(v)}`);
  }
  assert.equal(exclusionPatch({ exclude_contacted_hours: '48' }).exclude_contacted_hours, 48);
  assert.equal(exclusionPatch({ exclude_contacted_hours: 6.7 }).exclude_contacted_hours, 7);
});


// S338 hostile review — a settings-only save must not publish a byte-identical journey version.
{
  const J = require('../src/journeys.js');
  const a = { steps: { s1: { type: 'send', channel: 'whatsapp', on_skip: null }, s2: { type: 'end' } }, start: 's1' };
  const b = { start: 's1', steps: { s2: { type: 'end' }, s1: { on_skip: null, channel: 'whatsapp', type: 'send' } } };
  t('sameDefinition is key-order independent', () => assert.equal(J.sameDefinition(a, b), true));
  t('sameDefinition sees a real change', () => assert.equal(J.sameDefinition(a, { ...b, start: 's2' }), false));
  t('sameDefinition treats undefined vs null field as equal after a jsonb round-trip', () =>
    assert.equal(J.sameDefinition({ x: undefined, y: 1 }, { x: null, y: 1 }), true));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
