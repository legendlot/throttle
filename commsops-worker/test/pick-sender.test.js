// Unit tests for the H5 pickSender fixes: WABA scoping outranks an explicit senderId pin,
// waba_id compare is type-coerced (number vs string), and the single-sender fallback is
// judged on the PRE-filter channel count, not the WABA-narrowed count.
// Run: node test/pick-sender.test.js   (Node 18+)
const assert = require('assert');
const { pickSender } = require('../src/send.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const S = (id, purpose, waba) => ({ id, purpose, metadata: waba ? { waba_id: waba } : {} });

(async () => {
  await t('senderId pin on the WRONG WABA → null (refuse), never mis-route', () =>
    assert.strictEqual(pickSender([S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2')],
      { senderId: 'a', wabaId: 'W2' }), null));

  await t('senderId pin on the right WABA → picked', () =>
    assert.equal(pickSender([S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2')],
      { senderId: 'b', wabaId: 'W2' }).id, 'b'));

  await t('waba compare is type-coerced (number vs string)', () =>
    assert.equal(pickSender([{ id: 'a', purpose: 'utility', metadata: { waba_id: 1234567890 } }],
      { purpose: 'utility', wabaId: '1234567890' }).id, 'a'));

  await t('single-sender fallback judged on PRE-filter count: 3 channel senders, wrong-purpose template on W2 → refuse', () =>
    assert.strictEqual(pickSender(
      [S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2'), S('c', 'utility', 'W3')],
      { purpose: 'marketing', wabaId: 'W2' }), null));

  await t('genuinely single channel sender still falls back', () =>
    assert.equal(pickSender([S('a', 'transactional', 'W2')], { purpose: 'marketing', wabaId: 'W2' }).id, 'a'));

  // ── 2026-07-28: WABA-narrowed-to-one now routes (the recurring no_sender_on_waba) ──────
  // Templates/journey steps carry Meta's category ('utility'); sender rows carry a routing
  // label ('transactional'). Neither the exact-purpose nor the wildcard branch matches, and
  // the pre-filter count is >1 as soon as a second number exists — so every WABA-pinned
  // template failed to route even though its WABA had exactly one valid sender.
  const FLEET = () => [
    S('sandbox', 'all', 'Wsand'), S('txn_old', 'transactional', 'Wold'),
    S('txn', 'transactional', 'Wtxn'), S('mkt', 'marketing', 'Wmkt'), S('sup', 'utility', 'Wsup'),
  ];

  await t('utility template on a transactional-purpose sender, alone on its WABA → routes (was null)', () =>
    assert.equal(pickSender(FLEET(), { purpose: 'utility', wabaId: 'Wtxn' }).id, 'txn'));

  await t('transactional purpose (sendTest default) on the same sender → routes', () =>
    assert.equal(pickSender(FLEET(), { purpose: 'transactional', wabaId: 'Wtxn' }).id, 'txn'));

  await t('no purpose at all on a WABA with one sender → routes', () =>
    assert.equal(pickSender(FLEET(), { wabaId: 'Wtxn' }).id, 'txn'));

  await t('CARVE-OUT: marketing send on a non-marketing sender → still refuses', () =>
    assert.strictEqual(pickSender(FLEET(), { purpose: 'marketing', wabaId: 'Wtxn' }), null));

  await t('marketing send on the marketing WABA → unchanged', () =>
    assert.equal(pickSender(FLEET(), { purpose: 'marketing', wabaId: 'Wmkt' }).id, 'mkt'));

  await t('marketing send on a WILDCARD sender alone on its WABA → allowed (explicitly opted in)', () =>
    assert.equal(pickSender(FLEET(), { purpose: 'marketing', wabaId: 'Wsand' }).id, 'sandbox'));

  await t('WABA with TWO senders and no purpose match → still refuses (genuinely ambiguous)', () =>
    assert.strictEqual(pickSender(
      [S('a', 'transactional', 'W1'), S('b', 'transactional', 'W1'), S('c', 'marketing', 'W2')],
      { purpose: 'marketing', wabaId: 'W1' }), null));

  await t('unknown WABA → still refuses (never invent a sender)', () =>
    assert.strictEqual(pickSender(FLEET(), { purpose: 'utility', wabaId: 'Wnope' }), null));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
