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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
