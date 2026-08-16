// handleTrustsignalSms — DLR → message status + DND suppression.
//
// The load-bearing test here is the suppression ADDRESS. gate.js:93 matches
// `value=eq.<the address being sent to>`, which is canonical E.164. We send BARE 10 DIGITS to
// /v1/sms, so anything the vendor echoes back is bare-10 or 919876543210 — a suppression written
// from the callback would sit in the list looking correct and block nothing, forever.
// Run: node test/trustsignal-sms-webhook.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const { handleTrustsignalSms } = require('../src/webhooks.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

// Record every PostgREST call and answer message lookups from `row`.
function stub(row) {
  const calls = [];
  A.sbComms = async (path, env, opts) => {
    calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null,
                 headers: opts?.headers || null });
    if (path.startsWith('/rest/v1/messages?provider_message_id=')) return { ok: true, data: row ? [row] : [] };
    return { ok: true, data: [] };
  };
  return calls;
}
const orig = A.sbComms;
const MSG = { id: 'm1', status: 'sent', to_address: '+919876543210', profile_id: 'p1', channel: 'sms' };

(async () => {
  // ── delivered ──
  let calls = stub(MSG);
  await handleTrustsignalSms({}, { transaction_id: 'TX1', status: 'delivered', dlrt: '2026-08-03T10:15:03Z' });
  t('a delivered DLR PATCHes the row to delivered and stamps delivered_at', () => {
    const p = calls.find((c) => c.method === 'PATCH');
    assert.ok(p, 'expected a PATCH');
    assert.strictEqual(p.body.status, 'delivered');
    assert.strictEqual(p.body.delivered_at, '2026-08-03T10:15:03Z');
  });
  t('a delivered DLR writes NO suppression', () => {
    assert.ok(!calls.some((c) => c.path.includes('/suppressions')));
  });

  // ── DND ──
  calls = stub(MSG);
  await handleTrustsignalSms({}, { transaction_id: 'TX3', status: 'dnd', to: '9876543210' });
  const sup = () => calls.find((c) => c.path.includes('/suppressions'));
  t('a DND DLR writes an sms suppression', () => {
    assert.ok(sup(), 'expected a suppressions write');
    assert.strictEqual(sup().body.channel, 'sms');
    assert.strictEqual(sup().body.reason, 'dnd');
  });
  t('the suppression value is the canonical E.164 the GATE will query, not the callback echo', () => {
    // The payload said 9876543210. Storing that would never match gate.js's +919876543210.
    assert.strictEqual(sup().body.value, '+919876543210');
  });
  t('the suppression carries the profile id from our own row', () => {
    assert.strictEqual(sup().body.profile_id, 'p1');
  });
  t('it upserts on (channel,value) — a second DND for the same number must not 409', () => {
    assert.ok(sup().path.includes('on_conflict=channel,value'));
    assert.ok(/merge-duplicates/.test(sup().headers?.Prefer || ''));
  });
  t('a DND DLR also fails the message', () => {
    const p = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(p.body.status, 'failed');
  });

  // ── forward-only ──
  calls = stub({ ...MSG, status: 'delivered' });
  await handleTrustsignalSms({}, { transaction_id: 'TX1', status: 'submitted' });
  t('a late `submitted` never regresses a delivered row', () => {
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  // ── unknown id ──
  calls = stub(null);
  await handleTrustsignalSms({}, { transaction_id: 'NOPE', status: 'delivered' });
  t('an unknown transaction_id is ignored — never creates a row', () => {
    assert.ok(!calls.some((c) => c.method === 'PATCH' || c.method === 'POST'));
  });

  // ── unknown status ──
  calls = stub(MSG);
  await handleTrustsignalSms({}, { transaction_id: 'TX9', status: 'martian' });
  t('an unrecognised status writes nothing rather than throwing', () => {
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  // ── DND on a row with no to_address ──
  calls = stub({ ...MSG, to_address: null });
  await handleTrustsignalSms({}, { transaction_id: 'TX3', status: 'dndcf', to: '9876543210' });
  t('no to_address → no suppression written, rather than one that cannot match', () => {
    assert.ok(!calls.some((c) => c.path.includes('/suppressions')));
  });

  await t('a click emits link_clicked and upgrades the row to clicked (S290)', async () => {
    const calls = stub({ ...MSG, status: 'delivered' });
    await handleTrustsignalSms({}, {
      transaction_id: 'tx1', final_url: 'https://x/y', created_at: '2026-08-17T00:00:00Z',
    });
    const ev = calls.find((c) => c.path.startsWith('/rest/v1/events'));
    assert.ok(ev, 'no link_clicked insert');
    assert.strictEqual(ev.body.name, 'link_clicked');
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.body.status, 'clicked');
  });

  await t("a late DLR does not regress a clicked row (clicked is DLR-terminal)", async () => {
    const calls = stub({ ...MSG, status: 'clicked' });
    await handleTrustsignalSms({}, { transaction_id: 'tx1', status: 'delivered', dlrt: 'T' });
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'regressed clicked → delivered');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
