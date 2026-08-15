# Relay — Frozen Campaign Roster

> Status: **SPEC, not built.** Written 2026-08-15 (S286) after the 15 Aug sale send finished
> "clean" and post-run reconciliation could not answer *"who did we miss?"*
> Author's note: every number below was measured on the live database on 2026-08-15, not estimated.
> The hostile review in §9 is part of the spec, not an appendix — three of its findings changed
> the design before it was written down, and one of them (§9.1) invalidates the obvious approach.

---

## 1. The problem

A campaign's audience is currently **half-frozen**, and the half that is not is unauditable.

| | frozen? | where |
|---|---|---|
| `segment_members` | **yes** — materialised once at start | `materialize_segment` |
| consent | no — re-read every page | `campaign_recipients` |
| suppressions | no — re-read every page | `campaign_recipients` |
| phone/email identifier | no — re-read every page | `campaign_recipients` |
| cross-campaign exclusion | no — **deliberately live** (S276) | `campaign_recipients` |

Because eligibility is filtered **inside the recipient query**, a profile that loses eligibility
mid-run simply *stops appearing*. No row, no reason, no trace. The campaign then reports a clean
finish.

**Measured consequence, 15 Aug sale send:** the campaign completed (`sent`, `shards_done` 5/5, zero
DLQ) having attempted 48,189. A post-run reconciliation found **297 currently-reachable profiles
with no message row of any kind** — not `sent`, not `failed`, not `skipped`. Establishing *why*
took an hour of elimination and still did not fully resolve: ~55 were explained by opt-ins arriving
after their shard had swept past, and the remainder are consistent with sends that threw before
writing their row (see §3.3) but cannot be proven, because the evidence was `console.log`.

⚠️ **The count was still RISING while the campaign sat finished** — 297 → 301 in fifteen minutes.
That alone shows the current model cannot answer the question: there is no fixed denominator, so
"who did we miss" is measured against a moving target.

---

## 2. What must NOT change

⛔ **Consent and suppression must stay live at send time.** If a customer opts out at 17:00 and
their shard reaches them at 18:00, they must not be messaged. Freezing consent at send time is a
compliance defect, not a simplification. This spec does **not** propose freezing eligibility.

⛔ **Cross-campaign exclusion must stay live.** Two campaigns running concurrently exclude each
other by counting a fresh `queued` row as contacted (S276). Freezing that reintroduces the
double-send it was built to prevent. See §9.4 — this is the finding that most constrains the design.

**What changes is WHERE the filtering happens, not WHETHER it happens.**

---

## 3. Design

### 3.1 Freeze the roster, not the eligibility

At send time, snapshot the **list of intended recipients** into `comms.campaign_roster`. The
fan-out then paginates *that table* instead of re-running a live query. Eligibility is still
enforced per message — by `gate.js`, which already does it.

### 3.2 The gate already does this work, and does it visibly

`gate.js` runs, per message: suppression → consent → frequency cap → quiet hours → channel rule →
budget. When it blocks one it writes a **visible row** with a reason (`skipped/no_consent`,
`skipped/quiet_hours`, …). Today's data shows 253 `no_consent` skips from other sources — the
mechanism works and is auditable.

So the consent filter inside `campaign_recipients` is **redundant with the gate**, and the
redundant copy is the one that hides its work. Removing it from the roster path converts every
silent disappearance into a row with a reason.

⚠️ **Exception: `campaign_excluded` is NOT in the gate** (§9.4). It must be moved there, or the
concurrent-exclusion guarantee is lost. This is a prerequisite, not a follow-up.

### 3.3 Errors become visible by construction

`processQueueMessage`'s send pool catches per-recipient throws into `pageErrors`, which is
incremented, `console.log`ged, and **discarded**. `send()`'s first act is the dedup-reserve INSERT
that creates the message row, and `sbComms` does not catch a fetch rejection — so a transport-level
failure on that INSERT throws *before any row exists* and the profile vanishes.

With a frozen roster this needs no separate fix: **roster minus messages = missed**, whatever the
cause. The reconciliation catches it even when the mechanism is novel.

---

## 4. Schema

```sql
CREATE TABLE comms.campaign_roster (
  campaign_id  uuid    NOT NULL REFERENCES comms.campaigns(id) ON DELETE CASCADE,
  profile_id   uuid    NOT NULL,
  address      text    NOT NULL,
  shard        int     NOT NULL,
  PRIMARY KEY (campaign_id, profile_id)
);
CREATE INDEX ON comms.campaign_roster (campaign_id, shard, profile_id);
ALTER TABLE comms.campaign_roster ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.campaign_roster TO service_role;
```

- `PRIMARY KEY (campaign_id, profile_id)` makes the build **idempotent** — a retried or
  double-invoked build is a no-op via `ON CONFLICT DO NOTHING`, not a duplicated audience.
- `shard` is assigned **at build time and stored**, not recomputed per page. This is what makes
  per-shard progress observable — the thing that was missing when a chain died silently on 15 Aug.
- The covering index matches the fan-out's exact access path: `WHERE campaign_id=? AND shard=? AND
  profile_id > ? ORDER BY profile_id LIMIT n`.
- ⚠️ RLS on + `service_role` grant + `NOTIFY pgrst, 'reload schema'` in the same migration — a new
  table in an already-exposed schema is invisible to PostgREST until the cache reloads, and it
  fails **silently** (CORE.md, cost a live debugging round in S239).

Campaign columns: `roster_built_at timestamptz`, `roster_size int`.

---

## 5. Flow

```
approve → SEND pressed
  → status='building_roster'
  → chunked roster build (§6)  ← NOT one statement, see §9.1
  → roster_built_at set, roster_size = COUNT(*)
  → audience_snapshot := roster_size      (one number, one source)
  → status='sending', seed one chain per shard
  → each chain paginates comms.campaign_roster for ITS shard
  → gate runs per message, writing a reason row for every block
  → chain drains → finish_campaign_shard() → last one flips to 'sent'
```

**Reconciliation, available at any moment during or after the run:**

```sql
SELECT count(*) FROM comms.campaign_roster r
 WHERE r.campaign_id = $1
   AND NOT EXISTS (SELECT 1 FROM comms.messages m
                    WHERE m.dedup_key = 'campaign:'||$1||':'||r.profile_id);
```

That number is *unambiguously* "people we intended to message and did not". It is stable, because
the denominator no longer moves.

---

## 6. The roster build must be CHUNKED

⚠️ **This is the finding that killed the obvious implementation.** See §9.1 for the measurement.

The build runs as its own queue message, keyset-paginated:

```
{ kind: 'build_roster', campaignId, after: <last profile_id|null> }
```

Each message inserts one chunk (proposed 5,000) via `INSERT … SELECT … ON CONFLICT DO NOTHING`,
then enqueues the next cursor, and on a short chunk stamps `roster_built_at` and seeds the send
chains. Chunk size is bounded by the **8-second `statement_timeout`** on `authenticator`, not by
preference.

---

## 7. Migration & back-compat

- Campaigns already `sending` when this deploys have **no roster**. The fan-out must fall back to
  the live query when `roster_built_at IS NULL` — do not strand an in-flight broadcast.
- `campaign_recipients` keeps its current signature and behaviour; the roster build calls it once
  per chunk. Reach previews and tests are unaffected.
- The consent/suppression filters stay in `campaign_recipients` for the **preview** path (the
  number a human approves should reflect who is reachable *now*). They are bypassed only on the
  send path, where the gate takes over.

---

## 8. Measured constraints (2026-08-15, live)

| what | measured | source |
|---|---|---|
| `campaign_recipients` full scan, 48,478 rows | **6,343 ms**, 1,593,616 shared buffer hits | `EXPLAIN ANALYZE` |
| `authenticator` statement timeout | **8,000 ms** | `pg_roles.rolconfig` |
| `authenticator` lock timeout | 8,000 ms | `pg_roles.rolconfig` |
| PostgREST response cap | 5,000 rows, silent | CORE.md S275 (inherited, not re-measured today) |
| shard evenness, 5 shards | 9,651 / 9,668 / 9,732 / 9,766 / 9,661 | temp-table probe |
| segment size / reachable | 137,806 members → 48,478 reachable | live |

---

## 9. Hostile review

Written against the design above, deliberately looking for ways it breaks. Findings 9.1, 9.4 and
9.5 changed the design; the rest are constraints to build against.

### 9.1 🔴 A single-statement roster build DIES on a large audience — and it is close today

`campaign_recipients` over the live 48,478-row audience takes **6,343 ms**. `authenticator` — the
role PostgREST uses, i.e. every statement the worker issues — carries **`statement_timeout=8s`**.
That is **21% headroom**, and the cost is linear in segment size.

The full WhatsApp-reachable audience is **94,609**. A full-list send would take ~12.4s and be
**killed mid-build**. Worse, a killed build leaves a *partial* roster, which then reports itself as
complete and sends to a silently truncated audience — a more dangerous version of the exact bug
this spec exists to fix.

⚠️ My own first instinct — `INSERT … SELECT` in one statement inside `startCampaign` — is
therefore wrong, and would have shipped a landmine that only fires on large sends. **Mitigated:**
chunked build (§6), and `roster_built_at` is stamped only by the chunk that observes a short page,
so a partial roster can never present as finished.

### 9.2 🔴 Reading the recipients into the worker would silently truncate at 5,000

The alternative build — worker reads recipients, worker inserts them — hits the PostgREST
`db-max-rows` cap of **5,000 rows, applied to RPC calls, regardless of the function's own LIMIT,
with no error and no header** (CORE.md, S275: a 23,910-row export came back as exactly 5,000 and
looked complete). A 48k roster would silently become 5k.

**Mitigated:** the build never returns rows to the worker. `INSERT … SELECT` happens entirely
in-database; the worker only passes a cursor. ⚠️ Any future refactor that "simplifies" this by
reading rows out reintroduces it invisibly.

### 9.3 🟠 The build is not free, and it runs while the campaign looks idle

6.3s per 48k scan, 1.59M buffer hits, repeated per chunk (each chunk re-runs the consent/suppression
subqueries for its slice). Ten chunks is ~10 separate scans of decreasing size. During this the
campaign is in `building_roster` with **nothing sending**, and on 15 Aug the whole send had 4.4
hours of runway — a multi-minute silent prelude is a real cost against a quiet-hours deadline.

**Not mitigated in this spec.** Options: build the roster at **approval** time rather than send
time (audience drifts further, but the wait moves off the critical path), or accept it and surface
`building_roster` prominently in the UI. **Needs a decision.**

### 9.4 🔴 Freezing the roster BREAKS concurrent cross-campaign exclusion

S276's guarantee is that two campaigns running at once exclude each other, because
`campaign_excluded` counts a fresh `queued` row as contacted and is re-evaluated **every page**.

If campaign B's roster is frozen at *its* start while campaign A is still fanning out, B's roster
contains people A has not reached yet. Both then message them. **The frozen roster silently undoes
a guarantee the system currently has** — and it fails in the worst direction, toward double-sending
real customers.

**Mitigated, but it is a prerequisite not a follow-up:** `campaign_excluded` must move into
`gate.js` so it is evaluated per message at send time. Then B's roster may *contain* them and the
gate skips them with a visible reason — which is strictly better than today, where the exclusion is
correct but invisible. ⚠️ **Do not build the roster without this.** Shipping §4–§6 alone
reintroduces concurrent double-sends.

### 9.5 🟠 Resume semantics become ambiguous, and the current answer is wrong

Today a resume re-runs the live query and therefore picks up drifters. With a frozen roster, resume
walks the *original* roster — so the ~55/run who become eligible mid-send are **never** reached, by
design, and silently so.

**Proposed:** resume walks the frozen roster (that is the point), and a **separate explicit action
— "top up roster"** — appends newly-eligible profiles, showing the count before it does. Two
different intentions, two different buttons. ⚠️ Conflating them recreates the moving denominator
this whole spec removes.

### 9.6 🟠 `audience_snapshot` and `roster_size` can diverge, and one of them is load-bearing

`audience_snapshot` currently drives the approval-threshold re-check and the UI's "N recipients".
If the roster is built *after* the approval decision, the two numbers describe different moments.

**Proposed:** `audience_snapshot := roster_size`, assigned by the build, single source of truth.
⚠️ The existing `audience_grew_needs_approval` re-check must then run against `roster_size`,
**after** the build and **before** the chains are seeded — otherwise a campaign that outgrew its
approval starts sending and is only caught afterwards.

### 9.7 🟡 Storage grows without bound

One roster row per recipient per campaign, ~48k for a single sale send, and rosters outlive the
campaign. `comms.messages` already carries one row per send, so this roughly doubles per-campaign
storage.

**Proposed:** retain the roster while it is load-bearing (reconciliation, resume, top-up) and prune
on a schedule — say 90 days after `status='sent'` — with the reconciliation count *denormalised
onto the campaign* before pruning, so the historical answer survives its evidence.

### 9.8 🟡 The dedup-key join in the reconciliation is a string concat

`m.dedup_key = 'campaign:'||$1||':'||r.profile_id` will not use an index on `messages` unless one
exists on `dedup_key` (it does — `dedup_key` is UNIQUE). Fine today. ⚠️ But it couples
reconciliation to the *format* of the dedup key; a future change to that format silently breaks
reconciliation into reporting "everyone was missed". Prefer joining on
`(source, profile_id)` and add an index for it, or assert the key format in a test.

### 9.9 🟡 A shard's rows are fixed at build time, so shard count is fixed too

`shard` is stored, so changing `MAX_SHARDS` between the build and a resume would leave rows in
shards nobody walks — silently stranding a fraction of the audience.

**Mitigated:** the resume must read `shard_count` from the campaign row (already stored), never
recompute it from `shardsFor()`. ⚠️ A test should pin this: build a roster at 5 shards, change the
constant, resume, and assert every roster row is still visited.

### 9.10 🟡 `address` is frozen but phone numbers change

The roster stores the address resolved at build time. If a customer's number changes mid-run, the
message goes to the old one. Today's live query would pick up the new one.

**Assessment: acceptable, and arguably more correct** — the address is part of *who we decided to
message*. But it is a real behaviour change and belongs in the release note rather than being
discovered later.

---

## 10. Open questions for Afshaan

1. **§9.3** — build the roster at approval time (off the critical path, more drift) or at send time
   (accurate, but a silent multi-minute prelude before anything sends)?
2. **§9.5** — is "top up roster" a button worth having, or should drifters simply be caught by the
   next campaign?
3. **§9.7** — retention: 90 days after send, or keep rosters indefinitely?

## 11. Build order (non-negotiable sequence)

1. `campaign_excluded` → `gate.js` (§9.4). **Nothing else can ship before this.**
2. Table + migration (§4), with RLS, grant, and the PostgREST `NOTIFY`.
3. Chunked build (§6) + `building_roster` state.
4. Fan-out reads the roster, with the `roster_built_at IS NULL` fallback (§7).
5. Reconciliation query surfaced in the app as "N never reached" on a finished campaign.
6. Tests: idempotent build · partial-build-never-marked-complete · shard-count-change on resume
   (§9.9) · concurrent campaigns do not double-send (§9.4) · reconciliation returns 0 on a clean run.
