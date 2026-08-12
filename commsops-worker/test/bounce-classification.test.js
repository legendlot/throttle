// Bounce classification (S273). A bounce is not automatically permanent, and treating it as one
// is expensive: suppression is the ONE gate transactional/utility cannot bypass (gate.js:3), so
// a mis-classified bounce ends a real customer's order confirmations and shipping updates.
//
// Run: node test/bounce-classification.test.js
const assert = require('assert');
const E = require('../src/adapters/email.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// The ACTUAL live payload that exposed this, trimmed to the shape under test. This bounce
// permanently suppressed akshaabbasi2329@gmail.com on 2026-08-11 for a FULL INBOX.
const LIVE_TRANSIENT_BOUNCE = {
  type: 'email.bounced',
  created_at: '2026-08-10T20:18:39.414Z',
  data: {
    email_id: 'af2c2360-a37a-4351-a4ce-b181f8b28216',
    to: ['akshaabbasi2329@gmail.com'],
    bounce: { type: 'Transient', subType: 'MailboxFull',
      message: "The recipient's email provider sent a bounce message because the recipient's inbox was full." },
  },
};

const permanentBounce = {
  type: 'email.bounced', created_at: '2026-08-10T20:18:39.414Z',
  data: { email_id: 'x', to: ['nobody@gmail.con'],
          bounce: { type: 'Permanent', subType: 'General' } },
};

t('THE REGRESSION: a Transient/MailboxFull bounce is NOT a hard bounce', () => {
  const [u] = E.parseStatusWebhook(LIVE_TRANSIENT_BOUNCE);
  assert.strictEqual(u.reason, 'soft_bounce',
    'this exact payload permanently suppressed a real customer for a full inbox');
  assert.notStrictEqual(u.reason, 'hard_bounce');
});

t('a Permanent bounce IS a hard bounce (the genuine case still suppresses)', () => {
  const [u] = E.parseStatusWebhook(permanentBounce);
  assert.strictEqual(u.reason, 'hard_bounce');
});

t('Undetermined does NOT suppress — one ambiguous bounce is weak evidence', () => {
  const [u] = E.parseStatusWebhook({ ...permanentBounce,
    data: { ...permanentBounce.data, bounce: { type: 'Undetermined' } } });
  assert.strictEqual(u.reason, 'undetermined_bounce');
});

// The failure mode that matters most: a vendor shape change must not silently resurrect the bug.
t('a MISSING or UNKNOWN bounce type fails toward keeping the customer reachable', () => {
  for (const bounce of [undefined, {}, { type: null }, { type: 'SomethingNew' }]) {
    const [u] = E.parseStatusWebhook({ ...permanentBounce,
      data: { ...permanentBounce.data, bounce } });
    assert.strictEqual(u.reason, 'undetermined_bounce',
      `bounce=${JSON.stringify(bounce)} must not classify as hard_bounce`);
  }
});

t('only hard_bounce and complaint are suppressing reasons', () => {
  // Mirrors the handler predicate in webhooks.js. If that predicate widens, this must too.
  const suppresses = (r) => r === 'hard_bounce' || r === 'complaint';
  assert.ok(suppresses('hard_bounce'));
  assert.ok(suppresses(E.parseStatusWebhook({ type: 'email.complained', data: { email_id: 'x' } })[0].reason));
  assert.ok(!suppresses('soft_bounce'), 'a full mailbox must never suppress');
  assert.ok(!suppresses('undetermined_bounce'));
});

t('bounce type + subtype are carried through for persistence (diagnosable from the DB)', () => {
  const [u] = E.parseStatusWebhook(LIVE_TRANSIENT_BOUNCE);
  assert.strictEqual(u.bounce_type, 'Transient');
  assert.strictEqual(u.bounce_subtype, 'MailboxFull');
});

t('non-bounce events are untouched (no reason, no bounce fields)', () => {
  const [u] = E.parseStatusWebhook({ type: 'email.delivered', data: { email_id: 'x' } });
  assert.strictEqual(u.reason, null);
  assert.strictEqual(u.bounce_type, null);
  assert.strictEqual(u.canonical_status, 'delivered');
});

t('a click still parses its url (unchanged by this change)', () => {
  const [u] = E.parseStatusWebhook({ type: 'email.clicked',
    data: { email_id: 'x', click: { link: 'https://legendoftoys.com/products/shadow' } } });
  assert.strictEqual(u.engagement_event, 'link_clicked');
  assert.strictEqual(u.clicked_url, 'https://legendoftoys.com/products/shadow');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
