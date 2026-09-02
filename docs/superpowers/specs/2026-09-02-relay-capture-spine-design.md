# Relay capture spine — embeddable forms and surveys (design)

> **Date:** 2026-09-02 (S331) · **System:** Relay (`commsops`) · **Status:** design approved, plan not yet written
> **Backlog:** `backlog/relay.md` `[relay] [build] [HIGH]` "Embeddable website forms that feed Relay directly"
> **Supersedes nothing.** Overlaps the live `[relay] [build] [MED]` item "`/subscribe` e2e + website form wiring" — see §9.

---

## 1. Why this exists, and what it is not

Afshaan, 2026-09-02: replace the Shopify forms with capture that feeds Relay directly, **and** build a
survey builder in the same system — *"there should be a whole form builder because then we also need to
create a builder for surveys as well, and that should all be part of relay."*

The capture itself is trivial. The design work is everywhere else, and it was already recorded in
`systems/relay.md` before this session: this is commsops' **first unauthenticated public write surface**
(`/ingest` is token-authed and must NOT be exposed), consent must produce DPDP-grade evidence rather than
`unknown`, auto-segments need a segment kind that does not exist, and back-in-stock needs a stock signal.

⭐ **The expensive mistake to avoid, flagged in the original item and re-confirmed 2026-09-02: do not build
stock tracking again.** Odo already captures hourly Shopify inventory into `sales.inventory_reading`
(RULE-INV-001), and `sales.detect_stock_alerts()` + `sales.stock_alert_outbox` are **built and live with
exactly one consumer** — a Slack Incoming Webhook (`odoops-worker/src/index.js:4184,4225,4240,4301`),
inert without `SLACK_WEBHOOK_STOCK`. The work is wiring that existing signal to a `back_in_stock` event.

## 2. Decomposition — five sub-projects

Forms and surveys share a spine (question schema, response store, destination) but have different threat
models: a form is an anonymous stranger writing to us; a survey is a known profile answering something we
sent them. One builder, two delivery adapters (Afshaan's call, 2026-09-02).

| # | Sub-project | Ships | Rationale for position |
|---|---|---|---|
| **1** | **Capture spine** — public write surface, shared field schema, response store, consent | Back-in-stock capture live on one PDP, hand-wired | Contains every risky unknown |
| 2 | Membership-by-event segments | Captures become an audience journeys can trigger on | Blocks everything downstream |
| 3 | Back-in-stock end to end | `stock_alert_outbox` → `back_in_stock` event → journey | Small; the signal already exists |
| 4 | Builder UI | Team authors a form without a developer | Generalises a proven pipe |
| 5 | Surveys — web render + in-conversation adapter | CSAT, and the `[pitstop][build][P1]` with it | Reuses 1–4; only delivery differs |

**Ordering is risk → value → self-serve** (Afshaan chose "pipe first, builder at 4"). Sub-project 1
designs the **field schema** even though the authoring UI arrives at 4 — that is what stops us hand-wiring
a shape the builder cannot later express.

**This spec covers sub-project 1 only.** Each of 2–5 gets its own spec.

⭐ **Sub-project 5 is worth its own note:** the `[pitstop] [build] [P1]` CSAT item is a survey, and is
specced to capture via the J1 `wait_response` quick-reply machinery — in-conversation, not a web page. The
in-conversation adapter is what makes that P1 closable, which is why it is in this decomposition at all.

## 3. Decisions taken (Afshaan, 2026-09-02)

| Decision | Choice | Note |
|---|---|---|
| Scope | Full form builder, surveys included | Not the narrow back-in-stock-only slice |
| Survey surface | Both web page and in-conversation, one builder, sequenced | Web first (shares ~90% with forms), then the adapter |
| Ordering | Pipe first, builder at sub-project 4 | |
| Abuse model | Turnstile + confirmed opt-in for marketing | See §6 |
| Notify channel | Email and WhatsApp both offered, **email default** | See the caveat below |
| Alert purpose | Semantics: suppression + quiet hours honoured, frequency cap bypassed | ⛔ Implemented by **reusing the existing `service` purpose**, not by adding one — see §6 |
| Sending posture | Capture never sends; a human activates a journey | See §7 |

⚠️ **Email-default carries a measurement caveat, recorded because it will be asked later.** LOT's email
engagement is negligible against WhatsApp — measured 2026-09-02, `link_clicked` events run **17,257
WhatsApp vs 234 email**, and there have been **0 `email_opened` events ever** (Resend open tracking is
unwired; it is what blocks A/B test residual ④). Afshaan chose email default anyway, deliberately, to keep
the capture barrier low. **Consequence: the notify must carry a tracked `/r/` link**, because a click is
the only read-signal we will have on the default channel.

## 4. The public surface

**A new `/f/*` namespace, NOT an extension of `/subscribe`.**

`/subscribe` (`commsops-worker/src/subscribe.js`, routed at `index.js:3033`) is `PIXEL_TOKEN`-authed and
sits under commsops' **global wildcard CORS** — `Access-Control-Allow-Origin: '*'` is set for all routes at
`index.js:39-41`. A public write surface must be origin-scoped. The bot's `/web/*` block already does this
correctly: `BW.corsHeaders(origin)` against `ALLOWED_ORIGINS` (`bot-web.js:7,11-12`), OPTIONS → 204, a
`withCors()` wrapper on every response. **`/f/*` sits beside `/web/*` and reuses that helper.**

`/subscribe` stays exactly as it is — it is live and wired — and is retired at sub-project 4, once the
builder can express a list-signup form. Do not modify it in this sub-project.

**Widget delivery mirrors the bot verbatim.** `GET /f/widget.js?form=<slug>` returns a self-contained IIFE:
inline styles, no framework, no external assets, `Content-Type: application/javascript`,
`Cache-Control: public, max-age=300` — the shape of `bot-widget.js:8-10`. One `<script>` tag per form,
configured by query param. LOT yellow `#F2CD1A` per the existing widget.

**Turnstile is verified server-side, before any write.** The widget renders the challenge; `POST /f/submit`
verifies the token against Cloudflare siteverify. A failed or absent token is a hard reject — **no profile,
no identifier, no consent, no submission row**. LOT is already on Cloudflare, so this adds no vendor.

**Rate limiting:** per-session flood check reusing `BW.floodCheck` (`bot-web.js:95-99`). Per-IP stays a
Cloudflare WAF rule — dashboard config, not code, and the same residual the bot already carries
(`bot-web.js:89`). Retain the `/subscribe` honeypot pattern (a `website` field) as a cheap second gate.

## 5. Data model

Two new tables. Both are greenfield — verified 2026-09-02, no `comms.form*` table exists.

**`comms.forms`** — the definition, hand-seeded in this sub-project, written by the builder at 4.

| Column | Notes |
|---|---|
| `id` uuid PK, `slug` text UNIQUE | `slug` is what the widget's query param names |
| `name`, `kind` | `kind` ∈ `form` \| `survey` — the seam sub-project 5 uses |
| `fields` jsonb | The shared field schema, below |
| `dedupe_keys` text[] | See the per-product note below |
| `destination` jsonb | Reserved. **Unused in this sub-project** — it is where sub-project 2 will name the segment a submission joins. Ship the column, write nothing to it, read nothing from it |
| `consent_copy` text, `consent_copy_version` int | Versioned because it is DPDP evidence |
| `active` bool | Whether the form ACCEPTS submissions. **Not a sending switch** — see §7 |

**`comms.form_submissions`** — one row per submission. **This is the shared response store surveys reuse
at sub-project 5.**

| Column | Notes |
|---|---|
| `id` uuid PK, `form_id`, `profile_id` | |
| `payload` jsonb | The answers |
| `source_url`, `submitted_at`, `ip_hash`, `turnstile_ok` | |
| `confirmed_at` timestamptz NULL | Where pending-ness lives — see §6 |

**The field schema, deliberately small:** `{key, label, type, required, options?}` with
`type ∈ text | email | tel | select | radio | checkbox | hidden`. Everything beyond this list is YAGNI
until a real form needs it. This is the one artifact sub-project 1 owes sub-project 4.

⚠️ **Dedupe must be per-product, not per-person.** The same customer legitimately submits the same
back-in-stock form for five different SKUs, so a `form:<slug>:<email>` idempotency key would silently
swallow four of them. `dedupe_keys` names the field keys that, together with identity, make a submission
distinct — `['product_code']` for back-in-stock.

**Identity reuses `ingest()`.** Its existing resolution already merges on identifier — 1,335 merges logged
as of 2026-09-02, roughly 25/day. Do not build a second resolver.

**New table checklist (both tables):** RLS enabled at creation, `GRANT ALL … TO service_role`, and
`NOTIFY pgrst, 'reload schema';` in the same migration — PostgREST caches the schema at start and a table
created afterwards is **invisible with no error** (CORE.md; cost a live debugging round in S239).

## 6. Consent

**Verified 2026-09-02: `comms.consent.state` holds `opted_in` / `opted_out` / `unknown`, with no CHECK
constraint — it is free text.** Adding a `pending` state would therefore mean auditing every reader of that
column to confirm it fails closed: real blast radius across the send gate, for a state only this feature
needs.

**So pending-ness lives in `comms.form_submissions.confirmed_at`, and a `comms.consent` row is written only
when consent actually exists.** `comms.consent` keeps meaning exactly what it means today — an append-only
log of real decisions. All writes go through the existing `recordConsent()` (`consent.js:60-77`), which
already carries the fail-closed `unknown` guard.

Two paths:

- **Back-in-stock** — one alert the customer explicitly asked for. Writes `opted_in` at capture,
  `source: 'website_form:<slug>'` (matching the existing vocabulary at `subscribe.js:81`), `evidence`
  carrying `{form_slug, source_url, submitted_at, turnstile_ok, ip_hash, consent_copy_version}`.
- **Marketing enrolment** — writes **no consent row at capture**. A confirmation goes to the email; the
  link sets `confirmed_at` and *then* writes `opted_in`, with evidence carrying both timestamps. **An
  unconfirmed submission never becomes a sendable audience.**

**Channel preference is captured HERE even though nothing sends until sub-project 3.** The form asks how
the customer wants to be told — email (default, pre-selected) and/or WhatsApp — and **one consent row is
written per channel actually chosen**, never a blanket row. `comms.identifiers` gets the phone only when
WhatsApp is chosen. ⚠️ **This is the easy thing to leave out of sub-project 1 and it would strand
sub-project 3 with no channel to send on**, since consent is per-channel and cannot be back-filled from a
submission that never asked. `/subscribe` already models this shape as a `channels[]` array
(`subscribe.js:22-46`) — follow it.

**Purpose: reuse the existing `service`. Do NOT add `product_alert`.**

⛔ **CORRECTED 2026-09-02, before any code was written.** This section originally specified a new
`product_alert` purpose, on the stated basis that "the live vocabulary is `marketing` and `transactional`
only". **That was measured from consent-row DATA, not from code, and it was wrong.** `src/purposes.js`
defines five — `marketing`, `influencer_outreach`, `service`, `utility`, `transactional` — and one of them
already has the exact semantics chosen here.

`service` (added S274), verbatim from `gate.js:181-183`: *"bypasses consent + frequency cap + send budget,
RESPECTS quiet hours and (like every purpose, without exception) suppression."* That is precisely
"honours hard suppression and quiet hours, bypasses the frequency cap". Its stated definition —
*"a message the CUSTOMER'S OWN action triggered, sent to the person who just interacted with us"*
(`gate.js:172-173`) — describes a requested back-in-stock alert exactly, and its canonical example is the
CSAT survey, i.e. sub-project 5 of this decomposition.

**So a back-in-stock notify sends with `purpose: 'service'`**, and the consent row we write is DPDP
evidence rather than a gate input. Adding a sixth purpose would duplicate `service` in a file whose own
header exists because purposes had already been got wrong once.

⚠️ **Two things an implementer must know about `service`:**
1. **It gets no opt-out withdrawal check.** The `2a` withdrawal block (`gate.js:225-233`) is gated on
   `isOutreach` only, so a customer who opted out of *marketing* still receives a `service` send. For an
   alert they explicitly asked for this is the behaviour we want — but it is inherited, not chosen, so do
   not assume a withdrawal protects here.
2. **`service` was never added to the test-send allow-list in `index.js`, so a `service` test send is
   coerced to `transactional` to this day** (documented in `purposes.js`, S274 residual, PATTERN-218).
   That will affect testing the notify at sub-project 3. Fix it there or file it; do not silently rely on
   test sends behaving like real ones.

⚠️ Per CORE.md's count-reconciliation rule, this correction is *itself* the product of grepping every
reader of `purpose` rather than trusting a measurement. Keep doing that.

## 7. Sending posture — capture never sends

Afshaan, 2026-09-02: *"Keep the sending intent for now. That sending path should be that somebody enables
it so that after that it starts sending. Basically, journeys will be able to send it."*

**The capture path writes rows and emits an event. It never sends, under any configuration.** Sending
happens only when a human activates a journey listening for that event, so **the journey activation IS the
enable** — one switch, in one place. `comms.forms.active` governs whether the form accepts submissions and
is deliberately not a sending control; two switches that can disagree is how a system starts lying about
whether it is live.

This is consistent with Relay's standing posture: internal-test-only, no real customer sends until Afshaan
signs off (CORE.md).

**On activation, do NOT fire retroactively for intents captured while sending was off.** Only stock flips
occurring after activation produce a send. A stale "back in stock!" for something that has since sold out
again is worse than silence.

⭐ **Reuse the existing machinery for this rather than inventing one:** `comms.journeys.refresh_trigger_on_send`
exists precisely because a trigger payload describing a **mutating** thing goes stale (it was added in S265
for the stale-cart bug). Stock is exactly such a thing, so the back-in-stock journey wants
`refresh_trigger_on_send = true` — re-resolve stock at send time and drop the send if it is out of stock
again. ⚠️ That column **must stay default `false` globally** — it is correct only for mutating triggers and
wrong on Order Placed / Cancelled / Shipment Update.

## 8. Scope boundary and testing

**Sub-project 1 deliberately does NOT:** create segments (sub-project 2 — blocked on the membership-by-event
kind; verified 2026-09-02 that the only `comms.segments` INSERT is the UI-authored, permission-gated
`saveSegment` at `index.js:1765`, and a static segment returns `not_dynamic` so it cannot drive a journey
trigger) · wire stock (3) · ship a builder UI (4) · render or deliver surveys (5).

**What it ships:** a back-in-stock form live on one PDP, where a real submission lands as a profile, an
identifier, a consent row and a `form_submissions` row — verified by query.

**Tests (TDD — write first):**

1. Absent or invalid Turnstile token → 403 and **zero rows written** across all four affected tables —
   `comms.profiles`, `comms.identifiers`, `comms.consent`, `comms.form_submissions`.
2. Honeypot field populated → accepted-looking response, zero rows across those same four tables.
3. Per-product dedupe: same identity + same `product_code` → one row; same identity + different
   `product_code` → two rows.
4. Marketing enrolment writes **no** `comms.consent` row before `confirmed_at` is set.
5. Confirmation link sets `confirmed_at` and writes exactly one `opted_in` row with both timestamps in
   `evidence`.
6. Origin not in `ALLOWED_ORIGINS` → CORS refusal, zero rows written.
7. An existing profile's email resolves to that profile rather than creating a second.

## 9. Open questions and deferred items

- **`/subscribe` overlap.** The live backlog item "`/subscribe` e2e + website form wiring" describes wiring
  each launch-list form by hand against `/subscribe`. That item is **superseded at sub-project 4**, not
  here. Until then both paths exist; do not delete `/subscribe`.
- **Per-IP rate limiting** is a Cloudflare WAF dashboard rule, not code — carried as a residual exactly as
  the bot builder carries it.
- **Which storefront forms exist today** has never been inventoried. Needed before sub-project 4 can claim
  to replace them; not needed for this sub-project.
- **Survey response attribution for the web adapter** (tokenised link → known profile) is sub-project 5's
  problem, but the `form_submissions.profile_id` column is nullable-ready for it.
