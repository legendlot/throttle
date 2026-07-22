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

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
