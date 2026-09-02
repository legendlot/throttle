# Relay Capture Spine (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship commsops' first unauthenticated public write surface — an embeddable form that turns a website submission into a profile, an identifier, a consent row and a durable submission record — with a back-in-stock form live on one PDP.

**Architecture:** A new `/f/*` route block in `commsops-worker/src/index.js`, sitting beside the existing `/web/*` bot block and reusing its origin-scoped CORS helper rather than the worker's global wildcard CORS. All logic lives in one new module, `src/forms.js`, modelled directly on `src/subscribe.js`. Two new tables in the `comms` schema. Cloudflare Turnstile is verified server-side before any write.

**Tech Stack:** Cloudflare Workers (CommonJS, no build step), Supabase/PostgREST via `src/auth.js`'s `sbComms`, Cloudflare Turnstile, plain Node `assert` test scripts.

**Spec:** `docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md` — read it before Task 1. The plan argues from the spec; both travel together.

## Global Constraints

- **CommonJS only.** `require` / `module.exports`. No TypeScript, no bundler, no framework. Match `src/subscribe.js`.
- **Tests are plain Node scripts**, not a framework. One file per area under `commsops-worker/test/`, named `*.test.js`, run as `node test/<name>.test.js`. They exit non-zero on failure. **No CI runs them** (`.github/workflows/deploy-relay.yml` has no test step) — you must run them yourself and paste the output.
- **DB mocking is monkey-patching**: `const A = require('../src/auth.js'); const orig = A.sbComms; A.sbComms = async (path) => {...}; ... A.sbComms = orig;`. `env` is passed as a bare `{}`.
- **Never expose `/ingest`.** It is token-authed and stays that way. The public surface is `/f/*` only.
- **Never use the global `CORS` const** (`index.js:39-41`, `Access-Control-Allow-Origin: '*'`) on any `/f/*` response. Use `BW.corsHeaders(origin)`.
- **Consent purpose for a stock alert is `'service'`.** Do **not** add a new purpose. See spec §6.
- **Capture never sends.** No code in this plan calls `send.js` or enqueues a message. Ever.
- **Every new table:** `ENABLE ROW LEVEL SECURITY`, `GRANT ALL … TO service_role`, and `NOTIFY pgrst, 'reload schema';` in the same migration. A table created without the NOTIFY is **invisible to PostgREST with no error**.
- **Migration files are mirror markers**, not a tool's input. The live DB is the source of truth; you apply the SQL to Supabase and commit the file as a record. Number sequentially — the newest existing is `0058_comms_bots.sql`, so yours is `0059`.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0059_comms_forms.sql` | **Create:** `comms.forms` + `comms.form_submissions`, RLS, grants, NOTIFY |
| `src/forms.js` | **Create:** validation, dedupe key, Turnstile verify, submit handler, confirm handler. The whole capture spine |
| `src/form-widget.js` | **Create:** `formWidgetJs(slug, workerBase, siteKey)` — the embeddable IIFE, mirroring `src/bot-widget.js` |
| `src/index.js` | **Modify:** add the `/f/*` route block beside `/web/*`; add two `require` lines |
| `wrangler.toml` | **Modify:** document `TURNSTILE_SECRET` in the secrets comment block |
| `test/forms-validate.test.js` | **Create:** pure validator + dedupe-key tests (Tasks 2, 3) |
| `test/forms-turnstile.test.js` | **Create:** Turnstile verification tests (Task 4) |
| `test/forms-submit.test.js` | **Create:** write-path + confirmation tests (Tasks 5, 6) |

`src/forms.js` stays one file: it is the same size and shape as `src/subscribe.js` (96 lines), and splitting a spine this small across files would fight the codebase's existing convention.

---

### Task 1: Migration — the two tables

**Files:**
- Create: `commsops-worker/migrations/0059_comms_forms.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `comms.forms` (columns `id, slug, name, kind, fields, dedupe_keys, destination, consent_copy, consent_copy_version, requires_confirmation, active, created_at, updated_at`) and `comms.form_submissions` (columns `id, form_id, profile_id, payload, dedupe_key, source_url, ip_hash, turnstile_ok, confirm_token, confirmed_at, submitted_at`). Every later task reads or writes these names.

- [ ] **Step 1: Write the migration file**

```sql
-- 0059 · comms.forms + comms.form_submissions (S331) — the capture spine for embeddable
-- website forms and surveys. Sub-project 1 of 5.
-- Spec: docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md
-- ⚠️ MIRROR MARKER of an applied Supabase migration — the live DB is the source of truth.

-- The form DEFINITION. Hand-seeded in SP1; written by the builder UI in SP4.
CREATE TABLE comms.forms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  -- 'survey' is the seam SP5 renders differently. Nothing in SP1 branches on it yet.
  kind                  text NOT NULL DEFAULT 'form' CHECK (kind IN ('form','survey')),
  -- [{key,label,type,required,options?}] — type in text|email|tel|select|radio|checkbox|hidden
  fields                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Field keys that, WITH identity, make a submission distinct. ['product_code'] for
  -- back-in-stock: the same person legitimately notifies on five different SKUs.
  dedupe_keys           text[] NOT NULL DEFAULT '{}',
  -- RESERVED for SP2 (which segment a submission joins). SP1 writes and reads nothing here.
  destination           jsonb,
  consent_copy          text,
  -- Versioned because it is DPDP evidence: we must be able to say what they agreed TO.
  consent_copy_version  int NOT NULL DEFAULT 1,
  -- true  = ongoing marketing enrolment -> no consent row until confirmed
  -- false = single requested alert      -> consent row written at capture
  requires_confirmation boolean NOT NULL DEFAULT false,
  -- Whether the form ACCEPTS submissions. NOT a sending switch — sending is journey activation.
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One row per submission. THE shared response store — SP5 surveys reuse it unchanged.
CREATE TABLE comms.form_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id       uuid NOT NULL REFERENCES comms.forms(id),
  profile_id    uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text,
  source_url    text,
  ip_hash       text,
  turnstile_ok  boolean NOT NULL DEFAULT false,
  confirm_token text UNIQUE,
  confirmed_at  timestamptz,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);

-- Partial UNIQUE: enforces per-(form, identity, product) dedupe in the DB, so a race between
-- two concurrent submits cannot create two rows. NULL dedupe_key rows are always distinct.
CREATE UNIQUE INDEX form_submissions_dedupe_idx
  ON comms.form_submissions (form_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX form_submissions_profile_idx
  ON comms.form_submissions (profile_id, submitted_at DESC);

ALTER TABLE comms.forms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.form_submissions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.forms, comms.form_submissions TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it to Supabase**

Apply the SQL above to project `jkxcnjabmrkteanzoofj` (schema `comms`) using `apply_migration` with the name `comms_forms_capture_spine_v1`.

- [ ] **Step 3: Verify the tables exist AND PostgREST can see them**

Run this query:

```sql
select table_name, count(*) cols
from information_schema.columns
where table_schema='comms' and table_name in ('forms','form_submissions')
group by 1 order by 1;
```

Expected: `form_submissions | 11` and `forms | 13`.

Then confirm the PostgREST cache actually reloaded — this is the failure that is silent:

```sql
select count(*) from comms.forms;
```

Expected: `0`, with no error. If a later task gets an unexplained not-found on these tables, re-run `NOTIFY pgrst, 'reload schema';` before debugging anything else.

- [ ] **Step 4: Commit**

```bash
git add commsops-worker/migrations/0059_comms_forms.sql
git commit -m "S331 [relay] SP1 T1: comms.forms + form_submissions — the capture spine tables"
```

---

### Task 2: The pure validator

**Files:**
- Create: `commsops-worker/src/forms.js`
- Create: `commsops-worker/test/forms-validate.test.js`

**Interfaces:**
- Consumes: `SHOP.normalizePhone` from `./shopify.js` (used the same way `subscribe.js:31` uses it).
- Produces: `validateSubmission(form, body)` → `{ok:false, error}` or `{ok:true, slug, email, phone, channels, payload, source_url}`. Task 5 calls it. `channels` is an array of `'email' | 'whatsapp'`.

- [ ] **Step 1: Write the failing test**

Create `commsops-worker/test/forms-validate.test.js`:

```js
// test/forms-validate.test.js — the pure validation half of the capture spine (S331 SP1).
// Sync-only, no DB: validateSubmission must never touch the network.
const assert = require('assert');
const { validateSubmission } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const FORM = {
  slug: 'back-in-stock',
  active: true,
  fields: [
    { key: 'product_code', label: 'Product', type: 'hidden', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'phone', label: 'WhatsApp', type: 'tel', required: false },
  ],
  dedupe_keys: ['product_code'],
};

t('honeypot is rejected', () => {
  const r = validateSubmission(FORM, { website: 'bot', email: 'a@b.com', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'honeypot');
});

t('inactive form is rejected', () => {
  const r = validateSubmission({ ...FORM, active: false }, { email: 'a@b.com', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'form_inactive');
});

t('a missing required field is rejected, and names the field', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_field:product_code');
});

t('a malformed email is rejected', () => {
  const r = validateSubmission(FORM, { email: 'not-an-email', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_email');
});

t('no reachable channel is rejected', () => {
  const r = validateSubmission({ ...FORM, fields: [{ key: 'product_code', type: 'hidden', required: true }] },
    { product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'email_or_phone_required');
});

t('email only defaults to the email channel', () => {
  const r = validateSubmission(FORM, { email: 'A@B.com ', product_code: 'X' });
  assert.equal(r.ok, true);
  assert.equal(r.email, 'a@b.com');
  assert.deepEqual(r.channels, ['email']);
});

t('email + phone yields both channels, email first', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', phone: '7709991011', product_code: 'X' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['email', 'whatsapp']);
});

t('a channel we cannot reach is dropped, never recorded', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', channels: ['email', 'whatsapp'], product_code: 'X' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['email'], 'whatsapp must be dropped when no phone was given');
});

t('payload carries only declared field keys', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', product_code: 'X', evil: 'drop me' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.evil, undefined);
  assert.equal(r.payload.product_code, 'X');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd commsops-worker && node test/forms-validate.test.js
```

Expected: FAIL — `Cannot find module '../src/forms.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `commsops-worker/src/forms.js`:

```js
// The capture spine (S331, SP1) — embeddable website forms and, later, surveys.
// Spec: docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md
//
// This is commsops' FIRST unauthenticated public write surface. `/ingest` is token-authed
// and must never be exposed; everything the open internet can reach lives behind /f/* with
// origin-scoped CORS (bot-web.js corsHeaders), a Turnstile challenge verified server-side,
// and a honeypot. Modelled deliberately on subscribe.js — read that file first.
//
// ⚠️ NOTHING HERE SENDS. Capture writes rows and emits an event; a human activating a
// journey is the only thing that ever produces a message. One switch, in one place.
const SHOP = require('./shopify.js');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Pure + unit-tested. Returns {ok:false,error} or the normalized submission.
function validateSubmission(form, body) {
  if (!form || !form.active) return { ok: false, error: 'form_inactive' };
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_json' };
  // Honeypot: a visually-hidden "website" field — humans leave it empty, bots fill every
  // input. The caller reports success so the bot learns nothing (same lie as subscribe.js).
  if (body.website) return { ok: false, error: 'honeypot' };

  const fields = Array.isArray(form.fields) ? form.fields : [];

  // Only declared keys survive. An undeclared key is dropped, never stored — the payload is
  // author-defined, so accepting arbitrary keys would let anyone write anything into jsonb.
  const payload = {};
  for (const f of fields) {
    const raw = body[f.key];
    const val = raw === undefined || raw === null ? '' : String(raw).trim().slice(0, 2000);
    if (f.required && !val) return { ok: false, error: `missing_field:${f.key}` };
    if (val) payload[f.key] = val;
  }

  const email = payload.email ? payload.email.toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'bad_email' };
  const phone = payload.phone ? (SHOP.normalizePhone(payload.phone) || null) : null;
  if (!email && !phone) return { ok: false, error: 'email_or_phone_required' };
  if (email) payload.email = email;
  if (phone) payload.phone = phone;

  let channels = Array.isArray(body.channels)
    ? body.channels.filter((c) => ['email', 'whatsapp'].includes(c))
    : [];
  if (!channels.length) channels = [email && 'email', phone && 'whatsapp'].filter(Boolean);
  // Never record consent for a channel we cannot reach.
  channels = channels.filter((c) => (c === 'email' ? !!email : !!phone));
  if (!channels.length) return { ok: false, error: 'no_usable_channel' };

  return {
    ok: true, slug: form.slug, email, phone, channels, payload,
    source_url: body.source_url ? String(body.source_url).slice(0, 500) : null,
  };
}

module.exports = { validateSubmission };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd commsops-worker && node test/forms-validate.test.js
```

Expected: `9 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/forms.js commsops-worker/test/forms-validate.test.js
git commit -m "S331 [relay] SP1 T2: validateSubmission — declared-keys-only payload, per-channel reachability"
```

---

### Task 3: The dedupe key

**Files:**
- Modify: `commsops-worker/src/forms.js`
- Modify: `commsops-worker/test/forms-validate.test.js`

**Interfaces:**
- Consumes: `validateSubmission`'s output shape from Task 2.
- Produces: `dedupeKey(form, v)` → `string | null`, where `v` is a validated submission. Task 5 writes the result to `form_submissions.dedupe_key` and uses it in the ingest idempotency key.

- [ ] **Step 1: Write the failing test**

Append to `commsops-worker/test/forms-validate.test.js`, immediately **above** the final `console.log` line:

```js
// ── dedupeKey ────────────────────────────────────────────────────────────────
// ⚠️ THE BUG THIS EXISTS TO PREVENT: keying on identity alone. The same customer
// legitimately asks to be notified about five different SKUs, and a
// `form:<slug>:<email>` key would silently swallow four of them.
const { dedupeKey } = require('../src/forms.js');

t('dedupe key includes the declared dedupe field', () => {
  const v = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, v), 'back-in-stock:a@b.com:SKU1');
});

t('same person, different product -> different keys', () => {
  const a = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  const b = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU2' });
  assert.notEqual(dedupeKey(FORM, a), dedupeKey(FORM, b));
});

t('same person, same product -> identical keys', () => {
  const a = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  const b = validateSubmission(FORM, { email: 'A@B.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, a), dedupeKey(FORM, b));
});

t('phone-only identity keys on the phone', () => {
  const v = validateSubmission(FORM, { phone: '7709991011', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, v), 'back-in-stock:+917709991011:SKU1');
});

t('no dedupe_keys -> null, so every submission is kept', () => {
  const f = { ...FORM, dedupe_keys: [] };
  const v = validateSubmission(f, { email: 'a@b.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(f, v), null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd commsops-worker && node test/forms-validate.test.js
```

Expected: FAIL — `dedupeKey is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `commsops-worker/src/forms.js`, add above `module.exports`:

```js
// The identity+content key that makes a submission distinct.
//
// ⚠️ IDENTITY ALONE IS WRONG. Back-in-stock is per-PRODUCT: one customer notifying on five
// SKUs is five legitimate submissions, and a key of `slug:email` would collapse them to one
// and silently lose four alerts. `dedupe_keys` names the content fields that participate.
// An empty dedupe_keys means "never dedupe" (null), which the partial UNIQUE index treats
// as always-distinct — correct for a survey, where every response is its own row.
function dedupeKey(form, v) {
  const keys = Array.isArray(form.dedupe_keys) ? form.dedupe_keys : [];
  if (!keys.length) return null;
  const identity = v.email || v.phone;
  return [form.slug, identity, ...keys.map((k) => v.payload[k] || '')].join(':');
}
```

And update the export line:

```js
module.exports = { validateSubmission, dedupeKey };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd commsops-worker && node test/forms-validate.test.js
```

Expected: `14 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/forms.js commsops-worker/test/forms-validate.test.js
git commit -m "S331 [relay] SP1 T3: per-product dedupe key — identity alone would drop 4 of 5 alerts"
```

---

### Task 4: Turnstile verification

**Files:**
- Modify: `commsops-worker/src/forms.js`
- Create: `commsops-worker/test/forms-turnstile.test.js`
- Modify: `commsops-worker/wrangler.toml:46` (the secrets comment block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `async verifyTurnstile(env, token, ip)` → `boolean`. Task 5 calls it and refuses the whole request when it returns false.

- [ ] **Step 1: Write the failing test**

Create `commsops-worker/test/forms-turnstile.test.js`:

```js
// test/forms-turnstile.test.js — the bot gate on the public capture surface (S331 SP1).
// ⚠️ EVERY failure path must return false. A challenge that fails OPEN is not a challenge.
const assert = require('assert');
const { verifyTurnstile } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origFetch = globalThis.fetch;
const ENV = { TURNSTILE_SECRET: 's3cret' };

(async () => {
  await t('a valid token passes', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), true);
  });

  await t('an invalid token fails', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: false }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an absent token fails without calling out', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ success: true }) }; };
    assert.equal(await verifyTurnstile(ENV, '', '1.2.3.4'), false);
    assert.equal(called, false, 'must not call siteverify with an empty token');
  });

  await t('a network error fails CLOSED', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('a non-200 from siteverify fails CLOSED', async () => {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an unconfigured secret fails CLOSED, never open', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile({}, 'tok', '1.2.3.4'), false);
  });

  globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd commsops-worker && node test/forms-turnstile.test.js
```

Expected: FAIL — `verifyTurnstile is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `commsops-worker/src/forms.js`, add above `module.exports`:

```js
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ⚠️ FAILS CLOSED on every abnormal path — empty token, network error, non-200, missing
// secret. This is the only thing standing between the open internet and a profile write,
// and a challenge that passes when it cannot reach its verifier is not a challenge at all.
// (Same posture as gate.js's suppression/freq-cap reads: an unreadable check BLOCKS.)
async function verifyTurnstile(env, token, ip) {
  if (!env || !env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.success === true;
  } catch {
    return false;
  }
}
```

Update the export line:

```js
module.exports = { validateSubmission, dedupeKey, verifyTurnstile };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd commsops-worker && node test/forms-turnstile.test.js
```

Expected: `6 passed, 0 failed`.

- [ ] **Step 5: Document the secret**

In `commsops-worker/wrangler.toml`, add this line to the end of the secrets comment block (after the `SLACK_WEBHOOK_ALERTS` line at :46):

```toml
# TURNSTILE_SECRET         (S331 — Cloudflare Turnstile siteverify secret for the public /f/* capture surface. Its absence fails the challenge CLOSED, so an unset secret disables capture rather than opening it.)
```

- [ ] **Step 6: Commit**

```bash
git add commsops-worker/src/forms.js commsops-worker/test/forms-turnstile.test.js commsops-worker/wrangler.toml
git commit -m "S331 [relay] SP1 T4: Turnstile verification, failing closed on every abnormal path"
```

---

### Task 5: The write path

**Files:**
- Modify: `commsops-worker/src/forms.js`
- Create: `commsops-worker/test/forms-submit.test.js`

**Interfaces:**
- Consumes: `validateSubmission` (T2), `dedupeKey` (T3), `verifyTurnstile` (T4); `ingest` from `./ingest.js`; `recordConsent` from `./consent.js`; `A.sbComms` from `./auth.js`.
- Produces: `async handleFormSubmit(env, request)` → `{ok:true, submitted:true, slug, channels}` or `{ok:false, error, status}`. Task 7 routes to it.

- [ ] **Step 1: Write the failing test**

Create `commsops-worker/test/forms-submit.test.js`:

```js
// test/forms-submit.test.js — the write path of the public capture surface (S331 SP1).
// The four tables a submission can touch: profiles, identifiers (via resolve_identity),
// consent, form_submissions. A refused submission must write to NONE of them.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormSubmit } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origSb = A.sbComms, origFetch = globalThis.fetch;
const ENV = { TURNSTILE_SECRET: 's3cret' };

const FORM_ROW = {
  id: 'F1', slug: 'back-in-stock', name: 'Notify me', kind: 'form', active: true,
  requires_confirmation: false, consent_copy_version: 2,
  fields: [
    { key: 'product_code', type: 'hidden', required: true },
    { key: 'email', type: 'email', required: true },
  ],
  dedupe_keys: ['product_code'],
};

// Records every write so a test can assert on what was NOT written.
function mockDb(writes, opts = {}) {
  A.sbComms = async (path, env, o = {}) => {
    const method = o.method || 'GET';
    if (method !== 'GET') writes.push({ path, method, body: o.body ? JSON.parse(o.body) : null });
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [opts.form || FORM_ROW] };
    if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1' }] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [] };
    if (path.startsWith('/rest/v1/form_submissions')) return { ok: true, data: [{ id: 'S1' }] };
    if (path.startsWith('/rest/v1/profiles')) return { ok: true, data: [{ attributes: {} }] };
    return { ok: true, data: [] };
  };
}
const req = (body, headers = {}) => new Request('https://x/f/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const turnstile = (success) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ success }) }); };
const wrote = (writes, frag) => writes.filter((w) => w.path.includes(frag));

(async () => {
  await t('a happy submission writes an event, a consent row and a submission', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(wrote(writes, '/events').length, 1);
    assert.equal(wrote(writes, '/consent').length, 1);
    assert.equal(wrote(writes, '/form_submissions').length, 1);
  });

  await t('consent is purpose `service`, opted_in, with versioned evidence', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    const c = wrote(writes, '/consent')[0].body;
    assert.equal(c.purpose, 'service', 'a requested alert is `service` — NOT a new product_alert purpose');
    assert.equal(c.state, 'opted_in');
    assert.equal(c.source, 'website_form:back-in-stock');
    assert.equal(c.evidence.consent_copy_version, 2);
    assert.equal(c.evidence.turnstile_ok, true);
  });

  await t('a FAILED turnstile writes NOTHING to any of the four tables', async () => {
    const writes = []; mockDb(writes); turnstile(false);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'bad', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'challenge_failed');
    assert.equal(writes.length, 0, `expected zero writes, got ${JSON.stringify(writes)}`);
  });

  await t('the honeypot lies to the bot and writes nothing', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1', website: 'spam' }));
    assert.equal(r.ok, true, 'must look like success so the bot learns nothing');
    assert.equal(writes.length, 0);
  });

  await t('an unknown form slug is refused, with no writes', async () => {
    const writes = []; turnstile(true);
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleFormSubmit(ENV, req({ form: 'nope', turnstile_token: 'tok', email: 'a@b.com' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'form_not_found');
    assert.equal(writes.length, 0);
  });

  await t('an existing profile resolves via identifiers rather than a second profile', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    let sentIds = null;
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.includes('resolve_identity')) { sentIds = JSON.parse(o.body).p_identifiers; return { ok: true, data: 'EXISTING' }; }
      return sb(path, env, o);
    };
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(sentIds, [{ type: 'email', value: 'a@b.com', is_verified: false }],
      'identity must go through resolve_identity — never a second resolver');
    assert.equal(wrote(writes, '/form_submissions')[0].body.profile_id, 'EXISTING');
  });

  await t('the dedupe key reaches BOTH the ingest key and the submission row', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(wrote(writes, '/events')[0].body.idempotency_key, 'form:back-in-stock:a@b.com:SKU1');
    assert.equal(wrote(writes, '/form_submissions')[0].body.dedupe_key, 'back-in-stock:a@b.com:SKU1');
  });

  await t('a confirmation-required form writes NO consent row at capture', async () => {
    const writes = []; mockDb(writes, { form: { ...FORM_ROW, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(wrote(writes, '/consent').length, 0, 'consent must wait for confirmation');
    assert.ok(wrote(writes, '/form_submissions')[0].body.confirm_token, 'must mint a confirm token');
  });

  A.sbComms = origSb; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd commsops-worker && node test/forms-submit.test.js
```

Expected: FAIL — `handleFormSubmit is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `commsops-worker/src/forms.js`, add these requires at the top (below the existing `SHOP` require):

```js
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
```

Then add above `module.exports`:

```js
// A stable, non-reversible client hint for abuse triage. NOT an identifier and never joined
// on — a raw IP in a jsonb column is PII we have no use for.
async function hashIp(ip) {
  if (!ip) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleFormSubmit(env, request) {
  let body; try { body = await request.json(); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  const slug = String((body && body.form) || '').toLowerCase().trim();
  if (!slug) return { ok: false, error: 'form_required', status: 400 };

  // ⚠️ ORDER MATTERS. The challenge is verified BEFORE the form is even looked up, so an
  // unchallenged request cannot use this endpoint to probe which form slugs exist.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return { ok: false, error: 'challenge_failed', status: 403 };
  }

  const fr = await A.sbComms(
    `/rest/v1/forms?slug=eq.${A.enc(slug)}&active=is.true&select=*&limit=1`, env);
  const form = fr.ok ? fr.data?.[0] : null;
  if (!form) return { ok: false, error: 'form_not_found', status: 404 };

  const v = validateSubmission(form, body);
  if (!v.ok) {
    if (v.error === 'honeypot') return { ok: true, submitted: true };   // lie to bots
    return { ok: false, error: v.error, status: 400 };
  }

  const identifiers = [];
  if (v.email) identifiers.push({ type: 'email', value: v.email, is_verified: false });
  if (v.phone) identifiers.push({ type: 'phone', value: v.phone, is_verified: false });

  const key = dedupeKey(form, v);

  // Event first — ingest resolves/creates the profile and runs journey-trigger matching.
  // ⚠️ This EMITS; it does not send. A journey a human activated is the only sender.
  const r = await ingest(env, {
    identifiers,
    name: 'form_submitted',
    properties: { form: v.slug, kind: form.kind, channels: v.channels, source_url: v.source_url, ...v.payload },
    source: 'website_form',
    idempotency_key: key ? `form:${key}` : null,
  });
  if (!r.ok) return { ok: false, error: r.error, status: 400 };
  const profileId = r.profile_id;

  const needsConfirm = form.requires_confirmation === true;
  const confirmToken = needsConfirm ? crypto.randomUUID().replace(/-/g, '') : null;

  // Consent NOW only when this is a single requested alert. An ongoing marketing enrolment
  // writes nothing until the person confirms — an unconfirmed submission must never become
  // a sendable audience.
  if (!needsConfirm) {
    const evidence = {
      form: v.slug, source_url: v.source_url, consent_copy_version: form.consent_copy_version,
      turnstile_ok: true, ua: request.headers.get('user-agent') || null,
      at: new Date().toISOString(),
    };
    for (const channel of v.channels) {
      // `service`, not `marketing`: gate.js:181 — bypasses consent + frequency cap, RESPECTS
      // quiet hours and suppression. Exactly the semantics a requested alert wants.
      await recordConsent(env, {
        profile_id: profileId, channel, purpose: 'service', state: 'opted_in',
        source: `website_form:${v.slug}`, evidence,
      });
    }
  }

  await A.sbComms('/rest/v1/form_submissions', env, {
    method: 'POST',
    headers: key ? { Prefer: 'resolution=ignore-duplicates' } : {},
    body: JSON.stringify({
      form_id: form.id, profile_id: profileId, payload: v.payload, dedupe_key: key,
      source_url: v.source_url, ip_hash: await hashIp(ip), turnstile_ok: true,
      confirm_token: confirmToken,
    }),
  });

  return { ok: true, submitted: true, slug: v.slug, channels: v.channels };
}
```

Update the export line:

```js
module.exports = { validateSubmission, dedupeKey, verifyTurnstile, handleFormSubmit };
```

- [ ] **Step 4: Run both test files to verify they pass**

```bash
cd commsops-worker && node test/forms-validate.test.js && node test/forms-turnstile.test.js && node test/forms-submit.test.js
```

Expected: `14 passed`, `6 passed`, `8 passed`, all with `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/forms.js commsops-worker/test/forms-submit.test.js
git commit -m "S331 [relay] SP1 T5: the capture write path — challenge before lookup, service-purpose consent, zero writes on refusal"
```

---

### Task 6: The confirmation endpoint

**Files:**
- Modify: `commsops-worker/src/forms.js`
- Modify: `commsops-worker/test/forms-submit.test.js`

**Interfaces:**
- Consumes: `form_submissions.confirm_token` written by Task 5.
- Produces: `async handleFormConfirm(env, token)` → `{ok:true, confirmed:true}` or `{ok:false, error, status}`. Task 7 routes `GET /f/confirm?t=` to it.

- [ ] **Step 1: Write the failing test**

Append to `commsops-worker/test/forms-submit.test.js`, immediately **above** the `A.sbComms = origSb;` restore line:

```js
  // ── confirmation ───────────────────────────────────────────────────────────
  const { handleFormConfirm } = require('../src/forms.js');

  await t('confirming stamps confirmed_at and writes the consent row', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      const method = o.method || 'GET';
      if (method !== 'GET') writes.push({ path, method, body: o.body ? JSON.parse(o.body) : null });
      if (path.startsWith('/rest/v1/form_submissions')) {
        return { ok: true, data: [{ id: 'S1', form_id: 'F1', profile_id: 'P1', confirmed_at: null,
          payload: { email: 'a@b.com' }, source_url: null,
          submitted_at: '2026-09-02T09:00:00Z',
          forms: { slug: 'news', consent_copy_version: 3 } }] };
      }
      if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    const c = writes.filter((w) => w.path.includes('/consent'))[0].body;
    assert.equal(c.state, 'opted_in');
    assert.equal(c.purpose, 'marketing', 'a confirmed ENROLMENT is marketing, unlike a requested alert');
    assert.ok(c.evidence.confirmed_at, 'evidence must carry BOTH timestamps');
    assert.ok(c.evidence.submitted_at);
    assert.ok(writes.some((w) => w.method === 'PATCH' && w.body.confirmed_at));
  });

  await t('an unknown token is refused and writes nothing', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'nope');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_token');
    assert.equal(writes.length, 0);
  });

  await t('confirming twice is idempotent — no second consent row', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      if (path.startsWith('/rest/v1/form_submissions')) {
        return { ok: true, data: [{ id: 'S1', form_id: 'F1', profile_id: 'P1',
          confirmed_at: '2026-09-02T10:00:00Z', payload: { email: 'a@b.com' },
          forms: { slug: 'news', consent_copy_version: 3 } }] };
      }
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    assert.equal(writes.filter((w) => w.path.includes('/consent')).length, 0);
  });
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd commsops-worker && node test/forms-submit.test.js
```

Expected: FAIL — `handleFormConfirm is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `commsops-worker/src/forms.js`, add above `module.exports`:

```js
// The second half of confirmed opt-in. Until this runs, a marketing enrolment has a
// submission row and NO consent row, so it cannot be sent to by anything.
//
// ⚠️ The consent written here is `marketing`, not `service`: the person is enrolling in
// ongoing sends, which is exactly what `marketing` gates (purposes.js needsOptIn). Only a
// single alert the customer requested is `service`.
async function handleFormConfirm(env, token) {
  const tok = String(token || '').trim();
  if (!tok) return { ok: false, error: 'invalid_token', status: 400 };

  const sr = await A.sbComms(
    `/rest/v1/form_submissions?confirm_token=eq.${A.enc(tok)}` +
    `&select=*,forms(slug,consent_copy_version)&limit=1`, env);
  const sub = sr.ok ? sr.data?.[0] : null;
  if (!sub) return { ok: false, error: 'invalid_token', status: 404 };

  // Idempotent: a second click is a no-op, not a second consent row.
  if (sub.confirmed_at) return { ok: true, confirmed: true, already: true };

  const now = new Date().toISOString();
  const evidence = {
    form: sub.forms?.slug || null, source_url: sub.source_url || null,
    consent_copy_version: sub.forms?.consent_copy_version ?? null,
    submitted_at: sub.submitted_at || null, confirmed_at: now, turnstile_ok: true,
  };
  const channels = [sub.payload?.email && 'email', sub.payload?.phone && 'whatsapp'].filter(Boolean);
  for (const channel of channels) {
    await recordConsent(env, {
      profile_id: sub.profile_id, channel, purpose: 'marketing', state: 'opted_in',
      source: `website_form:${sub.forms?.slug || 'unknown'}`, evidence, captured_at: now,
    });
  }

  await A.sbComms(`/rest/v1/form_submissions?id=eq.${A.enc(sub.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ confirmed_at: now }),
  });
  return { ok: true, confirmed: true };
}
```

Update the export line:

```js
module.exports = { validateSubmission, dedupeKey, verifyTurnstile, handleFormSubmit, handleFormConfirm };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd commsops-worker && node test/forms-submit.test.js
```

Expected: `11 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add commsops-worker/src/forms.js commsops-worker/test/forms-submit.test.js
git commit -m "S331 [relay] SP1 T6: confirmed opt-in — consent written only on confirmation, idempotent"
```

---

### Task 7: The `/f/*` route block

**Files:**
- Modify: `commsops-worker/src/index.js` (add requires near :20-29; add the route block immediately after the `/web/` block, which ends at :2917)

**Interfaces:**
- Consumes: `handleFormSubmit`, `handleFormConfirm` (Tasks 5, 6); `formWidgetJs` (Task 8 — write Task 8 first if you prefer, the require is the only coupling); `BW.corsHeaders` from `./bot-web.js`.
- Produces: live routes `POST /f/submit`, `GET /f/confirm`, `GET /f/widget.js`.

- [ ] **Step 1: Add the module requires**

In `commsops-worker/src/index.js`, beside the existing requires (`SUB` is at :20, `WIDGET` at :29), add:

```js
const FORMS = require('./forms.js');
const FWIDGET = require('./form-widget.js');
```

- [ ] **Step 2: Add the route block**

Insert immediately **after** the closing `}` of the `/web/` block (`index.js:2917`) and before whatever route follows it:

```js
    // ── Public forms (S331, SP1) — commsops' FIRST unauthenticated public WRITE surface.
    // ⚠️ MUST use BW.corsHeaders (origin-scoped), NEVER the global CORS const at the top of
    // this file — that one is `Access-Control-Allow-Origin: '*'`, which is fine for a
    // token-authed route and wrong for an open one. Same posture as the /web/ block above.
    // ⚠️ Nothing in here sends. Capture emits `form_submitted`; a journey a human activated
    // is the only thing that ever produces a message.
    if (url.pathname.startsWith('/f/')) {
      const origin = request.headers.get('Origin') || '';
      const cors = BW.corsHeaders(origin);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const withCors = (resp) => { for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v); return resp; };

      if (url.pathname === '/f/submit' && request.method === 'POST') {
        // ⚠️ AN EXPLICIT ORIGIN REFUSAL, NOT JUST ABSENT CORS HEADERS. `corsHeaders` returns
        // {} for a disallowed origin, but the handler would still RUN and still WRITE —
        // CORS is enforced by the browser, so it stops a page, never curl. The spec's
        // "origin not allowed -> zero rows" only holds if we refuse here, so we do.
        // Turnstile remains the real control; this is defence in depth, not the wall.
        if (origin && !BW.ALLOWED_ORIGINS.has(origin)) return withCors(err('bad_origin', 403));
        const r = await FORMS.handleFormSubmit(env, request);
        return withCors(r.ok ? ok(r) : err(r.error, r.status || 400));
      }

      // A human clicking a link in their inbox — returns HTML, not JSON, and deliberately
      // carries no CORS requirement of its own.
      if (url.pathname === '/f/confirm' && request.method === 'GET') {
        const r = await FORMS.handleFormConfirm(env, url.searchParams.get('t'));
        const msg = r.ok ? 'You are subscribed. Thank you!' : 'This confirmation link is not valid.';
        return new Response(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="font:16px system-ui;padding:3rem;text-align:center">${msg}</body>`,
          { status: r.ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // The widget script — a plain script-tag target, no auth, cacheable.
      // MUST stay inside this /f/ block, above the closing 404.
      if (url.pathname === '/f/widget.js' && request.method === 'GET') {
        return new Response(
          FWIDGET.formWidgetJs(url.searchParams.get('form'), `https://${url.hostname}`, env.TURNSTILE_SITE_KEY || ''),
          { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' } });
      }

      return withCors(err('not_found', 404));
    }
```

- [ ] **Step 3: Verify the worker still parses**

```bash
cd commsops-worker && node --check src/index.js && node --check src/forms.js
```

Expected: no output (both files parse).

- [ ] **Step 4: Commit**

```bash
git add commsops-worker/src/index.js
git commit -m "S331 [relay] SP1 T7: /f/* route block — origin-scoped CORS, never the global wildcard"
```

---

### Task 8: The embeddable widget

**Files:**
- Create: `commsops-worker/src/form-widget.js`

**Interfaces:**
- Consumes: the `POST /f/submit` contract from Task 5 — body `{form, turnstile_token, source_url, ...field keys}`.
- Produces: `formWidgetJs(slug, workerBase, siteKey)` → a string containing a self-contained IIFE. Task 7 serves it.

- [ ] **Step 1: Write the module**

Create `commsops-worker/src/form-widget.js`:

```js
// The embeddable form widget (S331, SP1) — one <script> tag on a PDP.
// Mirrors src/bot-widget.js exactly: a string-templated, self-contained IIFE with inline
// styles, no framework and no external assets beyond Cloudflare's own Turnstile script.
//
// Usage on the storefront:
//   <div data-lot-form="back-in-stock" data-product="GH-PB-49"></div>
//   <script src="https://commsops.<...>.workers.dev/f/widget.js?form=back-in-stock" defer></script>
function formWidgetJs(slug, workerBase, siteKey) {
  const s = JSON.stringify(String(slug || ''));
  const base = JSON.stringify(String(workerBase || ''));
  const key = JSON.stringify(String(siteKey || ''));
  return `(function(){
  var SLUG=${s}, BASE=${base}, SITEKEY=${key};
  var host=document.querySelector('[data-lot-form="'+SLUG+'"]');
  if(!host) return;
  var Y='#F2CD1A';
  host.innerHTML='<form style="display:flex;flex-direction:column;gap:8px;max-width:340px;font:14px system-ui">'
    +'<input name="email" type="email" required placeholder="Email address" style="padding:10px;border:1px solid #ccc;border-radius:6px">'
    +'<label style="display:flex;gap:6px;align-items:center"><input name="wa" type="checkbox"><span>Also tell me on WhatsApp</span></label>'
    +'<input name="phone" type="tel" placeholder="WhatsApp number" style="padding:10px;border:1px solid #ccc;border-radius:6px;display:none">'
    +'<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">'
    +'<div class="lotf-ts"></div>'
    +'<button type="submit" style="padding:10px;border:0;border-radius:6px;background:'+Y+';font-weight:600;cursor:pointer">Notify me</button>'
    +'<p class="lotf-msg" style="margin:0;color:#555" aria-live="polite"></p></form>';
  var f=host.querySelector('form'), msg=host.querySelector('.lotf-msg');
  var wa=f.wa, phone=f.phone;
  wa.addEventListener('change',function(){ phone.style.display=wa.checked?'block':'none'; });
  var token='';
  // Turnstile renders itself; the token is the only thing the worker trusts.
  var ts=document.createElement('script');
  ts.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  ts.async=true; ts.defer=true;
  ts.onload=function(){ if(window.turnstile) window.turnstile.render(host.querySelector('.lotf-ts'),
    {sitekey:SITEKEY, callback:function(t){ token=t; }}); };
  document.head.appendChild(ts);
  f.addEventListener('submit',function(e){
    e.preventDefault();
    msg.textContent='Sending...';
    var payload={form:SLUG, turnstile_token:token, source_url:location.href,
      email:f.email.value, website:f.website.value,
      product_code:(host.getAttribute('data-product')||''),
      channels: wa.checked?['email','whatsapp']:['email']};
    if(wa.checked) payload.phone=phone.value;
    fetch(BASE+'/f/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(r){return r.json();})
      .then(function(j){
        msg.textContent = j && j.ok ? "You're on the list. We'll let you know." : 'Sorry, that did not go through.';
        if(j && j.ok) f.querySelector('button').disabled=true;
      })
      .catch(function(){ msg.textContent='Sorry, that did not go through.'; });
  });
})();`;
}

module.exports = { formWidgetJs };
```

- [ ] **Step 2: Verify it parses and produces valid JS**

```bash
cd commsops-worker && node -e "
const {formWidgetJs}=require('./src/form-widget.js');
const js=formWidgetJs('back-in-stock','https://x.dev','0xSITEKEY');
new Function(js);
console.log('widget parses OK, ' + js.length + ' bytes');
"
```

Expected: `widget parses OK, <n> bytes` with no SyntaxError.

- [ ] **Step 3: Commit**

```bash
git add commsops-worker/src/form-widget.js
git commit -m "S331 [relay] SP1 T8: embeddable form widget — self-contained IIFE, Turnstile, honeypot"
```

---

### Task 9: Seed, deploy, verify

**Files:**
- Modify: none (data + deploy only)

**Interfaces:**
- Consumes: everything above.
- Produces: a live, exercised capture surface.

- [ ] **Step 1: Set the Turnstile secrets**

Create a Turnstile widget in the Cloudflare dashboard for `legendoftoys.com`, then:

```bash
cd commsops-worker && npx wrangler secret put TURNSTILE_SECRET
```

Add the **site** key (public, not a secret) to `wrangler.toml`'s `[vars]` block:

```toml
# Turnstile SITE key — public by design, embedded in the widget JS. The SECRET half is a
# wrangler secret. An unset secret fails the challenge closed, disabling capture.
TURNSTILE_SITE_KEY = "<paste the site key>"
```

- [ ] **Step 2: Seed the back-in-stock form**

Apply against project `jkxcnjabmrkteanzoofj`:

```sql
INSERT INTO comms.forms (slug, name, kind, fields, dedupe_keys, consent_copy, consent_copy_version, requires_confirmation, active)
VALUES (
  'back-in-stock', 'Notify me when back in stock', 'form',
  '[{"key":"product_code","label":"Product","type":"hidden","required":true},
    {"key":"email","label":"Email address","type":"email","required":true},
    {"key":"phone","label":"WhatsApp number","type":"tel","required":false}]'::jsonb,
  ARRAY['product_code'],
  'Tell me once when this product is back in stock.', 1,
  false,   -- a single requested alert, not an ongoing marketing enrolment
  true
);
```

- [ ] **Step 3: Commit and push BEFORE deploying**

⚠️ The push must land first. Deploying from an unpushed branch silently reverts a parallel session's live change (PATTERN-220).

```bash
git push
```

Expected: push succeeds. If it is rejected, `git pull --rebase`, re-run all three test files, then continue.

- [ ] **Step 4: Deploy**

```bash
cd commsops-worker && npx wrangler deploy
```

- [ ] **Step 5: Verify the deploy is actually live**

```bash
cd commsops-worker && npx wrangler deployments status
```

Expected: the newest version id at `(100%)`. ⚠️ Do **not** use `deployments list` — it is oldest-first, so `| head` shows the oldest deploy and reads as "my deploy never landed".

- [ ] **Step 6: Prove the challenge blocks an unchallenged write**

```bash
curl -s -X POST https://commsops.<your-subdomain>.workers.dev/f/submit \
  -H 'Content-Type: application/json' \
  -d '{"form":"back-in-stock","email":"a@b.com","product_code":"TEST1"}'
```

Expected: `{"ok":false,"error":"challenge_failed"}`. Then confirm it wrote nothing:

```sql
select count(*) from comms.form_submissions;
```

Expected: `0`.

- [ ] **Step 7: Exercise the real form in a browser and verify the four writes**

Embed the widget on one PDP (or a staging page) and submit once with your own email. Then:

```sql
select s.id, s.dedupe_key, s.turnstile_ok, s.confirmed_at,
       p.id as profile_id, i.type, i.value, c.channel, c.purpose, c.state, c.source
from comms.form_submissions s
join comms.profiles p    on p.id = s.profile_id
join comms.identifiers i on i.profile_id = p.id
left join comms.consent c on c.profile_id = p.id and c.purpose = 'service'
order by s.submitted_at desc limit 5;
```

Expected: one submission row with `turnstile_ok = true` and `dedupe_key = 'back-in-stock:<your email>:<sku>'`, a profile, an identifier, and a consent row with `purpose='service'`, `state='opted_in'`, `source='website_form:back-in-stock'`.

- [ ] **Step 8: Prove per-product dedupe on live data**

Submit twice with the same email on the **same** product, then once on a **different** product:

```sql
select dedupe_key, count(*) from comms.form_submissions group by 1 order by 1;
```

Expected: two distinct keys, each with count 1 — the same-product resubmit did not create a second row.

- [ ] **Step 9: Commit the seed + config**

```bash
git add commsops-worker/wrangler.toml
git commit -m "S331 [relay] SP1 T9: back-in-stock form seeded, Turnstile keys wired, capture verified live"
git push
```

---

## What SP1 does NOT do

Stated so an implementer does not helpfully add it:

- **No segment creation.** That is SP2 and it is blocked on a membership-by-event segment kind that does not exist. `comms.forms.destination` ships unused.
- **No stock wiring and no notify.** That is SP3. The substrate already exists (`sales.inventory_reading`, `detect_stock_alerts()`, `stock_alert_outbox`) — do not rebuild it.
- **No builder UI.** That is SP4. Forms are seeded by hand.
- **No confirmation email send.** Capture emits `form_submitted`; a journey a human activates sends the confirmation. This is the "capture never sends" rule, and it means an unconfirmed marketing enrolment simply sits inert — which is the safe failure.
- **No survey rendering.** That is SP5. `kind='survey'` is accepted by the schema and branched on by nothing.

## One deliberate deviation from the spec

⚠️ **The spec's §4 says to reuse `BW.floodCheck` for per-session rate limiting. It cannot be reused, and
this plan does not.** `floodCheck` counts rows in `comms.bot_session_steps` for a given `session_id`
(`bot-web.js:95-99`) — a form submission has no session and no steps, so the function has nothing to count.

The code-side defences are therefore **Turnstile (fails closed), the honeypot, the explicit origin refusal,
and the DB's partial UNIQUE index** — which together stop bots, stop cross-origin pages, and make repeated
identical submissions a no-op. **Per-IP limiting remains a Cloudflare WAF dashboard rule**, exactly the
residual the bot builder already carries (`bot-web.js:89`).

`ip_hash` is stored so that if abuse does appear, it can be characterised before a rule is written. It is
never joined on and is not an identifier.
