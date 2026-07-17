# Relay Opt-Out & Consent Compliance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Rev 2 (2026-07-17)** — rewritten after a hostile review against the real code. Rev 1 had three runtime blockers (`A.can` doesn't exist; the `resolve_identity` test stub returned the wrong shape *and* used `.json()` where `sbComms` uses `.text()`; `auth.sub` doesn't exist) and one silent-data-loss bug (swallowed the opt-out error → 200 → Meta never retries → the STOP is gone). All fixed below. Do not resurrect Rev 1.

**Goal:** Make a customer's "STOP" actually stop marketing WhatsApp — writing a provable, auditable withdrawal to the consent ledger — and give withdrawal parity across every channel it can arrive on.

**Architecture:** One new module `src/optout.js` owns (a) keyword detection (pure) and (b) `applyOptOut` — the single writer that appends a withdrawal to `comms.consent` and mirrors it as a substrate event. All three opt-out paths (WhatsApp inbound keyword, email unsubscribe link, agent-actioned admin call) funnel through it, so evidence is uniform and withdrawal semantics live in exactly one place. No new tables: `comms.consent` already has the right grain (`profile × channel × purpose`) plus an unused `evidence jsonb`.

**Tech Stack:** Cloudflare Workers (commsops), Supabase/PostgREST via `src/auth.js sbComms`, plain-Node unit tests (`node test/x.test.js`, `assert`, no framework).

---

## Verified facts (checked against the code — do not re-derive)

| Fact | Why it matters |
|---|---|
| `sbComms` reads responses via **`res.text()` → `JSON.parse`**, never `.json()` | Test stubs MUST implement `text`, not `json`. A stub returning `text: ''` yields `data = null`. |
| `resolve_identity` returns a **bare uuid scalar** (`const profileId = rpc.data`) | Stub it as `text: async () => JSON.stringify('p-1')`, NOT `{profile_id:...}`. |
| `sbComms` uses `env.SUPABASE_URL` + `env.SUPABASE_SERVICE_ROLE_KEY` | Test ENV needs both. |
| `auth` = `{ userId, email, role, fullName, relayRole, permissions }` | No `.sub`. Use `auth.userId`. |
| Permission gates are `A.canConsentAdmin(auth.permissions)` etc. **`A.can` is module-private and NOT exported** | Rev 1's `A.can(auth, 'x')` was a TypeError. |
| `parseInbound` already normalises **button replies** into `m.text` (`m.button.text`, `interactive.button_reply.title`) | A tapped "Stop promotions" button flows through the same text detector. Free. |
| Gate step ② is `profileId ? latestConsent(...) : 'unknown'`, and `'unknown' !== 'opted_in'` → **fails closed** | Marketing with no resolvable profile is already blocked; the opt-out cannot be bypassed. |
| Gate step ② is **channel-specific** (`latestConsent(env, profileId, channel, 'marketing')`) | A WhatsApp opt-out correctly leaves email marketing alone. |
| `unsubscribeUrl` **self-heals** a missing token (mints + PATCHes it onto the latest row) | Token-less rows don't break links — but see Task 5, we still forward the token. |
| `ingest()` returns `{ ok, profile_id, event_id, deduped }` and dedups the **event** on `idempotency_key` | Opt-out runs outside that dedup — deliberate, see Task 3. |

---

## Context an engineer needs before starting

**Read first:** `systems/relay.md` (the send gate + TEST MODE), `reference/bitespeed.md` §1.

### The load-bearing decision: withdrawal = consent opt-out, NOT suppression

| | Grain | Gate step | Blocks |
|---|---|---|---|
| `comms.suppressions` | `channel × value` | ① first, absolute | **Everything, incl. transactional** |
| `comms.consent` | `profile × channel × purpose` | ② marketing only | Marketing only |

A marketing STOP **must** write a consent opt-out, never a suppression. A suppression would stop the customer's own **order and shipping updates**. Wrong operationally, wrong under Meta's policy (which governs *promotional* messaging), and wrong under DPDP — s.6(5)'s illustration says withdrawal does not undo the paid order's fulfilment. Suppressions stay reserved for hard blocks (Shopify GDPR redaction, hard bounces, spam complaints).

### Why this is real (but not November-urgent)

- **Meta** (Business Messaging Policy, primary source): *"You must respect all requests (either on or off WhatsApp) by a person to block, discontinue, or otherwise opt out of communications from you via WhatsApp."* Meta does **not** mandate a "Reply STOP" footer and specifies **no 24h SLA** — both are vendor folklore. But **our approved `lot_abandoned_cart_01` promises "Reply STOP to unsubscribe"**, so we're bound by our own copy.
- **DPDP** s.6(4): withdrawal must be *"with the ease... comparable to the ease with which such consent was given"* — statutory. s.6(10) puts the **burden of proof on us** → `evidence`.
- **Timing:** DPDP consent/notice/rights commence **14 May 2027**. Nov 2026 is Consent Manager registration and does not apply to LOT. This is *correctness*, not a deadline scramble.

### Decisions taken (Afshaan, 2026-07-17)

1. **English-only keywords for now.** `normalise()` strips non-`[a-z\s]`, so Devanagari/Tamil/Bengali STOP is **not detected**. Accepted: our approved template instructs "Reply STOP" in English. **Known gap — must be logged in BACKLOG** (Task 6): a customer writing बंद करो is a withdrawal we fail to action, which is a DPDP s.6(4) exposure. The agent-actioned path (Task 4) is the manual backstop.
2. **Never lose a STOP.** The opt-out error **propagates** → non-2xx → Meta retries. `ingest` dedups the *event*, but `applyOptOut` runs again, so a partial failure can write two identical `opted_out` rows. **This is a deliberate trade**: the ledger is append-only and latest-wins, so duplicates are cosmetic; a lost withdrawal is a compliance failure *and* invisible.

### Out of scope (and why)

- **Processor cascade (s.6(6))** — verified a non-issue for our rails: no audience/contact list at Resend (the adapter only `POST`s `/emails` per message), so a gate-blocked send never hands the address over. Real exposure is **BiteSpeed's 125k CDP** = the exit, not code.
- **The 47k SMS-inferred WhatsApp consent base** — needs a legal opinion + Afshaan's decision. Highest DPDP exposure. BACKLOG.
- **s.5(2) legacy notice** to the ~92k — a campaign, same legal gate.
- **Phase-B shortener** — separate plan, needs a DNS record on `go.legendoftoys.com`.
- **Third Schedule 3-year erasure** — does NOT apply (2 crore registered users; LOT ~92k). Do not build.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/optout.js` | Keyword detection (pure) + `applyOptOut` — the single withdrawal writer. |
| **Create** `test/optout.test.js` | Unit tests. Follows `test/wa.test.js`'s promise-based `t()` (handles sync + async uniformly). |
| **Modify** `src/wa-webhooks.js` | `handleInbound` — capture `profile_id`, detect keyword, apply. |
| **Modify** `src/index.js` | `optOutProfile` action + pass `all` through the unsubscribe route. |
| **Modify** `src/webhooks.js` | `handleUnsubscribe` — all-channel withdrawal (s.6(4) parity). |

---

### Task 1: Keyword detection + the withdrawal writer

**Files:**
- Create: `05_Throttle/commsops-worker/src/optout.js`
- Test: `05_Throttle/commsops-worker/test/optout.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/optout.test.js` (mirrors `test/wa.test.js`'s harness — `t()` returns a promise so sync and async cases share one runner; no trailing-line surgery in later tasks):

```js
// Node unit tests for opt-out keyword detection + the withdrawal writer.
// Run: node test/optout.test.js   (Node 18+ — global fetch)
// Pure detection needs no network; applyOptOut stubs fetch per-case.

const assert = require('assert');
const { detectOptOut, applyOptOut } = require('../src/optout.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
}

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };

// sbComms reads via res.text() then JSON.parse — NOT res.json(). Stubs must honour that.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    const r = handler ? handler(u) : null;
    return { ok: true, status: 201, text: async () => (r === undefined ? '[]' : r) };
  };
  return calls;
}

(async () => {
  console.log('detectOptOut — opt-out keywords');
  await t('bare STOP', () => assert.equal(detectOptOut('STOP'), 'opt_out'));
  await t('lowercase', () => assert.equal(detectOptOut('stop'), 'opt_out'));
  await t('trailing full stop', () => assert.equal(detectOptOut('Stop.'), 'opt_out'));
  await t('exclamation', () => assert.equal(detectOptOut('STOP!'), 'opt_out'));
  await t('surrounding whitespace', () => assert.equal(detectOptOut('  stop  '), 'opt_out'));
  await t('hyphenated OPT-OUT', () => assert.equal(detectOptOut('OPT-OUT'), 'opt_out'));
  await t('unsubscribe', () => assert.equal(detectOptOut('unsubscribe'), 'opt_out'));
  await t('button title "Stop promotions"', () => assert.equal(detectOptOut('Stop promotions'), 'opt_out'));

  console.log('detectOptOut — opt-in keywords');
  await t('START', () => assert.equal(detectOptOut('START'), 'opt_in'));
  await t('subscribe', () => assert.equal(detectOptOut('subscribe'), 'opt_in'));

  console.log('detectOptOut — MUST NOT false-positive on support messages');
  await t('complaint containing stop', () =>
    assert.equal(detectOptOut('please stop sending me broken cars'), null));
  await t('stop the order', () => assert.equal(detectOptOut('can you stop the order'), null));
  await t('cancel my order is not an opt-out', () =>
    assert.equal(detectOptOut('cancel my order please'), null));
  await t('greeting', () => assert.equal(detectOptOut('Hi'), null));

  console.log('detectOptOut — degenerate input');
  await t('empty', () => assert.equal(detectOptOut(''), null));
  await t('null', () => assert.equal(detectOptOut(null), null));
  await t('undefined', () => assert.equal(detectOptOut(undefined), null));
  await t('emoji only', () => assert.equal(detectOptOut('🛑'), null));
  // KNOWN GAP (accepted 2026-07-17): non-Latin scripts normalise to '' and are never
  // detected. Documented in BACKLOG; the agent-actioned path is the backstop.
  await t('KNOWN GAP: Hindi STOP is not detected', () =>
    assert.equal(detectOptOut('बंद करो'), null));

  console.log('applyOptOut');
  await t('writes consent + event with evidence', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, {
      profile_id: 'p1', channel: 'whatsapp', state: 'opted_out',
      source: 'whatsapp_inbound_keyword', evidence: { keyword: 'STOP' },
    });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent'));
    const event = calls.find((c) => c.url.includes('/rest/v1/events'));
    assert.ok(consent, 'must POST a consent row');
    assert.equal(consent.body.purpose, 'marketing');
    assert.equal(consent.body.state, 'opted_out');
    assert.equal(consent.body.channel, 'whatsapp');
    assert.deepEqual(consent.body.evidence, { keyword: 'STOP' }, 's.6(10) proof must persist');
    assert.ok(event, 'must mirror as a substrate event');
    assert.equal(event.body.name, 'opted_out');
  });

  await t('NEVER writes a suppression (would kill transactional)', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/suppressions')),
      'a marketing withdrawal must not suppress — order updates must survive it');
  });

  await t('forwards unsubscribe_token when given', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'email', state: 'opted_out',
      source: 'unsubscribe_link', unsubscribe_token: 'tok-1' });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent'));
    assert.equal(consent.body.unsubscribe_token, 'tok-1', 'token must survive — unsubscribeUrl keys off it');
  });

  await t('opt_in emits opted_in', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_in', source: 's' });
    assert.equal(calls.find((c) => c.url.includes('/rest/v1/events')).body.name, 'opted_in');
  });

  await t('requires profile_id', async () => {
    stubFetch();
    const r = await applyOptOut(ENV, { channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'profile_id_required');
  });

  await t('rejects a bad state', async () => {
    stubFetch();
    const r = await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'maybe', source: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_state');
  });

  await t('THROWS when the consent write fails (must not silently lose a STOP)', async () => {
    globalThis.fetch = async (url) => String(url).includes('/rest/v1/consent')
      ? { ok: false, status: 500, text: async () => '{"message":"boom"}' }
      : { ok: true, status: 201, text: async () => '[]' };
    await assert.rejects(
      () => applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' }),
      /consent_write_failed/,
      'a failed withdrawal must throw so the webhook 500s and Meta retries');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: FAIL — `Cannot find module '../src/optout.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/optout.js`:

```js
// Opt-out / opt-in intent detection + the single withdrawal writer.
// Channel-agnostic: WhatsApp inbound, the email unsubscribe link, and the agent-actioned
// admin call all funnel through applyOptOut, so evidence is uniform and withdrawal
// semantics live in exactly one place.

const A = require('./auth.js');
const { recordConsent } = require('./consent.js');

// EXACT-MATCH, not substring — deliberate. "please stop sending me broken cars" is a
// support complaint, not a withdrawal; substring-matching "stop" would silently opt that
// customer out while they were asking for help. That failure is invisible and
// unrecoverable — we'd never know to re-ask. A missed keyword is visible: the customer
// repeats themselves, or an agent actions it via optOutProfile. Bare keywords are also
// the TRAI/Meta convention, so exact-match is both safer AND standard.
//
// 'cancel' is deliberately ABSENT: "cancel my order" is a support intent, not a withdrawal.
const KEYWORDS_OUT = new Set([
  'stop', 'stopall', 'stop promotions', 'unsubscribe', 'unsub',
  'optout', 'opt out', 'end', 'quit', 'revoke',
]);
const KEYWORDS_IN = new Set(['start', 'unstop', 'subscribe', 'optin', 'opt in', 'resume']);

// Lowercase, drop anything that isn't a letter or space (punctuation, digits, emoji),
// collapse whitespace. "OPT-OUT" -> "opt out"; "Stop." -> "stop"; "🛑" -> "".
//
// KNOWN GAP (accepted by Afshaan 2026-07-17): this strips non-Latin scripts, so a Hindi
// "बंद करो" normalises to '' and is NEVER detected. Accepted because our approved
// template instructs "Reply STOP" in English. Tracked in BACKLOG as a DPDP s.6(4)
// exposure; optOutProfile (agent-actioned) is the manual backstop.
function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// detectOptOut(text) -> 'opt_out' | 'opt_in' | null
function detectOptOut(text) {
  const n = normalise(text);
  if (!n) return null;
  if (KEYWORDS_OUT.has(n)) return 'opt_out';
  if (KEYWORDS_IN.has(n)) return 'opt_in';
  return null;
}

// Append a withdrawal (or re-subscribe) to the consent ledger + mirror it as an event.
//
// Deliberately NOT a suppression: `comms.suppressions` is gate step ① and blocks EVERY
// purpose including transactional, so suppressing here would stop a customer's own order
// and shipping updates. `comms.consent` is gate step ② and gates marketing only — exactly
// "stop the promos, keep my delivery texts". Matches Meta's promotional policy and DPDP
// s.6(5) (withdrawal does not undo the paid order).
//
// THROWS on a failed consent write — never swallow. The caller is a webhook; a swallowed
// error returns 200, Meta never retries, and the customer's STOP is lost forever with no
// trace. Throwing surfaces a 500, Meta retries, and `ingest` dedups the event while this
// runs again. Cost: a partial failure can leave two identical opted_out rows. The ledger
// is append-only + latest-wins, so that's cosmetic. A lost withdrawal is not.
//
// `evidence` is the DPDP s.6(10) proof burden — the fiduciary must PROVE the withdrawal
// happened and on what basis. Always pass the raw artefact.
async function applyOptOut(env, { profile_id, channel, purpose = 'marketing', state, source, evidence, unsubscribe_token }) {
  if (!profile_id) return { ok: false, error: 'profile_id_required' };
  if (state !== 'opted_out' && state !== 'opted_in') return { ok: false, error: 'bad_state' };

  const c = await recordConsent(env, {
    profile_id, channel, purpose, state, source, evidence, unsubscribe_token,
  });
  if (!c.ok) throw new Error(`consent_write_failed:${JSON.stringify(c.data)}`);

  // Best-effort mirror. The consent row is the system of record; a failed event write
  // must not re-trigger the whole webhook and duplicate the consent row.
  await A.sbComms('/rest/v1/events', env, {
    method: 'POST',
    body: JSON.stringify({
      profile_id,
      name: state === 'opted_out' ? 'opted_out' : 'opted_in',
      source: source || null,
      properties: { channel, purpose },
    }),
  }).catch((e) => console.log('optout_event_error', e?.message || String(e)));

  return { ok: true, profile_id, channel, purpose, state };
}

module.exports = { detectOptOut, normalise, applyOptOut, KEYWORDS_OUT, KEYWORDS_IN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: `25 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/optout.js commsops-worker/test/optout.test.js
git commit -m "commsops: opt-out detection + applyOptOut (single withdrawal writer)"
```

---

### Task 2: Wire STOP into the WhatsApp inbound webhook

**Files:**
- Modify: `05_Throttle/commsops-worker/src/wa-webhooks.js` (`handleInbound`, ~lines 92-116)
- Test: `05_Throttle/commsops-worker/test/optout.test.js`

- [ ] **Step 1: Write the failing test**

Insert into `test/optout.test.js`, inside the async IIFE, immediately **before** the final `console.log(`\n${pass} passed...`)` line:

```js
  console.log('wa-webhooks — inbound STOP');
  const waHook = require('../src/wa-webhooks.js');

  // resolve_identity returns a BARE UUID SCALAR (rpc.data), and sbComms parses res.text().
  function waFetch(calls) {
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/rest/v1/rpc/resolve_identity'))
        return { ok: true, status: 200, text: async () => JSON.stringify('p-stop') };
      return { ok: true, status: 201, text: async () => '[]' };
    };
  }
  const payload = (body) => ({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '123' },
      messages: [{ id: 'wamid.' + Math.floor(Math.random() * 1e6), from: '919999999999',
                   timestamp: '1700000000', type: 'text', text: { body } }],
    } }] }],
  });

  await t('bare STOP opts the profile out of WhatsApp marketing', async () => {
    const calls = []; waFetch(calls);
    await waHook.handleInbound({ ...ENV, CSOPS_WA_FORWARD_URL: '' }, payload('STOP'));
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent') && c.body?.state === 'opted_out');
    assert.ok(consent, 'a bare STOP must write an opted_out consent row');
    assert.equal(consent.body.channel, 'whatsapp');
    assert.equal(consent.body.purpose, 'marketing');
    assert.equal(consent.body.source, 'whatsapp_inbound_keyword');
    assert.equal(consent.body.evidence.keyword, 'STOP', 'raw text is the s.6(10) proof');
  });

  await t('support message does NOT opt out', async () => {
    const calls = []; waFetch(calls);
    await waHook.handleInbound({ ...ENV, CSOPS_WA_FORWARD_URL: '' },
      payload('my car stopped working, please help'));
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/consent')),
      'a support message must never be read as a withdrawal');
  });

  await t('a failed consent write PROPAGATES (Meta must retry, not lose the STOP)', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/rpc/resolve_identity'))
        return { ok: true, status: 200, text: async () => JSON.stringify('p-stop') };
      if (u.includes('/rest/v1/consent'))
        return { ok: false, status: 500, text: async () => '{"message":"boom"}' };
      return { ok: true, status: 201, text: async () => '[]' };
    };
    await assert.rejects(
      () => waHook.handleInbound({ ...ENV, CSOPS_WA_FORWARD_URL: '' }, payload('STOP')),
      /consent_write_failed/,
      'must throw so the route 500s and Meta redelivers');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: FAIL — "a bare STOP must write an opted_out consent row"

- [ ] **Step 3: Write minimal implementation**

In `src/wa-webhooks.js`, add to the requires at the top:

```js
const { detectOptOut, applyOptOut } = require('./optout.js');
```

Replace the `for (const m of inbound)` loop body inside `handleInbound` with:

```js
  for (const m of inbound) {
    if (!m.from) continue;
    // 1. open the 24h window
    await A.sbComms('/rest/v1/wa_windows?on_conflict=identifier_value', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ identifier_value: m.from, last_inbound_at: m.ts, updated_at: new Date().toISOString() }),
    });
    // 2. substrate — resolve/create profile + append the inbound event
    const res = await ingest(env, {
      identifiers: [{ type: 'phone', value: `+${wa.toWaId(m.from)}` }],
      name: 'whatsapp_inbound',
      occurred_at: m.ts,
      source: 'whatsapp_webhook',
      idempotency_key: m.provider_message_id ? `wa:inbound:${m.provider_message_id}` : undefined,
      properties: { channel: 'whatsapp', text: m.text, type: m.type, phone_number_id: m.phone_number_id,
                    name: m.name, media: m.media, provider_message_id: m.provider_message_id },
    }).catch((e) => { console.log('wa_ingest_error', e?.message || String(e)); return null; });

    // 2b. honour STOP/START. Our approved marketing templates carry "Reply STOP to
    // unsubscribe" and Meta requires opt-out requests to be respected. Marketing-only —
    // this never blocks the customer's order/shipping updates (see optout.js).
    //
    // NOT wrapped in try/catch and NOT gated on res.deduped, both deliberate:
    //  - errors must propagate so the route 500s and Meta redelivers (a swallowed error
    //    = a silently lost withdrawal, the one failure this feature exists to prevent);
    //  - a redelivery re-runs this while ingest dedups the event, which can write a second
    //    identical opted_out row. Append-only + latest-wins, so that is cosmetic.
    // parseInbound normalises button/interactive replies into m.text, so a tapped
    // "Stop promotions" button lands here too.
    const intent = detectOptOut(m.text);
    if (intent && res?.profile_id) {
      await applyOptOut(env, {
        profile_id: res.profile_id,
        channel: 'whatsapp',
        purpose: 'marketing',
        state: intent === 'opt_out' ? 'opted_out' : 'opted_in',
        source: 'whatsapp_inbound_keyword',
        evidence: {
          keyword: m.text,
          provider_message_id: m.provider_message_id || null,
          from: m.from,
          received_at: m.ts || null,
        },
      });
    }
  }
```

**Do not** skip the Pitstop forward for opt-out messages — the agent should still see that the customer said STOP.

- [ ] **Step 4: Run tests**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js && node test/wa.test.js`
Expected: both pass; `wa.test.js` must not regress.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/wa-webhooks.js commsops-worker/test/optout.test.js
git commit -m "commsops: honour WhatsApp STOP/START -> marketing consent withdrawal"
```

---

### Task 3: Agent-actioned opt-out (`optOutProfile`)

Meta requires honouring opt-out requests **"either on or off WhatsApp"** — a request *about* WhatsApp arriving by any route (a Pitstop email, an IG DM, a phone call). That's a semantic judgement no keyword matcher can make, so it needs a human-actioned path. It's also the backstop for the accepted English-only gap, and the DPDP s.6(4) safety valve.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js`

- [ ] **Step 1: Add the require**

At the top of `index.js`, alongside the other module requires:

```js
const OPTOUT = require('./optout.js');
```

- [ ] **Step 2: Add the action**

Find `case 'recordConsent':` (~line 254). Add immediately **after** its closing brace — note it uses `A.canConsentAdmin(auth.permissions)`, matching its neighbour exactly (`A.can` does not exist):

```js
    case 'optOutProfile': {            // agent-actioned withdrawal — Meta "on or off WhatsApp"
      if (!A.canConsentAdmin(auth.permissions)) return err('forbidden', 403);
      if (!body.profile_id) return err('profile_id_required', 400);
      const channels = Array.isArray(body.channels) && body.channels.length
        ? body.channels : ['email', 'sms', 'whatsapp'];
      const state = body.state === 'opted_in' ? 'opted_in' : 'opted_out';
      const applied = [];
      for (const ch of channels) {
        applied.push(await OPTOUT.applyOptOut(env, {
          profile_id: body.profile_id,
          channel: ch,
          purpose: 'marketing',
          state,
          source: 'agent_actioned',
          evidence: {
            actioned_by: auth.email || auth.userId || 'unknown',
            reason: body.reason || null,
            requested_via: body.requested_via || null,
            actioned_at: new Date().toISOString(),
          },
        }));
      }
      return ok({ applied });
    }
```

- [ ] **Step 3: Verify it parses**

Run: `cd 05_Throttle/commsops-worker && node -e "require('./src/optout.js'); console.log('optout ok')"`
Expected: `optout ok`

(`index.js` can't be required standalone — it's a Workers ES-module entry. Syntax is validated by `wrangler deploy` in Task 5.)

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/index.js
git commit -m "commsops: optOutProfile — agent-actioned withdrawal (off-WhatsApp requests)"
```

---

### Task 4: All-channel withdrawal on the unsubscribe page (s.6(4) parity)

`handleUnsubscribe` today opts out **only the token's own channel** (`row.channel`), so an email unsubscribe leaves WhatsApp promos running. A customer who believes they've unsubscribed and keeps getting WhatsApp marketing is exactly who **blocks** the number — which damages the marketing number's quality rating, the thing we can least afford to burn at cutover.

**Decision:** default one-click stays *this channel* (predictable — it matches the link they clicked); add an explicit **"stop all marketing"** link on the confirmation page. Not automatic: silently withdrawing channels the customer didn't ask about is its own surprise.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/webhooks.js` (`handleUnsubscribe` + `page`, lines 87-119)
- Modify: `05_Throttle/commsops-worker/src/index.js` (the `/unsubscribe` route, ~line 561)

- [ ] **Step 1: Add the require**

At the top of `src/webhooks.js`:

```js
const { applyOptOut } = require('./optout.js');
```

- [ ] **Step 2: Replace `handleUnsubscribe`**

```js
// One-click List-Unsubscribe target. `all=1` withdraws marketing on EVERY channel
// (DPDP s.6(4) — withdrawal must be as easy as consent was to give).
async function handleUnsubscribe(env, token, all) {
  if (!token) return { html: page('Invalid unsubscribe link.'), status: 400 };
  const c = await A.sbComms(
    `/rest/v1/consent?unsubscribe_token=eq.${A.enc(token)}&select=profile_id,channel&order=captured_at.desc&limit=1`, env);
  const row = c.ok ? c.data?.[0] : null;
  if (!row) return { html: page('This unsubscribe link is no longer valid.'), status: 404 };

  const channels = all ? ['email', 'sms', 'whatsapp'] : [row.channel];
  for (const ch of channels) {
    await applyOptOut(env, {
      profile_id: row.profile_id,
      channel: ch,
      purpose: 'marketing',
      state: 'opted_out',
      source: all ? 'unsubscribe_link_all' : 'unsubscribe_link',
      // Forward the token — unsubscribeUrl() keys off the LATEST consent row's token, and
      // a token-less row makes it mint a fresh one on the next send (token churn).
      // Only stamp it on the row for the token's own channel; the others never had it.
      unsubscribe_token: ch === row.channel ? token : null,
      evidence: { unsubscribe_token: token, all_channels: !!all, at: new Date().toISOString() },
    });
  }

  if (all) {
    return { html: page("You've been unsubscribed from all Legend of Toys marketing. You'll still get essential order updates."), status: 200 };
  }
  return {
    html: page("You've been unsubscribed from marketing emails. You'll still get essential order updates.",
      `<p style="margin-top:18px"><a href="/unsubscribe?token=${encodeURIComponent(token)}&all=1" style="color:#F2CD1A;font-size:13px">Stop all marketing (email, SMS and WhatsApp)</a></p>`),
    status: 200,
  };
}
```

- [ ] **Step 3: Replace `page` (exact current markup + one `extra` slot)**

```js
function page(msg, extra) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe · Legend of Toys</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#282828;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1c1c1c;border:1px solid #333;border-radius:14px;padding:40px;max-width:440px;text-align:center}
.bar{height:4px;width:60px;background:#F2CD1A;border-radius:2px;margin:0 auto 20px}
h1{font-size:18px;margin:0 0 10px}p{color:#bbb;font-size:14px;line-height:1.5;margin:0}</style></head>
<body><div class="card"><div class="bar"></div><h1>Legend of Toys</h1><p>${msg}</p>${extra || ''}</div></body></html>`;
}
```

- [ ] **Step 4: Pass the flag through the route**

In `src/index.js`, replace the `/unsubscribe` route:

```js
    if (url.pathname === '/unsubscribe' && request.method === 'GET') {
      const r = await handleUnsubscribe(env, url.searchParams.get('token'), url.searchParams.get('all') === '1');
      return new Response(r.html, { status: r.status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
```

- [ ] **Step 5: Verify it parses**

Run: `cd 05_Throttle/commsops-worker && node -e "require('./src/webhooks.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/webhooks.js commsops-worker/src/index.js
git commit -m "commsops: all-channel marketing withdrawal on unsubscribe (DPDP s.6(4) parity)"
```

---

### Task 5: Deploy + live verification

- [ ] **Step 1: Full suite**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker
for f in test/*.test.js; do echo "== $f"; node "$f" || exit 1; done
```
Expected: all pass. `wa.test.js`, `journey-*.test.js`, `segment-entry.test.js`, `shopflo.test.js` must not regress.

- [ ] **Step 2: Push, then deploy** (⚠️ commsops also carries the journey engine + the `*/5` scheduler — confirm with Afshaan before deploying)

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git push
cd commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; output still shows `schedule */5`, `Consumer for commsops-broadcast`, `Consumer for commsops-dlq`, `workflow: commsops-journey`.

- [ ] **Step 3: Live smoke — real STOP on the sandbox number**

From the phone already registered as a test recipient, WhatsApp **`STOP`** to **+1 555-174-8518**. Then:

```sql
select c.profile_id, c.channel, c.purpose, c.state, c.source, c.evidence, c.captured_at
from comms.consent c
join comms.identifiers i on i.profile_id = c.profile_id
where i.value = '<your E.164 phone>' and c.channel = 'whatsapp'
order by c.captured_at desc limit 3;
```
Expected: one row — `purpose=marketing`, `state=opted_out`, `source=whatsapp_inbound_keyword`, `evidence.keyword='STOP'`. **Note the returned `profile_id` for Step 4.**

- [ ] **Step 4: Prove it did NOT suppress (the whole point)**

```sql
select count(*) as suppressions from comms.suppressions where profile_id = '<profile_id from Step 3>';
```
Expected: `0`. A marketing withdrawal must never suppress — the customer's order updates must survive it.

- [ ] **Step 5: START re-subscribes**

WhatsApp **`START`** to the same number; re-run Step 3's query.
Expected: a newer row, `state=opted_in`.

- [ ] **Step 6: Knowledge files + commit**

- `systems/relay.md` — new opt-out section: STOP/START honoured on WA inbound → marketing consent withdrawal (never suppression); `optOutProfile` for off-WhatsApp requests; all-channel unsubscribe; the English-only gap.
- `BACKLOG.md` — close `[relay] [P1] WhatsApp opt-out (STOP) is NOT handled`. **Add** `[relay] [MED] STOP detection is English-only` (DPDP s.6(4) exposure; non-Latin scripts normalise to '' and are never detected; agent-actioned path is the backstop). Leave the WA-consent-rebuild + s.5(2)-notice items open.

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add -A && git commit -m "knowledge: WA opt-out handling live [2026-07-17]" && git push
```

---

## Deferred — recorded, not fixed here

Found during the Rev-2 hostile review. None block this plan; all are worth a BACKLOG line.

1. **`latestConsent` has no tiebreaker.** It orders by `captured_at desc, limit 1`. Two rows in the same millisecond → non-deterministic winner. Same class as the S132 shift-version bug this codebase already fixed with an `effective_from.desc, created_at.desc` tiebreaker. Low probability (a STOP→START flip inside 1ms), known pattern. Fix = add `created_at.desc` as a secondary sort.
2. **`unsubscribeUrl` PATCHes the append-only ledger** to backfill a missing token. Only adds a token, never changes state — but mutating rows that are DPDP s.6(10) evidence is a smell. Consider a separate `unsubscribe_tokens` table.
3. **`/unsubscribe` is a GET.** Mail scanners and link-prefetchers follow GETs, which can trigger an unsubscribe nobody clicked. RFC 8058 one-click expects `POST` with `List-Unsubscribe-Post`. Pre-existing; worth its own look before volume ramps.
4. **Webhook subrequest budget.** `handleInbound` now does up to 5 sequential `sbComms` calls per inbound message (window, resolve, event, consent, event-mirror) inside a Worker capped at 50 subrequests. Opt-outs are rare, but a batched Meta payload with many messages could approach it after the support cutover. Move the consent write to the queue if inbound volume grows.

## Self-review

**Spec coverage.** STOP handling → Tasks 1-2. Cross-channel ("on or off WhatsApp") → Task 3 (agent-actioned) + Task 4 (all-channel unsubscribe). s.6(10) proof → `evidence` on every path. s.6(4) ease-comparability → Task 4. Processor cascade → verified non-issue, no task. English-only gap → accepted, tested as a known gap, BACKLOG'd in Task 5 Step 6. WA-consent rebuild + s.5(2) → out of scope, legal-gated. Shortener → separate plan.

**Type consistency.** `applyOptOut(env, {profile_id, channel, purpose, state, source, evidence, unsubscribe_token})` — identical at all four call sites (Tasks 2, 3, 4). `detectOptOut(text) -> 'opt_out'|'opt_in'|null`; callers map to `state` explicitly. `A.canConsentAdmin(auth.permissions)` matches the neighbouring `recordConsent` case. `recordConsent` used unchanged from `consent.js`. Test stubs implement `text()` (not `json()`) and return a bare uuid scalar for `resolve_identity` — matching `sbComms` and `ingest`.
