# Relay Opt-Out & Consent Compliance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a customer's "STOP" actually stop marketing WhatsApp — writing a provable, auditable withdrawal to the consent ledger — and give withdrawal parity across every channel it can arrive on.

**Architecture:** One new pure-ish module `src/optout.js` owns (a) keyword detection and (b) the single writer that appends a withdrawal to `comms.consent` + mirrors it as a substrate event. Every opt-out path — WhatsApp inbound keyword, the email unsubscribe link, and an agent-actioned admin call — funnels through that one writer, so proof/evidence is uniform and there is exactly one place withdrawal semantics live. No new tables; `comms.consent` already has the right grain (`profile × channel × purpose`) and an unused `evidence jsonb`.

**Tech Stack:** Cloudflare Workers (commsops), Supabase/PostgREST via `src/auth.js sbComms`, plain-Node unit tests (`node test/x.test.js`, `assert`, no framework).

---

## Context an engineer needs before starting

**Read these first:** `systems/relay.md` (the send gate + TEST MODE), `reference/bitespeed.md` §1 (WABA inventory).

### The load-bearing decision: withdrawal = consent opt-out, NOT suppression

`comms` has two block mechanisms and they are **not** interchangeable:

| | Grain | Gate step | Blocks |
|---|---|---|---|
| `comms.suppressions` | `channel × value` (address/phone) | ① — first, absolute | **Everything, including transactional** |
| `comms.consent` | `profile × channel × purpose` | ② — marketing only | Marketing only |

A marketing STOP **must** write a consent opt-out, never a suppression. If it wrote a suppression, a customer who stops promos would also stop receiving **their own order and shipping updates**. That is wrong operationally, wrong under Meta's policy (which is about promotional messaging), and wrong under DPDP — s.6(5)'s illustration is explicit that withdrawal does not undo a paid order's fulfilment. Suppressions stay reserved for hard blocks (Shopify GDPR redaction, hard bounces, spam complaints).

### Why the compliance case is real (but not November-urgent)

- **Meta** (WhatsApp Business Messaging Policy, verified against primary source): *"You must respect all requests (either on or off WhatsApp) by a person to block, discontinue, or otherwise opt out of communications from you via WhatsApp."* Meta does **not** mandate a "Reply STOP" footer and states **no 24h SLA** — both are vendor folklore. But **our approved template `lot_abandoned_cart_01` promises "Reply STOP to unsubscribe"**, so we are bound by our own copy.
- **DPDP** s.6(4): withdrawal must be *"with the ease of doing so being comparable to the ease with which such consent was given"* — statutory, not guidance. s.6(10) puts the **burden of proof on us** — hence `evidence`.
- **Timing:** DPDP consent/notice/rights obligations commence **14 May 2027**, not Nov 2026 (that date is Consent Manager registration only, and does not apply to LOT). So this is *correctness*, not a deadline scramble.

### What is deliberately NOT in this plan

- **Processor cascade (s.6(6))** — verified a non-issue for our own rails: no audience/contact list exists at Resend (the adapter only calls `POST /emails` per message), so a gate-blocked send never hands the address to the processor. The real cascade exposure is **BiteSpeed's 125k-profile CDP**, which is the exit, not a code task.
- **The 47k SMS-inferred WhatsApp consent base** — needs a legal opinion + an Afshaan decision. Highest DPDP exposure; tracked in BACKLOG, not fixable in code.
- **s.5(2) legacy notice campaign** to the ~92k — a campaign, gated on the same legal opinion.
- **Phase-B shortener** — separate plan, needs a DNS record on `go.legendoftoys.com`.
- **Third Schedule 3-year erasure** — does not apply (threshold is 2 crore registered users; LOT is at ~92k). Do not build it.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/optout.js` | Keyword detection (pure) + `applyOptOut` — the single withdrawal writer. Channel-agnostic so WA/email/admin all share it. |
| **Create** `test/optout.test.js` | Unit tests. Pure detection needs no network; `applyOptOut` stubs `fetch`. |
| **Modify** `src/wa-webhooks.js` | `handleInbound` — capture `profile_id` from ingest, detect keyword, apply. |
| **Modify** `src/index.js` | New JWT-gated `optOutProfile` action (agent-actioned, for requests arriving off-WhatsApp). |
| **Modify** `src/webhooks.js` | `handleUnsubscribe` — add an all-channels marketing withdrawal (s.6(4) parity). |

---

### Task 1: Opt-out keyword detection (pure)

**Files:**
- Create: `05_Throttle/commsops-worker/src/optout.js`
- Test: `05_Throttle/commsops-worker/test/optout.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/optout.test.js`:

```js
// Node unit tests for opt-out keyword detection + the withdrawal writer.
// Run: node test/optout.test.js   (Node 18+)
const assert = require('assert');
const { detectOptOut } = require('../src/optout.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

console.log('detectOptOut — opt-out keywords');
t('bare STOP', () => assert.equal(detectOptOut('STOP'), 'opt_out'));
t('lowercase stop', () => assert.equal(detectOptOut('stop'), 'opt_out'));
t('trailing punctuation', () => assert.equal(detectOptOut('Stop.'), 'opt_out'));
t('exclamation', () => assert.equal(detectOptOut('STOP!'), 'opt_out'));
t('surrounding whitespace', () => assert.equal(detectOptOut('  stop  '), 'opt_out'));
t('hyphenated OPT-OUT', () => assert.equal(detectOptOut('OPT-OUT'), 'opt_out'));
t('unsubscribe', () => assert.equal(detectOptOut('unsubscribe'), 'opt_out'));
t('stop promotions', () => assert.equal(detectOptOut('Stop promotions'), 'opt_out'));

console.log('detectOptOut — opt-in keywords');
t('START', () => assert.equal(detectOptOut('START'), 'opt_in'));
t('subscribe', () => assert.equal(detectOptOut('subscribe'), 'opt_in'));

console.log('detectOptOut — MUST NOT false-positive (support messages)');
t('complaint containing stop', () =>
  assert.equal(detectOptOut('please stop sending me broken cars'), null));
t('stop the order', () => assert.equal(detectOptOut('can you stop the order'), null));
t('cancel my order is NOT an opt-out', () =>
  assert.equal(detectOptOut('cancel my order please'), null));
t('greeting', () => assert.equal(detectOptOut('Hi'), null));

console.log('detectOptOut — degenerate input');
t('empty string', () => assert.equal(detectOptOut(''), null));
t('null', () => assert.equal(detectOptOut(null), null));
t('undefined', () => assert.equal(detectOptOut(undefined), null));
t('emoji only', () => assert.equal(detectOptOut('🛑'), null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: FAIL — `Cannot find module '../src/optout.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/optout.js`:

```js
// Opt-out / opt-in intent detection + the single withdrawal writer.
// Channel-agnostic: WhatsApp inbound, the email unsubscribe link, and the agent-actioned
// admin call all funnel through applyOptOut so evidence is uniform and withdrawal
// semantics live in exactly one place.

const A = require('./auth.js');
const { recordConsent } = require('./consent.js');

// EXACT-MATCH, not substring — deliberate. "please stop sending me broken cars" is a
// support complaint, not a withdrawal; substring-matching "stop" would silently opt that
// customer out of marketing while they were asking for help. That failure is invisible and
// unrecoverable (we'd never know to re-ask). A missed keyword, by contrast, is visible —
// the customer repeats themselves or an agent actions it via optOutProfile. Bare keywords
// are also the TRAI/Meta convention, so exact-match is both safer AND standard.
const KEYWORDS_OUT = new Set([
  'stop', 'stopall', 'stop promotions', 'unsubscribe', 'unsub',
  'optout', 'opt out', 'end', 'quit', 'revoke',
]);
const KEYWORDS_IN = new Set(['start', 'unstop', 'subscribe', 'optin', 'opt in', 'resume']);

// Lowercase, strip anything that isn't a letter or space (punctuation, digits, emoji),
// collapse whitespace. "OPT-OUT" -> "opt out"; "Stop." -> "stop"; "🛑" -> "".
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

module.exports = { detectOptOut, normalise, KEYWORDS_OUT, KEYWORDS_IN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: `19 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/optout.js commsops-worker/test/optout.test.js
git commit -m "commsops: opt-out keyword detection (exact-match, pure)"
```

---

### Task 2: The withdrawal writer (`applyOptOut`)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/optout.js`
- Test: `05_Throttle/commsops-worker/test/optout.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/optout.test.js`, immediately **before** the final `console.log`/`process.exit` lines:

```js
// --- applyOptOut: stub fetch, assert what we POST ---
const { applyOptOut } = require('../src/optout.js');

async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 201, json: async () => ([]), text: async () => '[]' };
  };
  return calls;
}

(async () => {
  await ta('applyOptOut writes consent + event with evidence', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, {
      profile_id: 'p1', channel: 'whatsapp', state: 'opted_out',
      source: 'whatsapp_inbound_keyword', evidence: { keyword: 'STOP' },
    });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent'));
    const event = calls.find((c) => c.url.includes('/rest/v1/events'));
    assert.ok(consent, 'must POST a consent row');
    assert.equal(consent.body.purpose, 'marketing', 'defaults to the marketing purpose');
    assert.equal(consent.body.state, 'opted_out');
    assert.equal(consent.body.channel, 'whatsapp');
    assert.deepEqual(consent.body.evidence, { keyword: 'STOP' }, 's.6(10) proof must persist');
    assert.ok(event, 'must mirror as a substrate event');
    assert.equal(event.body.name, 'opted_out');
  });

  await ta('applyOptOut NEVER writes a suppression (would kill transactional)', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/suppressions')),
      'a marketing withdrawal must not suppress — order updates must survive it');
  });

  await ta('applyOptOut opt_in emits opted_in', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_in', source: 's' });
    assert.equal(calls.find((c) => c.url.includes('/rest/v1/events')).body.name, 'opted_in');
  });

  await ta('applyOptOut requires profile_id', async () => {
    stubFetch();
    const r = await applyOptOut(ENV, { channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'profile_id_required');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

Then **delete** the old trailing two lines from Task 1's file (`console.log(...)` and `process.exit(...)`) — the async IIFE above now owns the summary, otherwise it prints before the async tests finish.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: FAIL — `applyOptOut is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/optout.js`, before `module.exports`:

```js
// Append a withdrawal (or re-subscribe) to the consent ledger + mirror it as an event.
//
// Deliberately NOT a suppression: `comms.suppressions` is gate step ① and blocks EVERY
// purpose including transactional, so suppressing here would stop a customer's own order
// and shipping updates. `comms.consent` is gate step ②, which only gates marketing —
// exactly the semantics of "stop the promos, keep my delivery texts". This matches Meta's
// promotional-messaging policy and DPDP s.6(5) (withdrawal does not undo the paid order).
//
// `evidence` is the s.6(10) proof burden — the fiduciary must be able to PROVE the
// withdrawal happened and on what basis. Always pass the raw artefact (the message text,
// the provider message id, who actioned it).
async function applyOptOut(env, { profile_id, channel, purpose = 'marketing', state, source, evidence }) {
  if (!profile_id) return { ok: false, error: 'profile_id_required' };
  if (state !== 'opted_out' && state !== 'opted_in') return { ok: false, error: 'bad_state' };

  await recordConsent(env, { profile_id, channel, purpose, state, source, evidence });
  await A.sbComms('/rest/v1/events', env, {
    method: 'POST',
    body: JSON.stringify({
      profile_id,
      name: state === 'opted_out' ? 'opted_out' : 'opted_in',
      source: source || null,
      properties: { channel, purpose },
    }),
  });
  return { ok: true, profile_id, channel, purpose, state };
}
```

Update the export line:

```js
module.exports = { detectOptOut, normalise, applyOptOut, KEYWORDS_OUT, KEYWORDS_IN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: `23 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/optout.js commsops-worker/test/optout.test.js
git commit -m "commsops: applyOptOut — single withdrawal writer w/ s.6(10) evidence"
```

---

### Task 3: Wire STOP into the WhatsApp inbound webhook

**Files:**
- Modify: `05_Throttle/commsops-worker/src/wa-webhooks.js:92-116` (`handleInbound`)
- Test: `05_Throttle/commsops-worker/test/optout.test.js`

**Note:** `handleInbound` currently discards ingest's return value (`.catch(...)` only). `ingest()` returns `{ ok, profile_id, event_id, deduped }` — we need `profile_id` to write consent against.

- [ ] **Step 1: Write the failing test**

Insert into `test/optout.test.js`, inside the async IIFE before the final summary:

```js
  await ta('WA inbound "STOP" opts the profile out of marketing', async () => {
    const waHook = require('../src/wa-webhooks.js');
    const calls = stubFetch();
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      // resolve_identity RPC -> a profile id
      if (u.includes('/rest/v1/rpc/resolve_identity')) {
        return { ok: true, status: 200, json: async () => ({ profile_id: 'p-stop' }), text: async () => '' };
      }
      return { ok: true, status: 201, json: async () => ([]), text: async () => '[]' };
    };
    await waHook.handleInbound({ ...ENV, CSOPS_WA_FORWARD_URL: '' }, {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123' },
        messages: [{ id: 'wamid.1', from: '919999999999', timestamp: '1700000000',
                     type: 'text', text: { body: 'STOP' } }],
      } }] }],
    });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent') && c.body?.state === 'opted_out');
    assert.ok(consent, 'a bare STOP must write an opted_out consent row');
    assert.equal(consent.body.channel, 'whatsapp');
    assert.equal(consent.body.purpose, 'marketing');
    assert.equal(consent.body.source, 'whatsapp_inbound_keyword');
    assert.equal(consent.body.evidence.keyword, 'STOP', 'raw text is the proof');
  });

  await ta('WA inbound support message does NOT opt out', async () => {
    const waHook = require('../src/wa-webhooks.js');
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/rest/v1/rpc/resolve_identity')) {
        return { ok: true, status: 200, json: async () => ({ profile_id: 'p-help' }), text: async () => '' };
      }
      return { ok: true, status: 201, json: async () => ([]), text: async () => '[]' };
    };
    await waHook.handleInbound({ ...ENV, CSOPS_WA_FORWARD_URL: '' }, {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123' },
        messages: [{ id: 'wamid.2', from: '919999999999', timestamp: '1700000000',
                     type: 'text', text: { body: 'my car stopped working, please help' } }],
      } }] }],
    });
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/consent')),
      'a support message must never be read as a withdrawal');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js`
Expected: FAIL on the first — "a bare STOP must write an opted_out consent row"

- [ ] **Step 3: Write minimal implementation**

In `src/wa-webhooks.js`, add to the requires at the top of the file:

```js
const { detectOptOut, applyOptOut } = require('./optout.js');
```

Replace the body of the `for (const m of inbound)` loop in `handleInbound` (currently lines ~94-112) with:

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
    // unsubscribe", and Meta requires opt-out requests to be respected. Marketing-only:
    // this never blocks the customer's order/shipping updates (see optout.js).
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
      }).catch((e) => console.log('wa_optout_error', e?.message || String(e)));
    }
  }
```

**Do not** skip the Pitstop forward for opt-out messages — the agent should still see that the customer said STOP (it's context, and Meta's "on or off WhatsApp" means agents may need to action related requests).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd 05_Throttle/commsops-worker && node test/optout.test.js && node test/wa.test.js`
Expected: both suites pass; `wa.test.js` must not regress.

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/wa-webhooks.js commsops-worker/test/optout.test.js
git commit -m "commsops: honour WhatsApp STOP/START -> marketing consent withdrawal"
```

---

### Task 4: Agent-actioned opt-out (`optOutProfile`)

Meta requires honouring opt-out requests **"either on or off WhatsApp"** — i.e. a request *about* WhatsApp that arrives by any route (a Pitstop email, an IG DM, a phone call). That is a semantic judgement a keyword matcher cannot make, so it needs a human-actioned path. This is also the DPDP s.6(4) "ease comparable" backstop.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` (add a case to the JWT-authenticated action switch, next to `recordConsent`)

- [ ] **Step 1: Add the action**

Find the existing `case 'recordConsent':` in the action switch. Add immediately after it:

```js
    case 'optOutProfile': {   // agent-actioned withdrawal — Meta "on or off WhatsApp"
      if (!A.can(auth, 'data_consent_admin')) return err('forbidden', 403);
      if (!body.profile_id) return err('profile_id_required', 400);
      const channels = Array.isArray(body.channels) && body.channels.length
        ? body.channels : ['email', 'sms', 'whatsapp'];
      const out = [];
      for (const ch of channels) {
        out.push(await OPTOUT.applyOptOut(env, {
          profile_id: body.profile_id,
          channel: ch,
          purpose: 'marketing',
          state: body.state === 'opted_in' ? 'opted_in' : 'opted_out',
          source: 'agent_actioned',
          evidence: {
            actioned_by: auth?.email || auth?.sub || 'unknown',
            reason: body.reason || null,
            requested_via: body.requested_via || null,
            actioned_at: new Date().toISOString(),
          },
        }));
      }
      return ok({ applied: out });
    }
```

Add the require at the top of `index.js`, alongside the other module requires:

```js
const OPTOUT = require('./optout.js');
```

- [ ] **Step 2: Verify it parses**

Run: `cd 05_Throttle/commsops-worker && node -e "require('./src/index.js')" 2>&1 | head -3`
Expected: no output, or only a Workers-runtime warning — **not** a SyntaxError.

- [ ] **Step 3: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/index.js
git commit -m "commsops: optOutProfile — agent-actioned withdrawal (off-WhatsApp requests)"
```

---

### Task 5: All-channel withdrawal on the unsubscribe page (s.6(4) parity)

Today `handleUnsubscribe` opts out **only the channel the token belongs to** (`row.channel`), so an email unsubscribe leaves WhatsApp marketing live. DPDP s.6(4) requires withdrawal to be as easy as consent was to give; a customer who thinks they've unsubscribed but keeps getting WhatsApp promos is the exact failure that provokes a Board complaint (and, on WhatsApp, a **block** — which damages the number's quality rating).

**Decision:** keep the default one-click as *this channel* (predictable, matches the link they clicked), and add an explicit **"stop all marketing"** link on the confirmation page. Not automatic, because silently withdrawing channels a customer didn't ask about is its own surprise.

**Files:**
- Modify: `05_Throttle/commsops-worker/src/webhooks.js:87-109` (`handleUnsubscribe`), `src/index.js` (route)

- [ ] **Step 1: Implement the all-channel branch**

In `src/webhooks.js`, add to the requires at the top:

```js
const { applyOptOut } = require('./optout.js');
```

Replace `handleUnsubscribe` with:

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

Update `page()` to accept the extra block:

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

**Note:** verify the existing `page()` body markup before overwriting — reuse whatever the current `.card`/`h1` structure is; only the `${extra || ''}` slot and the second parameter are new.

- [ ] **Step 2: Pass the flag through the route**

In `src/index.js`, update the unsubscribe route:

```js
    if (url.pathname === '/unsubscribe' && request.method === 'GET') {
      const r = await handleUnsubscribe(env, url.searchParams.get('token'), url.searchParams.get('all') === '1');
      return new Response(r.html, { status: r.status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
    }
```

- [ ] **Step 3: Verify it parses**

Run: `cd 05_Throttle/commsops-worker && node -e "require('./src/webhooks.js'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add commsops-worker/src/webhooks.js commsops-worker/src/index.js
git commit -m "commsops: all-channel marketing withdrawal on unsubscribe (DPDP s.6(4) parity)"
```

---

### Task 6: Deploy + live verification

**Files:** none (deploy + verify)

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker
for f in test/*.test.js; do echo "== $f"; node "$f" || exit 1; done
```
Expected: every suite passes. `wa.test.js`, `journey-*.test.js`, `segment-entry.test.js` must not regress.

- [ ] **Step 2: Push, then deploy**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && git push
cd commsops-worker && npx wrangler deploy
```
Expected: deploy succeeds; output still shows `schedule */5`, `Consumer for commsops-broadcast`, `Consumer for commsops-dlq`, `workflow: commsops-journey`.

- [ ] **Step 3: Live smoke — a real STOP on the sandbox number**

From the phone already registered as a test recipient, WhatsApp **`STOP`** to the sandbox number **+1 555-174-8518**. Then:

```sql
select c.channel, c.purpose, c.state, c.source, c.evidence, c.captured_at
from comms.consent c
join comms.identifiers i on i.profile_id = c.profile_id
where i.value = '<your E.164 phone>' and c.channel = 'whatsapp'
order by c.captured_at desc limit 3;
```
Expected: one row — `purpose=marketing`, `state=opted_out`, `source=whatsapp_inbound_keyword`, `evidence.keyword='STOP'`.

- [ ] **Step 4: Verify the gate now blocks marketing but NOT transactional**

```sql
-- marketing must now be blocked for this profile; utility must still pass.
select state from comms.consent
where profile_id = '<profile_id>' and channel='whatsapp' and purpose='marketing'
order by captured_at desc limit 1;   -- expect: opted_out
```
Then confirm no suppression was created (this is the whole point):
```sql
select count(*) from comms.suppressions where profile_id = '<profile_id>';
-- expect: 0  — a marketing withdrawal must NEVER suppress
```

- [ ] **Step 5: Send START and confirm re-subscribe**

WhatsApp **`START`** to the same number, then re-run the Step-3 query.
Expected: a newer row with `state=opted_in`.

- [ ] **Step 6: Update the knowledge files + commit**

- `systems/relay.md` — add an opt-out section: STOP/START honoured on WA inbound → marketing consent withdrawal (never suppression); `optOutProfile` for off-WhatsApp requests; all-channel unsubscribe.
- `BACKLOG.md` — close the `[relay] [P1] WhatsApp opt-out (STOP) is NOT handled` item; leave the WA-consent-rebuild and s.5(2)-notice items open.

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add -A && git commit -m "knowledge: WA opt-out handling live [2026-07-17]" && git push
```

---

## Self-review

**Spec coverage.** STOP handling → Tasks 1-3. Cross-channel ("on or off WhatsApp") → Task 4 (agent-actioned) + Task 5 (all-channel unsubscribe). s.6(10) proof burden → `evidence` on every path (Tasks 2-5). s.6(4) ease-comparability → Task 5. Processor cascade → verified non-issue, documented above, no task. WA-consent rebuild + s.5(2) notice → explicitly out of scope, gated on legal. Shortener → separate plan.

**Type consistency.** `applyOptOut(env, {profile_id, channel, purpose, state, source, evidence})` — same signature at all four call sites (Tasks 3, 4, 5). `detectOptOut(text) -> 'opt_out'|'opt_in'|null` — callers map to `state` explicitly rather than passing the intent through. `recordConsent` is used unchanged from `consent.js`.

**Known risk to watch.** `handleInbound` now does up to 4 sequential `sbComms` calls per inbound message (window, ingest, consent, event) inside a webhook. Meta retries on non-2xx, and Workers cap at 50 subrequests — a batched payload with many messages could approach it. Opt-outs are rare enough that this is fine in practice, but if inbound volume grows after the support cutover, move the consent write to the queue.
