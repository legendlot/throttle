// Unit tests for the C2P late-confirm repair (S297).
// Run: node test/c2p-late-confirm.test.js   (pure; all I/O stubbed)
//
// The invariant these protect: this module writes to LIVE customer orders on Shopify off an
// inbound webhook, so the dangerous failure is not "the repair didn't run" — it is the repair
// running on an order it had no business touching. Two cases carry that risk and both are
// asserted below: a customer who confirmed INSIDE the window (no no-response tag → must be
// left completely alone) and an order that is already cancelled (must be flagged for a human,
// never quietly re-tagged as confirmed).
const assert = require('assert');
const A = require('../src/auth.js');
const SH = require('../src/shopify.js');
const AL = require('../src/alerts.js');
const C2P = require('../src/c2p-late-confirm.js');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function run() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const ENV = { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't' };
const PROFILE = '41bae11c-0078-468c-ba51-118e6c27f2ce';
const RECENT = new Date(Date.now() - 3600000).toISOString();

// Stub harness: records every Shopify mutation so the assertions can be about EFFECTS.
function install({ enrolments = [], eventProps = {}, order = null, orderThrows = false }) {
  const calls = { gql: [], alerts: [] };
  A.sbComms = async (path) => {
    if (path.startsWith('/rest/v1/enrolments')) return { ok: true, data: enrolments };
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ properties: eventProps }] };
    return { ok: true, data: [] };
  };
  SH.shopifyGraphQL = async (_env, query, variables) => {
    calls.gql.push({ query, variables });
    if (/^query/.test(query)) {
      if (orderThrows) throw new Error('shopify_graphql:500:http');
      return { order };
    }
    return /tagsRemove/.test(query) ? { tagsRemove: { userErrors: [] } }
                                    : { tagsAdd: { userErrors: [] } };
  };
  AL.alert = async (_env, msg) => { calls.alerts.push(msg); };
  return calls;
}
const mutations = (calls) => calls.gql.filter((c) => !/^query/.test(c.query));
const tagsFor = (calls, kind) => calls.gql
  .filter((c) => new RegExp(kind).test(c.query))
  .flatMap((c) => c.variables.tags);

const ENROLMENT = { id: 'en-1', ended_at: RECENT, context: { trigger_event_id: 'ev-1' } };
const ORDER_BASE = { id: 'gid://shopify/Order/6329360842804', name: '#LOT47217',
                     cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED' };

// ── the button guard ────────────────────────────────────────────────────────
t('isConfirmButton accepts both C2P confirm buttons, case-insensitively', () => {
  assert.ok(C2P.isConfirmButton('Confirm COD Order'));
  assert.ok(C2P.isConfirmButton('confirm cod order'));
  assert.ok(C2P.isConfirmButton('no_confirm'));
});

t('isConfirmButton rejects the buttons that must NOT trigger a repair', () => {
  // "Cancel Order" and "yes_cancel" mean the opposite; "Make Payment" is the prepaid path.
  for (const b of ['Cancel Order', 'yes_cancel', 'Make Payment', '', null, undefined]) {
    assert.ok(!C2P.isConfirmButton(b), `should reject ${JSON.stringify(b)}`);
  }
});

t('a non-confirm button does no I/O at all', async () => {
  const calls = install({});
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Cancel Order' });
  assert.strictEqual(r.skipped, 'not_a_confirm_button');
  assert.strictEqual(calls.gql.length, 0);
});

// ── the safety cases ────────────────────────────────────────────────────────
t('an IN-WINDOW confirm (no no-response tag) leaves the order untouched', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['COD', 'Shopflo', 'relay-cod-confirmed'] },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.skipped, 'no_matching_order');
  assert.strictEqual(mutations(calls).length, 0, 'must not write to an order it did not tag');
});

t('an ALREADY-CANCELLED order is flagged for a human, never re-tagged as confirmed', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['COD', 'relay-c2p-no-response', 'COD_CANCELLED'],
             cancelledAt: '2026-08-17T14:02:11Z' },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.outcome, 'after_cancel');
  const added = tagsFor(calls, 'tagsAdd');
  assert.deepStrictEqual(added, [C2P.AFTER_CANCEL_TAG]);
  assert.ok(!added.includes(C2P.CONFIRMED_TAG), 'a cancelled order must not read as confirmed');
  assert.strictEqual(tagsFor(calls, 'tagsRemove').length, 0, 'must not untag a cancelled order');
  assert.strictEqual(calls.alerts.length, 1, 'a human must be told to call the customer back');
  assert.ok(/#LOT47217/.test(calls.alerts[0]));
});

// ── the repair ──────────────────────────────────────────────────────────────
t('a LATE confirm swaps no-response for confirmed and marks the repair', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['COD', 'Shopflo', 'relay-c2p-no-response'] },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.outcome, 'repaired');
  assert.strictEqual(r.order, '#LOT47217');
  assert.deepStrictEqual(tagsFor(calls, 'tagsRemove'), [C2P.NO_RESPONSE_TAG]);
  assert.deepStrictEqual(tagsFor(calls, 'tagsAdd'), [C2P.CONFIRMED_TAG, C2P.REPAIRED_TAG]);
});

t('the untag runs BEFORE the tag — a half-failure must not leave both tags on', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['relay-c2p-no-response'] },
  });
  await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  const muts = mutations(calls).map((c) => c.query);
  assert.ok(/tagsRemove/.test(muts[0]), 'remove must be first');
  assert.ok(/tagsAdd/.test(muts[1]), 'add must be second');
});

t('the repair is idempotent — a redelivered webhook writes nothing', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['relay-c2p-no-response', 'relay-cod-confirmed', 'relay-c2p-late-confirm'] },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.skipped, 'already_repaired');
  assert.strictEqual(mutations(calls).length, 0);
});

t('a second tap after an after-cancel flag does not re-alert', async () => {
  const calls = install({
    enrolments: [ENROLMENT], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['relay-c2p-no-response', 'relay-c2p-late-confirm-after-cancel'],
             cancelledAt: '2026-08-17T14:02:11Z' },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.skipped, 'already_repaired');
  assert.strictEqual(calls.alerts.length, 0);
});

// ── the give-up paths ───────────────────────────────────────────────────────
t('no recent no-response enrolment → nothing happens', async () => {
  const calls = install({ enrolments: [] });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'no_confirm' });
  assert.strictEqual(r.skipped, 'no_recent_no_response_enrolment');
  assert.strictEqual(calls.gql.length, 0);
});

t('an enrolment with no trigger event is skipped, not crashed on', async () => {
  const calls = install({ enrolments: [{ id: 'en-2', ended_at: RECENT, context: {} }] });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.skipped, 'no_matching_order');
  assert.strictEqual(calls.gql.length, 0);
});

t('a Shopify read failure is swallowed, never thrown into the webhook', async () => {
  install({ enrolments: [ENROLMENT], eventProps: { shopify_order_id: '1' }, orderThrows: true });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, 'no_matching_order');
});

t('a missing profile id is a no-op', async () => {
  const calls = install({ enrolments: [ENROLMENT] });
  const r = await C2P.repairLateConfirm(ENV, { profileId: null, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.skipped, 'no_profile');
  assert.strictEqual(calls.gql.length, 0);
});

t('the newest enrolment wins when a profile has several COD orders in the week', async () => {
  // Only the first enrolment resolves to an order carrying the tag; the walk must reach it.
  const older = { id: 'en-0', ended_at: RECENT, context: { trigger_event_id: 'ev-0' } };
  const calls = install({
    enrolments: [ENROLMENT, older], eventProps: { shopify_order_id: '6329360842804' },
    order: { ...ORDER_BASE, tags: ['relay-c2p-no-response'] },
  });
  const r = await C2P.repairLateConfirm(ENV, { profileId: PROFILE, buttonId: 'Confirm COD Order' });
  assert.strictEqual(r.outcome, 'repaired');
  // Stops at the first match rather than repairing every order the customer has open.
  assert.strictEqual(tagsFor(calls, 'tagsRemove').length, 1);
});

run();
