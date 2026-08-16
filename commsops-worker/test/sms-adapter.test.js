// SMS template binding: positional variables and the route/consent-type cross-check.
// Run: node test/sms-adapter.test.js
const assert = require('assert');
const { buildSmsParams, routeForPurpose, assertBindable, PURPOSE_ROUTE } = require('../src/adapters/sms.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('var_order maps named vars onto pr1..prN IN ORDER', () => {
  const out = buildSmsParams(['first_name', 'product_url'], { product_url: 'https://x/y', first_name: 'Riya' });
  assert.deepStrictEqual(out, { pr1: 'Riya', pr2: 'https://x/y' });
});

t('order is positional, NOT alphabetical — the whole point', () => {
  const out = buildSmsParams(['zeta', 'alpha'], { alpha: 'A', zeta: 'Z' });
  assert.strictEqual(out.pr1, 'Z');
  assert.strictEqual(out.pr2, 'A');
});

t('a missing variable throws rather than sending a hole', () => {
  assert.throws(() => buildSmsParams(['first_name'], {}), /unresolved_variables:first_name/);
});

t('more than 5 variables is refused (pr1..pr5 is a hard ceiling)', () => {
  assert.throws(() => buildSmsParams(['a','b','c','d','e','f'], { a:1,b:2,c:3,d:4,e:5,f:6 }), /too_many_variables/);
});

t('exactly 5 is allowed', () => {
  const out = buildSmsParams(['a','b','c','d','e'], { a:'1',b:'2',c:'3',d:'4',e:'5' });
  assert.strictEqual(out.pr5, '5');
});

t('purpose maps to the documented routes', () => {
  assert.strictEqual(routeForPurpose('marketing'), 'promotional');
  assert.strictEqual(routeForPurpose('utility'), 'transactional');
  assert.strictEqual(routeForPurpose('transactional'), 'transactional');
});

t('an unknown purpose is refused — never defaults to a sendable route', () => {
  assert.throws(() => routeForPurpose('nonsense'), /unmapped_purpose/);
});

t('`global` is unreachable from a purpose (it is the no-template route)', () => {
  assert.ok(!Object.values(PURPOSE_ROUTE).includes('global'));
});

t('a click payload (final_url, no status) parses as a click, never a status write (S290)', () => {
  const { parseStatusWebhook } = require('../src/adapters/sms.js');
  const [ev] = parseStatusWebhook({
    id: '17847889229334938_0', transaction_id: '1784788927235213696334938',
    number: 9990012234, final_url: 'https://google.com', route: 'promotional',
    ip: '49.205.42.42', created_at: '2026-07-23T06:45:02.801946631Z',
  });
  assert.strictEqual(ev.click, true);
  assert.strictEqual(ev.clicked_url, 'https://google.com');
  assert.strictEqual(ev.at, '2026-07-23T06:45:02.801946631Z');
});

t('a DLR carrying BOTH a status and (hypothetically) a url stays a status event', () => {
  const { parseStatusWebhook } = require('../src/adapters/sms.js');
  const [ev] = parseStatusWebhook({ transaction_id: 'tx', status: 'delivered', final_url: 'https://x' });
  assert.ok(!ev.click);
  assert.strictEqual(ev.canonical_status, 'delivered');
});

t('binding a utility journey to an `explicit` template is a hard error (F3)', () => {
  assert.throws(
    () => assertBindable({ purpose: 'utility', template_type: 'explicit' }),
    /route_template_type_mismatch/);
});

t('binding marketing to `explicit` is fine', () => {
  assert.doesNotThrow(() => assertBindable({ purpose: 'marketing', template_type: 'explicit' }));
});

t('an EMPTY template_type is refused — create-without-update leaves it "" (F15)', () => {
  assert.throws(() => assertBindable({ purpose: 'utility', template_type: '' }), /template_type_unset/);
});

// ── send() ──
const { send } = require('../src/adapters/sms.js');
const ENV = { TRUSTSIGNAL_API_KEY: 'k' };
const origFetch = global.fetch;
const withFetch = async (impl, fn) => { global.fetch = impl; try { return await fn(); } finally { global.fetch = origFetch; } };

const RENDERED = {
  to: '+919876543210',
  sender: 'LGNDRC',
  purpose: 'marketing',
  provider_template_id: 'G38A46v1i',
  template_type: 'explicit',
  var_order: ['first_name'],
  vars: { first_name: 'Riya' },
  body: 'Hey Riya! ...',
  has_link: true,
};

(async () => {
  await withFetch(async (url, init) => {
    const b = JSON.parse(init.body);
    // The vendor's param table is `to []int` and its example is `"to": [9999999999]`.
    // Sending the bare STRING (which the plan specified, and this test originally asserted)
    // is rejected live with INVALID_JSON — verified against the real endpoint 2026-08-03.
    assert.deepStrictEqual(b.to, [9876543210], 'array of int, per the vendor contract');
    assert.strictEqual(b.route, 'promotional');
    assert.strictEqual(b.template_id, 'G38A46v1i');
    assert.strictEqual(b.sender_id, 'LGNDRC');
    assert.strictEqual(b.pr1, 'Riya');
    assert.strictEqual(b.isdesturl, 'true');
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, results: [{ phone: 919876543210, transaction_id: 'TX1', sms_cost: 1 }] }) };
  }, async () => {
    const r = await send(RENDERED, ENV);
    t('send returns the transaction_id as provider_message_id', () => {
      assert.strictEqual(r.provider_message_id, 'TX1');
      assert.strictEqual(r.status, 'sent');
    });
    t('send captures cost as a NUMBER (F11)', () => assert.strictEqual(r.cost, 1));
  });

  await withFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, results: [{ transaction_id: 'TX2', sms_cost: '0.5' }] }) }),
    async () => {
      const r = await send(RENDERED, ENV);
      t('a STRING cost is coerced to a number (F11)', () => assert.strictEqual(r.cost, 0.5));
    });

  await withFetch(async () => { throw new Error('boom api_key=SECRET'); }, async () => {
    const r = await send(RENDERED, ENV);
    t('a network failure is a failed RESULT, not a throw', () => assert.strictEqual(r.status, 'failed'));
    t('the api_key never appears in a failure reason', () => assert.ok(!r.reason.includes('SECRET')));
  });

  await withFetch(async () => { throw new Error('unreachable'); }, async () => {
    const r = await send({ ...RENDERED, to: '+14155550123' }, ENV);
    t('an international number fails BEFORE any network call (F1)', () => {
      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(r.reason, 'unsupported_country');
      assert.strictEqual(r.provider_message_id, null);
    });
  });

  const { parseStatusWebhook } = require('../src/adapters/sms.js');

  t('a delivered DLR maps to delivered', () => {
    const [e] = parseStatusWebhook({ transaction_id: 'TX1', status: 'delivered', dlrt: '2026-08-03T10:15:03Z' });
    assert.strictEqual(e.provider_message_id, 'TX1');
    assert.strictEqual(e.canonical_status, 'delivered');
  });

  t('a failed DLR maps to failed and carries the reason', () => {
    const [e] = parseStatusWebhook({ transaction_id: 'TX2', status: 'failed', error: 'EXPIRED' });
    assert.strictEqual(e.canonical_status, 'failed');
    assert.ok(e.reason.includes('EXPIRED'));
  });

  t('a DND DLR is failed AND flags a suppression (F5)', () => {
    const [e] = parseStatusWebhook({ transaction_id: 'TX3', status: 'dnd', to: '+919876543210' });
    assert.strictEqual(e.canonical_status, 'failed');
    assert.strictEqual(e.suppress, 'dnd');
    assert.strictEqual(e.suppress_value, '+919876543210');
  });

  t('suppression is SMS-scoped — a DND says nothing about email or WhatsApp', () => {
    const [e] = parseStatusWebhook({ transaction_id: 'TX3', status: 'dndcf', to: '+919876543210' });
    assert.strictEqual(e.suppress_channel, 'sms');
  });

  t('an unknown status is returned as null rather than throwing', () => {
    const [e] = parseStatusWebhook({ transaction_id: 'TX4', status: 'martian' });
    assert.strictEqual(e.canonical_status, null);
  });

  t('a payload with no transaction_id yields no events', () => {
    assert.strictEqual(parseStatusWebhook({ status: 'delivered' }).length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
