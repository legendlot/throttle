// A/B statistics + refusal states (S272). Pure. This is the most correctness-critical code in the
// feature, which is exactly why it lives here and not in PL/pgSQL (no SQL test harness in this repo).
const assert = require('assert');
const { mde, verdict, MATURITY_HOURS } = require('../src/ab-stats.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// arm helper. preSendFailed = failed BEFORE the send (render/gate) — never entered `sent`.
// providerFailed = failed AFTER the send (wa_131049 etc) — inside `sent`, contributes 0 reads.
const arm = (label, sent, read, delivered = null, preSendFailed = 0, providerFailed = 0) => ({
  label, sent, read,
  delivered: delivered === null ? Math.round(sent * 0.7) : delivered,
  preSendFailed, providerFailed,
  assigned: sent + preSendFailed,
});

const MATURE = { hoursSinceSent: 24 };

t('MDE falls as n rises', () => {
  assert.ok(mde(0.4, 400) > mde(0.4, 800));
  assert.ok(mde(0.4, 800) > mde(0.4, 2127));
});

t('MDE matches the spec curve at p=0.40 (within 0.3pp)', () => {
  assert.ok(Math.abs(mde(0.4, 2127) - 4.2) < 0.3, `got ${mde(0.4, 2127)}`);
  assert.ok(Math.abs(mde(0.4, 800)  - 6.9) < 0.3, `got ${mde(0.4, 800)}`);
  assert.ok(Math.abs(mde(0.4, 400)  - 9.7) < 0.3, `got ${mde(0.4, 400)}`);
});

t('mde(0) and mde(_,0) are safe, not NaN', () => {
  assert.ok(Number.isFinite(mde(0.4, 0)) || mde(0.4, 0) === null);
  assert.ok(Number.isFinite(mde(0, 100)) || mde(0, 100) === null);
});

t('identical arms → too_close (NOT underpowered — there is no gap to be underpowered about)', () => {
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 800)], MATURE);
  assert.equal(v.state, 'too_close');
  assert.equal(v.winner, null);
});

t('a visible gap below the MDE → underpowered, which is a different message from too_close', () => {
  // 2.5pp apart on 2,000 per arm: real-looking, not significant, and below the ~4.3pp MDE.
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 850)], MATURE);
  assert.equal(v.state, 'underpowered');
  assert.ok(/bigger send/.test(v.reason), `expected a sample-size explanation, got: ${v.reason}`);
});

t('big gap on a big sample → a winner, and it names the right arm', () => {
  const v = verdict([arm('A', 2000, 700), arm('B', 2000, 900)], MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'B');
});

// ⚠️ THE 244-PERSON TRAP — the whole reason the guardrail exists. A 5pt gap on a tiny sample
// must NOT be called, however tempting it looks on screen.
t('big gap on a TINY sample → still refuses', () => {
  const v = verdict([arm('A', 122, 70), arm('B', 122, 76)], MATURE);
  assert.notEqual(v.state, 'winner');
  assert.equal(v.winner, null);
});

t('immature result refuses regardless of the gap', () => {
  const v = verdict([arm('A', 2000, 700), arm('B', 2000, 900)], { hoursSinceSent: 1 });
  assert.equal(v.state, 'immature');
  assert.equal(v.winner, null);
});

t('asymmetric PRE-SEND failures refuse — a biased sample, not a small one', () => {
  // B's template referenced a variable A's did not, so B failed to render for a non-random group.
  const v = verdict([arm('A', 2000, 700, 1400, 50), arm('B', 2000, 900, 1400, 600)], MATURE);
  assert.equal(v.state, 'asymmetric_failures');
  assert.equal(v.winner, null);
});

// ⚠️ THE MIRROR TEST, and the one that pins the correction. Post-send provider failures
// (wa_131049) live INSIDE `sent` and contribute zero reads, so ITT already prices them in. An
// earlier draft refused here — which would have refused in exactly the case the answer is real.
t('asymmetric POST-SEND provider failures do NOT refuse — they are the treatment effect', () => {
  const v = verdict([arm('A', 2000, 900, 1400, 0, 40), arm('B', 2000, 700, 1400, 0, 500)], MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'A');
  assert.equal(v.providerFailuresDiffer, true, 'must still be FLAGGED, just not refused');
});

t('more than two arms refuses rather than silently comparing the first two', () => {
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 900), arm('C', 2000, 700)], MATURE);
  assert.equal(v.state, 'too_many_arms');
  assert.equal(v.winner, null);
});

t('accepts snake_case straight from the RPC as well as camelCase', () => {
  const rpc = [
    { label: 'A', assigned: 2000, sent: 2000, delivered: 1400, read_count: 700, pre_send_failed: 0, provider_failed: 0 },
    { label: 'B', assigned: 2000, sent: 2000, delivered: 1400, read_count: 900, pre_send_failed: 0, provider_failed: 0 },
  ];
  const v = verdict(rpc, MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'B');
});

t('fewer than two arms is not a test', () => {
  assert.equal(verdict([arm('A', 2000, 800)], MATURE).state, 'not_a_test');
  assert.equal(verdict([], MATURE).state, 'not_a_test');
});

t('zero sent does not divide by zero', () => {
  const v = verdict([arm('A', 0, 0, 0), arm('B', 0, 0, 0)], MATURE);
  assert.ok(['not_a_test', 'too_close', 'underpowered'].includes(v.state));
  assert.ok(Number.isFinite(v.arms[0].readRate) || v.arms[0].readRate === null);
});

t('every verdict carries a plain-English reason a marketer can act on', () => {
  for (const v of [
    verdict([arm('A', 2000, 800), arm('B', 2000, 800)], MATURE),
    verdict([arm('A', 122, 70), arm('B', 122, 76)], MATURE),
    verdict([arm('A', 2000, 700), arm('B', 2000, 900)], { hoursSinceSent: 1 }),
  ]) {
    assert.ok(typeof v.reason === 'string' && v.reason.length > 20, `weak reason: ${v.reason}`);
  }
});

t('the primary rate is read/sent (ITT), not read/delivered', () => {
  // 1000 sent, 500 delivered, 400 read → ITT 40%, delivered-based would be 80%
  const v = verdict([arm('A', 1000, 400, 500), arm('B', 1000, 400, 500)], MATURE);
  assert.ok(Math.abs(v.arms[0].readRate - 0.4) < 1e-9, `got ${v.arms[0].readRate}`);
  assert.ok(Math.abs(v.arms[0].readRateOfDelivered - 0.8) < 1e-9);
});

t('a significant per-arm DELIVERY difference is flagged even when the verdict stands', () => {
  const a = { label: 'A', sent: 2000, read: 700, delivered: 1000, failed: 0 };
  const b = { label: 'B', sent: 2000, read: 900, delivered: 1600, failed: 0 };
  const v = verdict([a, b], MATURE);
  assert.equal(v.deliveryDiffers, true);
});

t('MATURITY_HOURS is 4, from the p80 read latency of 3.6h', () => assert.equal(MATURITY_HOURS, 4));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
