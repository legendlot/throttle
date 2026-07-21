# Relay hostile code review — 2026-07-21

> Commissioned by Afshaan ahead of the BiteSpeed cutover: "any bugs, open-ended buttons,
> silent failures, future bugs — be a hostile reviewer." Method: 4 parallel adversarial
> review agents on independent slices (send spine / webhooks+ingest / orchestration / app UI),
> every CRITICAL+HIGH claim then **verified line-by-line by the primary session** against the
> code, plus a live-DB state audit. Codebase at commsops `acb86827` / monorepo `88179ce2`.
>
> **[V] = verified directly in code by the primary session. [a] = agent-reported, spot-consistent
> but not independently re-derived.** File refs are `commsops-worker/src/...` unless noted.

## Verdict

The architecture is right and the compliance discipline in the opt-out paths is genuinely good
(single withdrawal writer, throw-on-failure, evidence trail). But the codebase has **one systemic
disease and one design flaw** that together produce most of the ~60 findings:

1. **`sbComms` never throws — it returns `{ok:false}` — and a large fraction of call sites never
   check `.ok`.** Every unchecked site is a silent-failure path: fail-open gates, lost consent
   writes, campaigns marked sent that weren't, permanently silenced parcels.
2. **Dedup is dedup-on-ATTEMPT, not dedup-on-success** (`send.js` reserve-then-consume). Any
   non-sent outcome burns the key forever; retries report `deduped` which downstream treats as
   success. This converts *every transient failure anywhere in the send path* into a silent,
   permanent, unretryable loss.

**Relay is safe in today's posture (test_mode ON, journeys draft) and fine for the email volumes
it has carried. It is NOT yet safe to unlock customer sends at marketing scale** until the
Fix-before-go-live list below lands. All fixes are small and localized; nothing structural.

---

## CRITICAL

**C1 [V] Dedup key burned on any outcome — skipped/failed sends become permanent silent losses.**
`send.js:111–123` reserves the messages row (with dedup_key) BEFORE template/gate/adapter;
`finalize()` keeps the key on the row whatever the status. Retry → `deduped`; and
`journey-graph.js sendWentOut()` counts `deduped` as "sent". Worst concrete case: a campaign
fanned out (or scheduled) during quiet hours → **every recipient skipped, every key consumed,
campaign marked `sent`, and it can never be re-sent** (startCampaign refuses from `sent`; keys
block a rebuild). Fix: dedup on success only — delete/exclude the reserve row on skip/fail, or
key the dedup check on status.

**C2 [V] Campaign fan-out marks the campaign `sent` when the recipients RPC fails mid-broadcast.**
`campaigns.js:77,89–94` — `{ok:false}` → `recs=[]` → "fan-out complete" → `setStatus('sent')`.
One transient PostgREST 500 mid-audience = remaining recipients never contacted, no error, no
retry, campaign reports success. Fix: `if (!r.ok) throw` (queue retry semantics then apply).

**C3 [V] A Shopflo opt-OUT can be silently lost while acking 200.** `shopflo-webhooks.js:77–80` —
`recordConsent` returns `{ok:false}` without throwing; result unchecked (`.catch(()=>{})` is dead
code); and the consent block runs only `if (!r.deduped)`, so once the event row exists a retry
can never re-attempt the failed consent write. Violates the withdrawal-must-propagate rule the
WA path enforces. Fix: check the result; on failure return non-2xx (or decouple consent from the
event-dedup guard).

**C4 [V] The WA template UI's "Submit to Meta" can never succeed, and every UI save strips the
WABA pin.** `apps/relay/.../templates/page.js:106–116` rebuilds WA content WITHOUT `waba_id`;
`waTemplate.js:76` then always errors ("Pick the WhatsApp Business Account") → the button is dead
in all cases, while the preview badge says "Ready to submit". Worse: **saving a submitted template
from the UI persists content without `waba_id`** → sync polls the wrong WABA (silently reads as
"no change") and send routing falls back to `env.WA_WABA_ID`. This would have corrupted the 18
live pins had staging been done via the UI instead of `/internal/wa-template-op`. Fix: carry
`waba_id` (and `header_handle`, `provider_template_id`) through buildPayload/startEdit; server-side,
make `saveTemplate` merge-not-replace `content` keys it doesn't own.

## HIGH — send path & money

**H1 [V] Suppression and freq-cap fail OPEN on DB error.** `gate.js:66–69` (`sup.ok &&` → error
passes as not-suppressed → sends to hard-bounced/complained addresses), `gate.js:85` (cap silently
disabled). Consent happens to fail closed; suppression must too. Fix: `if (!sup.ok) return
{pass:false, reason:'gate_error'}`.

**H2 [V] Email adapter has no try/catch around fetch.** `adapters/email.js:20` — a network error
throws through `send()` (adapter call at `send.js:200` is outside the try): no messages row, a
reserved row stuck `queued` (feeds C1), and in the campaign loop it poisons the whole page (H3).

**H3 [V] One throwing recipient kills the rest of the broadcast and strands the campaign.**
`campaigns.js:79–87` — no per-recipient try/catch; a deterministic throw (H2, or gate TypeError
on array `to`, `gate.js:42`) → page retries ×3 → DLQ → continuation never enqueued → campaign
stuck `sending` forever (no stall sweep exists). Fix: per-recipient try/catch + a stalled-campaign
sweep.

**H4 [V] WhatsApp cost mis-parse: free messages counted as billable.** `adapters/whatsapp.js:111`
— `billable===true || pricing.category`: Meta always sends `category`, so `{billable:false,
category:'service'}` (all free service-window traffic — i.e. most of the SUPPORT number's volume
post-cutover) is costed `1`. WA spend metrics will be massively overstated. Fix: `priced =
s.pricing?.billable === true` (the row's separate `billable` column is already correct).

**H5 [V] Cutover-day sender-routing set** (each fires the moment 3 live WA senders exist):
- `send.js:34` — an explicit `senderId` pin bypasses the WABA filter entirely → a stale pin sends
  a template from a number whose WABA doesn't hold it (per-send Meta 132001 failures, made
  unretryable by C1).
- `send.js:55` — the single-sender fallback runs AFTER the WABA filter narrows to 1, so a
  mis-pinned template routes out the wrong-purpose number instead of refusing (the exact pre-S224
  bug, reachable again).
- `send.js:14–22` — `wa_windows` is keyed on customer number only, not (customer, phone_number_id):
  the 24h window opened by messaging SUPPORT also opens free-text from MARKETING/TXN.
- `send.js:43` — `metadata.waba_id === wabaId` strict equality: a number-vs-string mismatch in
  either jsonb source zeroes the sender set (`no_sender_on_waba`). Verify live row types at cutover.

**H6 [a] `unsubscribeUrl` swallows the token-persist failure + races concurrent mints.**
`send.js:86–93` — PATCH result unchecked; the token is embedded in the email regardless → live
marketing emails can carry dead one-click unsubscribe links (DPDP + Gmail bulk-sender risk).

## HIGH — orchestration & auth

**H7 [V] Scheduler privilege bypass: `campaign_build` alone can reach real customers.**
`index.js:412–423` saveCampaign PATCHes ANY campaign (no status guard) incl. setting
`scheduled_at` on an approved one; `submitCampaign` auto-approves transactional at any size and
marketing ≤500; the cron sweep (`index.js:549–557`) then fires it with no permission actor.
`sendCampaign`'s `canActivate` gate is decorative for a patient builder. Currently contained ONLY
by test_mode. Fix: status-guard saveCampaign (draft-only PATCH), or require `send_activate` to set
`scheduled_at`.

**H8 [V] Journey activation is gated on `campaign_build`, not `send_activate`** (`index.js:475`),
while the roles UI advertises "send_activate — Activate/send campaigns & journeys". A draft-only
builder can activate unlimited-audience automation. Fix: `canActivate` on `setJourneyStatus`.

**H9 [V] `relay_admin` can grant `relay_super_admin`** (`index.js:219–246` — no role-height check)
→ self-escalation → `saveRelaySettings` (test_mode OFF) + PII backfill. Fix: super-admin-only when
`role_key` is a super role (mirror Manifest's RULE-MANIFEST-006 posture).

**H10 [a] Enrolments silently lost on transient errors.** `journeys.js:165–188` — `enrol()`
returns `{ok:false}` instead of throwing (queue acks, no retry, no DLQ); a journey-read blip is
misclassified `journey_not_active`. Same class: `ingest.js:99–112` journey-trigger fan-out swallow
— the event inserts, the enqueue fails, and redelivery hits `deduped` so the trigger is skipped
forever.

**H11 [V] shipment-events fails OPEN on transient DB error.** `shipment-events.js:90–99` — a
failed `order_placed` lookup (or one that simply hasn't arrived yet — same-day ship) takes the
`unresolved → markEmitted` branch, which is TERMINAL for `delivered`/`rto`: the customer's
lifecycle messages are permanently cancelled by a 30-second blip. Directly relevant to the
Delivered/RTO journeys at cutover. Fix: only markEmitted on `ev.ok && no row`, and consider a
retry-count before giving up on young orders.

**H12 [a] Double-enrol holes.** `journeys.js:170–180` — `reenrolment:'cooldown'` with null/0 hours
skips dedup entirely; unknown policy values have none; `once_*` is check-then-insert with no
unique constraint (redelivery race). A redelivered enrol message mints a NEW enrolment id, so the
instance-id idempotency does not protect.

**H13 [a] Version-save race → dangling `active_version`.** `journeys.js:140–148` — versions insert
unchecked + read-then-increment; on failure `active_version` points at a missing version → every
new enrolment fails while the UI shows the journey active.

**H14 [a] `#park` catch-all masks errors as timeouts + plain `wait` duration is never validated.**
`journey-workflow.js:372–381` + `journeys.js:53` — a typo'd duration ("3 dayz") throws in
waitForEvent → caught as `{kind:'timeout'}` → a 3-day drip fires instantly back-to-back.

**H15 [a] Resend webhook fails open if `RESEND_WEBHOOK_SECRET` is unset** (`webhooks.js:30–35` —
every other receiver 503s until configured; this one processes unsigned payloads, and a forged
bounce suppresses an arbitrary address forever). **Live-mitigated** — the secret IS set on the
worker — but the code posture is wrong and svix verification is non-timing-safe with no timestamp
tolerance (replay).

## MEDIUM (selected — full agent lists in the appendix)

- **M1 [V] `/send` defaults `purpose` to `'marketing'`** (`send.js:106`) — the worst default for
  the Pitstop cutover: a support reply that omits purpose gets consent+quiet-hours+cap and is
  silently withheld. Refuse-on-missing-purpose for the internal gateway.
- **M2 [a] Approval threshold is submit-time only** (`campaigns.js`) — approved at 400, sends to
  whatever the dynamic segment holds at fire time (40k) with no re-check.
- **M3 [a] `sendTest` (`index.js:374`) = arbitrary content + recipient for `campaign_build`,
  purpose-hardcoded transactional (consent bypass by design) — a side door once test_mode is off.
- **M4 [a] Cron has no single-flight** — overlapping `runScheduled` races segment scans/baselines/
  alerts; only startCampaign is claim-guarded. Max-duration sweep zombie accumulation
  (`limit=200`, no order) can starve newer expiries.
- **M5 [a] DLQ consumer acks even when the `queue_failures` insert fails** (`index.js:853–863`) —
  the "recorded for review" guarantee can be false.
- **M6 [a] Out-of-order status webhooks regress `messages.status`** (read→delivered overwrite;
  WA + Resend both). Timestamps survive; canonical status wrong. (M8 analytics already counts via
  timestamps — the design anticipated this — but the row's `status` is still wrong for UI/queries.)
- **M7 [a] `auth.js:41` role lookup is `limit=1` with no order** — a user with two active roles
  gets nondeterministic permissions.
- **M8 [a] Template `content` is replaced wholesale by three writers** (`saveTemplate` /
  `waSubmitTemplate` / `waUploadHeaderMedia`) — last-write-wins drops `waba_id`/`header_handle`.
  Same root as C4's server half.
- **M9 [a] `previewSegment` is a PII count-oracle for any `relay_view` holder** (no
  `segment_manage` gate on arbitrary definitions).
- **M10 [a] wa-templates sync `|| data[0]` fallback + language-blind match can adopt the wrong
  template's status** (`wa-templates.js:241–246`).
- **M11 [a] UI: admin/users role dropdown silently empty for `relay_admin`** (worker gates
  `getRoles` on super_admin; 403 swallowed → grant flow un-completable with no error).
- **M12 [a] UI: static "internal testing" banners + sendNow confirm hardcode the test-gate text**
  — the day test_mode goes OFF, the confirm lies in the dangerous direction. Read
  `getRelaySettings` live.
- **M13 [a] UI: email template with `html_body` but no `design_json` opens as a blank canvas;
  save overwrites the real HTML with the scaffold.**
- **M14 [a] UI: marketing template missing `{unsubscribe_url}` — warning toast then saves anyway**
  (missing `return`).
- **M15 [a] UI: analytics/funnel/contacts swallow fetch errors into fake zeros/empties** —
  "Attributed revenue ₹0" is indistinguishable from an RPC outage.
- **M16 [a] Segment-entry: entrants' membership commits, then the per-entrant enqueue loop fails
  → permanently un-enrolled** (`segment-entry.js:94–99`).
- **M17 [a] Shopify order idempotency key includes `updated_at`** (`shopify.js:233`) — safe today
  (only orders/create subscribed) but a future orders/updated subscription double-counts
  `lifetime_orders`.

## LOW (selected)

Internal bearer compares are non-timing-safe (`===`) · `compileJourney` ungated beyond view +
unbounded recursion in `hasCycle` (DoS-able) · `alert()` never checks res.ok (dead Slack webhook
= silent) · deliverability check re-alerts hourly forever on one stale complaint · budget consumed
on sends that then fail at the adapter + sbComms error mislabeled `budget_exhausted` ·
`tagLinks` corrupts entity-encoded `&amp;` hrefs in multi-param marketing links ·
media-header template with no asset silently omits the header (opaque Meta reject at send) ·
suppression match is exact-string (case-sensitive) on the manual path · test-mode allowlist
`compactAddr` strips dots from email local parts · `optOutProfile` (the Meta "on-or-off-WhatsApp"
withdrawal) has NO UI control · `waUploadHeaderMedia` has no UI (media headers unauthorable) ·
`workerFetch` parses JSON before `res.ok`.

**UI action diff: clean.** Every action the app invokes exists on the worker; no dead buttons from
missing handlers. Unreachable worker capabilities: `optOutProfile`, `waUploadHeaderMedia`.

---

## Fix order (recommended)

**Gate 1 — before any real-customer unlock (test_mode OFF), all small:**
C1 dedup-on-success · C2 fan-out RPC throw · H1 fail-closed gates · C3 Shopflo consent ·
H2 adapter try/catch + H3 per-recipient catch · M14 unsubscribe-save guard.

**Gate 2 — before/at the WA cutover:**
H5 sender-routing set (pin-respects-WABA, pre-filter fallback, per-number windows, type-coerced
waba compare) · H4 cost parse · C4/M8 template-content merge + UI waba_id · H11 shipment-events
fail-closed · M1 /send purpose refusal · M12 live test-mode banner.

**Gate 3 — before widening the team's roles:**
H7 scheduler bypass · H8 journey activation gate · H9 role-escalation guard · M11 admin/users ·
M3 sendTest containment · M9 previewSegment gate.

**Gate 4 — robustness (journeys at scale):**
H10 enrol/trigger retryability · H12 enrol dedup constraint · H13 version-save check ·
H14 wait validation + park catch discrimination · M4 cron single-flight · M16 segment-entry
enqueue-before-commit ordering.
