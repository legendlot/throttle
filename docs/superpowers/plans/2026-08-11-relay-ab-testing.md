# Relay A/B Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a marketer send two versions of a WhatsApp campaign to a randomly split audience and be told which won — or, honestly, that the result cannot be trusted.

**Architecture:** A `campaign_variants` table per campaign; the existing queue fan-out assigns each recipient to an arm with a deterministic FNV-1a hash salted by `campaign_id`; the arm is stamped on `messages.variant_id`. A Postgres RPC aggregates per-arm counts, a pure worker module computes the statistics (intention-to-treat read÷sent, two-proportion z-test, MDE), and the Relay UI renders — it never does arithmetic.

**Tech Stack:** Cloudflare Workers (CommonJS), Supabase/PostgREST, Cloudflare Queues, Next.js (static export) for `apps/relay`, node's built-in `assert` for tests.

**Spec:** `docs/superpowers/specs/2026-08-11-relay-ab-testing-design.md` — read §5, §6 and §7 before starting. This plan implements spec §13 steps 1–6. **Step 7 (the Relay System Manual scaffold) is deliberately NOT in this plan** — it is the standard fleet pattern applied to a new app and is not A/B-specific. It needs its own plan. ⚠️ The A/B manual chapter must not be dropped when that happens; until the manual exists, its content lives as the inline UI guidance built in Tasks 10 and 12.

---

## Before you start

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/commsops-worker
node -e "1" && ls test | wc -l    # expect 55+
for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "ALREADY FAILING: $t"; done
```

Expect no output from the loop. The suite is green as of 2026-08-11; if something is already failing, fix or note that before adding to it.

**Conventions you must follow (from `05_Throttle/CLAUDE.md` and the workspace `CLAUDE.md`):**
- PostgREST returns numeric columns as **strings** — wrap every one in `Number()` before arithmetic.
- Never loop `await` per row; batch with `in.()` filters.
- `A.sbComms(path, env, opts)` returns `{ok, status, data}` and **never throws** on an HTTP error.
- Deploy sequence is edit → commit → **push (must succeed)** → `npx wrangler deploy`.

---

## File structure

**commsops-worker (create):**
| file | responsibility |
|---|---|
| `migrations/0050_comms_ab_testing.sql` | `campaign_variants`, `campaign_experiments`, `messages.variant_id`, `NOTIFY pgrst` |
| `migrations/0051_comms_campaign_variant_stats.sql` | aggregation-only RPC |
| `src/variants.js` | `fnv1a`, `pickVariant` — pure, no I/O |
| `src/ab-stats.js` | z-test, MDE, verdict + refusal states — pure, no I/O |
| `test/variants.test.js`, `test/ab-stats.test.js` | |

**commsops-worker (modify):**
| file | change |
|---|---|
| `src/send.js` | thread `opts.variantId` → `messages.variant_id` |
| `src/campaigns.js` | load variants (throw on failure), assign, per-arm test send, `startCampaign` guards |
| `src/index.js` | worker actions: variant CRUD, stats, experiment record |
| `src/wa-webhooks.js` | pause a `sending` campaign when Meta disables a bound template |

**apps/relay (create):** `campaigns/VariantSetup.js`, `campaigns/VariantProgress.js`, `campaigns/VariantResults.js`, `campaigns/useVariantStats.js`, `experiments/page.js`
**apps/relay (modify):** `campaigns/page.js` (mount the components; it is already 742 lines — do not grow it further), `src/lib/nav.js`

---

## Task 1: Migration — tables and column

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0050_comms_ab_testing.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0050 — A/B testing: variant arms, the experiment record, and the per-message stamp (S272)

CREATE TABLE IF NOT EXISTS comms.campaign_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES comms.campaigns(id) ON DELETE CASCADE,
  label        text NOT NULL,
  template_id  uuid NULL REFERENCES comms.templates(id),   -- NULL = holdout arm (future)
  weight       int  NOT NULL DEFAULT 50 CHECK (weight > 0),
  sort_order   int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, label)
);
CREATE INDEX IF NOT EXISTS campaign_variants_campaign_idx ON comms.campaign_variants(campaign_id);

CREATE TABLE IF NOT EXISTS comms.campaign_experiments (
  campaign_id      uuid PRIMARY KEY REFERENCES comms.campaigns(id) ON DELETE CASCADE,
  hypothesis       text NULL,
  planned_read_at  timestamptz NULL,
  learning         text NULL,
  verdict_snapshot jsonb NULL,
  decided_at       timestamptz NULL,
  decided_by       uuid NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ON DELETE NO ACTION matches messages_template_id_fkey / messages_sender_identity_id_fkey.
-- It deliberately collides with the CASCADE above: deleting a campaign that has sent messages is
-- blocked, which is correct. index.js must catch the 23503 and name it (Task 8).
ALTER TABLE comms.messages
  ADD COLUMN IF NOT EXISTS variant_id uuid NULL REFERENCES comms.campaign_variants(id);
CREATE INDEX IF NOT EXISTS messages_variant_idx ON comms.messages(variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE comms.campaign_variants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.campaign_experiments ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.campaign_variants    TO service_role;
GRANT ALL ON comms.campaign_experiments TO service_role;

-- ⚠️ REQUIRED. PostgREST caches the schema; a table created afterwards is invisible to it and
-- fails SILENTLY as a not-found (CORE.md, cost a debugging round in S239).
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 2: Apply it**

Apply via the Supabase MCP `apply_migration` tool, name `comms_ab_testing`, project `jkxcnjabmrkteanzoofj`.

- [ ] **Step 3: Verify the tables are real AND reachable through PostgREST**

```sql
SELECT to_regclass('comms.campaign_variants')     AS variants,
       to_regclass('comms.campaign_experiments')  AS experiments,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='comms' AND table_name='messages' AND column_name='variant_id') AS variant_col;
```
Expected: both regclasses non-null, `variant_col` = 1.

⚠️ Then confirm PostgREST can actually see it — the whole point of the NOTIFY:
```sql
SELECT count(*) FROM comms.campaign_variants;
```
Expected: `0`, not an error.

- [ ] **Step 4: Commit**

```bash
git add 05_Throttle/commsops-worker/migrations/0050_comms_ab_testing.sql
git commit -m "relay: A/B schema — campaign_variants, campaign_experiments, messages.variant_id"
```

---

## Task 2: `pickVariant` — deterministic assignment

**Files:**
- Create: `05_Throttle/commsops-worker/src/variants.js`
- Test: `05_Throttle/commsops-worker/test/variants.test.js`

- [ ] **Step 1: Write the failing test**

```js
// Deterministic arm assignment (S272). Pure — no DB, no network.
const assert = require('assert');
const { pickVariant, fnv1a } = require('../src/variants.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = { id: 'var-a', label: 'A', weight: 50 };
const B = { id: 'var-b', label: 'B', weight: 50 };
const CAMP1 = 'camp-1111', CAMP2 = 'camp-2222';

t('returns null when there are no variants', () => {
  assert.equal(pickVariant(CAMP1, uuid(1), []), null);
  assert.equal(pickVariant(CAMP1, uuid(1), null), null);
});

t('a single variant always wins', () => {
  for (let i = 0; i < 50; i++) assert.equal(pickVariant(CAMP1, uuid(i), [A]).id, 'var-a');
});

t('deterministic — same inputs, same arm, every time', () => {
  const first = pickVariant(CAMP1, uuid(7), [A, B]).id;
  for (let i = 0; i < 20; i++) assert.equal(pickVariant(CAMP1, uuid(7), [A, B]).id, first);
});

t('50/50 splits within tolerance over 10k profiles', () => {
  let a = 0;
  for (let i = 0; i < 10000; i++) if (pickVariant(CAMP1, uuid(i), [A, B]).id === 'var-a') a++;
  assert.ok(a > 4700 && a < 5300, `arm A got ${a}/10000, expected ~5000`);
});

t('80/20 is respected', () => {
  const big = { id: 'big', label: 'A', weight: 80 }, small = { id: 'small', label: 'B', weight: 20 };
  let b = 0;
  for (let i = 0; i < 10000; i++) if (pickVariant(CAMP1, uuid(i), [big, small]).id === 'big') b++;
  assert.ok(b > 7700 && b < 8300, `80-weight arm got ${b}/10000, expected ~8000`);
});

// ⚠️ THE FOOTGUN TEST (spec §5.1). Salting with campaign_id is what stops one cohort
// permanently living in arm A of every campaign. State the assertion precisely: two independent
// 50/50 splits agree ~50% of the time BY CHANCE. Asserting ~0% overlap would be demanding
// anti-correlation and would fail against correct code.
t('campaign salt re-shuffles: ~50% overlap between two campaigns, not ~100% and not ~0%', () => {
  let same = 0;
  for (let i = 0; i < 10000; i++) {
    if (pickVariant(CAMP1, uuid(i), [A, B]).id === pickVariant(CAMP2, uuid(i), [A, B]).id) same++;
  }
  assert.ok(same > 4500 && same < 5500, `${same}/10000 landed in the same arm; expected ~5000`);
});

// ⚠️ Assignment must be a function of the SET of arms, not of the array order they arrive in.
t('assignment is independent of the order the arms are passed in', () => {
  for (let i = 0; i < 200; i++) {
    assert.equal(pickVariant(CAMP1, uuid(i), [A, B]).id, pickVariant(CAMP1, uuid(i), [B, A]).id,
      `profile ${i} flipped arm when the array order changed`);
  }
});

t('fnv1a is stable and unsigned', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  assert.ok(fnv1a('anything') >= 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd 05_Throttle/commsops-worker && node test/variants.test.js`
Expected: `Cannot find module '../src/variants.js'`

- [ ] **Step 3: Implement**

```js
// Deterministic A/B arm assignment (S272). Pure: no DB, no network, no clock.
//
// Assignment is a hash, not a stored table, so it is stateless, replay-safe (a re-run assigns
// identically and dedup_key suppresses the send anyway), and — the property that matters most —
// INDEPENDENT of the keyset pagination order. That is what keeps a cancelled or stalled campaign's
// sent prefix correctly split and therefore still analysable. Do not "improve" this into a
// pre-assigned table.

// FNV-1a, 32-bit. Chosen over crypto.subtle because it is synchronous and trivially testable;
// cryptographic strength is irrelevant for bucketing.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;   // unsigned
}

// ⚠️ The `${campaignId}:` salt is load-bearing. Hash profile_id alone and the same people land in
// arm A of EVERY campaign forever — one cohort would only ever see one style of copy and every
// future test would inherit that bias.
//
// Modulo bias from `% total` is real and negligible: with a 32-bit hash and a total of 100, the
// low buckets are favoured by ~4 parts in 43 million. Do not "fix" it with rejection sampling.
function pickVariant(campaignId, profileId, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const arms = variants
    .filter((v) => v && Number(v.weight) > 0)
    // ⚠️ SORT BY id, DO NOT TRUST THE CALLER'S ORDER. The cumulative walk below is
    // order-sensitive, so if arms arrived in a different sequence — a changed `sort_order`, a
    // reordered UI list, a query without an ORDER BY — every recipient's arm would flip while
    // still looking perfectly deterministic. Sorting on the immutable id makes assignment a
    // function of (campaign, profile, set-of-arms) rather than of array order.
    .slice()
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0];

  const total = arms.reduce((s, v) => s + Number(v.weight), 0);
  let bucket = fnv1a(`${campaignId}:${profileId}`) % total;
  for (const v of arms) {
    bucket -= Number(v.weight);
    if (bucket < 0) return v;
  }
  return arms[arms.length - 1];   // unreachable; guards against float/NaN weights
}

module.exports = { fnv1a, pickVariant };
```

- [ ] **Step 4: Run the tests**

Run: `node test/variants.test.js`
Expected: `8 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add 05_Throttle/commsops-worker/src/variants.js 05_Throttle/commsops-worker/test/variants.test.js
git commit -m "relay: deterministic A/B arm assignment, salted by campaign_id"
```

---

## Task 3: `ab-stats` — the statistics and the refusal states

**Files:**
- Create: `05_Throttle/commsops-worker/src/ab-stats.js`
- Test: `05_Throttle/commsops-worker/test/ab-stats.test.js`

Spec §6 and §7. The primary metric is **read ÷ sent (ITT)** — see the spec for why conditioning on delivered is wrong.

- [ ] **Step 1: Write the failing test**

```js
// A/B statistics + refusal states (S272). Pure. This is the most correctness-critical code in the
// feature, which is exactly why it lives here and not in PL/pgSQL (no SQL test harness in this repo).
const assert = require('assert');
const { mde, verdict, MATURITY_HOURS } = require('../src/ab-stats.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// arm helper. preSendFailed = failed BEFORE the send (render/gate) — never entered `sent`.
// providerFailed = failed AFTER the send (wa_131049 etc) — inside `sent`, contributes 0 reads.
const arm = (label, sent, read, delivered = null, preSendFailed = 0, providerFailed = 0) => ({
  label, sent, read,
  delivered: delivered === null ? Math.round(sent * 0.7) : delivered,
  preSendFailed, providerFailed,
  assigned: sent + preSendFailed,
});

const MATURE = { hoursSinceSent: 24 };

t('MDE falls as n rises', () => {
  assert.ok(mde(0.4, 400) > mde(0.4, 800));
  assert.ok(mde(0.4, 800) > mde(0.4, 2127));
});

t('MDE matches the spec curve at p=0.40 (within 0.3pp)', () => {
  assert.ok(Math.abs(mde(0.4, 2127) - 4.2) < 0.3, `got ${mde(0.4, 2127)}`);
  assert.ok(Math.abs(mde(0.4, 800)  - 6.9) < 0.3, `got ${mde(0.4, 800)}`);
  assert.ok(Math.abs(mde(0.4, 400)  - 9.7) < 0.3, `got ${mde(0.4, 400)}`);
});

t('mde(0) and mde(_,0) are safe, not NaN', () => {
  assert.ok(Number.isFinite(mde(0.4, 0)) || mde(0.4, 0) === null);
  assert.ok(Number.isFinite(mde(0, 100)) || mde(0, 100) === null);
});

t('identical arms → too_close (NOT underpowered — there is no gap to be underpowered about)', () => {
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 800)], MATURE);
  assert.equal(v.state, 'too_close');
  assert.equal(v.winner, null);
});

t('a visible gap below the MDE → underpowered, which is a different message from too_close', () => {
  // 2.5pp apart on 2,000 per arm: real-looking, not significant, and below the ~4.3pp MDE.
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 850)], MATURE);
  assert.equal(v.state, 'underpowered');
  assert.ok(/bigger send/.test(v.reason), `expected a sample-size explanation, got: ${v.reason}`);
});

t('big gap on a big sample → a winner, and it names the right arm', () => {
  const v = verdict([arm('A', 2000, 700), arm('B', 2000, 900)], MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'B');
});

// ⚠️ THE 244-PERSON TRAP — the whole reason the guardrail exists. A 5pt gap on a tiny sample
// must NOT be called, however tempting it looks on screen.
t('big gap on a TINY sample → still refuses', () => {
  const v = verdict([arm('A', 122, 70), arm('B', 122, 76)], MATURE);
  assert.notEqual(v.state, 'winner');
  assert.equal(v.winner, null);
});

t('immature result refuses regardless of the gap', () => {
  const v = verdict([arm('A', 2000, 700), arm('B', 2000, 900)], { hoursSinceSent: 1 });
  assert.equal(v.state, 'immature');
  assert.equal(v.winner, null);
});

t('asymmetric PRE-SEND failures refuse — a biased sample, not a small one', () => {
  // B's template referenced a variable A's did not, so B failed to render for a non-random group.
  const v = verdict([arm('A', 2000, 700, 1400, 50), arm('B', 2000, 900, 1400, 600)], MATURE);
  assert.equal(v.state, 'asymmetric_failures');
  assert.equal(v.winner, null);
});

// ⚠️ THE MIRROR TEST, and the one that pins the correction. Post-send provider failures
// (wa_131049) live INSIDE `sent` and contribute zero reads, so ITT already prices them in. An
// earlier draft refused here — which would have refused in exactly the case the answer is real.
t('asymmetric POST-SEND provider failures do NOT refuse — they are the treatment effect', () => {
  const v = verdict([arm('A', 2000, 900, 1400, 0, 40), arm('B', 2000, 700, 1400, 0, 500)], MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'A');
  assert.equal(v.providerFailuresDiffer, true, 'must still be FLAGGED, just not refused');
});

t('more than two arms refuses rather than silently comparing the first two', () => {
  const v = verdict([arm('A', 2000, 800), arm('B', 2000, 900), arm('C', 2000, 700)], MATURE);
  assert.equal(v.state, 'too_many_arms');
  assert.equal(v.winner, null);
});

t('accepts snake_case straight from the RPC as well as camelCase', () => {
  const rpc = [
    { label: 'A', assigned: 2000, sent: 2000, delivered: 1400, read_count: 700, pre_send_failed: 0, provider_failed: 0 },
    { label: 'B', assigned: 2000, sent: 2000, delivered: 1400, read_count: 900, pre_send_failed: 0, provider_failed: 0 },
  ];
  const v = verdict(rpc, MATURE);
  assert.equal(v.state, 'winner');
  assert.equal(v.winner, 'B');
});

t('fewer than two arms is not a test', () => {
  assert.equal(verdict([arm('A', 2000, 800)], MATURE).state, 'not_a_test');
  assert.equal(verdict([], MATURE).state, 'not_a_test');
});

t('zero sent does not divide by zero', () => {
  const v = verdict([arm('A', 0, 0, 0), arm('B', 0, 0, 0)], MATURE);
  assert.ok(['not_a_test', 'too_close', 'underpowered'].includes(v.state));
  assert.ok(Number.isFinite(v.arms[0].readRate) || v.arms[0].readRate === null);
});

t('every verdict carries a plain-English reason a marketer can act on', () => {
  for (const v of [
    verdict([arm('A', 2000, 800), arm('B', 2000, 800)], MATURE),
    verdict([arm('A', 122, 70), arm('B', 122, 76)], MATURE),
    verdict([arm('A', 2000, 700), arm('B', 2000, 900)], { hoursSinceSent: 1 }),
  ]) {
    assert.ok(typeof v.reason === 'string' && v.reason.length > 20, `weak reason: ${v.reason}`);
  }
});

t('the primary rate is read/sent (ITT), not read/delivered', () => {
  // 1000 sent, 500 delivered, 400 read → ITT 40%, delivered-based would be 80%
  const v = verdict([arm('A', 1000, 400, 500), arm('B', 1000, 400, 500)], MATURE);
  assert.ok(Math.abs(v.arms[0].readRate - 0.4) < 1e-9, `got ${v.arms[0].readRate}`);
  assert.ok(Math.abs(v.arms[0].readRateOfDelivered - 0.8) < 1e-9);
});

t('a significant per-arm DELIVERY difference is flagged even when the verdict stands', () => {
  const a = { label: 'A', sent: 2000, read: 700, delivered: 1000, failed: 0 };
  const b = { label: 'B', sent: 2000, read: 900, delivered: 1600, failed: 0 };
  const v = verdict([a, b], MATURE);
  assert.equal(v.deliveryDiffers, true);
});

t('MATURITY_HOURS is 4, from the p80 read latency of 3.6h', () => assert.equal(MATURITY_HOURS, 4));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node test/ab-stats.test.js`
Expected: `Cannot find module '../src/ab-stats.js'`

- [ ] **Step 3: Implement**

```js
// A/B statistics + refusal states (S272). Pure: no DB, no network. Spec §6/§7.
//
// PRIMARY METRIC IS read ÷ sent (intention-to-treat). NOT read ÷ delivered.
// Delivery happens AFTER the treatment is applied, so conditioning on it is post-treatment
// conditioning: if the copy affects whether Meta delivers (wa_131049 block rates run 26–39%
// across templates), comparing read-rates among the delivered compares two differently-filtered
// populations and can invent a winner. Random assignment equalises bad numbers across arms in
// expectation, so read÷sent is unbiased by construction. read÷delivered is kept as a labelled
// diagnostic only.

const Z_CRIT = 1.96;          // two-sided 95%
const Z_POWER = 2.8;          // 1.96 + 0.84 → 80% power
const MATURITY_HOURS = 4;     // p80 of WA marketing read latency is 3.6h; round up

// Minimum detectable effect, in PERCENTAGE POINTS, for n per arm at baseline rate p.
function mde(p, n) {
  if (!(n > 0) || !(p > 0) || !(p < 1)) return null;
  return Z_POWER * Math.sqrt((2 * p * (1 - p)) / n) * 100;
}

// Pooled two-proportion z-test. Returns null when either arm has no denominator.
function zTest(r1, n1, r2, n2) {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = r1 / n1, p2 = r2 / n2;
  const pooled = (r1 + r2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  return (p1 - p2) / se;
}

const num = (v) => Number(v || 0);

function verdict(rawArms, ctx = {}) {
  const arms = (rawArms || []).map((a) => {
    const assigned = num(a.assigned), sent = num(a.sent), delivered = num(a.delivered);
    const read = num(a.read ?? a.read_count);
    const preSendFailed = num(a.preSendFailed ?? a.pre_send_failed);
    const providerFailed = num(a.providerFailed ?? a.provider_failed);
    return {
      label: a.label, assigned, sent, delivered, read, preSendFailed, providerFailed,
      readRate: sent > 0 ? read / sent : null,                       // PRIMARY (ITT)
      readRateOfDelivered: delivered > 0 ? read / delivered : null,  // diagnostic only
      // Denominator is ASSIGNED, not sent+failed. A pre-send failure never entered `sent`, so
      // `sent + failed` double-counts nothing but describes a different population per arm.
      preSendFailRate: assigned > 0 ? preSendFailed / assigned : null,
    };
  });

  const base = { arms, winner: null, z: null, mde: null,
                 deliveryDiffers: false, providerFailuresDiffer: false };
  if (arms.length < 2) {
    return { ...base, state: 'not_a_test',
      reason: 'This campaign sent a single version, so there is nothing to compare.' };
  }
  // ⚠️ The model takes N arms (spec §2) but this compares exactly two. Say so loudly rather than
  // silently comparing the first two and presenting it as the answer — a 3-arm test created
  // through the API would otherwise get a confident verdict about two-thirds of itself.
  if (arms.length > 2) {
    return { ...base, state: 'too_many_arms',
      reason: `This campaign has ${arms.length} versions. The result readout compares two at a `
        + 'time and cannot yet call a winner across more — compare them in the experiment log, or '
        + 'rerun with two versions.' };
  }

  const [a, b] = arms;
  const z = zTest(a.read, a.sent, b.read, b.sent);
  const pooled = (a.read + b.read) / Math.max(1, a.sent + b.sent);
  const nPerArm = Math.min(a.sent, b.sent);
  const detectable = mde(pooled || 0.4, nPerArm);
  const gapPp = Math.abs((a.readRate || 0) - (b.readRate || 0)) * 100;
  const out = { ...base, z, mde: detectable };

  // Is the DELIVERY rate itself different between arms? If so read÷delivered is confounded.
  // REPORTED, NEVER A REFUSAL — under ITT a delivery difference is part of the effect, and this
  // is also the clean evidence about whether content moves wa_131049 (spec §6).
  const zDeliv = zTest(a.delivered, a.sent, b.delivered, b.sent);
  out.deliveryDiffers = zDeliv !== null && Math.abs(zDeliv) > Z_CRIT;

  // Same for post-send provider failures (131049 and friends): they live INSIDE `sent` and
  // contribute zero reads, so ITT already counts them correctly. Surfacing them explains WHY an
  // arm lost; refusing on them would refuse exactly when the answer is real.
  const zProv = zTest(a.providerFailed, a.sent, b.providerFailed, b.sent);
  out.providerFailuresDiffer = zProv !== null && Math.abs(zProv) > Z_CRIT;

  // ⚠️ ONLY PRE-SEND failures trigger a refusal, and the distinction is the whole point.
  // A render failure (unresolved_variables) happens BEFORE the send, so those people never enter
  // `sent` — and they are not a random subset, they are precisely the profiles missing the field
  // that arm's template referenced. That silently changes who each arm was measured over.
  // Measured 2026-08-11: render failures 57 rows / 0 with sent_at; wa_131049 1,905 rows / all
  // with sent_at. Refusing on the latter would have been wrong.
  // Order matters: a biased sample must be caught BEFORE a significance test is quoted off it.
  const zFail = zTest(a.preSendFailed, a.assigned, b.preSendFailed, b.assigned);
  if (zFail !== null && Math.abs(zFail) > Z_CRIT) {
    return { ...out, state: 'asymmetric_failures',
      reason: 'The two versions failed BEFORE sending at different rates — usually one template '
        + 'referencing a variable the other does not, so it failed for everyone missing that '
        + 'field. The people each version actually reached are therefore different groups. This '
        + 'is a biased result, not merely a small one — do not act on it. The per-version failure '
        + 'reasons below will name the variable.' };
  }

  // hoursSinceSent is derived from the RPC's last_sent_at (the last ACTUAL send), never from
  // campaigns.updated_at — that column is bumped by the fan-out heartbeat and by any later edit,
  // so using it would reset a mature result to "still maturing" every time someone touched the
  // campaign.
  if (num(ctx.hoursSinceSent) < MATURITY_HOURS) {
    return { ...out, state: 'immature',
      reason: `Still arriving. Half of all reads land within about 30 minutes but 20% take more `
        + `than 3.6 hours, so give it ${MATURITY_HOURS} hours from the end of the send before `
        + `reading this.` };
  }

  if (z === null) {
    return { ...out, state: 'too_close', reason: 'Not enough data yet to compare the two versions.' };
  }

  if (Math.abs(z) > Z_CRIT) {
    return { ...out, state: 'winner', winner: (a.readRate > b.readRate ? a.label : b.label),
      reason: `${a.readRate > b.readRate ? a.label : b.label} did better, and the gap is larger `
        + `than chance would produce (p < 0.05).` };
  }

  // ⚠️ ORDER AND THE 0.5pp FLOOR BOTH MATTER. Without the floor, two arms that performed
  // IDENTICALLY (gap = 0) fall into 'underpowered' and the marketer is told "the difference is
  // 0.0 points but you can only detect 4.3" — technically true, useless, and it implies there is
  // a real difference being hidden by sample size. 'underpowered' means "there is a visible gap
  // your sample cannot support"; a nil gap means "they performed the same", which is too_close.
  if (detectable !== null && gapPp > 0.5 && gapPp < detectable) {
    return { ...out, state: 'underpowered',
      reason: `The difference is ${gapPp.toFixed(1)} points, but this audience can only reliably `
        + `detect about ${detectable.toFixed(1)}. You would need a bigger send to tell these two `
        + `apart — treat them as equal.` };
  }

  return { ...out, state: 'too_close',
    reason: 'The two versions are within the range chance alone would produce. Treat them as equal.' };
}

module.exports = { mde, zTest, verdict, MATURITY_HOURS, Z_CRIT, Z_POWER };
```

- [ ] **Step 4: Run the tests**

Run: `node test/ab-stats.test.js`
Expected: `18 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add 05_Throttle/commsops-worker/src/ab-stats.js 05_Throttle/commsops-worker/test/ab-stats.test.js
git commit -m "relay: A/B statistics — ITT read rate, z-test, MDE, refusal states"
```

---

## Task 4: Aggregation RPC

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0051_comms_campaign_variant_stats.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0051 — per-arm aggregation for A/B results (S272). AGGREGATION ONLY.
-- The statistics live in commsops-worker/src/ab-stats.js, where they can be unit-tested;
-- this returns counts. Do not add a z-test here.

CREATE OR REPLACE FUNCTION comms.campaign_variant_stats(p_campaign_id uuid)
RETURNS TABLE (
  variant_id      uuid,
  label           text,
  template_id     uuid,
  weight          int,
  assigned        bigint,
  sent            bigint,
  delivered       bigint,
  read_count      bigint,
  pre_send_failed bigint,
  provider_failed bigint,
  skipped         bigint,
  cost            numeric,
  last_sent_at    timestamptz,
  fail_reasons    jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT v.id, v.label, v.template_id, v.weight,
         count(m.id)                                            AS assigned,
         count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)        AS sent,
         count(m.id) FILTER (WHERE m.delivered_at IS NOT NULL)   AS delivered,
         count(m.id) FILTER (WHERE m.read_at IS NOT NULL)        AS read_count,
         -- ⚠️ THE SPLIT THAT DECIDES WHETHER A RESULT IS BIASED OR MERELY SMALL.
         -- Measured 2026-08-11 across every failed/skipped message in comms.messages:
         --   render failures (unresolved_variables) — 57 rows, 0 with sent_at
         --   gate skips                             — 11,563 rows, 0 with sent_at
         --   wa_131049 pacing blocks                — 1,905 rows, ALL 1,905 with sent_at
         -- PRE-SEND failures never entered `sent`, so they remove people from the ITT
         -- denominator NON-RANDOMLY (everyone missing a first_name) → that biases.
         -- POST-SEND failures are inside `sent` and contribute zero reads → under ITT they
         -- are part of the treatment effect, NOT a confound. Do not conflate the two.
         count(m.id) FILTER (WHERE m.status IN ('failed','skipped','suppressed')
                               AND m.sent_at IS NULL)            AS pre_send_failed,
         count(m.id) FILTER (WHERE m.status = 'failed'
                               AND m.sent_at IS NOT NULL)        AS provider_failed,
         count(m.id) FILTER (WHERE m.status IN ('skipped','suppressed')) AS skipped,
         coalesce(sum(m.cost), 0)                                AS cost,
         -- Maturity must be measured from the last ACTUAL send, never campaigns.updated_at:
         -- that column is bumped by the page heartbeat and by any later edit, so an edit
         -- would make a mature result look immature again.
         max(m.sent_at)                                          AS last_sent_at,
         -- ⚠️ Counts per reason via a GROUPED subquery. `jsonb_object_agg(reason, 1)` over raw
         -- rows silently collapses duplicate keys and reports 1 for EVERY reason — verified
         -- against live data 2026-08-11 (it returned quiet_hours:1 where the truth was 235).
         coalesce((
           SELECT jsonb_object_agg(r.reason, r.n)
             FROM (SELECT m2.reason, count(*) AS n
                     FROM comms.messages m2
                    WHERE m2.variant_id = v.id
                      AND m2.status IN ('failed','skipped','suppressed')
                      AND m2.reason IS NOT NULL
                    GROUP BY m2.reason) r
         ), '{}'::jsonb)                                         AS fail_reasons
    FROM comms.campaign_variants v
    LEFT JOIN comms.messages m ON m.variant_id = v.id
   WHERE v.campaign_id = p_campaign_id
   GROUP BY v.id, v.label, v.template_id, v.weight, v.sort_order
   ORDER BY v.sort_order, v.label;
$$;

GRANT EXECUTE ON FUNCTION comms.campaign_variant_stats(uuid) TO service_role;
```

- [ ] **Step 2: Apply it**

Apply via `apply_migration`, name `comms_campaign_variant_stats`.

- [ ] **Step 3: Verify it runs and returns nothing for a campaign with no variants**

```sql
SELECT * FROM comms.campaign_variant_stats(
  (SELECT id FROM comms.campaigns ORDER BY created_at LIMIT 1));
```
Expected: **0 rows** (no variants exist yet) and no error. A zero-variant campaign must be a clean empty result, not a failure — spec §10.8.

- [ ] **Step 4: Commit**

```bash
git add 05_Throttle/commsops-worker/migrations/0051_comms_campaign_variant_stats.sql
git commit -m "relay: campaign_variant_stats RPC (aggregation only)"
```

---

## Task 5: Thread `variantId` through the send spine

**Files:**
- Modify: `05_Throttle/commsops-worker/src/send.js` (the `finalize` row builder)
- Test: `05_Throttle/commsops-worker/test/send-variant.test.js` (create)

- [ ] **Step 1: Write the failing test**

⚠️ **Do NOT write this as a source-text grep.** `send.js` IS behaviourally testable — the established
pattern is in `test/send-dedup.test.js`: monkey-patch `A.sbComms`, call the real `send()`, and assert
on what it wrote. Read that file first and copy its harness (async `t()` helper, `ENV` stub, restore
`A.sbComms` at the end). Asserting on source text would pass against code that never runs.

Facts you need, already verified against `src/send.js`:
- With **no** `dedupKey` there is no `opts._reservedId`, so `finalize` calls `logMessage`, which
  **POSTs to `/rest/v1/messages`** with the whole row as the body (`send.js:178`).
- With a `dedupKey` it **PATCHes `/rest/v1/messages?id=eq.<reserved>`** instead.
- A template lookup returning `{ok:true, data:[]}` drives `template_not_found` → `finalize` with a
  **non-sent** status, which is the cheapest way to exercise the failure path.

```js
// test/send-variant.test.js — variant_id must land on the messages row for EVERY outcome, not just
// successful sends. The per-arm failure-asymmetry check in ab-stats.js reads exactly those
// non-sent rows, so if the stamp were only applied on success that check would silently compare
// nothing. Harness copied from test/send-dedup.test.js.
const assert = require('assert');
const A = require('../src/auth.js');
const { send } = require('../src/send.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
const origSb = A.sbComms;
const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };

(async () => {
  await t('variant_id is persisted on a NON-SENT outcome', async () => {
    let posted = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };   // → template_not_found
      if (path.startsWith('/rest/v1/messages') && (opts.method || 'GET') === 'POST') {
        posted = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'M-VAR' }] };
      }
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com',
                                templateId: 'T', variantId: 'VAR-B' });
    assert.ok(posted, 'finalize must have written a messages row');
    assert.equal(posted.variant_id, 'VAR-B', 'variant_id missing from the persisted row');
    assert.notEqual(r.status, 'sent');
  });

  await t('variant_id is null when no arm was assigned (every existing caller)', async () => {
    let posted = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };
      if (path.startsWith('/rest/v1/messages') && (opts.method || 'GET') === 'POST') {
        posted = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'M-NOVAR' }] };
      }
      return { ok: true, data: [] };
    };
    await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T' });
    assert.ok(posted, 'finalize must have written a messages row');
    assert.strictEqual(posted.variant_id, null, 'must be null, not undefined — undefined is dropped by JSON.stringify and the column would never be written');
  });

  A.sbComms = origSb;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

⚠️ The second test is the one that matters more than it looks: `opts.variantId || null` yields
`null`, but a bare `opts.variantId` would yield `undefined`, which `JSON.stringify` **drops from the
body entirely** — so the column would silently never be written and every existing caller would look
fine. Assert `strictEqual(..., null)`, not falsiness.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node test/send-variant.test.js`
Expected: `2 failed`

- [ ] **Step 3: Add the field**

In `src/send.js`, inside `finalize`'s `const row = {` object, immediately after the `template_id` / `template_version` pair, add:

```js
    // A/B arm (S272). Stamped for EVERY outcome — a skipped or failed message still belongs to
    // an arm, and the per-arm failure-asymmetry check in ab-stats.js depends on those rows.
    variant_id: opts.variantId || null,
```

- [ ] **Step 4: Run the tests**

Run: `node test/send-variant.test.js`
Expected: `2 passed, 0 failed`

Then the full suite: `for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add 05_Throttle/commsops-worker/src/send.js 05_Throttle/commsops-worker/test/send-variant.test.js
git commit -m "relay: stamp variant_id on every messages row, including skips and failures"
```

---

## Task 6: Assign arms in the fan-out

**Files:**
- Modify: `05_Throttle/commsops-worker/src/campaigns.js` (`processQueueMessage`, ~line 77; `startCampaign`, ~line 45)

- [ ] **Step 1: Add the variants loader**

Near the top of `campaigns.js`, after the existing `getCampaign`:

```js
const { pickVariant } = require('./variants.js');

// ⚠️ THROWS on a read failure — never returns [] as a fallback.
// A soft failure here is silently catastrophic: `[]` means "no variants", which sends
// campaigns.template_id — i.e. ARM A FOR EVERYONE. A transient 5xx thirty minutes into a fan-out
// would produce a campaign that is half a clean A/B and half all-A, with nothing in the data
// marking the boundary, and a verdict computed off it that looks perfectly fine.
// Throwing lets Queues redeliver the page and eventually DLQ with an alert — the same rule and
// the same reasoning as the campaign_recipients guard below (review C2).
async function loadVariants(env, campaignId) {
  const r = await A.sbComms(
    `/rest/v1/campaign_variants?campaign_id=eq.${A.enc(campaignId)}`
    + `&select=id,label,template_id,weight,sort_order&order=sort_order.asc,label.asc`, env);
  if (!r.ok) throw new Error(`campaign_variants_failed:${campaignId}:${r.status}`);
  return Array.isArray(r.data) ? r.data : [];
}
```

- [ ] **Step 2: Use it in `processQueueMessage`**

Immediately after the `if (!camp || camp.status !== 'sending') return;` guard:

```js
  const variants = await loadVariants(env, campaignId);
```

Then replace the `send({...})` call inside the recipient loop with:

```js
      // Per-recipient assignment INSIDE the page — never "all of A then all of B". The fan-out is
      // serial at ~1,200/hr, so batching by arm would push B hours later in the day and the test
      // would measure time-of-day rather than copy.
      const arm = pickVariant(campaignId, rec.profile_id, variants);
      await send(env, {
        channel: camp.channel, purpose: camp.purpose, profileId: rec.profile_id, to: rec.address,
        templateId: arm?.template_id || camp.template_id,
        variantId: arm?.id || null,
        constants: camp.vars || {},
        tracking: { campaign: camp.name, utm: camp.utm },
        source: `campaign:${campaignId}`, dedupKey: `campaign:${campaignId}:${rec.profile_id}`,
      });
```

- [ ] **Step 3: Guard `startCampaign`**

In `startCampaign`, after the existing `segment_and_template_required` check:

```js
  // Every arm must be sendable BEFORE a single message goes out. Discovering an unapproved
  // template mid-fan-out leaves a half-run experiment that can never be completed or compared.
  //
  // ⚠️ loadVariants THROWS by design (it must, in the fan-out). Here that would surface as an
  // unhandled 500 on a button press, so catch it and return a normal error result.
  let variants;
  try { variants = await loadVariants(env, id); }
  catch { return { ok: false, error: 'variants_unreadable' }; }

  if (variants.length >= 2) {
    const ids = variants.map((v) => v.template_id).filter(Boolean);
    // ⚠️ An all-holdout set leaves ids empty, and `id=in.()` is a malformed PostgREST filter.
    if (ids.length === 0) return { ok: false, error: 'no_sendable_arm' };
    const tr = await A.sbComms(
      `/rest/v1/templates?id=in.(${ids.map(A.enc).join(',')})&select=id,name,approval_status`, env);
    if (!tr.ok) return { ok: false, error: 'variant_templates_unreadable' };
    const byId = new Map((tr.data || []).map((t) => [t.id, t]));
    for (const v of variants) {
      if (!v.template_id) continue;                      // holdout arm — nothing to approve
      const t = byId.get(v.template_id);
      if (!t) return { ok: false, error: `variant_${v.label}_template_missing` };
      if (camp.channel === 'whatsapp' && String(t.approval_status || '').toUpperCase() !== 'APPROVED')
        return { ok: false, error: `variant_${v.label}_template_not_approved` };
    }
  }
```

- [ ] **Step 4: Verify nothing regressed**

Run: `cd 05_Throttle/commsops-worker && for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done`
Expected: no output.

Then confirm a zero-variant campaign is byte-identical to today: `pickVariant` returns `null`, so `templateId` falls back to `camp.template_id` and `variantId` is `null` — exactly the current behaviour.

- [ ] **Step 5: Commit and deploy**

```bash
git add 05_Throttle/commsops-worker/src/campaigns.js
git commit -m "relay: assign A/B arms in the campaign fan-out; guard unapproved arms at start"
git push
cd 05_Throttle/commsops-worker && npx wrangler deploy
```

⚠️ The push must succeed before the deploy (PATTERN-220 — deploying off an unpushed branch silently reverts a parallel session's live change).

---

## Task 7: Per-arm test sends

**Files:**
- Modify: `05_Throttle/commsops-worker/src/campaigns.js` (`sendCampaignTest`, ~line 165)

- [ ] **Step 1: Accept a `variantId`**

`sendCampaignTest` currently sends `campaigns.template_id`, which would silently only ever preview arm A. Change the signature to `{ id, to, draft, variantId }` and resolve the template:

```js
  // Which ARM is being previewed. Without this the test send always shows arm A, which defeats
  // the purpose — the whole point is seeing each version on a real handset, and they differ.
  let templateId = camp.template_id;
  if (variantId) {
    const vr = await A.sbComms(
      `/rest/v1/campaign_variants?id=eq.${A.enc(variantId)}&campaign_id=eq.${A.enc(id)}`
      + `&select=id,label,template_id&limit=1`, env);
    const v = vr.ok && vr.data?.[0];
    if (!v) return { ok: false, error: 'variant_not_found' };
    if (!v.template_id) return { ok: false, error: 'holdout_arm_has_nothing_to_send' };
    templateId = v.template_id;
  }
```

Use `templateId` in the `send()` call. **Do not** pass `variantId` into `send()` here — test sends keep `source: 'campaign_test:<id>'` and must stay out of the experiment's numbers entirely.

- [ ] **Step 2: Verify**

Run: `for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done`
Expected: no output (`test-send-alias.test.js` and `test-mode-allow.test.js` both exercise this path).

- [ ] **Step 3: Commit**

```bash
git add 05_Throttle/commsops-worker/src/campaigns.js
git commit -m "relay: campaign test sends target a named arm"
```

---

## Task 8: Worker actions

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js`

- [ ] **Step 1: Add the read actions**

In the JWT-authenticated GET/POST switch, following the existing house style (guard first — RULE-011):

- `getCampaignVariants` — `canView`; returns the arms for a campaign plus the linked `campaign_experiments` row.
- `getVariantStats` — `canView`; calls `comms.campaign_variant_stats`, then computes `hoursSinceSent` from the campaign's `updated_at` when `status='sent'`, and returns `AB.verdict(arms, { hoursSinceSent })` alongside the raw arms. **`Number()` every count from PostgREST before it reaches `verdict`.**
- `listExperiments` — `canView`; joins `campaign_experiments` → `campaigns` for the log page.

- [ ] **Step 1b: Add `getVariantPreflight` — the checks Task 10 renders**

⚠️ Without this the setup checklist has nothing behind it. Task 10 marks three of its rows
*blocking*, and a blocking check computed in the browser is not a check.

`getVariantPreflight` — `canView`. Returns one row per check: `{ key, pass, blocking, detail }`.

```js
// The variables diff is the one that is not merely hygiene. If arm B's template references a
// variable arm A's does not, B fails for exactly the profiles missing that field — so B's
// SURVIVING audience is systematically different from A's (everyone without a first_name, say).
// That is confounding, not noise: it produces a plausible and completely wrong winner. The same
// pre-flight diff was run before the order_placed_wa_r_01 bind in S265; reuse that discipline.
const varsOf = (tpl) => new Set(
  JSON.stringify(tpl?.content || {}).match(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g) || []);

const onlyInB = [...varsOf(b)].filter((v) => !varsOf(a).has(v));
const onlyInA = [...varsOf(a)].filter((v) => !varsOf(b).has(v));
checks.push({
  key: 'variables_match', blocking: true,
  pass: onlyInA.length === 0 && onlyInB.length === 0,
  detail: onlyInA.length || onlyInB.length
    ? `Arm A uses ${onlyInA.join(', ') || 'nothing extra'}; arm B uses ${onlyInB.join(', ') || 'nothing extra'}. `
      + 'Both versions must use the same variables, or one will fail for a different group of '
      + 'people and the comparison will be biased rather than just smaller.'
    : 'Both versions use the same variables.',
});
```

The other checks: `templates_approved` (blocking, WhatsApp only — reuse Task 6's approval query),
`same_channel_purpose` (blocking), `quiet_hours_risk` (warning — estimate duration as
`reachable / 1200` hours and compare the projected end against 21:00 IST).

- [ ] **Step 2: Add the write actions**

- `saveCampaignVariant` — `canBuild`. Upserts an arm. **Auto-creates arm A from `campaigns.template_id` when the first B is added**, and creates the `campaign_experiments` row at the same moment.
- `deleteCampaignVariant` — `canBuild`.
- `recordExperimentLearning` — `canBuild`. Writes `learning`, `decided_at`, `decided_by` **and snapshots the current `getVariantStats` payload into `verdict_snapshot`.**

```js
// ⚠️ The snapshot is the point. The verdict is otherwise recomputed on every page view forever,
// so late-arriving reads (5% land after 39h) can flip it AFTER someone wrote down "B won" and
// acted on it — leaving the log and the live screen permanently contradicting each other with no
// way to tell which was ever true.
```

- [ ] **Step 3: Enforce the freeze**

`saveCampaignVariant` and `deleteCampaignVariant` must both:

```js
  // Variants freeze at APPROVED, not at sending. Between approved and sending an arm could
  // otherwise be added that nobody approved — the approval was granted against arm A alone, so
  // without this the A/B feature is a way around the approval gate.
  if (['approved', 'scheduled', 'sending', 'sent'].includes(camp.status)) {
    if (camp.status === 'sending' || camp.status === 'sent')
      return err('campaign_already_sending', 422);
    // approved/scheduled: allow the edit but send it back for approval
    await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}`, env,
      { method: 'PATCH', body: JSON.stringify({ status: 'draft', approved_by: null }) });
  }
```

- [ ] **Step 4: Name the FK collision**

Wherever a campaign is deleted, catch Postgres `23503` and return `campaign_has_sent_messages` rather than leaking the raw constraint error. See Task 1's comment for why the collision is deliberate.

- [ ] **Step 5: Verify and commit**

Run: `for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done` — expect no output.

```bash
git add 05_Throttle/commsops-worker/src/index.js
git commit -m "relay: A/B worker actions — variant CRUD, stats, experiment record, approval freeze"
git push && cd 05_Throttle/commsops-worker && npx wrangler deploy
```

---

## Task 9: Freeze templates and react to Meta status changes

**Files:**
- Modify: `05_Throttle/commsops-worker/src/index.js` (template edit path)
- Modify: `05_Throttle/commsops-worker/src/wa-webhooks.js` (`handleMeta`, ~line 385)

- [ ] **Step 1: Block edits to a bound template**

In the template-update action, before writing:

```js
  // Freezing the variant rows while leaving template CONTENT editable is a half-measure:
  // messages.template_version is stamped per send, so editing an arm's template at page 500 of
  // 1,064 splits that arm across two versions and the "arm" stops being one thing.
  const bound = await A.sbComms(
    `/rest/v1/campaigns?template_id=eq.${A.enc(templateId)}&status=in.(approved,scheduled,sending)`
    + `&select=id,name&limit=1`, env);
  if (bound.ok && bound.data?.[0]) return err('template_bound_to_live_campaign', 422);
```

Apply the same check for templates referenced by `campaign_variants` of such a campaign.

- [ ] **Step 2: Pause a campaign when Meta disables its template**

In `handleMeta`, inside the `message_template_status_update` branch, after the existing alert:

```js
      // An arm Meta disabled halfway through produces exactly the asymmetric, biased sample the
      // refusal states exist to reject — and it keeps burning sends that can never be compared.
      if (v.event && /REJECTED|DISABLED|PAUSED/i.test(v.event) && v.message_template_name) {
        const tpl = await A.sbComms(
          `/rest/v1/templates?channel=eq.whatsapp&content->>meta_name=eq.${A.enc(v.message_template_name)}`
          + `&select=id&limit=1`, env);
        const tid = tpl.ok && tpl.data?.[0]?.id;
        if (tid) {
          A.checkWrite('campaign_pause_on_template_status_failed',
            await A.sbComms(`/rest/v1/campaigns?status=eq.sending&template_id=eq.${A.enc(tid)}`, env,
              { method: 'PATCH', body: JSON.stringify({ status: 'paused' }) }),
            { template: v.message_template_name, event: v.event });
        }
      }
```

⚠️ **Checked 2026-08-11: `comms.campaigns` has NO CHECK constraint on `status` at all** — its only constraints are the PK and two FKs, so the database will accept `'paused'` silently. That makes this *more* dangerous, not less: the real gate is the **code and UI status ladder**, and nothing will error if you miss one.

Before using `'paused'`, grep every reader and teach each one — this is PATTERN-218, the most repeated defect class in this codebase, and a free-text column is exactly how it hides:
```bash
grep -rn "'sending'\|'approved'\|'scheduled'\|status ===" 05_Throttle/commsops-worker/src 05_Throttle/apps/relay/src | grep -v node_modules
```
At minimum: `campaigns.js` `startCampaign`/`processQueueMessage` status guards, the M9 scheduler sweep, the stall sweep in `index.js` `runScheduled`, and `tabOf`/`campaignStatus` in the campaigns page (a status no tab matches makes the campaign **vanish from the list**). If teaching every reader is too wide for this task, use the existing `'cancelled'` terminal state plus an alert instead — a paused-but-invisible campaign is worse than a cancelled one.

- [ ] **Step 3: Verify and commit**

Run the suite; expect no output.

```bash
git add 05_Throttle/commsops-worker/src/index.js 05_Throttle/commsops-worker/src/wa-webhooks.js
git commit -m "relay: freeze bound templates, pause a live campaign on a Meta template block"
git push && cd 05_Throttle/commsops-worker && npx wrangler deploy
```

---

## Task 10: UI — variant setup

**Files:**
- Create: `05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantSetup.js`
- Modify: `05_Throttle/apps/relay/src/app/(auth)/campaigns/page.js` (mount only)

Spec §8.1. Every number shown here comes from the worker; **this component does no arithmetic except the sent-per-arm division**, which is `reachable / arms`.

- [ ] **Step 1: Build the component**

It renders:
1. **Arms list** — label, template picker (`Combobox` with `portal` — PATTERN-160 makes this mandatory inside a card), weight. "Add B version" when there is one arm.
2. **Power line** with colour from sent-per-arm. ⚠️ **`reachable × (smallestWeight ÷ totalWeight)`, NOT `reachable / arms`** — weights are editable, and on an 80/20 split the small arm has 20% of the audience, so dividing by arm count would overstate its power by 2.5× and tell the marketer a test is well-powered when its deciding arm is not. Statistical power is set by the *smaller* arm:
   - `>= 800` green — *"~N per arm — you can detect a difference of about X points."*
   - `400–800` amber — *"…only a large difference will show up."*
   - `< 400` red — *"this audience cannot answer the question — send it as a normal campaign."*
   Red does **not** block; it states the consequence and lets the marketer decide.
3. **Pre-flight checklist**, each row pass/fail with the fix, blocking where marked:
   - both arms' templates Meta-approved — *blocking*
   - variables diff clean between arms — *blocking*
   - same channel and purpose — *blocking*
   - estimated duration vs quiet hours — *warning*: *"~3.5h at the current rate; starting after 17:30 IST risks the tail being cut at 21:00."*
4. **Hypothesis field** — *"What is the one thing that differs between A and B?"* → `campaign_experiments.hypothesis`.
5. **Read-time commitment** — *"Check back after ~4h"* → `planned_read_at`.
6. **Test send per arm** — two buttons, wired to Task 7's `variantId`.

- [ ] **Step 2: Verify in the browser**

Start the preview, open a draft campaign, add a B arm, and confirm the power line changes colour as the segment changes and that an unapproved template blocks the send button.

- [ ] **Step 3: Commit**

```bash
git add "05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantSetup.js" "05_Throttle/apps/relay/src/app/(auth)/campaigns/page.js"
git commit -m "relay UI: A/B setup — arms, power guardrail, blocking pre-flight checks"
```

---

## Task 11: UI — in-flight progress

**Files:**
- Create: `05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantProgress.js`

Spec §8.2. Shown while `status='sending'`: per-arm assigned / sent / delivered so far, a **variants are frozen** notice with the reason, and a live per-arm skip/failure count so an asymmetry is visible while it is happening rather than only at the end.

- [ ] **Step 1: Build it** — polls `getVariantStats` on the existing campaign-detail refresh interval; renders counts only.
- [ ] **Step 2: Commit**

```bash
git add "05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantProgress.js"
git commit -m "relay UI: per-arm in-flight progress"
```

---

## Task 12: UI — results

**Files:**
- Create: `05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantResults.js`, `useVariantStats.js`

Spec §8.3. **Renders only — no arithmetic.** Everything comes from `getVariantStats`.

- [ ] **Step 1: Build it**

1. **Verdict banner first**, using `verdict.reason` verbatim — it is already written for a marketer. Colour by `state`: `winner` green; `too_close`/`underpowered`/`immature`/`asymmetric_failures` amber; never red (a refusal is a correct outcome, not an error).
2. **Per-arm funnel** — assigned → sent → delivered → read. **The primary rate (read÷sent) is visually dominant; read÷delivered is shown smaller and explicitly labelled "diagnostic"**, so nobody reads the wrong one as the answer.
3. **`deliveryDiffers` banner** when true: *"The two versions were delivered at different rates, so the delivered-based figures below are not comparable. The headline result uses read ÷ sent and is unaffected."*
4. **Skips and failures by reason, per arm.**
5. **Cost per arm**, with: *"Two versions cost the same as one — the same number of messages are sent either way."*
6. **Maturity + peeking guard** — *"You planned to read this at 14:20; it is 11:05 and 20% of reads have not arrived."*
7. **Read-receipt caveat inline, next to the rate**, not in a footnote: *"Recipients can switch read receipts off, so this is a floor, not the true percentage who read it."*
8. **"Record what we learned"** — free text → `recordExperimentLearning`, which snapshots the verdict. Once recorded, show the snapshot **and** the live figure side by side, and surface any divergence rather than hiding it.

- [ ] **Step 2: Verify in the browser** against the existing sent Roxie campaign (zero variants → the `not_a_test` state must render cleanly, not crash).
- [ ] **Step 3: Commit**

```bash
git add "05_Throttle/apps/relay/src/app/(auth)/campaigns/VariantResults.js" "05_Throttle/apps/relay/src/app/(auth)/campaigns/useVariantStats.js"
git commit -m "relay UI: A/B results — verdict, per-arm funnel, refusal states, learning capture"
```

---

## Task 13: UI — the experiment log

**Files:**
- Create: `05_Throttle/apps/relay/src/app/(auth)/experiments/page.js`
- Modify: `05_Throttle/apps/relay/src/lib/nav.js`

Spec §8.4. **This is the surface that makes the feature institutional rather than personal** — without it every test runs in isolation and the same question gets re-asked in six months.

- [ ] **Step 1: Build the page** — a table across all campaigns: date, campaign, hypothesis, arms, audience, the **snapshotted** verdict, and the recorded learning. Filter by verdict state. Link each row to its campaign.
- [ ] **Step 2: Add a note at the top of the list**, because it is the honest thing and it is where someone will be tempted to over-read: *"Run enough tests and roughly one in twenty will show a 'winner' by chance alone. Treat a single result as a hint; treat a result you have reproduced as a finding."*
- [ ] **Step 3: Add the nav entry** — `relay_view`-gated, beside Campaigns.
- [ ] **Step 4: Commit**

```bash
git add "05_Throttle/apps/relay/src/app/(auth)/experiments/page.js" 05_Throttle/apps/relay/src/lib/nav.js
git commit -m "relay UI: cross-campaign experiment log"
```

---

## Task 14: List marker and CSV export

**Files:**
- Modify: `05_Throttle/apps/relay/src/app/(auth)/campaigns/page.js` (`downloadCampaignsCsv`, ~line 54)

- [ ] **Step 1:** Mark A/B campaigns in the campaigns list with an "A/B" chip so a test is identifiable without opening it.
- [ ] **Step 2:** Add per-arm columns to the CSV export — the team will want to share results outside the app, and a self-serve tool that cannot export forces someone to ask for a query.
- [ ] **Step 3: Build, verify, commit**

```bash
cd 05_Throttle && npx turbo build --filter=relay
```
⚠️ **Read the build output, do not just check the exit code.** An "Attempted import error" exits 0 and then white-screens the page at runtime — that shape hid three broken financial pages for ~8 weeks.

```bash
git add "05_Throttle/apps/relay/src/app/(auth)/campaigns/page.js"
git commit -m "relay UI: mark A/B campaigns in the list, export per-arm results"
git push
```

---

## Final verification

- [ ] Full worker suite green: `cd 05_Throttle/commsops-worker && for t in test/*.test.js; do node "$t" >/dev/null 2>&1 || echo "FAIL $t"; done` → no output.
- [ ] Relay builds clean, with the output read rather than the exit code trusted.
- [ ] **A zero-variant campaign behaves exactly as before** — send one to yourself and confirm `variant_id` is null, the results screen shows `not_a_test`, and the existing campaign stats are unchanged.
- [ ] `campaign_stats_list` output is byte-identical for the three already-sent campaigns.
- [ ] Update `systems/relay.md` with the shipped state and strike the A/B item from `BACKLOG.md` **in the same commit** (BACKLOG hygiene rule).

## Not in this plan

- **Relay System Manual scaffold + A/B chapter** (spec §9, §13 step 7) — needs its own plan. Until then, Tasks 10 and 12 carry the guidance inline.
- Auto-select-winner, holdouts, click-based winners, email tests, >2 arms in the UI (spec §2).
