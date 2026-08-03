# Relay SMS via TrustSignal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SMS as a live Relay channel on TrustSignal, sending through the existing gate, with delivery webhooks, DND suppression and the DLT template model.

**Architecture:** A shared `trustsignal-client.js` holds every vendor quirk (per-service hosts, `api_key` query auth + redaction, three error shapes, phone rendering). `adapters/sms.js` implements the existing `{ send, parseStatusWebhook }` contract and is registered in `send.js`'s `ADAPTERS` map, so the gate, quiet-hours defer, frequency cap and TEST MODE all apply unchanged. RCS is a **separate later plan** that reuses the same client.

**Tech Stack:** Cloudflare Worker (CommonJS, `commsops`), Supabase/PostgREST via `src/auth.js`, Node's built-in `assert` for tests (`node test/<name>.test.js`).

**Spec:** `docs/superpowers/specs/2026-08-03-relay-sms-rcs-trustsignal-design.md`. Finding ids (F1…F15) below refer to that spec.

---

## File structure

| File | Responsibility |
|---|---|
| `src/trustsignal-client.js` (create) | Vendor boundary ONLY: hosts, auth+redaction, error normalisation, phone rendering. No channel logic, no DB. |
| `src/adapters/sms.js` (create) | SMS send + webhook parse. Implements the adapter contract. |
| `src/send.js` (modify, line 8-11) | Register the adapter. |
| `src/webhooks.js` (modify) | `parseTrustsignalSms` → message status updates + DND suppression. |
| `src/index.js` (modify, ~line 1595) | Route `POST /webhooks/trustsignal/sms`. |
| `test/trustsignal-phone.test.js` (create) | F1 — the dangerous one. |
| `test/trustsignal-client.test.js` (create) | Error shapes + redaction. |
| `test/sms-adapter.test.js` (create) | var_order → pr1..pr5, route cross-check, send shape. |
| `apps/relay/src/app/(auth)/templates/page.js` etc. (modify) | Channel allow-lists (F-sweep). |

**Why a separate client file:** SMS and RCS differ in template model, consent rule and webhook shape, but share exactly the vendor weirdness. That weirdness must exist once. `trustsignal-client.js` never imports channel code and never touches the DB — it is pure and unit-testable without network.

---

### Task 1: Phone rendering (F1 — CRITICAL)

The obvious implementation sends `+14155550123` to Indian mobile `4155550123`, a real stranger. 177 non-`+91` identifiers are live. Build this first, alone, with tests.

**Files:**
- Create: `commsops-worker/src/trustsignal-client.js`
- Test: `commsops-worker/test/trustsignal-phone.test.js`

- [ ] **Step 1: Write the failing test**

```js
// Phone rendering for TrustSignal SMS (F1). The naive "last 10 digits" version sends
// international numbers to unrelated Indian mobiles, silently. Live data 2026-08-03:
// 82,964 +91 · 177 non-+91 · 1 malformed +91.
// Run: node test/trustsignal-phone.test.js
const assert = require('assert');
const { renderPhoneForSms } = require('../src/trustsignal-client.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('a well-formed +91 renders to bare 10 digits', () => {
  assert.deepStrictEqual(renderPhoneForSms('+919876543210'), { ok: true, value: '9876543210' });
});

t('a US number is REJECTED, never truncated', () => {
  const r = renderPhoneForSms('+14155550123');
  assert.strictEqual(r.ok, false, 'must not send');
  assert.strictEqual(r.reason, 'unsupported_country');
  assert.ok(!('value' in r) || r.value == null, 'must not emit a dialable value');
});

t('a UK number is REJECTED', () => {
  assert.strictEqual(renderPhoneForSms('+447700900123').reason, 'unsupported_country');
});

t('a malformed +91 (wrong length) is REJECTED, not repaired', () => {
  assert.strictEqual(renderPhoneForSms('+9198765').reason, 'invalid_phone');
  assert.strictEqual(renderPhoneForSms('+91987654321012').reason, 'invalid_phone');
});

t('a value with no + is REJECTED — we store canonical E.164 only', () => {
  assert.strictEqual(renderPhoneForSms('9876543210').reason, 'invalid_phone');
});

t('null / empty are REJECTED', () => {
  assert.strictEqual(renderPhoneForSms(null).reason, 'invalid_phone');
  assert.strictEqual(renderPhoneForSms('').reason, 'invalid_phone');
});

t('a +91 with non-digits is REJECTED rather than stripped', () => {
  assert.strictEqual(renderPhoneForSms('+91 98765 43210').reason, 'invalid_phone');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/trustsignal-phone.test.js`
Expected: FAIL — `Cannot find module '../src/trustsignal-client.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// TrustSignal vendor boundary. Hosts, auth, error shapes, phone rendering.
// NO channel logic and NO database access lives here — SMS and RCS both import it.

// ── Phone rendering (F1) ─────────────────────────────────────────────────────
// Relay stores canonical E.164. `/v1/sms` wants BARE 10 DIGITS, which makes the naive
// implementation "take the last 10" — and that sends +14155550123 to Indian mobile
// 4155550123, a real unrelated person, with nothing erroring anywhere.
//
// So: only a well-formed +91 is dialable. Everything else is a typed refusal, never a
// best-effort repair. The DLT header and template registry are India-only, so an
// international SMS could not be compliant even if it were deliverable.
function renderPhoneForSms(e164) {
  const s = typeof e164 === 'string' ? e164.trim() : '';
  if (!/^\+\d+$/.test(s)) return { ok: false, value: null, reason: 'invalid_phone' };
  if (!s.startsWith('+91')) return { ok: false, value: null, reason: 'unsupported_country' };
  if (s.length !== 13) return { ok: false, value: null, reason: 'invalid_phone' };
  return { ok: true, value: s.slice(3) };
}

module.exports = { renderPhoneForSms };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/trustsignal-phone.test.js`
Expected: `7 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/trustsignal-client.js commsops-worker/test/trustsignal-phone.test.js
git commit -m "relay: TrustSignal phone rendering — reject non-+91 rather than truncate (F1)"
```

---

### Task 2: Error normalisation + api_key redaction

Three incompatible error shapes, and credentials in the query string.

**Files:**
- Modify: `commsops-worker/src/trustsignal-client.js`
- Test: `commsops-worker/test/trustsignal-client.test.js`

- [ ] **Step 1: Write the failing test**

```js
// TrustSignal error shapes + credential redaction.
// Run: node test/trustsignal-client.test.js
const assert = require('assert');
const { normalizeError, redact } = require('../src/trustsignal-client.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('shape A — structured errors[]', () => {
  const r = normalizeError({ success: false, errors: [{ code: '114', codeMsg: 'INVALID_SENDERID', message: 'Invalid senderid' }] });
  assert.deepStrictEqual(r, { code: '114', codeMsg: 'INVALID_SENDERID', message: 'Invalid senderid' });
});

t('shape B — flat message', () => {
  const r = normalizeError({ success: false, message: 'Wrong OTP' });
  assert.strictEqual(r.message, 'Wrong OTP');
  assert.strictEqual(r.code, null);
});

t('shape C — single error string', () => {
  const r = normalizeError({ success: false, error: 'Webhook URL is missing' });
  assert.strictEqual(r.message, 'Webhook URL is missing');
});

t('an unknown shape still yields a message rather than throwing', () => {
  const r = normalizeError({ success: false, weird: true });
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
});

t('a null body does not throw', () => {
  assert.ok(normalizeError(null).message);
});

t('redact removes the api_key VALUE from a url', () => {
  const out = redact('https://sms.trustsignal.io/v1/sms?api_key=SUPERSECRET123&to=99');
  assert.ok(!out.includes('SUPERSECRET123'), 'key must not survive');
  assert.ok(out.includes('api_key=[redacted]'));
  assert.ok(out.includes('to=99'), 'other params must survive');
});

t('redact handles the key anywhere in the string, not just as first param', () => {
  const out = redact('failed: to=9&api_key=abc123 (500)');
  assert.ok(!out.includes('abc123'));
});

t('redact is safe on non-strings', () => {
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined), '');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/trustsignal-client.test.js`
Expected: FAIL — `normalizeError is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/trustsignal-client.js`, above `module.exports`:

```js
// ── Credential redaction ─────────────────────────────────────────────────────
// TrustSignal authenticates with ?api_key= in the URL, so the key reaches every log line,
// span and exception that echoes a request. One console.error(url) leaks the account key
// into Cloudflare logs. EVERY log/error path in this integration goes through redact().
function redact(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/(api_key=)[^&\s'"]+/gi, '$1[redacted]');
}

// ── Error normalisation ──────────────────────────────────────────────────────
// Three incompatible failure shapes ship in the vendor collection:
//   A  { errors: [{ code, codeMsg, message }] }   most SMS/RCS/WhatsApp endpoints
//   B  { message }                                 Otify verify, WA typing indicator
//   C  { error }                                   WA Get Webhook
// The published code catalogue is explicitly partial, so an unrecognised body must still
// produce a usable message rather than throwing inside a send path.
function normalizeError(body) {
  const b = body || {};
  const first = Array.isArray(b.errors) ? b.errors[0] : null;
  if (first) {
    return {
      code: first.code != null ? String(first.code) : null,
      codeMsg: first.codeMsg || null,
      message: first.message || first.codeMsg || 'trustsignal_error',
    };
  }
  const msg = (typeof b.message === 'string' && b.message)
    || (typeof b.error === 'string' && b.error)
    || 'trustsignal_error';
  return { code: null, codeMsg: null, message: msg };
}
```

Update the export line to:

```js
module.exports = { renderPhoneForSms, redact, normalizeError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/trustsignal-client.test.js`
Expected: `8 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/trustsignal-client.js commsops-worker/test/trustsignal-client.test.js
git commit -m "relay: TrustSignal error normaliser + api_key redaction"
```

---

### Task 3: The request wrapper

**Files:**
- Modify: `commsops-worker/src/trustsignal-client.js`

- [ ] **Step 1: Write the implementation**

Append above `module.exports`:

```js
// ── Hosts ────────────────────────────────────────────────────────────────────
// One host per service, and the path prefixes DISAGREE (sms `/v1`, rcs `/api/v1`).
// Hard-code per call site; never derive a path from a base.
const HOSTS = {
  auth: 'https://auth.trustsignal.io',
  sms:  'https://sms.trustsignal.io',
  rcs:  'https://rcsapi.trustsignal.io',
};

// tsFetch(env, service, path, {method, body}) → {ok, status, data, error}
// `error` is a normalized {code, codeMsg, message} on any non-2xx OR success:false body —
// the vendor returns HTTP 400 for conditions that are logically 404 (codes 109/114), so
// NEVER branch on HTTP status alone.
async function tsFetch(env, service, path, opts = {}) {
  const base = HOSTS[service];
  if (!base) throw new Error(`unknown_trustsignal_service:${service}`);
  const key = env.TRUSTSIGNAL_API_KEY;
  if (!key) return { ok: false, status: 0, data: null, error: { code: null, codeMsg: 'API_KEY_MISSING', message: 'TRUSTSIGNAL_API_KEY not set' } };

  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}api_key=${encodeURIComponent(key)}`;

  let res, data;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } catch (e) {
    // A network failure must be a RESULT, not a throw — a throw escapes the send path and
    // leaves no messages row (the same failure mode adapters/email.js guards against).
    return { ok: false, status: 0, data: null,
             error: { code: null, codeMsg: 'NETWORK', message: redact(String(e?.message || e)).slice(0, 140) } };
  }

  const okBody = data && typeof data === 'object' ? data.success !== false : true;
  if (!res.ok || !okBody) {
    return { ok: false, status: res.status, data, error: normalizeError(data) };
  }
  return { ok: true, status: res.status, data, error: null };
}
```

Update the export line to:

```js
module.exports = { renderPhoneForSms, redact, normalizeError, tsFetch, HOSTS };
```

- [ ] **Step 2: Verify the module still loads and prior tests pass**

Run: `cd commsops-worker && node -e "require('./src/trustsignal-client.js')" && node test/trustsignal-phone.test.js && node test/trustsignal-client.test.js`
Expected: both suites pass, no load error

- [ ] **Step 3: Commit**

```bash
git add commsops-worker/src/trustsignal-client.js
git commit -m "relay: TrustSignal request wrapper — per-service hosts, result-not-throw on network failure"
```

---

### Task 4: SMS template model — `var_order` → `pr1..pr5` (F9), route cross-check (F3)

DLT templates use positional `{#var#}`; Relay templates use named `{token}`. Wrong order = a
grammatical message with the wrong words in it, and nothing errors.

**Files:**
- Create: `commsops-worker/src/adapters/sms.js`
- Test: `commsops-worker/test/sms-adapter.test.js`

- [ ] **Step 1: Write the failing test**

```js
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: FAIL — `Cannot find module '../src/adapters/sms.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// SMS adapter — TrustSignal. Contract matches adapters/email.js:
//   send(rendered, env) → {provider_message_id, status, reason, raw}
//   parseStatusWebhook(payload) → [{provider_message_id, canonical_status, at, reason}]

const TS = require('../trustsignal-client.js');

// Relay purpose → TrustSignal route, and the DLT consent type each REQUIRES.
// `global` is deliberately absent: it is the no-template international route and must never
// be reachable from an ordinary send.
const PURPOSE_ROUTE = { marketing: 'promotional', utility: 'transactional', transactional: 'transactional' };
const ROUTE_TYPE    = { promotional: 'explicit', transactional: 'implicit' };

function routeForPurpose(purpose) {
  const r = PURPOSE_ROUTE[purpose];
  if (!r) throw new Error(`unmapped_purpose:${purpose}`);
  return r;
}

// ⚠️ INTERNAL CONSISTENCY ONLY — NOT a compliance check (F15). TrustSignal's template_type is a
// self-declared dropdown value that nothing reconciles against the DLT registration, so agreement
// here proves only that we bound the template the way we labelled it. The carrier enforces on DLT.
// Never describe this as verifying compliance, in code or UI copy.
function assertBindable({ purpose, template_type }) {
  const want = ROUTE_TYPE[routeForPurpose(purpose)];
  if (!template_type) throw new Error('template_type_unset');
  if (template_type !== want)
    throw new Error(`route_template_type_mismatch:${purpose}->${want},got:${template_type}`);
  return true;
}

// DLT templates carry POSITIONAL {#var#} placeholders filled by pr1..pr5; Relay templates use
// NAMED {token} variables. `var_order` is the bridge and its order is load-bearing: get it wrong
// and the customer receives a grammatical message with the wrong words in it, and nothing errors.
// pr1..pr5 is a hard vendor ceiling — a 6th variable would silently vanish.
function buildSmsParams(varOrder, vars) {
  const order = Array.isArray(varOrder) ? varOrder : [];
  if (order.length > 5) throw new Error(`too_many_variables:${order.length}`);
  const out = {};
  const missing = [];
  order.forEach((name, i) => {
    const v = vars ? vars[name] : undefined;
    if (v === undefined || v === null || v === '') { missing.push(name); return; }
    out[`pr${i + 1}`] = String(v);
  });
  if (missing.length) throw new Error(`unresolved_variables:${missing.join(',')}`);
  return out;
}

module.exports = { buildSmsParams, routeForPurpose, assertBindable, PURPOSE_ROUTE, ROUTE_TYPE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: `11 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/adapters/sms.js commsops-worker/test/sms-adapter.test.js
git commit -m "relay: SMS template binding — positional var_order, route cross-check (F3/F9/F15)"
```

---

### Task 5: `send()`

**Files:**
- Modify: `commsops-worker/src/adapters/sms.js`
- Test: `commsops-worker/test/sms-adapter.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/sms-adapter.test.js`, above the final `console.log`:

```js
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
    assert.strictEqual(b.to, '9876543210', 'bare 10-digit');
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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
```

Remove the now-duplicated trailing `console.log`/`process.exit` lines from the earlier block so the file ends with the async IIFE.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: FAIL — `send is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/adapters/sms.js` above `module.exports`:

```js
async function send(rendered, env) {
  // Phone first: an unsupported recipient must fail BEFORE any network call, so a bad number
  // can never be partially attempted (F1).
  const phone = TS.renderPhoneForSms(rendered.to);
  if (!phone.ok) return { provider_message_id: null, status: 'failed', reason: phone.reason, raw: null, cost: null };

  let route, params;
  try {
    route = routeForPurpose(rendered.purpose);
    assertBindable({ purpose: rendered.purpose, template_type: rendered.template_type });
    params = buildSmsParams(rendered.var_order, rendered.vars);
  } catch (e) {
    return { provider_message_id: null, status: 'failed', reason: String(e.message).slice(0, 140), raw: null, cost: null };
  }

  const body = {
    sender_id: rendered.sender,
    to: phone.value,
    route,
    message: rendered.body,
    template_id: rendered.provider_template_id,
    ...params,
    // Vendor-side link shortening + click callbacks. Safe ONLY because the URL lives inside a
    // {#var#} variable — a URL literal in approved DLT content would be rewritten and stop
    // matching the registered template (F6), which the carrier rejects.
    ...(rendered.has_link ? { isdesturl: 'true' } : {}),
  };

  const r = await TS.tsFetch(env, 'sms', '/v1/sms', { method: 'POST', body });
  if (!r.ok) {
    return { provider_message_id: null, status: 'failed',
             reason: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`).slice(0, 140),
             raw: r.data, cost: null };
  }
  const first = Array.isArray(r.data?.results) ? r.data.results[0] : null;
  return {
    provider_message_id: first?.transaction_id || null,
    status: 'sent',                 // accepted, NOT delivered — the webhook moves it forward
    reason: null,
    raw: r.data,
    cost: first?.sms_cost == null ? null : Number(first.sms_cost),
  };
}
```

Update the export line to add `send`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: `17 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/adapters/sms.js commsops-worker/test/sms-adapter.test.js
git commit -m "relay: SMS adapter send() — phone-first refusal, isdesturl, numeric cost"
```

---

### Task 6: `parseStatusWebhook` + DND suppression (F5)

SMS has **no inbound channel**, so there is no STOP path. DND is carrier-side and arrives as a
failure. Without suppressing we re-send and re-pay to the same dead numbers forever.

**Files:**
- Modify: `commsops-worker/src/adapters/sms.js`
- Test: `commsops-worker/test/sms-adapter.test.js`

- [ ] **Step 1: Write the failing test**

Insert before the final `console.log` in the async IIFE:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: FAIL — `parseStatusWebhook is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/adapters/sms.js` above `module.exports`:

```js
// TrustSignal SMS DLR status → our canonical message status.
// `success:true` on send means ACCEPTED; only the DLR moves a row to a terminal state.
const SMS_STATUS = {
  delivered: 'delivered',
  submitted: 'sent',
  submit_queue: 'sent',
  failed: 'failed',
  expired: 'failed',
  rejected: 'failed',
  dnd: 'failed',
  dndcf: 'failed',
};
// DND is the one failure that must also SUPPRESS. SMS has no inbound, so a customer cannot send
// STOP to us — the carrier's DND registry is the only signal, and it arrives as a delivery
// failure. Without suppressing we retry and re-pay indefinitely and the failure rate quietly
// becomes the channel's baseline.
// ⚠️ SMS-SCOPED ONLY. A DND registration is a carrier-SMS state and says nothing about the
// customer's email or WhatsApp reachability — never suppress the profile globally.
const DND_STATUSES = new Set(['dnd', 'dndcf']);

function parseStatusWebhook(payload) {
  const p = payload || {};
  const id = p.transaction_id || null;
  if (!id) return [];
  const raw = String(p.status || '').toLowerCase();
  const ev = {
    provider_message_id: id,
    canonical_status: SMS_STATUS[raw] || null,
    at: p.dlrt || p.st || null,
    reason: p.error || p.error_code ? `${p.error_code || ''}:${p.error || ''}`.replace(/^:|:$/g, '') : null,
  };
  if (DND_STATUSES.has(raw)) {
    ev.suppress = 'dnd';
    ev.suppress_channel = 'sms';
    ev.suppress_value = p.to || null;
  }
  return [ev];
}
```

Update the export line to add `parseStatusWebhook`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd commsops-worker && node test/sms-adapter.test.js`
Expected: `23 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/adapters/sms.js commsops-worker/test/sms-adapter.test.js
git commit -m "relay: SMS DLR parsing + DND suppression, SMS-scoped only (F5)"
```

---

### Task 7: Register the adapter

**Files:**
- Modify: `commsops-worker/src/send.js:8-11`

- [ ] **Step 1: Make the change**

```js
const emailAdapter = require('./adapters/email.js');
const whatsappAdapter = require('./adapters/whatsapp.js');
const smsAdapter = require('./adapters/sms.js');

const ADAPTERS = { email: emailAdapter, whatsapp: whatsappAdapter, sms: smsAdapter };
```

- [ ] **Step 2: Verify the worker still loads**

Run: `cd commsops-worker && cp src/index.js /tmp/i.mjs && node --check /tmp/i.mjs && rm /tmp/i.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add commsops-worker/src/send.js
git commit -m "relay: register the SMS adapter in the send dispatch map"
```

---

### Task 8: Seed the SMS sender identity

**Files:**
- Migration via Supabase MCP `apply_migration`, name `comms_sms_sender_identity`

- [ ] **Step 1: Apply the migration**

```sql
-- The DLT header is the SMS "sender". LGNDRC, entity 1701175957030337181, Active since
-- 2026-07-28. purpose='all' because one header serves promotional and transactional routes
-- here (verified: templates of both consent types list LGNDRC in allowed_headers).
INSERT INTO comms.sender_identities (channel, address, purpose, provider, status, credentials_ref, metadata)
SELECT 'sms', 'LGNDRC', 'all', 'trustsignal', 'active', 'TRUSTSIGNAL_API_KEY',
       jsonb_build_object('dlt_entity_id', '1701175957030337181')
WHERE NOT EXISTS (
  SELECT 1 FROM comms.sender_identities WHERE channel='sms' AND address='LGNDRC');
```

- [ ] **Step 2: Verify**

Run this via Supabase MCP `execute_sql`:

```sql
SELECT channel, address, purpose, provider, status, metadata FROM comms.sender_identities WHERE channel='sms';
```

Expected: exactly one row, `LGNDRC` / `all` / `trustsignal` / `active`.

---

### Task 9: Webhook receiver

**Files:**
- Modify: `commsops-worker/src/index.js` (add a route beside `/webhooks/shopflo`, ~line 1595)

- [ ] **Step 1: Add `ctx` to the fetch signature**

⚠️ **`src/index.js:1455` is currently `async fetch(request, env)` — there is NO `ctx`.** The
`ctx.waitUntil` at line 1780 lives in `scheduled()`, a different handler. Calling `ctx.waitUntil`
in a fetch route as-is is a **ReferenceError at runtime**: the build passes, `turbo` reports
success, and every webhook 500s (the PATTERN-226 shape). Cloudflare always passes `ctx` as the
third argument, so adding it is additive and safe.

Change line 1455 from:

```js
  async fetch(request, env) {
```

to:

```js
  async fetch(request, env, ctx) {
```

- [ ] **Step 2: Add the route**

```js
    // TrustSignal SMS delivery receipts. There is NO signature on these callbacks, so the
    // shared secret is a bearer token configured in TrustSignal's own "Header (JSON)" field
    // on the webhook record. Reject anything without it — an unguessable path is not auth.
    if (url.pathname === '/webhooks/trustsignal/sms' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (!env.TRUSTSIGNAL_WEBHOOK_TOKEN || auth !== `Bearer ${env.TRUSTSIGNAL_WEBHOOK_TOKEN}`)
        return new Response('unauthorized', { status: 401 });
      const body = await request.json().catch(() => null);
      // Respond 200 immediately and process asynchronously — these retry and reorder.
      ctx.waitUntil(require('./webhooks.js').handleTrustsignalSms(env, body).catch((e) =>
        console.log('ts_sms_webhook_error', require('./trustsignal-client.js').redact(String(e?.message || e)))));
      return new Response('ok', { status: 200 });
    }
```

- [ ] **Step 2: Add the handler in `src/webhooks.js`**

```js
// TrustSignal SMS DLR → message status + DND suppression.
// Only ever moves state FORWARD: a late 'sent' must not overwrite a 'delivered'.
const TERMINAL = new Set(['delivered', 'failed', 'bounced']);

async function handleTrustsignalSms(env, body) {
  const events = require('./adapters/sms.js').parseStatusWebhook(body);
  for (const ev of events) {
    if (!ev.provider_message_id) continue;
    const cur = await A.sbComms(
      `/rest/v1/messages?provider_message_id=eq.${A.enc(ev.provider_message_id)}&select=id,status&limit=1`, env);
    const row = cur.ok && cur.data?.[0];
    if (!row) continue;                       // unknown id — log-only, never create a row
    if (TERMINAL.has(row.status)) continue;   // forward-only
    if (ev.canonical_status) {
      await A.sbComms(`/rest/v1/messages?id=eq.${A.enc(row.id)}`, env, {
        method: 'PATCH',
        body: JSON.stringify({
          status: ev.canonical_status,
          ...(ev.reason ? { reason: ev.reason } : {}),
          ...(ev.canonical_status === 'delivered' && ev.at ? { delivered_at: ev.at } : {}),
        }),
      });
    }
    if (ev.suppress && ev.suppress_value) {
      // ⚠️ NORMALISE EXACTLY AS index.js:769 DOES, and use the same on_conflict target.
      // gate.js matches suppressions with `value=eq.<the address being sent to>`, so a row
      // stored in any other shape is written successfully and then NEVER ENFORCED — the
      // channel keeps sending to a DND number while the suppression list looks correct.
      // `ignore-duplicates` without an on_conflict target 409s on the second DND for the
      // same number, so use merge-duplicates against (channel, value) like the manual path.
      const norm = String(ev.suppress_value).replace(/[^\d+]/g, '');
      await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ channel: ev.suppress_channel, value: norm, reason: ev.suppress }),
      });
    }
  }
}
```

Add `handleTrustsignalSms` to that file's `module.exports`.

- [ ] **Step 3: Verify the worker loads**

Run: `cd commsops-worker && cp src/index.js /tmp/i.mjs && node --check /tmp/i.mjs && rm /tmp/i.mjs && node -e "require('./src/webhooks.js')" && echo OK`
Expected: `OK`

- [ ] **Step 4: Prove the suppression actually blocks a send**

A suppression that is written but not matched is the failure this step exists to catch. After
Task 11's first live send, insert a DND suppression for the test number and confirm the gate
refuses. Via Supabase MCP `execute_sql`:

```sql
SELECT channel, value, reason FROM comms.suppressions WHERE channel='sms';
```

Then attempt a send to that number and confirm the message row records
`status='skipped'` with a suppression reason rather than `sent`.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/index.js commsops-worker/src/webhooks.js
git commit -m "relay: TrustSignal SMS webhook receiver — bearer-token auth, forward-only status, DND suppression"
```

---

### Task 10: Set the webhook token and deploy

- [ ] **Step 1: Mint and set the token** (internal token — ours to generate)

```bash
cd commsops-worker && npx wrangler secret put TRUSTSIGNAL_WEBHOOK_TOKEN
```

Paste a freshly generated value at the prompt (e.g. from `openssl rand -hex 32` run separately). Never commit it.

- [ ] **Step 2: Deploy**

```bash
cd commsops-worker && npx wrangler deploy
```

Expected: `Deployed commsops triggers` and a new Version ID.

- [ ] **Step 3: Register the webhook on Sigmo**

SMS → Settings → Webhook → **Add Event Webhook**. URL `https://commsops.afshaan.workers.dev/webhooks/trustsignal/sms`, Header `{"Authorization": "Bearer <the token>"}`.

⚠️ **F14 — registration takes up to 10 minutes to propagate.** Do not treat a missing DLR in the first minutes as a broken receiver.

- [ ] **Step 4: Verify propagation before proceeding**

Re-open the webhook list and confirm the row is present and enabled. Only then continue to Task 11.

---

### Task 11: First live send (TEST MODE)

- [ ] **Step 1: Add the test recipient in FULL E.164**

⚠️ **F13 — TEST MODE matching does not strip `+`** (`compactAddr` removes spaces/parens/hyphens/dots only). An allowlist entry of `9876543210` will NOT match a sent `+919876543210`. It fails closed, so the symptom is a silently refused send, not a leak.

Via Supabase MCP `execute_sql`:

```sql
UPDATE comms.settings
SET test_mode_allow = COALESCE(test_mode_allow, '[]'::jsonb) || '["+91XXXXXXXXXX"]'::jsonb
WHERE id = 1;
```

Substitute a real internal number.

- [ ] **Step 2: Send via the `/send` seam**

Use an `implicit` template for a utility-purpose test (e.g. `vyNTAwgHa` Prepaid Order Confirmation) so route and template_type agree.

- [ ] **Step 3: Verify the row and the DLR**

```sql
SELECT id, channel, status, provider_message_id, cost, reason, delivered_at
FROM comms.messages WHERE channel='sms' ORDER BY queued_at DESC LIMIT 5;
```

Expected: one row, `status='sent'` immediately, moving to `delivered` once the DLR lands.

- [ ] **Step 4: Commit nothing** — this task changes no code.

---

### Task 12: UI channel allow-lists (the PATTERN-218 sweep)

Adding a channel is never one edit. Each of these enumerates channels independently.

**Files:**
- Modify: `apps/relay/src/app/(auth)/templates/page.js:21` — `['email','whatsapp']` → `['email','sms','whatsapp']`
- Modify: `apps/relay/src/app/(auth)/campaigns/page.js:95` — same change
- Modify: `apps/relay/src/components/journey-canvas/NodeDrawer.js:37` — change the `sms` entry from `{ id:'sms', label:'SMS (not live yet)', live:false }` to `{ id:'sms', label:'SMS', live:true }`

`admin/connectors`, `admin/senders`, `contacts` and `segments` already list `sms` — leave them.

- [ ] **Step 1: Make the three edits**

- [ ] **Step 2: Build**

Run: `cd 05_Throttle && npx turbo build --filter=relay 2>&1 | grep -iE "attempted import|error|Compiled|Tasks:"`
Expected: `✓ Compiled successfully` and `1 successful`. ⚠️ An "Attempted import error" is a RUNTIME CRASH that still exits 0 — read the output, not just the exit code.

- [ ] **Step 3: Commit**

```bash
git add apps/relay/src
git commit -m "relay: surface SMS in templates, campaigns and the journey canvas"
```

---

## Out of scope for this plan

RCS entirely (separate plan, reuses `trustsignal-client.js`), Otify, TrustSignal email, voice,
sub-accounts, and the first-party `/r/` redirect. The `fallback_from` column belongs to the RCS
plan — nothing in SMS-only uses it.

**Deferred deliberately, from spec sections this plan does NOT implement.** Listed so they are
visibly deferred rather than silently missed:

- **§6c template authoring** (`POST /v1/accounts/templates` + the two-call `template_type` update).
  20 templates already exist and cover the current journeys, so authoring is not needed to send.
  It becomes valuable when the team wants to add SMS content without us. **Its two-call
  create-then-set-type sequence is the whole point** — a single-call implementation leaves
  `template_type` empty, which `assertBindable` now rejects (`template_type_unset`), so a future
  authoring feature fails loudly rather than producing unusable templates.
- **F12 click capture.** Task 5 enables `isdesturl`, so links WILL be shortened and clicks WILL
  occur — but the `clickwebhook_url` slot is a separate registration and this plan does not wire
  it. **Consequence: SMS clicks happen and are not recorded**, so SMS shows zero clicks rather
  than real ones. When built, it must emit the existing channel-agnostic `link_clicked` event,
  never a new `sms_clicked` — S189 renamed it specifically so SMS could reuse it, and minting a
  parallel name would fragment every click segment.
- **F10 template-status gate.** `assertBindable` checks `template_type` but not the template's
  Active/approved status. Deferred because that status is a self-declared dropdown value (F15) and
  gating on it would imply a verification it does not provide. Worth adding alongside the
  `Template` webhook event, which is the only thing that would make it a live signal.

## Self-review notes (findings fixed in this plan before first execution)

Two bugs were caught reviewing this plan against the real codebase, both of which would have
shipped broken:

1. **`ctx` does not exist in the fetch handler.** `src/index.js:1455` is `async fetch(request, env)`;
   the `ctx.waitUntil` at line 1780 is in `scheduled()`. A route using `ctx.waitUntil` would be a
   runtime ReferenceError with a green build — Task 9 Step 1 now widens the signature first.
2. **The DND suppression would have been written but never enforced.** `gate.js` matches on
   `value=eq.<address being sent to>`, and the existing manual path at `index.js:769` normalises
   with `value.replace(/[^\d+]/g,'')` and upserts on `on_conflict=channel,value`. The first draft
   used neither, so the row would exist, look correct, and block nothing — while also 409-ing on
   the second DND for the same number. Task 9 now mirrors the existing convention, and Step 4
   proves the block rather than assuming it.

## Before this ships to customers

- **Credits are ~₹9.85.** Enough for internal tests, not a campaign.
- **The `Order Shipped` template is registered `explicit`** and will not reach DND-registered
  numbers. That is a DLT-portal question, not a code one, and is unanswerable from TrustSignal
  (F15). Resolve before routing any transactional journey to SMS.
- **TEST MODE stays ON** until Afshaan signs off, per the standing Relay gate.
