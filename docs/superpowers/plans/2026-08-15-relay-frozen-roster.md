# Plan — Frozen Campaign Roster (send-time build + top-up)

> Spec: `../specs/2026-08-15-relay-frozen-roster-design.md` — **read §9 and §9-R2 first**; three
> findings there rule out the obvious implementations, and this plan is sequenced around them.
> Decisions locked (Afshaan, 2026-08-15): build at **send time** · **top-up button** exists ·
> retention defaults to keep-indefinitely.
> Every task is TDD: the test is named before the change, and the test list at the bottom of each
> task is the definition of done. Worker order per house rule: edit → commit → push → deploy.

## Ground rules for the whole plan

- ⛔ **Ship order is the spec's §11. Tasks 1–2 are prerequisites, not preferences** — a roster
  without task 2 double-sends under concurrent campaigns (§9.4/§9.21).
- Every migration that creates a table or function: RLS on, `GRANT … TO service_role`,
  `NOTIFY pgrst, 'reload schema'` in the same migration (S239 trap).
- ⚠️ `CREATE OR REPLACE` with a **changed argument list creates an overload, it does not replace**
  — today's own bug (`comms_drop_stale_campaign_recipients_overload_v1`). Any signature change =
  explicit `DROP FUNCTION` of the old signature in the same migration, then re-prove callers.
- All numerics from PostgREST arrive as strings — `Number()` at every read.
- After each worker deploy, verify the live behaviour (a probe call), not the deploy banner.

---

### Task 1 — Queue-dispatch hardening (§9.11) · ✅ SHIPPED 2026-08-15 (commsops `2f004f5a`)

> Live-verified: 29 enrolments + 24 messages routed through the new dispatcher in the 10 min
> post-deploy, 0 DLQ rows. ⚠️ The sweep also caught my afternoon clock guard having made
> campaign-exclusions.test.js time-of-day dependent (red at 23:12, green all afternoon) — fixed
> by stubbing quiet hours exempt there. Check OTHER suites that call startCampaign for the same
> bomb when touching them.

A live latent bug independent of the roster: unknown `kind` falls through to the campaign branch,
gets early-returned and **acked**, i.e. silently destroyed.

- `index.js` queue consumer: default branch requires `b.campaignId && !b.kind`; anything else
  **throws** (`unknown_queue_kind:<kind>`), so Queues redelivers → retry lands on a current isolate
  → after `max_retries`, DLQ + alert (existing path).
- **Tests** (`test/queue-dispatch.test.js`, new): known kinds route · bare campaign body routes to
  `processQueueMessage` · `{kind:'build_roster'}` on a consumer without the handler **throws**
  rather than acks · `{kind:'garbage'}` throws.

### Task 2 — `campaign_excluded_batch` + per-page visible exclusion (§9.21) · ✅ SHIPPED 2026-08-15 (commsops `ac767185`)

> Batch proven ≡ scalar on 400 live profiles (0 disagreements) before wiring. Post-deploy: queue
> healthy (16 enrolments / 14 messages in 8 min, 0 DLQ). ⚠️ The RPC's PostgREST exposure has not
> been exercised through the worker yet — it only fires mid-fan-out with exclusions active. That
> is acceptable because its failure mode is LOUD by construction: bx.ok false → page throws →
> 3 retries → DLQ + alert (Task 1's contract). An invisible RPC self-announces; it cannot
> silently pass. First real exercise = the next campaign carrying exclusion rules.

- Migration `comms_campaign_excluded_batch_v1`: `campaign_excluded_batch(p_profile_ids uuid[],
  p_channel text, p_exclude_segments uuid[], p_exclude_campaigns uuid[],
  p_exclude_contacted_hours int) RETURNS uuid[]` — a thin array wrapper over the existing
  `campaign_excluded` predicate (ONE predicate, no copy — PATTERN-297).
- `campaigns.js` fan-out, per page: call it once; for excluded ids write **one array insert** of
  `status='skipped', reason='excluded_recent_contact'` rows (profile_id, channel, purpose, source,
  to_address; no dedup_key — a later resume may legitimately retry them); send the rest.
- ⚠️ The batch call failing must **throw** (page retries), never soft-continue — soft-continue
  sends to people the exclusion should have held back, in the S276 concurrency window.
- **Tests**: excluded ids get skip rows and are not sent · RPC failure throws · empty exclusion
  args skip the RPC call entirely (no subrequest tax on the common case).

### Task 3 — Roster table + `p_before` (§4, §9.12)

- Migration `comms_campaign_roster_v1`: table exactly per spec §4 (PK `(campaign_id, profile_id)`,
  covering index `(campaign_id, shard, profile_id)`, RLS, grant, NOTIFY) + campaign columns
  `roster_built_at timestamptz`, `roster_size int`, `build_cursor uuid`.
- Same migration: `campaign_recipients` gains `p_before uuid DEFAULT NULL`
  (`AND (p_before IS NULL OR sm.profile_id <= p_before)`). ⚠️ Changed argument list → **DROP the
  10-arg signature, CREATE the 11-arg one, in one migration**, then immediately re-prove: the
  partition check (unsharded == Σ shards, 0 missing, 0 overlap) and one live fan-out page.
- **Tests**: SQL-level — `p_before NULL` ≡ old behaviour byte-identical · a `[after, before]`
  slice unions with its complement to the full set.

### Task 4 — Scan-bounded chunked build (§9.12/§9.13/§9.14) + `building_roster`

- Migration `comms_build_roster_chunk_v1`: `build_roster_chunk(p_campaign_id uuid, p_after uuid,
  p_scan_limit int DEFAULT 15000) RETURNS TABLE(scanned int, inserted int, cursor uuid, done bool)`
  — walks `segment_members_pkey` to the scan-limit boundary (`p_before`), INSERT…SELECT the slice
  through `campaign_recipients` with `ON CONFLICT DO NOTHING`, cursor = **last member scanned**
  (always advances; §9.12), `done = scanned < p_scan_limit`. Single-row return — immune to the
  5,000-row cap (§9.2).
- `startCampaign` (first send: status `approved`/`scheduled`, `roster_built_at IS NULL`): run
  guards + dialogs synchronously as today (§9.14) → atomic claim → `status='building_roster'` →
  enqueue `{kind:'build_roster', campaignId, after:null}` → return `{building:true, estimated}`.
- Consumer handler for `kind:'build_roster'`: abort silently if status ≠ `building_roster` (stop
  honoured); run chunk; not done → enqueue next cursor; done → stamp `roster_built_at`,
  `roster_size`, `audience_snapshot := roster_size`, **approval re-check** (outgrew → park
  `pending_approval` + ALERT, §9.14), else `shard_count := shardsFor(roster_size)`,
  `shards_done := 0`, `status='sending'`, seed one chain per shard.
- `stopCampaign`: widen to `status=in.(sending,building_roster)` (§9.16).
- **Tests**: chunk cursor advances on a zero-emission slice · build resumes from `max(profile_id)`
  after a mid-build stop · partial build never stamps `roster_built_at` · approval re-check parks
  and does NOT seed chains · a double-delivered build message is a no-op (idempotent insert).

### Task 5 — `stalled` via the DLQ consumer (§9.15) · closes the dead-chain P1

- DLQ consumer: for dead-lettered `build_roster` or campaign-fan-out messages, PATCH the campaign
  `status='stalled'` where `status=in.(building_roster,sending)`, and say so in the existing alert.
- `startCampaign` accepts `stalled` as resumable — build-resume if `roster_built_at IS NULL`
  (cursor from `max(profile_id)` in roster), send-resume otherwise. Atomic-claim list widened in
  the same edit (the two lists are the same gate written twice — keep them in step, it is the
  documented trap).
- **Tests**: DLQ'd build message stalls the campaign · DLQ'd fan-out page stalls the campaign ·
  resume from stalled with no roster resumes the BUILD · with roster resumes the SEND.
- ✅ On ship: close BACKLOG P1 "dead fan-out chain silently stalls a campaign" (its pass condition
  — visible within a minute without reading the DLQ — is met by the status + alert).

### Task 6 — Fan-out reads the roster (§7) + holdout rows (§9.17)

- `processQueueMessage`: when the campaign has `roster_built_at`, page from `campaign_roster`
  (`campaign_id, shard, profile_id > after` on the covering index) instead of
  `campaign_recipients`; **fallback to the live query when NULL** — never strand a campaign
  in-flight across the deploy.
- Holdout arms: write `status='skipped', reason='holdout'` with `variant_id` instead of returning
  silently. ✅ **Verified against `campaign_variant_stats` + `ab-stats.js` (2026-08-15): safe** —
  `sent` counts `sent_at IS NOT NULL`, the primary metric is read÷sent, `zTest` nulls on a zero
  denominator; holdout rows inflate only `assigned` and the labelled diagnostics.
- **Tests**: roster path pages correctly and terminates per shard · fallback used when
  `roster_built_at` NULL · holdout recipients produce skip rows and no send · roster path still
  applies the Task-2 per-page exclusion.

### Task 7 — Reconciliation + top-up (§5, §9.18)

- `getCampaignRecon` (GET): roster LEFT JOIN messages on `(source, profile_id)`
  (`messages_source_idx` verified) → `{roster_size, attempted, never_attempted}`. App shows
  **"N never reached"** + resume on finished campaigns (extends the existing tail UI, which today
  compares `audience_snapshot` to `stats.sent` — replace that estimate with the real join).
- `previewTopUp` (GET): `campaign_recipients` minus roster → count. `applyTopUp` (POST):
  **gated `status IN ('sent','stopped','stalled')`** (§9.18) + `canSend`; inserts with
  `shard = hash % stored shard_count` (**stored** — never recompute via `shardsFor`, §9.9);
  approval re-check against `roster_size + added`; bumps `roster_size`. Flow in the app:
  top-up → confirm count → resume.
- **Tests**: recon is 0 on a fully-attempted roster · counts holdout rows as attempted · top-up
  refused while `sending` · top-up rows land in valid shards under the STORED shard_count ·
  resume after top-up visits the new rows (cursor `after:null` re-walk).

### Task 8 — App + manual + close-out

- Campaigns page: `building_roster` badge ("Preparing audience — N of M built", poll) · `stalled`
  badge + resume · recon line · top-up button. `sendNow` copy for `{building:true}` response.
- System Manual campaign-lifecycle chapter updated **in the same PR** (S105 rule), then
  `build.py` + `build-manual-web.py relay`.
- Full regression: all campaign/gate/segment test files + the live smoke (signed-in) on a
  50-person internal segment end-to-end: build → send → recon 0.
- BACKLOG: close the P1 (Task 5), update the 297-miss item (reconciliation now answers it per
  campaign), spec/plan pointers.

## Explicitly out of scope

- Roster pruning (§9.7 open — keeping indefinitely until decided).
- Changing `THROUGHPUT_PER_HOUR` / the quiet-hours guard shape (separate backlog item; re-measure
  first full sharded run).
- The Links-page wording item and the 297 root-cause instrumentation — the recon makes misses
  *visible and recoverable* per campaign; the swallowed-throw instrumentation (`pageErrors`
  persistence) rides along in Task 6 only if trivial, else stays its own item.
