// Unit tests for WA/email sender routing (pickSender) — the P1 fix that stops the
// oldest-active-row-wins mis-route (txn/support sends exiting the wrong number).
// Run: node test/sender-routing.test.js   (Node 18+)
// Pure-function coverage; no network.

const assert = require('assert');
const { pickSender } = require('../src/send.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

// helper: rows are oldest-first (as the DB query returns them)
const S = (id, purpose) => ({ id, purpose, status: 'active' });

// ── today's live state: zero behaviour change ──
t('email: single "all" sender matches every purpose', () => {
  const rows = [S('email1', 'all')];
  assert.equal(pickSender(rows, { purpose: 'marketing' })?.id, 'email1');
  assert.equal(pickSender(rows, { purpose: 'transactional' })?.id, 'email1');
  assert.equal(pickSender(rows, { purpose: 'utility' })?.id, 'email1');
});

t('WA today: lone sandbox (transactional) resolves for any purpose', () => {
  const rows = [S('sandbox', 'transactional')];
  assert.equal(pickSender(rows, { purpose: 'transactional' })?.id, 'sandbox'); // exact
  assert.equal(pickSender(rows, { purpose: 'marketing' })?.id, 'sandbox');     // single-sender fallback
  assert.equal(pickSender(rows, { purpose: 'utility' })?.id, 'sandbox');       // single-sender fallback
});

// ── the bug this fixes: multiple active senders, purpose routes correctly ──
t('cutover: purpose routes to its own sender, NOT the oldest', () => {
  // sandbox is OLDEST — pre-fix it would win for every purpose.
  const rows = [S('sandbox', 'transactional'), S('marketing', 'marketing'), S('support', 'utility')];
  assert.equal(pickSender(rows, { purpose: 'marketing' })?.id, 'marketing');
  assert.equal(pickSender(rows, { purpose: 'utility' })?.id, 'support');
  assert.equal(pickSender(rows, { purpose: 'transactional' })?.id, 'sandbox');
});

t('no silent mis-route: multiple senders, no purpose match → null (visible fail)', () => {
  const rows = [S('marketing', 'marketing'), S('support', 'utility')];
  // 'transactional' has no home yet and there is no wildcard → refuse, do not pick oldest.
  assert.equal(pickSender(rows, { purpose: 'transactional' }), null);
});

// ── precedence rules ──
t('explicit senderId pins the row', () => {
  const rows = [S('a', 'marketing'), S('b', 'utility')];
  assert.equal(pickSender(rows, { purpose: 'marketing', senderId: 'b' })?.id, 'b');
});

t('explicit senderId not active on channel → null (no fallback)', () => {
  const rows = [S('a', 'marketing')];
  assert.equal(pickSender(rows, { purpose: 'marketing', senderId: 'ghost' }), null);
});

t('exact purpose beats a wildcard "all" sender', () => {
  const rows = [S('wild', 'all'), S('mkt', 'marketing')];
  assert.equal(pickSender(rows, { purpose: 'marketing' })?.id, 'mkt');
});

t('wildcard "all" used when no exact purpose match', () => {
  const rows = [S('wild', 'all'), S('mkt', 'marketing')];
  assert.equal(pickSender(rows, { purpose: 'transactional' })?.id, 'wild');
});

t('null/empty purpose on a sender is treated as wildcard', () => {
  assert.equal(pickSender([S('a', null)], { purpose: 'marketing' })?.id, 'a');
  assert.equal(pickSender([S('a', '')], { purpose: 'utility' })?.id, 'a');
});

t('oldest wins among same-purpose senders (deterministic tiebreak)', () => {
  const rows = [S('old', 'marketing'), S('new', 'marketing')];
  assert.equal(pickSender(rows, { purpose: 'marketing' })?.id, 'old');
});

// ── empties ──
t('no active senders → null', () => {
  assert.equal(pickSender([], { purpose: 'marketing' }), null);
  assert.equal(pickSender(null, { purpose: 'marketing' }), null);
});

// ── WABA-scoping (added when the three live numbers got sender rows) ──
// A WhatsApp template approved on WABA A does not exist on WABA B. Sending it from a number on
// B is rejected by Meta as an unknown template, so the template's WABA must outrank purpose.
const W = (id, purpose, waba) => ({ id, purpose, status: 'active', metadata: { waba_id: waba } });

t('WA: template WABA wins over purpose', () => {
  const rows = [W('mkt', 'marketing', 'A'), W('txn', 'transactional', 'B')];
  // a marketing-purpose send whose template lives on B must NOT go out of the marketing number
  assert.equal(pickSender(rows, { purpose: 'marketing', wabaId: 'B' })?.id, 'txn');
  assert.equal(pickSender(rows, { purpose: 'transactional', wabaId: 'A' })?.id, 'mkt');
});

t('WA: no sender on the template\'s WABA refuses rather than mis-routing', () => {
  const rows = [W('mkt', 'marketing', 'A'), W('txn', 'transactional', 'B')];
  assert.equal(pickSender(rows, { purpose: 'marketing', wabaId: 'C' }), null);
});

t('WA: purpose still decides WITHIN the right WABA', () => {
  const rows = [W('a1', 'marketing', 'A'), W('a2', 'transactional', 'A')];
  assert.equal(pickSender(rows, { purpose: 'transactional', wabaId: 'A' })?.id, 'a2');
});

t('WA: no wabaId (email, or a template with none) keeps the old purpose routing', () => {
  const rows = [W('mkt', 'marketing', 'A'), W('txn', 'transactional', 'B')];
  assert.equal(pickSender(rows, { purpose: 'transactional' })?.id, 'txn');
});

t('WA: explicit senderId still overrides the WABA filter', () => {
  const rows = [W('mkt', 'marketing', 'A'), W('txn', 'transactional', 'B')];
  assert.equal(pickSender(rows, { senderId: 'mkt', wabaId: 'B' })?.id, 'mkt');
});


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
