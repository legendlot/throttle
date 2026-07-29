// `trigger.requires_identifier` — the reachability precondition on journey enrolment.
//
// WHY IT EXISTS: a WhatsApp-only journey triggered by an anonymous browse event enrols a profile
// with no phone number, burns a Workflow instance + a 30-minute durable sleep, and only then
// skips at the send step. Measured 2026-07-29 on the add-to-cart journey: 1,525 pixel-triggered
// enrolments → 1,374 `no_phone_identifier` skips → 0 messages that ever reached a customer.
//
// Run: node test/trigger-reachability.test.js
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

// ── stub auth.js before ingest.js binds it ──────────────────────────────────────────────
const state = { journeys: [], idRows: [], idReadOk: true, idReads: 0, enqueued: [] };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './auth.js') return {
    enc: (s) => encodeURIComponent(s),
    sbComms: async (url, env, opts) => {
      if (url.startsWith('/rest/v1/rpc/resolve_identity')) return { ok: true, data: 'prof-1' };
      if (url.startsWith('/rest/v1/events')) {
        // event insert → return the created row; anything else (lookups) → empty
        if (opts && opts.method === 'POST') return { ok: true, data: [{ id: 'ev-1' }] };
        return { ok: true, data: [] };
      }
      if (url.startsWith('/rest/v1/journeys')) return { ok: true, data: state.journeys };
      if (url.startsWith('/rest/v1/identifiers')) {
        state.idReads++;
        return state.idReadOk ? { ok: true, data: state.idRows } : { ok: false, status: 500 };
      }
      if (url.startsWith('/rest/v1/profiles')) return { ok: true, data: [{ attributes: {} }] };
      if (url.startsWith('/rest/v1/enrolment_waits')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    },
  };
  return origLoad.apply(this, arguments);
};
const I = require('../src/ingest.js');
Module._load = origLoad;

const ENV = { BROADCAST_QUEUE: { send: async (m) => { state.enqueued.push(m); } } };
const reset = () => { state.idRows = []; state.idReadOk = true; state.idReads = 0; state.enqueued = []; };
const fire = () => I.ingest(ENV, {
  identifiers: [{ type: 'email', value: 'a@b.com' }], name: 'add_to_cart', properties: {},
});

(async () => {
  // ── the fix ───────────────────────────────────────────────────────────────────────────
  reset();
  state.journeys = [{ id: 'j1', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: 'phone' } }];
  state.idRows = [{ type: 'email' }];                       // anonymous browser: email only
  await fire();
  await t('unreachable profile is NOT enrolled', async () =>
    assert.strictEqual(state.enqueued.length, 0));

  reset();
  state.idRows = [{ type: 'email' }, { type: 'phone' }];
  await fire();
  await t('reachable profile IS enrolled', async () =>
    assert.strictEqual(state.enqueued.length, 1));

  // ── the precondition must not disturb journeys that don't declare it ──────────────────
  reset();
  state.journeys = [{ id: 'j1', trigger: { type: 'event', name: 'add_to_cart' } }];
  state.idRows = [];                                        // no identifiers at all
  await fire();
  await t('journey WITHOUT requires_identifier still enrols (purely additive)', async () => {
    assert.strictEqual(state.enqueued.length, 1);
    assert.strictEqual(state.idReads, 0, 'and pays no identifier lookup');
  });

  // ── fail OPEN: a transient read blip must not silently stop the funnel ────────────────
  reset();
  state.journeys = [{ id: 'j1', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: 'phone' } }];
  state.idReadOk = false;
  await fire();
  await t('identifier read failure fails OPEN (send gate re-checks anyway)', async () =>
    assert.strictEqual(state.enqueued.length, 1));

  // ── memoisation: one lookup regardless of how many journeys ask ───────────────────────
  reset();
  state.journeys = [
    { id: 'j1', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: 'phone' } },
    { id: 'j2', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: ['phone'] } },
    { id: 'j3', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: 'phone' } },
  ];
  state.idRows = [{ type: 'phone' }];
  await fire();
  await t('three requiring journeys cost exactly ONE identifier lookup', async () => {
    assert.strictEqual(state.enqueued.length, 3);
    assert.strictEqual(state.idReads, 1);
  });

  // ── any-of semantics ─────────────────────────────────────────────────────────────────
  reset();
  state.journeys = [{ id: 'j1', trigger: { type: 'event', name: 'add_to_cart', requires_identifier: ['phone', 'email'] } }];
  state.idRows = [{ type: 'email' }];
  await fire();
  await t('array form is ANY-of, not all-of', async () =>
    assert.strictEqual(state.enqueued.length, 1));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
