# Ignition → Relay email/outreach integration (Batch B theme ①) — design

> Status: DESIGN — no code. Written S294 (2026-08-17) per the S182 decision: "theme ① routes
> through Relay (Ignition calls `commsops /send` + journeys/templates — NO native email engine);
> write a Relay-integration design doc before any ① code."
> Scope: B2 email briefs · B3 UTM auto-gen · B10 bulk outreach · B5 10-day-no-post reminder.
> Unlocks later: B16 WhatsApp (same seam, `channel:'whatsapp'`) · B6 60-day re-engage (bulk send
> over the existing `ignition.reengage_list()` RPC).
> ⚠️ Ignition-side build only. NOTHING in this design modifies commsops — every Relay-side
> capability referenced below already exists. If a gap turns out to need a commsops change, that
> change goes to the Relay lane as its own item, not into this build.

## 1. Context

Reann's Batch B theme ① is the email/outreach backbone: send deal briefs at contract stage,
bulk-outreach prospect influencers, and nudge influencers who went quiet after shipping. Afshaan
decided (S182) this routes through Relay rather than a native Ignition mailer, because Relay
already owns: sender identities (Resend, `hello@comms.legendoftoys.com`), versioned templates
with variable binding, the central send gate (suppressions → consent → freq cap → quiet hours →
channel rule), the unified `comms.messages` outbound log, and delivery/bounce webhooks. Building
any of that twice is the anti-pattern.

**The seam contract (existing, verified in systems/relay.md):**
`POST /send` (bearer `INGEST_TOKEN`) `{channel, purpose, profileId?, to, templateId?|template?,
constants?, source?, dedupKey?}` → render → gate → adapter → `comms.messages` row. Gate-fail
writes a `skipped`/`suppressed` row, never silent. csops already calls this seam for WA — the
sibling-caller pattern is established.

## 2. Architecture decision

**Ignition = trigger + audience owner. Relay = transport + template + log.**

- ignitionops calls `POST /send` service-to-service. It never touches Resend, never renders
  email HTML, never re-implements gate logic.
- Templates are authored and versioned **in Relay** (channel `email`), with author-defined
  variables. Ignition passes `constants` per send. Ignition stores only loose template *refs*
  (see §5 settings) — never template bodies.
- Trigger logic (which influencer, when, why) stays **in Ignition** — it owns the stage data.
  v1 uses direct `/send` calls from ignitionops, NOT Relay journeys: a journey would need
  Ignition stage-events ingested into `comms.events` first, which is more plumbing than the
  four features need. Revisit journeys if/when theme-① sequences grow branching logic.
- **Influencers become comms profiles** via the existing `POST /ingest` seam (identity resolve
  on email; phone attached when present for future WA). Profile attributes carry
  `influencer: true` + `ignition_influencer_code` so customer-facing segments can exclude them
  and Relay contacts views can identify them. `resolve_identity` dedups if an influencer is
  also a customer — that is correct behaviour (one human, one profile), and the attribute
  simply marks the influencer facet.

## 3. The four features

### B2 — email brief at contract stage
- Trigger: explicit button on the engagement detail ("Send brief"), enabled at/after the
  contract-ish stages; NOT auto-fired on stage change (a mis-click advancing a stage must not
  email an influencer).
- Ignition composes `constants`: influencer/channel name, deal no, products (from
  `engagement_products`), deal type, payment terms/amount, expected post date, compliance
  checklist summary, `utm_link` (B3), and a brief/contract link.
- Brief document: v1 links the engagement's existing attachment (signed URL from
  `ignition-payment-proofs`-style private-bucket flow already used for attachments). `/send`
  has no attachment support and this design does not add one — the email carries a link.
- Idempotency: `dedupKey = 'ign-brief-<engagement_no>-v<n>'`; re-send is an explicit
  "Send again" that bumps n and is logged.

### B3 — UTM auto-gen (pure Ignition, no Relay involvement)
- Columns already exist (`utm_link`, `utm_source/medium/campaign`). Worker mints on demand:
  `utm_source=<influencer_code>`, `utm_medium=influencer`, `utm_campaign=<engagement_no>`,
  target = product page (first engagement product). Overwritable, never auto-overwritten.
- Feeds B2/B10 constants and Reann's GA4-side attribution ask (blocked separately on creds).

### B5 — 10-day-no-post reminder
- ignitionops cron (its own `scheduled()`; no commsops cron): daily, IST-aware. Set = video
  deals with `delivered_date` (or `shipping_date` fallback) ≥10 days ago, stage not
  live/closed, `post_date` null, not `gifted_no_post`, not do-not-ship, reminder not yet sent.
- Sends via `/send` with `dedupKey='ign-remind10-<engagement_no>'` (one reminder per deal,
  ever — repeat nudges are a human call, not a loop). Stamps `reminder_sent_at` (new column,
  §5) only on a non-skipped send result.

### B10 — bulk outreach email
- From the influencer master list: filter (type/category/niche/location) → select → pick a
  Relay template → per-recipient `/send` loop (batched; the 10k subrequest ceiling is not a
  constraint at influencer-list scale, but batch anyway per CORE).
- Each send `dedupKey='ign-outreach-<batch_id>-<influencer_code>'`; a `bulk_batches` row (§5)
  records who/when/template/count so the same list can't be accidentally double-blasted.
- ⚠️ Consent shape differs from B2/B5 — see §4. Bulk outreach to people with no prior
  relationship is the one genuinely marketing-shaped send in this theme.

## 4. Purpose + consent (THE open decision — needs Afshaan/Relay-lane sign-off)

Relay's gate: `marketing` requires `opted_in`; `transactional`/`utility`/`service` bypass
consent/freq-cap/quiet-hours but NEVER suppressions. Influencers are business contacts, not
DND-registered consumers, but the gate doesn't know that distinction.

- **B2 brief / B5 reminder → purpose `service`** (recommended). These are 1:1 operational
  correspondence about a deal the influencer already agreed to — the exact shape the S274
  `service` purpose (CSAT) was added for. No commsops change needed. Hard suppressions still
  honoured (an influencer who unsubscribed/bounced stays blocked — correct).
- **B10 bulk outreach → unresolved.** Options:
  (a) send as `marketing` + record `opted_in` consent (source `ignition_roster`) at influencer
      ingest — machinery fits, but the consent record is a fiction; rejected as written unless
      Afshaan explicitly blesses "roster contact = business-contact consent" as the recorded
      evidence string;
  (b) send as `service` — honest gate-wise (suppressions still apply) but mislabels cold
      outreach as operational correspondence;
  (c) ask the Relay lane for an `influencer_outreach` purpose/consent class — cleanest, but a
      commsops change, so out of this build's scope by definition.
  **Recommendation: build B2/B3/B5 first (no controversy), hold B10 behind this decision.**
- **Unsubscribe:** Relay's email footer/one-click unsubscribe writes consent opt-out and/or
  suppression per its own rules; Ignition must surface a "do not email" signal on the
  influencer (read `comms` state at render of the detail page, or mirror on send-fail with
  `suppressed`) rather than maintaining a second opt-out list.

## 5. Ignition-side data model (all additive, `ignition` schema, RLS-on + service_role grant + NOTIFY)

- `engagements.reminder_sent_at timestamptz` (B5 stamp).
- `ignition.outreach_log` — `id, engagement_id?, influencer_id, kind
  ('brief'|'reminder'|'outreach'), template_ref, dedup_key UNIQUE, send_result
  ('sent'|'skipped'|'suppressed'|'failed'), comms_message_ref?, batch_id?, actor, created_at`.
  Ignition's own audit of what it asked Relay to send (Relay's `comms.messages` stays the
  delivery truth; this is the "why" log on the Ignition side).
- `ignition.bulk_batches` — `id, name, template_ref, filter_snapshot jsonb, recipient_count,
  actor, created_at` (B10).
- `ignition.settings` k/v (or reuse an existing pattern): `relay_template_brief`,
  `relay_template_reminder`, default outreach template — loose text refs to Relay template
  ids, editable by `ignition_admin`, so template swaps never need a deploy.
- Secrets on ignitionops: `COMMSOPS_URL` + the `/send` bearer. ⚠️ INGEST_TOKEN is shared
  service-to-service (csops holds it too) and systems/relay.md flags it for rotation — adding
  a third holder is more reason to rotate first; coordinate with the Relay lane at build time.

## 6. Status backflow

v1: `outreach_log.send_result` from the synchronous `/send` response (sent vs skipped vs
suppressed — the gate answers immediately). Delivery/open/bounce live in `comms.messages`;
ignitionops MAY read them read-only cross-schema (service_role, the Manifest→store precedent)
to decorate the engagement timeline, but that is a polish phase, not v1.

## 7. Rollout gates

1. **Relay is under the internal-test-only gate** ([[project_relay_internal_testing_gate]]):
   no real sends until Afshaan signs off. Everything here ships inert-first: test recipients
   (team inboxes) only, real influencer sends behind the same sign-off.
2. Build order: B3 (pure Ignition, zero risk) → B2 (1:1, explicit button) → B5 (cron, capped
   + dedup-keyed) → B10 (held on the §4 decision).
3. Templates authored in Relay by the team (self-serve per
   [[feedback_handover_self_serve_tooling]]); this build ships with placeholder internal-test
   templates only.

## 8. Open questions (blocking the respective slice only)

1. §4 B10 purpose/consent call — Afshaan (+ Relay lane if option c).
2. Brief content: link-to-attachment (v1 here) vs rendered-in-body brief — Reann preference.
3. Reminder cadence: one-shot at 10 days (v1 here) vs escalating repeats — Reann.
4. Does the `service` purpose have an email sender resolution today (the `'all'`-wildcard
   email sender should match per pickSender; verify in test mode before relying on it)?
