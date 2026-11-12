import test from 'node:test';
import assert from 'node:assert/strict';
import { normEmail, refusedImportPayload, importDirectoryCandidates } from '../src/index.js';

// mgrDisagrees and its S369 tests went with the move tiers (J1b D10: Podium pushes the manager to Google).

test('normEmail folds blanks to null and never throws on odd input', () => {
  assert.equal(normEmail('  A@B.com '), 'a@b.com');
  for (const blank of [null, undefined, '', '   ']) assert.equal(normEmail(blank), null);
  assert.equal(normEmail(42), '42');
});

// ── J1b D10: Podium owns department / manager / org unit — the import may not write Google's values back ──
const HR = { userId: '44444444-5555-4666-8777-888888888888', permissions: { podium_view: true, podium_hr: true } };
const ENV = { SUPABASE_URL: 'https://db.invalid', GOOGLE_SA_JSON: '{}', GOOGLE_ADMIN_IMPERSONATE_EMAIL: 'admin@x.com' };
const EMP = '55555555-6666-4777-8888-999999999999';

async function callImport(data) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('no network in tests'); };
  try {
    const res = await importDirectoryCandidates({ action: 'importDirectoryCandidates', data }, HR, ENV);
    return { status: res.status, body: await res.json(), calls };
  } finally { globalThis.fetch = real; }
}

test('J1b: update[] is refused server-side, before any read or write', async () => {
  const r = await callImport({ update: [{ id: EMP, department_id: null, manager_id: null, org_unit: '/Team A' }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'podium_owns_these_fields');
  assert.deepEqual(r.calls, [], 'nothing reached the database or Google');
});

test('J1b: dismiss[] and baseline[] are refused too', async () => {
  for (const data of [{ dismiss: [{ id: EMP, org_unit: '/Team A' }] }, { baseline: [{ id: EMP, org_unit: '/Team A' }] }]) {
    const r = await callImport(data);
    assert.equal(r.status, 400, JSON.stringify(data));
    assert.equal(r.body.error, 'podium_owns_these_fields');
    assert.deepEqual(r.calls, []);
  }
});

test('J1b: an exit list is still refused with the X1 code (it wins over update[])', async () => {
  const r = await callImport({ exit: [{ id: EMP }], update: [{ id: EMP }] });
  assert.equal(r.body.error, 'exits_are_recorded_in_podium');
  assert.deepEqual(r.calls, []);
});

test('J1b: empty lists (an old client sending update: []) are not a refusal', async () => {
  const r = await callImport({ create: [], ignore: [], update: [], dismiss: [], baseline: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { created: [], ignored: [], errors: [] });
});

test('refusedImportPayload: the pure rule', () => {
  assert.equal(refusedImportPayload({}), null);
  assert.equal(refusedImportPayload(null), null);
  assert.equal(refusedImportPayload({ update: 'x' }), null, 'not a list → nothing to apply');
  assert.equal(refusedImportPayload({ update: [{}] }), 'podium_owns_these_fields');
  assert.equal(refusedImportPayload({ exit: [{}] }), null, 'exit[] is the X1 guard in the handler, not this rule');
});
