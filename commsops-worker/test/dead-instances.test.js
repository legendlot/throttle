// Dead-instance sweep (S397, 2026-09-22).
// Run: node test/dead-instances.test.js
//
// THE DEFECT: an enrolment row is 'active' from insert, and only the Workflow instance ever
// moves it on. An instance that errored (2026-08-26: PGRST106 at its first wait) or never
// existed (2026-09-13: create() returned, Cloudflare has no instance) leaves the row active
// forever, blocking `once_while_active` re-enrolment for that profile for up to 30 days.
//
// THE HAZARD THE SWEEP ITSELF INTRODUCES, and the reason for the probe_error tests: reading a
// transient probe failure as "gone" would kill LIVE journeys during a Cloudflare blip.
const assert = require('assert');
const DI = require('../src/dead-instances.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };
const enc = encodeURIComponent;
const NOW = Date.parse('2026-09-22T10:00:00Z');

// ── the query ────────────────────────────────────────────────────────────────────────────────
t('query is scoped to ACTIVE rows, bounded, oldest first', () => {
  const q = DI.buildSweepQuery(NOW, enc);
  assert.ok(q.startsWith('/rest/v1/enrolments?status=eq.active'), q);
  assert.ok(q.includes(`limit=${DI.PROBE_LIMIT}`), q);
  assert.ok(q.includes('order=enrolled_at.asc'), q);
});

t('query carries BOTH shapes: null-step after 1 h, any step after 24 h', () => {
  const q = decodeURIComponent(DI.buildSweepQuery(NOW, enc));
  assert.ok(q.includes('and(current_step.is.null,enrolled_at.lt.2026-09-22T09:00:00.000Z)'), q);
  assert.ok(q.includes(',enrolled_at.lt.2026-09-21T10:00:00.000Z)'), q);
});

t('a full tick of ids builds a PATCH URL under the 16 KB limit', () => {
  const ids = Array.from({ length: DI.PROBE_LIMIT }, () => '5487683f-b21c-4ed4-a0e7-1e52c8b99a82');
  const url = `/rest/v1/enrolments?id=in.(${ids.join(',')})&status=eq.active`;
  assert.ok(url.length < 16 * 1024, `${url.length} bytes`);
  assert.ok(DI.PROBE_LIMIT <= 50, 'probes are SERIAL binding calls inside the cron lock — keep the cap small');
});

// ── classify: the verdicts ───────────────────────────────────────────────────────────────────
t('errored → failed (the 2026-08-26 cohort)', () => {
  assert.deepStrictEqual(DI.classify({ found: true, status: 'errored' }), { dead: true, to: 'failed', why: 'instance_errored' });
});
t('terminated → failed', () => {
  assert.strictEqual(DI.classify({ found: true, status: 'terminated' }).to, 'failed');
});
t('not found → failed (the 2026-09-13 cohort), on either spelling of the INSTANCE error', () => {
  assert.strictEqual(DI.classify({ found: false, error: 'workflows.api.error.instance.not_found [code: 10400]' }).to, 'failed');
  assert.strictEqual(DI.classify({ found: false, error: 'Instance not found' }).to, 'failed');
});
t('THE HAZARD: a FLEET-level "not found" (binding / class rename) is NOT an instance verdict', () => {
  for (const err of ['Workflow JOURNEY_WORKFLOW not found', 'workflow not found', 'binding not found']) {
    assert.strictEqual(DI.classify({ found: false, error: err }).dead, false, err);
  }
});
t('complete with the row still active → ended_unknown, never an invented outcome', () => {
  assert.deepStrictEqual(DI.classify({ found: true, status: 'complete' }), { dead: true, to: 'ended_unknown', why: 'instance_complete_row_active' });
});

// ── the batch guard + the alert ──────────────────────────────────────────────────────────────
t('every candidate not-found above the floor → ABORT (that is the probe failing, not a cohort)', () => {
  assert.strictEqual(DI.shouldAbort({ why: { instance_not_found: 25 }, n: 25 }), true);
  assert.strictEqual(DI.shouldAbort({ why: { instance_not_found: 24, instance_errored: 1 }, n: 25 }), false, 'one other verdict = a real cohort');
  assert.strictEqual(DI.shouldAbort({ why: { instance_not_found: 5 }, n: 5 }), false, 'small batches may legitimately be all not-found');
  assert.strictEqual(DI.shouldAbort({ why: {}, n: 0 }), false);
});
t('alert at the bulk threshold, throttled to once an hour', () => {
  const now = NOW;
  assert.strictEqual(DI.shouldAlert({ swept: DI.ALERT_AT, lastAlertMs: 0, nowMs: now }), true);
  assert.strictEqual(DI.shouldAlert({ swept: DI.ALERT_AT - 1, lastAlertMs: 0, nowMs: now }), false);
  assert.strictEqual(DI.shouldAlert({ swept: 50, lastAlertMs: now - 10 * 60 * 1000, nowMs: now }), false, 'throttled');
  assert.strictEqual(DI.shouldAlert({ swept: 50, lastAlertMs: now - DI.ALERT_THROTTLE_MS, nowMs: now }), true);
  assert.ok(DI.alertText({ swept: 12, why: { instance_errored: 12 } }).includes('12 enrolments'));
});

// ── classify: the things it must NOT touch ───────────────────────────────────────────────────
t('every live status is left alone', () => {
  for (const s of ['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'unknown']) {
    assert.strictEqual(DI.classify({ found: true, status: s }).dead, false, s);
  }
});
t('THE HAZARD: a probe error that is not a not-found is NOT a verdict', () => {
  for (const err of ['fetch failed', 'HTTP 503', 'timeout', '', undefined]) {
    const c = DI.classify({ found: false, error: err });
    assert.strictEqual(c.dead, false, `error "${err}" must not sweep`);
    assert.strictEqual(c.why, 'probe_error');
  }
});
t('an unrecognised future status fails SAFE (alive)', () => {
  assert.strictEqual(DI.classify({ found: true, status: 'hibernating' }).dead, false);
});
t('a missing probe is alive', () => {
  assert.strictEqual(DI.classify(undefined).dead, false);
  assert.strictEqual(DI.classify(null).dead, false);
});

// ── plan: grouping for the batched PATCH ─────────────────────────────────────────────────────
t('plan groups ids by target status and counts every reason', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
  const probes = {
    a: { found: true, status: 'errored' },
    b: { found: false, error: 'instance.not_found' },
    c: { found: true, status: 'complete' },
    d: { found: true, status: 'waiting' },
    e: { found: false, error: 'HTTP 502' },
  };
  const p = DI.plan(rows, probes);
  assert.deepStrictEqual(p.byStatus, { failed: ['a', 'b'], ended_unknown: ['c'] });
  assert.strictEqual(p.alive, 2);
  assert.deepStrictEqual(p.why, { instance_errored: 1, instance_not_found: 1, instance_complete_row_active: 1, instance_waiting: 1, probe_error: 1 });
});

t('patch body writes status + ended_at only — never context, never current_step', () => {
  assert.deepStrictEqual(DI.patchBody('failed', '2026-09-22T10:00:00.000Z'), { status: 'failed', ended_at: '2026-09-22T10:00:00.000Z' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
