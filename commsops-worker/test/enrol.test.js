// H10/H12 — enrol() must throw (not silently ack) on transient read/insert failures so
// the queue retries instead of dropping the enrolment; dedup policy defaults must be
// safe (null/0 cooldown hours still runs the dedup check; unknown policy → safest default).
// Run: node test/enrol.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const J = require('../src/journeys.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const ENV = { JOURNEY_WORKFLOW: { create: async () => ({}) } };
const ACTIVE = { id: 'J', status: 'active', active_version: 1, reenrolment: 'once_while_active', reenrol_cooldown_hours: null };

(async () => {
  await t('journey READ failure → THROWS (queue retries), not journey_not_active', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/journeys?id=eq.')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(ENV, { journeyId: 'J', profileId: 'P' }), /journey_read_failed/);
  });

  await t('enrolment INSERT failure → THROWS', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };   // existence checks empty
    };
    await assert.rejects(() => J.enrol(ENV, { journeyId: 'J', profileId: 'P' }), /enrolment_insert_failed/);
  });

  await t('cooldown with null hours behaves as once_while_active (dedup check RUNS)', async () => {
    let existenceChecked = false;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [{ ...ACTIVE, reenrolment: 'cooldown', reenrol_cooldown_hours: null }] };
      if (path.includes('/enrolments') && (!opts.method || opts.method === 'GET')) { existenceChecked = true; return { ok: true, data: [{ id: 'E-existing' }] }; }
      return { ok: true, data: [] };
    };
    const r = await J.enrol(ENV, { journeyId: 'J', profileId: 'P' });
    assert.ok(existenceChecked, 'dedup existence check must run');
    assert.equal(r.ok, false);   // deduped, not double-enrolled
  });

  // ── S327: the failure-PATCH after a failed workflow start is load-bearing ──────────────
  // If it does not land, the enrolment stays 'active' with no Workflow instance. The throw
  // makes the queue retry enrol(), the retry's dedup matches status='active', and it ACKS as
  // skipped:'reenrolment_policy' — so the customer silently never gets the journey and every
  // future enrolment of that profile on that journey is blocked until the J1 max-duration
  // sweep expires the row, 3–30 days later.
  const FAILING_WF = { JOURNEY_WORKFLOW: { create: async () => { throw new Error('boom'); } } };

  await t('workflow start fails → enrolment is PATCHed to failed, then throws', async () => {
    let patched = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: true, data: [{ id: 'E1' }] };
      if (path.includes('/enrolments') && opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(FAILING_WF, { journeyId: 'J', profileId: 'P' }), /workflow_start_failed/);
    assert.equal(patched?.status, 'failed', 'the enrolment must be marked failed');
  });

  await t('a FAILING patch is RETRIED, and a later attempt succeeding is enough', async () => {
    let attempts = 0;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: true, data: [{ id: 'E1' }] };
      if (path.includes('/enrolments') && opts.method === 'PATCH') { attempts++; return { ok: attempts >= 2 }; }
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(FAILING_WF, { journeyId: 'J', profileId: 'P' }),
      /workflow_start_failed:/);
    assert.equal(attempts, 2, 'retried until it landed');
  });

  await t('patch fails EVERY time → error names the stuck enrolment, never a silent ack', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: true, data: [{ id: 'E-STUCK' }] };
      if (path.includes('/enrolments') && opts.method === 'PATCH') return { ok: false, status: 500 };
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(FAILING_WF, { journeyId: 'J', profileId: 'P' }),
      /workflow_start_failed_and_enrolment_stuck_active:E-STUCK/);
  });

  await t('a PATCH that REJECTS (transport) is caught, not surfaced as an unrelated throw', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: true, data: [{ id: 'E-STUCK' }] };
      if (path.includes('/enrolments') && opts.method === 'PATCH') throw new Error('socket hang up');
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(FAILING_WF, { journeyId: 'J', profileId: 'P' }),
      /workflow_start_failed_and_enrolment_stuck_active/);
  });

  await t("workflow 'already exists' is benign — no PATCH, no throw", async () => {
    let patchCalls = 0;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: true, data: [{ id: 'E1' }] };
      if (path.includes('/enrolments') && opts.method === 'PATCH') { patchCalls++; return { ok: true }; }
      return { ok: true, data: [] };
    };
    const ALREADY = { JOURNEY_WORKFLOW: { create: async () => { throw new Error('instance ALREADY exists'); } } };
    const r = await J.enrol(ALREADY, { journeyId: 'J', profileId: 'P' });
    assert.equal(r.ok, true);
    assert.equal(patchCalls, 0, 'a benign duplicate must not mark the enrolment failed');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
