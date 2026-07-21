# Relay Bug-Fix Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every go-live-blocking finding from the 2026-07-21 hostile code review of Relay (commsops worker + relay app), in four tiers ("gates"), so that flipping `test_mode` OFF, cutting over WhatsApp, and widening team roles each become safe decisions.

**Architecture:** Small, localized fixes to an existing Cloudflare Worker (`05_Throttle/commsops-worker`) and Next.js static-export app (`05_Throttle/apps/relay`). Two systemic patterns drive most fixes: (a) `sbComms` returns `{ok:false}` and never throws — unchecked call sites must fail CLOSED or THROW into the queue-retry machinery; (b) send dedup must become dedup-on-SUCCESS, not dedup-on-attempt. No schema restructuring; two small additive migrations.

**Tech Stack:** Cloudflare Workers (Queues, Workflows, cron), Supabase/PostgREST via `sbComms`, Node-script unit tests (`node test/<file>.test.js`, fetch/module stubbing — see pattern in `test/wa.test.js`), Next.js static export.

---

## Session bootstrap (read this first, fresh session)

**Authoritative findings source:** `05_Throttle/docs/superpowers/reviews/2026-07-21-relay-hostile-code-review.md` — READ IT FIRST. Finding IDs below (C1…C4, H1…H15, M1…M17) refer to it.

**Repo/deploy facts:**
- Worker source: `05_Throttle/commsops-worker/src/`. Tests: `cd 05_Throttle/commsops-worker && node test/<name>.test.js` (each prints `N passed, 0 failed`; exit 1 on failure). Existing suites: `wa.test.js` (26), `shipment-events.test.js` (10), `segment-entry.test.js` (13), `pixel-identity.test.js` (5) — run ALL as a baseline before Task 1 and after every gate.
- Deploy: `cd 05_Throttle/commsops-worker && npx wrangler deploy` — ONLY at the two deploy checkpoints, always AFTER commit+push. **Never modify `wrangler.toml`.**
- App: `cd 05_Throttle && npx turbo build --filter=relay` must pass with zero errors before committing app changes; pushing `main` auto-deploys.
- Migrations: Supabase MCP `apply_migration` on project `jkxcnjabmrkteanzoofj` (non-destructive runs autonomously; the `wa_windows` PK swap contains `DROP CONSTRAINT` → the sql-gate hook will prompt — expected, approve it).
- Commit after EVERY task (`git -C 05_Throttle add … && git -C 05_Throttle commit && git -C 05_Throttle push`).
- **Live posture must not change:** `comms.settings.test_mode` stays `true` throughout this session. Verify at bootstrap: `SELECT test_mode FROM comms.settings` → must be `true`.

**Review discipline (mandatory):** one fresh implementer subagent per task; after each task a fresh REVIEWER subagent reads the diff (`git -C 05_Throttle diff HEAD~1`) against the task's finding + fix spec and answers: (1) does the diff actually close the described failure scenario? (2) does it regress any adjacent behaviour? (3) do the new tests fail without the fix (revert-check if unsure)? Main session spot-checks anything the reviewer flags. Do not batch tasks past a reviewer rejection.

**Explicitly OUT of scope (do not fix here):** the Shopify `unknown`-consent redesign (needs an Afshaan decision — BACKLOG item); CR1/browse pixel-identity gap (structural); csops media-send (different worker); English-only STOP; timing-safe bearer compares; `compactAddr` dot-stripping; `customers/data_request` persistence; Cloudflare-Workflows-internals residuals documented in J1.

**Module-stubbing pattern used by every new test** (matches `test/wa.test.js`): modules capture `const A = require('./auth.js')` and call `A.sbComms(...)` — so tests do `const A = require('../src/auth.js'); const orig = A.sbComms; A.sbComms = async (path, env, opts) => {...}; …; A.sbComms = orig;`. Same for `global.fetch`.

---

# GATE 1 — before `test_mode` can ever be switched OFF

### Task 1: Dedup-on-success in the send spine (finding C1) [CRITICAL]

**Files:**
- Modify: `05_Throttle/commsops-worker/src/send.js` (reserve block ~111–123, `finalize` ~205–226)
- Create: `05_Throttle/commsops-worker/test/send-dedup.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/send-dedup.test.js — dedup must be on SUCCESS, not on attempt.
// Run: node test/send-dedup.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const { send } = require('../src/send.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
const origSb = A.sbComms;

// env stub is irrelevant — everything goes through A.sbComms.
const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };

(async () => {
  await t('conflict with a SENT row → deduped', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, status: 201, data: [] };       // conflict
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, status: 200, data: [{ id: 'M1', status: 'sent', queued_at: new Date().toISOString() }] };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k1' });
    assert.equal(r.status, 'deduped');
  });

  await t('conflict with a SKIPPED row → takes the row over and proceeds (template lookup runs)', async () => {
    const calls = [];
    A.sbComms = async (path, env, opts = {}) => {
      calls.push(path.split('?')[0] + ':' + (opts.method || 'GET'));
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M2', status: 'skipped', queued_at: '2026-07-01T00:00:00Z' }] };
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };                       // template_not_found → finalize
      if (path.includes('/messages?id=eq.M2')) return { ok: true, data: [{ id: 'M2' }] };          // finalize PATCH on the ADOPTED row
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k2' });
    assert.notEqual(r.status, 'deduped');                       // it retried
    assert.ok(calls.some((c) => c.includes('/messages') && c.endsWith(':PATCH')), 'must PATCH the adopted row');
  });

  await t('conflict with a FRESH queued row (in-flight) → deduped', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M3', status: 'queued', queued_at: new Date().toISOString() }] };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k3' });
    assert.equal(r.status, 'deduped');
  });

  await t('conflict with a STALE queued row (crashed run) → takes over', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: true, data: [{ id: 'M4', status: 'queued', queued_at: '2026-07-01T00:00:00Z' }] };
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };
      if (path.includes('/messages?id=eq.M4')) return { ok: true, data: [{ id: 'M4' }] };
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k4' });
    assert.notEqual(r.status, 'deduped');
  });

  await t('conflict + status-lookup FAILURE → deduped (fail-safe against double-send)', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [] };
      if (path.includes('/messages?dedup_key=eq.')) return { ok: false, status: 500, data: null };
      throw new Error('unexpected ' + path);
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k5' });
    assert.equal(r.status, 'deduped');
  });

  await t('finalize RELEASES the dedup key on a non-sent outcome', async () => {
    let patched = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'M6' }] };        // fresh reserve
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };                        // → failed
      if (path.includes('/messages?id=eq.M6') && opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, data: [{ id: 'M6' }] }; }
      return { ok: true, data: [] };
    };
    await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T', dedupKey: 'k6' });
    assert.strictEqual(patched.dedup_key, null, 'non-sent outcome must free the key');
  });

  A.sbComms = origSb;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run — expect FAIL** (`node test/send-dedup.test.js`; the skipped/stale-takeover and release tests fail against current code)

- [ ] **Step 3: Implement.** In `send.js`, replace the reserve block:

```js
  // dedup reserve — dedup on SUCCESS, not on attempt. A prior sent-like row (or a fresh
  // in-flight queued row) dedups; a prior skipped/failed/suppressed/stale-queued row is
  // ADOPTED so the retry can run. Review 2026-07-21 finding C1: burning the key on any
  // outcome turned every transient failure into a silent permanent loss.
  const SENT_LIKE = new Set(['sent', 'delivered', 'opened', 'clicked', 'bounced']);
  const IN_FLIGHT_MS = 10 * 60 * 1000;
  if (opts.dedupKey) {
    const reserve = await A.sbComms('/rest/v1/messages?on_conflict=dedup_key', env, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        profile_id: opts.profileId || null, channel, purpose, status: 'queued',
        source: opts.source || null, dedup_key: opts.dedupKey, to_address: opts.to || null,
      }),
    });
    if (reserve.ok && Array.isArray(reserve.data) && reserve.data.length === 0) {
      const ex = await A.sbComms(
        `/rest/v1/messages?dedup_key=eq.${A.enc(opts.dedupKey)}&select=id,status,queued_at&limit=1`, env);
      const row = ex.ok ? ex.data?.[0] : null;
      const inFlight = row && row.status === 'queued'
        && (Date.now() - new Date(row.queued_at).getTime()) < IN_FLIGHT_MS;
      // Unknown state (lookup failed / row vanished) → dedup: fail-safe against double-send.
      if (!row || SENT_LIKE.has(row.status) || inFlight) return { status: 'deduped', deduped: true };
      opts._reservedId = row.id;   // adopt the failed/skipped/stale row — this attempt owns it now
    } else {
      opts._reservedId = reserve.data?.[0]?.id || null;
    }
  }
```

And in `finalize()`, change the `row` literal's dedup line:

```js
    // Non-sent outcomes FREE the key (dedup-on-success). 'sent' keeps it so redeliveries dedup.
    dedup_key: res.status === 'sent' ? (opts.dedupKey || null) : null,
```

- [ ] **Step 4: Run new test → PASS; run ALL existing suites → PASS** (`for f in test/*.test.js; do node $f || exit 1; done`)
- [ ] **Step 5: Note (no code):** `journey-graph.js sendWentOut()` counting `deduped` as went-out is now CORRECT (deduped ⇒ sent-like or in-flight). Leave it.
- [ ] **Step 6: Commit** — `fix(send): dedup on success, not attempt — adopt failed/skipped/stale rows on retry (review C1)`

### Task 2: Fail-closed gate — suppression + frequency cap (finding H1) [HIGH]

**Files:**
- Modify: `05_Throttle/commsops-worker/src/gate.js:66–70, 80–87`
- Create: `05_Throttle/commsops-worker/test/gate-failclosed.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/gate-failclosed.test.js — a DB error must BLOCK, never pass.
const assert = require('assert');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const base = { test_mode: false, test_mode_allow: [], frequency_cap_per_day: 3, frequency_cap_window_hours: 24, quiet_hours_start: 21, quiet_hours_end: 9 };

(async () => {
  await t('suppression query error → gate_error, not pass', async () => {
    A.sbComms = async (path) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const g = await runGate({}, { channel: 'email', purpose: 'utility', to: 'x@y.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:suppression');
  });

  await t('freq-cap query error → gate_error, not silently uncapped', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
      if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{ state: 'opted_in' }] };
      if (path.startsWith('/rest/v1/messages')) return { ok: false, status: 500, data: null };
      if (path.includes('consume_send_budget')) return { ok: true, data: true };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'x@y.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:freq_cap');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run → FAIL** (both currently pass the gate)
- [ ] **Step 3: Implement in `gate.js`.** Suppression block becomes:

```js
  // 1. suppression — overrides everything. FAIL CLOSED: an unreadable suppression list is a
  //    blocked send, not a free pass (review 2026-07-21 H1 — the one gate that must never fail open).
  if (to) {
    const sup = await A.sbComms(
      `/rest/v1/suppressions?channel=eq.${A.enc(channel)}&value=eq.${A.enc(to)}&select=id&limit=1`, env);
    if (!sup.ok) return { pass: false, reason: 'gate_error:suppression' };
    if (sup.data?.[0]) return { pass: false, reason: 'suppressed' };
  }
```

Freq-cap block becomes:

```js
      const cnt = await A.sbComms(
        `/rest/v1/messages?profile_id=eq.${A.enc(profileId)}&purpose=eq.marketing` +
        `&status=in.(sent,delivered,opened,clicked)&queued_at=gte.${A.enc(since)}&select=id`, env);
      if (!cnt.ok || !Array.isArray(cnt.data)) return { pass: false, reason: 'gate_error:freq_cap' };
      if (cnt.data.length >= Number(s.frequency_cap_per_day || 3))
        return { pass: false, reason: 'freq_cap' };
```

- [ ] **Step 4: Run new + `wa.test.js` (its gate tests must still pass) → PASS**
- [ ] **Step 5: Commit** — `fix(gate): suppression + freq-cap fail CLOSED on DB error (review H1)`

### Task 3: Email adapter network try/catch (finding H2) [HIGH]

**Files:**
- Modify: `05_Throttle/commsops-worker/src/adapters/email.js:20–31`
- Create: `05_Throttle/commsops-worker/test/email-adapter.test.js`

- [ ] **Step 1: Failing test**

```js
// test/email-adapter.test.js
const assert = require('assert');
const email = require('../src/adapters/email.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const realFetch = global.fetch;
(async () => {
  await t('network error → failed result, never a throw', async () => {
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com'); };
    const r = await email.send({ from: 'a <a@b.c>', to: 'x@y.com', subject: 's', html: '<p>h</p>' }, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(r.status, 'failed');
    assert.ok(String(r.reason).startsWith('resend_network:'));
    assert.strictEqual(r.provider_message_id, null);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run → FAIL** (currently throws)
- [ ] **Step 3: Implement** — wrap the fetch:

```js
  let res, data;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    // A network failure must surface as a failed RESULT — a throw here escapes send() with no
    // messages row and (pre-Task-1) a permanently burned dedup key (review H2).
    return { provider_message_id: null, status: 'failed',
             reason: `resend_network:${String(e?.message || e).slice(0, 140)}`, raw: null };
  }
```

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `fix(email): catch network errors — failed result, not a throw (review H2)`

### Task 4: Campaign fan-out — throw on RPC failure, contain per-recipient throws (findings C2, H3)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/campaigns.js:67–95`
- Create: `05_Throttle/commsops-worker/test/campaign-fanout.test.js`

- [ ] **Step 1: Failing tests**

```js
// test/campaign-fanout.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const CAMPROW = { id: 'C', status: 'sending', segment_id: 'S', template_id: 'T', channel: 'email', purpose: 'utility', name: 'x', vars: {} };

(async () => {
  await t('recipients-RPC failure → THROWS (queue retries); campaign is NOT marked sent', async () => {
    let sentPatch = false;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [CAMPROW] };
      if (path.includes('campaign_recipients')) return { ok: false, status: 500, data: null };
      if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') { sentPatch = true; return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    let threw = false;
    try { await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId: 'C', after: null }); }
    catch (e) { threw = true; assert.ok(String(e.message).includes('campaign_recipients_failed')); }
    assert.ok(threw, 'must throw so the queue retries');
    assert.ok(!sentPatch, 'must NOT mark the campaign sent');
  });

  await t('one recipient throwing does not kill the page; continuation still enqueues', async () => {
    const enq = [];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [CAMPROW] };
      if (path.includes('campaign_recipients')) return { ok: true, data: [
        { profile_id: 'P1', address: 'a@b.com' }, { profile_id: 'P2', address: 'b@b.com' },
        { profile_id: 'P3', address: 'c@b.com' }, { profile_id: 'P4', address: 'd@b.com' } ] };  // == SENDS_PER_MSG
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'R' + Math.random() }] };
      if (path.includes('/templates?id=eq.') ) {
        // throw RAW on the first template lookup only → recipient 1's send() throws
        if (!global.__threw_once) { global.__threw_once = true; throw new Error('boom'); }
        return { ok: true, data: [] };   // others: template_not_found → failed result, no throw
      }
      return { ok: true, data: [] };
    };
    global.__threw_once = false;
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async (m) => enq.push(m) } }, { campaignId: 'C', after: null });
    assert.equal(enq.length, 1, 'continuation enqueued despite recipient-1 throw');
    assert.equal(enq[0].after, 'P4');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run → FAIL** (test 1: campaign gets marked sent; test 2: the throw escapes)
- [ ] **Step 3: Implement in `processQueueMessage`:**

```js
  const r = await A.sbComms('/rest/v1/rpc/campaign_recipients', env, {
    method: 'POST',
    body: JSON.stringify({ p_segment_id: camp.segment_id, p_channel: camp.channel,
      p_purpose: camp.purpose, p_after: after, p_limit: SENDS_PER_MSG }),
  });
  // An RPC failure is NOT "fan-out complete" (review C2): throw → Queues redeliver this page →
  // after max retries it DLQs with an alert. Only a genuine short page may finish the campaign.
  if (!r.ok) throw new Error(`campaign_recipients_failed:${campaignId}:${r.status}`);
  const recs = Array.isArray(r.data) ? r.data : [];

  let pageErrors = 0;
  for (const rec of recs) {
    if (!rec.address) continue;
    try {
      await send(env, {
        channel: camp.channel, purpose: camp.purpose, profileId: rec.profile_id, to: rec.address,
        templateId: camp.template_id, constants: camp.vars || {},
        tracking: { campaign: camp.name },
        source: `campaign:${campaignId}`, dedupKey: `campaign:${campaignId}:${rec.profile_id}`,
      });
    } catch (e) {
      // One bad recipient must not poison the page (review H3). The dedup row (Task 1) lets a
      // later manual replay retry this profile; the rest of the audience continues now.
      pageErrors++;
      console.log('campaign_recipient_error', campaignId, rec.profile_id, e?.message || String(e));
    }
  }
  if (pageErrors) console.log('campaign_page_errors', campaignId, pageErrors);
```

- [ ] **Step 4: Run new + all suites → PASS**
- [ ] **Step 5: Commit** — `fix(campaigns): throw on recipients-RPC failure; contain per-recipient throws (review C2,H3)`

### Task 5: Stalled-campaign alert sweep (finding H3 tail)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — inside `runScheduled`, after the due-campaign sweep block

- [ ] **Step 1: Implement (no unit harness for cron — code review + live check):**

```js
  // 1b. stalled broadcasts — a campaign stuck 'sending' for >30 min means its continuation
  // chain died (DLQ'd page / worker eviction). Alert-only: resuming needs a human decision.
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuck = await A.sbComms(
      `/rest/v1/campaigns?status=eq.sending&updated_at=lt.${A.enc(cutoff)}&select=id,name,updated_at`, env);
    for (const c of (stuck.ok && Array.isArray(stuck.data) ? stuck.data : [])) {
      await AL.alert(env, `⚠️ *Relay — broadcast stalled*\n"${c.name}" has been 'sending' since ${c.updated_at}. Fan-out chain likely died — check comms.queue_failures.`);
    }
  } catch (e) { console.log('stall_sweep_error', e?.message || String(e)); }
```

Note: `setStatus` bumps `updated_at` on claim; pages don't bump it — long legitimate fan-outs may alert once. Acceptable (alert, not action). If noisy later, bump `updated_at` per page in `processQueueMessage`.

- [ ] **Step 2: Run all suites (no regression) → PASS**
- [ ] **Step 3: Commit** — `feat(cron): alert on broadcasts stalled in 'sending' >30min (review H3)`

### Task 6: Shopflo consent hardening (finding C3) [CRITICAL/compliance]

**Files:**
- Modify: `05_Throttle/commsops-worker/src/shopflo-webhooks.js:74–84`
- Create: `05_Throttle/commsops-worker/test/shopflo-consent.test.js`

- [ ] **Step 1: Failing tests**

```js
// test/shopflo-consent.test.js — a consent write failure must surface as non-2xx (Shopflo retries),
// and consent must be attempted even on a deduped event retry.
const assert = require('assert');
const A = require('../src/auth.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

// handleShopfloWebhook(env, request) — build a minimal Request-alike.
const req = (body) => ({
  headers: { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer tok' : null) },
  json: async () => body, text: async () => JSON.stringify(body), url: 'https://x/webhooks/shopflo',
  method: 'POST', clone() { return this; },
});
// Real Shopflo abandoned-checkout shape carrying an explicit opt-OUT:
const BODY = { event: 'abandoned_checkout', data: { customer: { email: 'x@y.com', phone: '+919999999999', marketing_consent: false }, checkout_id: 'CK1', total_price: '1999' } };
const ENV = { SHOPFLO_WEBHOOK_TOKEN: 'tok', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const { handleShopfloWebhook } = require('../src/shopflo-webhooks.js');
const orig = A.sbComms;

(async () => {
  await t('consent insert failure → ok:false / status 500 (Shopflo will retry)', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('resolve_identity')) return { ok: true, data: { profile_id: 'P', event_id: 'E', deduped: false } };
      if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E' }] };
      if (path.startsWith('/rest/v1/consent')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
  });

  await t('deduped event retry STILL attempts consent (append-only, duplicate rows are cosmetic)', async () => {
    let consentTried = 0;
    A.sbComms = async (path) => {
      if (path.includes('resolve_identity')) return { ok: true, data: { profile_id: 'P', event_id: 'E', deduped: true } };
      if (path.startsWith('/rest/v1/consent')) { consentTried++; return { ok: true, data: [{}] }; }
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    assert.equal(r.ok, true);
    assert.ok(consentTried >= 1, 'consent must be re-attempted on a deduped retry');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

**Implementation note for the test-writer subagent:** if `handleShopfloWebhook`'s ingest path differs from the stub shapes above (it calls `ingest()` from `../src/ingest.js`, which itself calls `A.sbComms`), stub at the `A.sbComms` level as shown and adjust path matchers to whatever `ingest()` actually requests (`resolve_identity` RPC + `/events`). Run the test, read the failure, adjust matchers — do NOT weaken the assertions.

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement.** Replace the consent block in `shopflo-webhooks.js`:

```js
    // Record marketing consent from the payload — on EVERY delivery, including deduped
    // retries. The ledger is append-only latest-wins, so a duplicate row is cosmetic; a LOST
    // opt-out is a compliance failure (review C3). A failed write returns 500 so Shopflo
    // redelivers and the consent is re-attempted.
    let consent = 0;
    for (const c of FLO.consentRowsFrom(body, envlp.occurred_at)) {
      const w = await recordConsent(env, { profile_id: r.profile_id, ...c });
      if (!w.ok) {
        await capture(env, request, body).catch(() => {});
        return { ok: false, error: 'consent_write_failed', status: 500 };
      }
      consent++;
    }
```

(Delete the old `if (!r.deduped) { ... .catch(() => {}) }` wrapper entirely.)

- [ ] **Step 4: Run new + all suites → PASS**
- [ ] **Step 5: Commit** — `fix(shopflo): consent writes checked + retried on dedup — a lost opt-out can no longer ack 200 (review C3)`

### Task 7: UI — marketing template unsubscribe warning must block save (finding M14)

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/templates/page.js:134–136`

- [ ] **Step 1: Implement** — locate the block that toasts `Marketing emails should include {unsubscribe_url}` and add the missing `return`:

```js
    if (t.channel === 'email' && t.purpose === 'marketing'
        && !String(content.html_body || '').includes('{unsubscribe_url}')) {
      showToast('Marketing emails must include {unsubscribe_url} — add the merge tag before saving.', 'error');
      return;                                   // review M14: the toast used to fire and save anyway
    }
```

(Adapt the condition to the exact existing check at :134 — keep its detection, add the `return`.)

- [ ] **Step 2: Build** — `cd 05_Throttle && npx turbo build --filter=relay` → zero errors
- [ ] **Step 3: Commit** — `fix(relay-ui): block save of marketing email templates missing {unsubscribe_url} (review M14)`

### ✅ GATE 1 CHECKPOINT
- [ ] All suites green (`for f in test/*.test.js; do node $f || exit 1; done`)
- [ ] Reviewer subagent: read the full Gate-1 diff (`git -C 05_Throttle diff <pre-gate-sha>`) against findings C1,C2,C3,H1,H2,H3,M14 — confirm each failure scenario is closed; report anything reopened.
- [ ] Push. **Deploy checkpoint A:** `cd 05_Throttle/commsops-worker && npx wrangler deploy`. Live smoke: `curl -s https://commsops.afshaan.workers.dev/` health 200; send a template test to `afshaan@legendoftoys.com` via the UI or `sendTest` → delivered; confirm a deliberate bad-address send writes a `skipped` row with a readable reason.

---

# GATE 2 — before / at the WhatsApp cutover

### Task 8: `pickSender` — WABA scoping outranks the pin; type-safe compare; pre-filter fallback (finding H5 parts 1,2,4)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/send.js:32–56`
- Create: `05_Throttle/commsops-worker/test/pick-sender.test.js`

- [ ] **Step 1: Failing tests**

```js
// test/pick-sender.test.js
const assert = require('assert');
const { pickSender } = require('../src/send.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const S = (id, purpose, waba) => ({ id, purpose, metadata: waba ? { waba_id: waba } : {} });

(async () => {
  await t('senderId pin on the WRONG WABA → null (refuse), never mis-route', () =>
    assert.strictEqual(pickSender([S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2')],
      { senderId: 'a', wabaId: 'W2' }), null));

  await t('senderId pin on the right WABA → picked', () =>
    assert.equal(pickSender([S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2')],
      { senderId: 'b', wabaId: 'W2' }).id, 'b'));

  await t('waba compare is type-coerced (number vs string)', () =>
    assert.equal(pickSender([{ id: 'a', purpose: 'utility', metadata: { waba_id: 1234567890 } }],
      { purpose: 'utility', wabaId: '1234567890' }).id, 'a'));

  await t('single-sender fallback judged on PRE-filter count: 3 channel senders, wrong-purpose template on W2 → refuse', () =>
    assert.strictEqual(pickSender(
      [S('a', 'marketing', 'W1'), S('b', 'transactional', 'W2'), S('c', 'utility', 'W3')],
      { purpose: 'marketing', wabaId: 'W2' }), null));

  await t('genuinely single channel sender still falls back', () =>
    assert.equal(pickSender([S('a', 'transactional', 'W2')], { purpose: 'marketing', wabaId: 'W2' }).id, 'a'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run → FAIL** (pin bypass + post-filter fallback + strict equality all fail)
- [ ] **Step 3: Implement — replace `pickSender`:**

```js
function pickSender(rows, { purpose, senderId, wabaId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const channelCount = rows.length;              // pre-filter count — fallback is judged on THIS
  if (wabaId) {
    // WABA scoping outranks EVERYTHING including an explicit pin (review H5): a pinned sender
    // on the wrong WABA would POST a template Meta doesn't have there. Compare as strings —
    // the ids live in two independently-authored jsonb blobs (review H5 part 4).
    const key = String(wabaId);
    const onWaba = rows.filter((s) => String(s.metadata?.waba_id ?? '') === key);
    if (!onWaba.length) return null;
    rows = onWaba;
  }
  if (senderId) return rows.find((s) => s.id === senderId) || null;   // pin, WITHIN the WABA
  const isWild = (p) => p == null || p === '' || p === 'all';
  if (purpose) {
    const exact = rows.find((s) => s.purpose === purpose);
    if (exact) return exact;
  }
  const wild = rows.find((s) => isWild(s.purpose));
  if (wild) return wild;
  // Fallback only when the CHANNEL genuinely has one sender — a WABA-narrowed single row is
  // NOT unambiguous, it's a mis-pinned template about to leave the wrong number (review H5 part 2).
  return channelCount === 1 ? rows[0] : null;
}
```

- [ ] **Step 4: Run new + all suites → PASS**
- [ ] **Step 5: Commit** — `fix(send): WABA scoping outranks sender pin; string-compare waba ids; fallback on channel count (review H5)`

### Task 9: Per-number 24h windows (finding H5 part 3)

**Files:**
- Migration (Supabase `apply_migration`, name `comms_wa_windows_per_number_v1`)
- Modify: `05_Throttle/commsops-worker/src/send.js` (`waWindowOpen` + its call site), `05_Throttle/commsops-worker/src/wa-webhooks.js` (window upsert ~120–124)
- Modify: `05_Throttle/commsops-worker/test/wa.test.js` if any window test asserts the old key (check first)

- [ ] **Step 1: Migration** (contains `DROP CONSTRAINT` → sql-gate prompts; approve):

```sql
-- comms_wa_windows_per_number_v1 — Meta's 24h service window is per (business number ↔ customer),
-- not per customer (review H5 part 3). Old rows keep phone_number_id='' and age out in 24h.
ALTER TABLE comms.wa_windows ADD COLUMN IF NOT EXISTS phone_number_id text NOT NULL DEFAULT '';
ALTER TABLE comms.wa_windows DROP CONSTRAINT wa_windows_pkey;
ALTER TABLE comms.wa_windows ADD PRIMARY KEY (identifier_value, phone_number_id);
```

- [ ] **Step 2: Writer** — in `wa-webhooks.js`, the inbound window upsert gains the receiving number (the change value's `metadata.phone_number_id` is already extracted nearby as `phoneId` — pass it):

```js
      await A.sbComms('/rest/v1/wa_windows?on_conflict=identifier_value,phone_number_id', env, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ identifier_value: waId, phone_number_id: phoneId || '',
                               last_inbound_at: at, updated_at: new Date().toISOString() }),
      });
```

(Adapt variable names to the surrounding code — the customer wa_id and the receiving `phone_number_id` are both in scope in `handleInbound`.)

- [ ] **Step 3: Reader** — in `send.js`, `waWindowOpen(env, to)` becomes `waWindowOpen(env, to, phoneNumberId)`:

```js
async function waWindowOpen(env, to, phoneNumberId) {
  const id = whatsappAdapter.toWaId(to);
  if (!id || !phoneNumberId) return false;      // no number context = no window (fail closed)
  const r = await A.sbComms(
    `/rest/v1/wa_windows?identifier_value=eq.${A.enc(id)}` +
    `&phone_number_id=eq.${A.enc(phoneNumberId)}&select=last_inbound_at&limit=1`, env);
  const row = r.ok ? r.data?.[0] : null;
  if (!row?.last_inbound_at) return false;
  return (Date.now() - new Date(row.last_inbound_at).getTime()) < 24 * 3600 * 1000;
}
```

Call site inside `send()` (the WhatsApp render branch) becomes:

```js
      const windowOpen = isTemplate ? false
        : await waWindowOpen(env, to, sender.metadata?.phone_number_id || null);
```

- [ ] **Step 4: Run all suites; fix any window-test stubs to include the new query param → PASS**
- [ ] **Step 5: Commit** — `fix(wa): 24h window is per (customer, business number) — migration + writer + reader (review H5)`

### Task 10: WhatsApp cost parse — billable means billable (finding H4)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/adapters/whatsapp.js:111,120`
- Modify: `05_Throttle/commsops-worker/test/wa.test.js` (the status/cost parse test)

- [ ] **Step 1: Extend the existing cost test in `wa.test.js`** (find the `parseStatusWebhook` cost assertion) with:

```js
  await t('cost: billable:false service message is NOT costed; absent billable is unpriced', () => {
    const mk = (pricing) => ({ entry: [{ changes: [{ value: { statuses: [{ id: 'w', status: 'delivered', timestamp: '1700000000', pricing }] } }] }] });
    assert.strictEqual(wa.parseStatusWebhook(mk({ billable: false, category: 'service' }))[0].cost, null);
    assert.strictEqual(wa.parseStatusWebhook(mk({ category: 'utility' }))[0].cost, null);          // tri-state: absent ≠ billable
    assert.strictEqual(wa.parseStatusWebhook(mk({ billable: true, category: 'marketing' }))[0].cost, 1);
  });
```

- [ ] **Step 2: Run → FAIL** (first two currently cost `1`)
- [ ] **Step 3: Implement:**

```js
      // Billable means Meta SAID billable. category-presence is not a price signal —
      // {billable:false, category:'service'} is every free service-window message, i.e. most
      // of the support number's traffic (review H4). Absent billable = unpriced (tri-state).
      const priced = s.pricing?.billable === true;
```

- [ ] **Step 4: Run wa.test.js + all → PASS**
- [ ] **Step 5: Commit** — `fix(wa): only billable:true is costed — free service messages no longer counted (review H4)`

### Task 11: `saveTemplate` merges worker-owned content keys (findings C4-server, M8)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — the `saveTemplate` POST case (~322–345)

- [ ] **Step 1: Implement.** In the update path (when `body.id` exists), before writing:

```js
      // The UI rebuilds `content` from form state and historically DROPPED worker-owned keys
      // (waba_id pin, header_handle, and the WA approval linkage) — which silently re-routes
      // sync/sends to the wrong WABA (review C4/M8). Carry them over unless explicitly sent.
      if (body.id) {
        const exist = await A.sbComms(
          `/rest/v1/templates?id=eq.${A.enc(body.id)}&select=content&limit=1`, env);
        const prev = (exist.ok && exist.data?.[0]?.content) || {};
        for (const k of ['waba_id', 'header_handle']) {
          if (content[k] == null && prev[k] != null) content[k] = prev[k];
        }
      }
```

(Place after the handler has assembled its `content` object from `body`, before the PATCH. Adapt the variable name to the handler's local.)

- [ ] **Step 2: Run all suites (no worker unit harness covers index handlers — reviewer subagent must trace the handler by eye) → PASS**
- [ ] **Step 3: Commit** — `fix(templates): saveTemplate preserves waba_id/header_handle on update (review C4,M8)`

### Task 12: UI — carry `waba_id` through the WA template editor (findings C4-UI, #11-UI)

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/templates/page.js` (`buildPayload` ~106–116, `startEdit` ~69–83)
- Modify: `05_Throttle/apps/relay/src/components/wa-editor/WaEditor.js` (~61 lock check)

- [ ] **Step 1: `buildPayload`** — in the WA `content` object add:

```js
      if (w.waba_id) content.waba_id = w.waba_id;
```

- [ ] **Step 2: `startEdit`** — where the `wa` editor state is seeded from the stored template's `content` (call it `c`), include the pin and the submit linkage:

```js
        waba_id: c.waba_id || '',
```

- [ ] **Step 3: WABA lock** — the lock check reads `c.provider_template_id` off the `wa` object where it never lives. Pass the template-root field down: in `templates/page.js`, give WaEditor a prop `locked={!!t.provider_template_id}`; in `WaEditor.js` replace the `c.provider_template_id` condition on the WABA `<select>`'s `disabled` with the `locked` prop.
- [ ] **Step 4: Manual verification (no UI test harness):** `npx turbo build --filter=relay` → zero errors. Then in the built app (or by code trace in review): open an existing WA template → the WABA select shows its pinned account and is disabled; Save → network payload contains `content.waba_id`; the "Submit to Meta" validation no longer reports the phantom missing-WABA error.
- [ ] **Step 5: Commit** — `fix(relay-ui): WA editor round-trips waba_id; submit no longer self-blocks; WABA lock works (review C4)`

### Task 13: shipment-events fails closed with a grace window (finding H11)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/shipment-events.js:88–99`
- Modify: `05_Throttle/commsops-worker/test/shipment-events.test.js` (add cases)

- [ ] **Step 1: Add failing tests** to the existing suite (match its stub style — it already stubs `A.sbComms` and drives `emitShipmentEvents`):

```js
  await t('order_placed lookup FAILURE → parcel retried next tick, NOT marked emitted', async () => {
    // stub: settings watermark passes; events select returns {ok:false}; markEmitted must NOT be called
    // assert: result counts failed>=1 and no PATCH to ecom_shipments for this row
  });
  await t('young parcel with no order_placed yet → NOT marked emitted (grace <24h)', async () => {
    // stub: events select ok but empty; shipment first_seen_at = now; assert no markEmitted PATCH
  });
  await t('old parcel (>24h) with no order_placed → marked emitted (pre-Relay order)', async () => {
    // stub: events select ok but empty; first_seen_at = 3 days ago; assert markEmitted PATCH happens
  });
```

Write these as REAL tests following the file's existing helpers (it has a stub harness — reuse it; the three comments above describe the exact stub/assert per case; implement them fully, run, and confirm they fail before the fix).

- [ ] **Step 2: Implement:**

```js
    const ev = await A.sbComms(
      `/rest/v1/events?name=eq.order_placed&properties->>shopify_order_id=eq.${A.enc(s.shopify_order_id)}`
      + `&select=profile_id&limit=1`, env);
    if (!ev.ok) { failed++; continue; }          // transient read error → retry next tick (review H11)
    const profileId = ev.data?.[0]?.profile_id || null;
    if (!profileId) {
      // Genuinely no order_placed. Young parcels may simply be ahead of the Shopify webhook
      // (same-day ship + retry backoff) — give them 24h before writing them off as pre-Relay.
      const born = new Date(s.first_seen_at || 0).getTime();
      if (Date.now() - born < 24 * 3600 * 1000) { unresolved++; continue; }
      unresolved++;
      await markEmitted(env, s);
      continue;
    }
```

(Confirm `first_seen_at` is selected in the module's shipment query; if not, add it to the select list.)

- [ ] **Step 3: Run shipment-events + all suites → PASS**
- [ ] **Step 4: Commit** — `fix(shipment-events): fail closed on read errors; 24h grace before writing off young parcels (review H11)`

### Task 14: `/send` requires an explicit purpose + live test-mode banners (findings M1, M12)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — the token-gated `POST /send` route (~641–648)
- Modify: `05_Throttle/apps/relay/src/app/(auth)/campaigns/page.js` (~305–322), `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js` (~305–310)

- [ ] **Step 1: Worker** — in the `/send` route, before calling `send()`:

```js
      // The internal gateway must never GUESS intent: an omitted purpose used to default to
      // 'marketing', silently withholding support replies behind consent/quiet-hours (review M1).
      if (!b.purpose) return err('purpose_required', 400);
```

- [ ] **Step 2: UI** — both pages: load settings once (`garageFetch('getRelaySettings', {}, session)`) into state; render the internal-test banner ONLY when `settings.test_mode !== false`; and in `sendNow()`'s confirm string, branch:

```js
      const gateLine = settings?.test_mode === false
        ? '⚠️ TEST MODE IS OFF — this WILL send to real customers.'
        : 'INTERNAL TEST GATE — sends off the allowlist are blocked.';
```

(Wire `gateLine` into the existing `window.confirm` text; keep the rest of the copy.)

- [ ] **Step 3: Build relay → zero errors. Run worker suites → PASS.**
- [ ] **Step 4: Commit** — `fix(send,ui): /send refuses missing purpose; test-mode banners read live settings (review M1,M12)`

### ✅ GATE 2 CHECKPOINT
- [ ] All suites green; relay builds clean.
- [ ] Reviewer subagent over the full Gate-2 diff vs findings H4,H5,H11,C4,M1,M8,M12.
- [ ] Push. **Deploy checkpoint B:** deploy commsops. Live smokes: sandbox WA template send still works (`pickSender` regression check — the sandbox sender + 3 live senders must still route by template WABA); `POST /send` without purpose → 400; `wa_windows` migration applied (`\d comms.wa_windows` shows composite PK).

---

# GATE 3 — before widening team roles

### Task 15: Scheduling is an activation act (finding H7)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — `saveCampaign` case (~412–423)

- [ ] **Step 1: Implement** — two guards inside `saveCampaign`:

```js
      // (a) Setting a schedule ARMS the cron to send with no further human action — that is
      // activation, and requires send_activate (review H7: build → schedule → auto-approve →
      // cron = customer sends on campaign_build alone).
      if (row.scheduled_at && !A.canActivate(auth.permissions))
        return err('send_activate_required_to_schedule', 403);
```

and make the update path draft-only:

```js
      const r = id
        ? await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(id)}&status=eq.draft`, env,
            { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) })
        : /* existing insert unchanged */;
      if (id && r.ok && Array.isArray(r.data) && r.data.length === 0)
        return err('not_editable_after_submit', 400);   // (b) post-draft campaigns are immutable via save
```

- [ ] **Step 2: Reviewer trace:** `cancelSchedule` (approved/scheduled) and `approve/reject/submit` flows still function — they PATCH via their own cases, untouched.
- [ ] **Step 3: Run suites; build; commit** — `fix(campaigns): scheduling requires send_activate; saveCampaign edits drafts only (review H7)`

### Task 16: Journey activation requires `send_activate` (finding H8)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js:475–477`
- Modify: `05_Throttle/apps/relay/src/app/(auth)/journeys/page.js:99` (switch gating)

- [ ] **Step 1: Worker:**

```js
    case 'setJourneyStatus': {
      // Activating = live customer automation → send_activate, matching what the roles UI
      // has promised all along (review H8). Drafting/pausing stays campaign_build.
      const gate = body.status === 'active' ? A.canActivate : A.canBuild;
      if (!gate(auth.permissions)) return err('forbidden', 403);
      const r = await J.setJourneyStatus(env, body.id, body.status);
      return r.ok ? ok(r) : err(r.error, 400); }
```

- [ ] **Step 2: UI:** the on/off switch's enable condition adds `perms.send_activate` for the activate direction (pause stays on `campaign_build`).
- [ ] **Step 3: Run suites; build; commit** — `fix(journeys): activation gated on send_activate (review H8)`

### Task 17: No self-escalation to super_admin (finding H9)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — `assignUserRole` case (~219–246)

- [ ] **Step 1: Implement** — after the `canAdmin` gate:

```js
      // Only a super admin may hand out a role that carries relay_super_admin — otherwise a
      // relay_admin self-escalates into saveRelaySettings/test_mode/PII backfill (review H9).
      const roleR = await A.sbStore(
        `/rest/v1/relayops_roles?role_key=eq.${A.enc(role_key)}&select=permissions&limit=1`, env);
      if (!roleR.ok || !roleR.data?.[0]) return err('unknown_role', 400);
      if (roleR.data[0].permissions?.relay_super_admin && !A.canSuperAdmin(auth.permissions))
        return err('super_admin_required_to_grant_super_admin', 403);
```

- [ ] **Step 2: Run suites; commit** — `fix(auth): granting a super-admin role requires super_admin (review H9)`

### Task 18: `getRoles` readable by admins; deterministic role pick (findings M11, M7)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js:44` (getRoles gate), `05_Throttle/commsops-worker/src/auth.js:41–43`

- [ ] **Step 1:** `getRoles` gate: `canSuperAdmin` → `canAdmin` (the /admin/users page needs the list to grant; role EDITING — `saveRole` — stays super_admin).
- [ ] **Step 2:** `auth.js` role lookup adds a deterministic order (newest active grant wins):

```js
  const urRes = await sbStore(
    `/rest/v1/relayops_user_roles?user_id=eq.${user.id}&active=eq.true` +
    `&select=role_key&order=assigned_at.desc&limit=1`, env);
```

- [ ] **Step 3: Run suites; commit** — `fix(auth): admins can list roles; newest active grant wins deterministically (review M11,M7)`

### Task 19: Contain the side doors — `sendTest` allowlist, `previewSegment` gate (findings M3, M9)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` — `sendTest` case (~374–384), `previewSegment` case (~397–404)

- [ ] **Step 1: `sendTest`** — permanently internal-only regardless of test_mode:

```js
      // sendTest is arbitrary-content + arbitrary-recipient by design — so its recipients are
      // permanently restricted to the internal allowlist, even after test_mode goes OFF
      // (review M3). Real-customer rehearsal is sendCampaignTest with a saved template.
      const st = await A.sbComms('/rest/v1/settings?id=eq.1&select=test_mode_allow&limit=1', env);
      const allow = (st.ok && st.data?.[0]?.test_mode_allow) || ['@legendoftoys.com'];
      if (!G.testModeAllows(body.to, allow))
        return err('test_sends_are_internal_only', 403);
```

(`const G = require('./gate.js')` is already imported in index.js as the gate module — reuse whatever its local name is.)

- [ ] **Step 2: `previewSegment`** — add `if (!A.canSegment(auth.permissions)) return err('forbidden', 403);` as the first line (review M9: arbitrary-definition preview is a PII count-oracle for mere viewers).
- [ ] **Step 3: Run suites; build (UI unaffected); commit** — `fix(gates): sendTest internal-only forever; previewSegment needs segment_manage (review M3,M9)`

### ✅ GATE 3 CHECKPOINT
- [ ] Reviewer subagent over the Gate-3 diff vs H7,H8,H9,M3,M7,M9,M11. Specifically attempt the H7 chain on paper: build→schedule→submit — where does it now stop? (Answer: schedule 403s without send_activate.)
- [ ] Run suites; push. (No deploy needed mid-way — Gate 4 continues; deploy at final checkpoint.)

---

# GATE 4 — journey/ops robustness

### Task 20: `enrol()` throws on transient failures; dedup policy hardening (findings H10, H12)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js:164–203`
- Create: `05_Throttle/commsops-worker/test/enrol.test.js`

- [ ] **Step 1: Failing tests**

```js
// test/enrol.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const J = require('../src/journeys.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const ENV = { JOURNEY_WORKFLOW: { create: async () => ({}) } };
const ACTIVE = { id: 'J', status: 'active', active_version: 1, reenrolment: 'once_while_active', reenrol_cooldown_hours: null };

(async () => {
  await t('journey READ failure → THROWS (queue retries), not journey_not_active', async () => {
    A.sbComms = async (path) => {
      if (path.includes('/journeys?id=eq.')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    await assert.rejects(() => J.enrol(ENV, { journeyId: 'J', profileId: 'P' }), /journey_read_failed/);
  });

  await t('enrolment INSERT failure → THROWS', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [ACTIVE] };
      if (path.includes('/enrolments') && opts.method === 'POST') return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };   // existence checks empty
    };
    await assert.rejects(() => J.enrol(ENV, { journeyId: 'J', profileId: 'P' }), /enrolment_insert_failed/);
  });

  await t('cooldown with null hours behaves as once_while_active (dedup check RUNS)', async () => {
    let existenceChecked = false;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/journeys?id=eq.')) return { ok: true, data: [{ ...ACTIVE, reenrolment: 'cooldown', reenrol_cooldown_hours: null }] };
      if (path.includes('/enrolments') && (!opts.method || opts.method === 'GET')) { existenceChecked = true; return { ok: true, data: [{ id: 'E-existing' }] }; }
      return { ok: true, data: [] };
    };
    const r = await J.enrol(ENV, { journeyId: 'J', profileId: 'P' });
    assert.ok(existenceChecked, 'dedup existence check must run');
    assert.equal(r.ok, false);   // deduped, not double-enrolled
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

(Adjust path matchers to `enrol()`'s real queries after a first run — keep assertions intact.)

- [ ] **Step 2: Implement in `journeys.js enrol()`:**
  - journey read: `if (!jr.ok) throw new Error('journey_read_failed');` (a genuinely missing/inactive journey keeps returning `{ok:false, error:'journey_not_active'}`).
  - insert: `if (!ins.ok) throw new Error('enrolment_insert_failed:' + ins.status);`
  - policy: normalize first —

```js
  const policy = ['once_while_active', 'once_ever', 'cooldown', 'always'].includes(j.reenrolment)
    ? j.reenrolment : 'once_while_active';                       // unknown → safest (review H12)
  const cooldownH = policy === 'cooldown' ? (Number(j.reenrol_cooldown_hours) || 24) : null;  // null/0 → 24h default
```

and use `policy`/`cooldownH` in the existing branch logic (only `'always'` skips the dedup check).
- [ ] **Step 3: Migration `comms_enrolments_active_unique_v1`** (race-proofs `once_while_active`): first check duplicates (`SELECT journey_id, profile_id, count(*) FROM comms.enrolments WHERE status='active' GROUP BY 1,2 HAVING count(*)>1` — expect 0 live; if >0 stop and report), then:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS enrolments_one_active_per_journey_profile
  ON comms.enrolments (journey_id, profile_id) WHERE status = 'active';
```

With the index, a raced second insert gets `{ok:false}` → the new throw → queue retry → existence check now sees the winner → clean dedup.
- [ ] **Step 4: Run new + all suites → PASS. Commit** — `fix(journeys): enrol throws on transient failures; policy defaults + active-unique index kill double-enrol (review H10,H12)`

### Task 21: Journey version-save integrity (finding H13)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js:140–148`

- [ ] **Step 1: Implement** — check the insert before touching `active_version`:

```js
  const ins = await A.sbComms('/rest/v1/journey_versions', env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ journey_id: id, version: nextV, definition }),
  });
  if (!ins.ok || !ins.data?.[0])
    return { ok: false, error: 'version_insert_failed' };   // never point active_version at a ghost (review H13)
```

- [ ] **Step 2: Run suites; commit** — `fix(journeys): never activate a version whose insert failed (review H13)`

### Task 22: Validate plain-`wait` durations at compile; log park errors (finding H14)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/journeys.js:53` (compile), `05_Throttle/commsops-worker/src/journey-workflow.js:372–381` (#park catch)

- [ ] **Step 1: Compile** — where `wait` steps are validated, require a parseable duration (reuse the module's existing `durationToMs`):

```js
      if (s.type === 'wait') {
        if (!s.duration || !durationToMs(s.duration))
          return bad(`step ${id}: wait duration invalid — use forms like '30m', '4h', '3 days'`);
      }
```

(Match `bad(...)`/error-collection style used by the surrounding compile checks.)
- [ ] **Step 2: #park catch** — keep the catch (CF signals timeout by throwing) but record what actually happened:

```js
    } catch (e) {
      // waitForEvent signals BOTH timeout and infra errors by throwing. Compile-time duration
      // validation (Task 22) removes the config-error case; anything else is logged so a
      // masked infra failure is at least visible in the step row (review H14).
      console.log('park_exit', stepId, String(e?.message || e).slice(0, 140));
      return { kind: 'timeout' };
    }
```

- [ ] **Step 3: Run suites; commit** — `fix(journeys): compile rejects unparseable wait durations; park logs its exits (review H14)`

### Task 23: Status-rank guard — webhooks can't downgrade engagement (finding M6)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/wa-webhooks.js` (~79–97), `05_Throttle/commsops-worker/src/webhooks.js` (~46–51)
- Create: `05_Throttle/commsops-worker/test/status-rank.test.js` — exercise whichever of the two update paths is testable with the sbComms stub (the wa-webhooks one has `handleStatuses` reachable via its exported handler; follow the file's structure); assert an `opened` row is NOT patched back to `delivered` but IS patched to `failed`.

- [ ] **Step 1: Shared rank (duplicate the tiny map in both files — they share no util module):**

```js
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4, bounced: 9, failed: 9, suppressed: 9, skipped: 9 };
const isUpgrade = (from, to) => (STATUS_RANK[to] ?? 0) >= (STATUS_RANK[from] ?? 0) || (STATUS_RANK[to] ?? 0) >= 9;
```

Both update sites already fetch the current message row (`msg`); guard the status field of the PATCH:

```js
      if (!isUpgrade(msg.status, canonical)) delete patch.status;   // late 'delivered' after 'read' keeps opened (review M6)
```

(Timestamps — `delivered_at` etc. — still PATCH regardless; only the canonical `status` is monotonic.)
- [ ] **Step 2: Run new + all suites → PASS. Commit** — `fix(webhooks): canonical message status is monotonic — out-of-order receipts can't downgrade (review M6)`

### Task 24: Small-batch — alerts, budget label, WA sync exact-match, unsubscribe token (findings L-alerts, L-budget, M10, H6)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/alerts.js:10–16`, `05_Throttle/commsops-worker/src/gate.js:109–111`, `05_Throttle/commsops-worker/src/wa-templates.js:241–246`, `05_Throttle/commsops-worker/src/send.js:78–94`

- [ ] **Step 1: alerts.js** — check the response:

```js
    const res = await fetch(env.SLACK_WEBHOOK_ALERTS, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) console.log('alert_delivery_failed', res.status);   // dead webhook must not be silent
    return res.ok;
```

- [ ] **Step 2: gate.js budget** — distinguish DB error from exhaustion:

```js
    const b = await A.sbComms('/rest/v1/rpc/consume_send_budget', env, { method: 'POST', body: '{}' });
    if (!b.ok) return { pass: false, reason: 'gate_error:budget' };      // don't misdiagnose a 500 as "cap hit"
    if (b.data !== true) return { pass: false, reason: 'budget_exhausted' };
```

- [ ] **Step 3: wa-templates sync** — exact name + language, no first-row fallback:

```js
    const hit = (data?.data || []).find((x) => x.name === name
      && (!t.content?.language || x.language === (t.content.language || t.language || 'en'))) || null;
```

(Delete the `|| data?.data?.[0]` arm — adopting an unrelated template's status was the bug, review M10.)
- [ ] **Step 4: send.js `unsubscribeUrl`** — conditional PATCH + verify (review H6):

```js
  if (row && !token) {
    token = rand();
    const w = await A.sbComms(
      `/rest/v1/consent?id=eq.${A.enc(row.id)}&unsubscribe_token=is.null`, env,
      { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ unsubscribe_token: token }) });
    if (!w.ok) return null;                                   // fail closed: no dead links in live mail
    if (!Array.isArray(w.data) || w.data.length === 0) {
      // lost a mint race — adopt the winner's token so THIS email's link resolves
      const re = await A.sbComms(`/rest/v1/consent?id=eq.${A.enc(row.id)}&select=unsubscribe_token&limit=1`, env);
      token = (re.ok && re.data?.[0]?.unsubscribe_token) || null;
      if (!token) return null;
    }
  }
```

- [ ] **Step 5: Run all suites; commit** — `fix(misc): alert delivery checked; budget errors labeled; WA sync exact-match; unsubscribe token race-safe (review H6,M10,L)`

### Task 25: Send-time audience re-check for auto-approved campaigns (finding M2)

**Files:**
- Modify: `05_Throttle/commsops-worker/src/campaigns.js` — `startCampaign` (~44–63)

- [ ] **Step 1: Implement** — after `reachableCount`, before the claim:

```js
  // Approval was judged on the SUBMIT-time audience; a dynamic segment may have grown past the
  // threshold since. A human-approved campaign (approved_by set) stands; an auto-approved one
  // that outgrew the threshold goes back for eyes (review M2).
  if (!camp.approved_by && await needsApproval(env, camp, reachable)) {
    await setStatus(env, id, { status: 'pending_approval', audience_snapshot: reachable });
    return { ok: false, error: 'audience_grew_needs_approval' };
  }
```

- [ ] **Step 2: Add a case to `test/campaign-fanout.test.js`:** stub a marketing campaign with `approved_by: null`, settings threshold 500, preview returning reachable 40000 → assert `startCampaign` returns `audience_grew_needs_approval` and PATCHed status `pending_approval`.
- [ ] **Step 3: Run; commit** — `fix(campaigns): auto-approved audiences re-checked at send time (review M2)`

### Task 26: Cron single-flight (finding M4)

**Files:**
- Migration `comms_cron_lock_v1`; Modify `05_Throttle/commsops-worker/src/index.js` — top of `runScheduled`

- [ ] **Step 1: Migration:**

```sql
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS cron_lock_at timestamptz;
```

- [ ] **Step 2: Claim (conditional PATCH = the same atomic pattern as startCampaign):**

```js
  // Single-flight: crons can overlap when a tick runs long. Claim via conditional PATCH on a
  // lock column; a tick that can't claim exits (the work is all sweep-shaped — next tick catches up).
  const lockCutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const claim = await A.sbComms(
    `/rest/v1/settings?id=eq.1&or=(cron_lock_at.is.null,cron_lock_at.lt.${A.enc(lockCutoff)})`, env,
    { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ cron_lock_at: new Date().toISOString() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0) {
    console.log('cron_skipped_overlap');
    return;
  }
```

(4-min lease < 5-min cadence: a crashed tick's lock expires before the next tick. No unlock write needed.)
- [ ] **Step 3: Reviewer check:** `getSettings` caches settings rows — the lock column rides the same row; confirm the settings-cache TTL (60s) doesn't fight the claim (it doesn't — the claim PATCHes directly, never through the cache).
- [ ] **Step 4: Run suites; commit** — `fix(cron): single-flight lease on runScheduled (review M4)`

### Task 27: UI error-surfacing + contacts opt-out (findings M13, M15, LOW-optout)

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/analytics/page.js` (~71–87), `.../journeys/page.js` (~111–113, 481), `.../contacts/page.js` (~57, 102–119), `.../templates/page.js` (+ `components/email-editor/EmailEditor.js` guard)

- [ ] **Step 1: Analytics/funnel:** replace the silent `catch → {}` fallbacks with an error flag rendered as text — pattern for each fetch site:

```js
      .catch(() => { setStatsError(true); return null; });
```

and in render, when the flag is set show `Analytics unavailable — retry` instead of ₹0 rows (review M15: fabricated zeros are indistinguishable from "earned nothing").
- [ ] **Step 2: Contacts:** gate the Identifiers/Events panels on `detailLoading` (spinner text) and render a visible error state when `getProfile` fails, instead of the seeded empty arrays.
- [ ] **Step 3: Blank-canvas guard (M13):** in `templates/page.js`, when opening a template with `content.html_body` but no `content.design_json`, set `htmlOnly=true`; on save with `htmlOnly` and a mounted editor, `window.confirm('This template was authored outside the visual editor. Saving will REPLACE its HTML with the canvas content. Continue?')` — cancel aborts the save.
- [ ] **Step 4: Contacts detail:** add an **"Opt out everywhere"** button (visible with `perms.data_consent_admin`) calling `workerFetch('optOutProfile', { profile_id: detail.id, state: 'opt_out', source: 'agent_ui' }, session)` with a confirm; render the per-channel results it returns. (First check the worker's `optOutProfile` case for its exact expected body keys and mirror them.)
- [ ] **Step 5: Build relay → zero errors; commit** — `fix(relay-ui): surface fetch errors instead of fake zeros; html-only template guard; opt-out-everywhere button (review M13,M15)`

### ✅ FINAL CHECKPOINT
- [ ] Full suite run: every `test/*.test.js` green. `npx turbo build --filter=relay` green.
- [ ] **Final adversarial review (fresh subagent):** read the review doc's Gate 1–4 lists top to bottom; for each finding ID, name the commit that closed it or the explicit out-of-scope entry. Anything unaccounted for → fix or log to BACKLOG before deploy.
- [ ] Commit + push everything. **Deploy commsops** (`npx wrangler deploy`).
- [ ] Live smokes: health 200 · sandbox WA template send OK · email test send delivered · `/send` sans purpose → 400 · a `gate_error:*` never appears in fresh sends (spot-check `comms.messages` reasons) · cron ticks visible, `cron_skipped_overlap` absent under normal cadence.
- [ ] Update knowledge files: `systems/relay.md` header (one paragraph: hostile-review fixes shipped, list gate numbers + worker version), close the BACKLOG hostile-review P1 item's fixed findings (leave out-of-scope ones listed), append `archive/SESSIONS.md`. Commit + push the workspace root.

---

## Self-review appendix (plan-time)

- **Coverage vs review doc:** C1→T1 · C2→T4 · C3→T6 · C4→T11+T12 · H1→T2 · H2→T3 · H3→T4+T5 · H4→T10 · H5→T8+T9 · H6→T24 · H7→T15 · H8→T16 · H9→T17 · H10→T20 · H11→T13 · H12→T20 · H13→T21 · H14→T22 · H15→(live-mitigated; svix hardening consciously deferred — LOW) · M1→T14 · M2→T25 · M3→T19 · M4→T26 · M5→(deferred: DLQ retry loop risk > benefit; alert already fires — log to BACKLOG at final checkpoint) · M6→T23 · M7→T18 · M8→T11 · M9→T19 · M10→T24 · M11→T18 · M12→T14 · M13→T27 · M14→T7 · M15→T27 · M16→(deferred, alert-only acceptable — BACKLOG) · M17→(deferred, latent-only — BACKLOG) · LOW batch→T24 + out-of-scope list.
- **Type consistency:** `pickSender(rows, {purpose, senderId, wabaId})` unchanged in arity (T8); `waWindowOpen` gains a 3rd arg with exactly one call site (T9); `STATUS_RANK` duplicated intentionally in two files (T23); all test files follow the `wa.test.js` runner shape.
- **Known live-data caveat for T9:** `comms.wa_windows` had 6 rows on 2026-07-21 — the `DEFAULT ''` backfill covers them; they expire naturally within 24h.
