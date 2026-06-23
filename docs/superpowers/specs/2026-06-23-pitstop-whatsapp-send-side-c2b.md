# Pitstop — WhatsApp send-side via BiteSpeed (Phase C2-B) — build handover

> Status: **SCOPED — build-ready, awaiting BiteSpeed API token**
> Date: 2026-06-23 (Session 163) · Author: Afshaan + Claude
> Route chosen: **via BiteSpeed (Chatwoot Application API)** — fast path; BiteSpeed stays the WA transport (BSP). NOT direct WhatsApp Cloud API (that's the bigger "fully retire BiteSpeed" workstream, separate).
> Surface: `05_Throttle/csops-worker/src/index.js` + `apps/pitstop/src/app/(auth)/inbox/page.js`
> Why: complete the workflow layer so agents reply to WhatsApp **inside Pitstop** → then flip round-robin on for WA. Last lever before BiteSpeed is fully redundant.

---

## How it works
BiteSpeed is white-labeled Chatwoot, so "send" = the **Chatwoot Application API**:
```
POST https://chat.bitespeed.co/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages
Header: api_access_token: <token>
Body:   { "content": "<reply text>", "message_type": "outgoing" }
```
Chatwoot/BiteSpeed then delivers it to the customer over the WABA. We never touch Meta directly.

## What already exists (verified S163)
- **`account_id`** = `cs_wa_threads.provider_account_id`; **`conversation_id`** = `cs_wa_threads.provider_thread_ref` — both captured per thread by the C2-A inbound webhook (`biteSpeedFindOrCreateThread`). No new capture needed.
- **`sendWaMessage(body, auth, env)`** is ~90% built (`csops-worker/src/index.js`): gate `cs_ticket_manage`; validates `kind` (text/template/image/video/audio/document); resolves the thread (currently **ticket-keyed** via `findOrCreateWaThread(customer_phone)`); enforces the 24h window (free-text rejected outside window → template required); resolves `cs_wa_templates` body with `{{N}}` substitution. It then **stops short of sending** — inserts the `cs_wa_messages` row as `status:'queued'` + `status_error = WA_PROVIDER_NOT_WIRED_ERROR`. Dispatch case already wired (`case 'sendWaMessage'`).
- **Templates catalog** (`cs_wa_templates`) + `/admin/wa-templates` admin already exist.
- **Inbox** (`inbox/page.js`): WhatsApp is `sendable:false` in the `CHANNELS` map → composer replaced with a "Reply in BiteSpeed" deep-link. IG/FB reply via `sendMetaMessage(thread_id)`.

## THE BLOCKER (do this first, at office)
**Confirm BiteSpeed exposes the Chatwoot Application API and issue an `api_access_token`** (BiteSpeed → Profile Settings → Access Token). Some BSP plans lock this down — this is the only real unknown. The token must belong to an agent/bot user with access to the WA inbox.
- Set it as a csops secret: `cd 05_Throttle/csops-worker && npx wrangler secret put BITESPEED_API_TOKEN`.
- `account_id`/`conversation_id` already captured. `inbox_id` is **only** needed to *start* brand-new conversations (out-of-window template to a customer with no open Chatwoot conv) — NOT needed for replying. Capture it later if/when template-initiated sends are built.

## Build steps

### Worker (`csops`)
1. **Real send** — in `sendWaMessage`, after the window check + body resolution, POST to the Chatwoot endpoint above using `env.BITESPEED_API_TOKEN`, `thread.provider_account_id`, `thread.provider_thread_ref`. On `res.ok`: insert the `cs_wa_messages` row with `status:'sent'`, `provider_message_id = <returned message id>`, **no** `status_error`. On failure: keep `status:'failed'` + `status_error` = the API error; return it.
2. **Idempotency** — insert with the **returned Chatwoot message id** as `provider_message_id`. Chatwoot fires a `message_created` webhook for our own outgoing message; `biteSpeedMessageCreated` already dedupes on `provider_message_id` (UNIQUE), so the echo is a no-op. (Race-safe: the UNIQUE constraint wins either order.)
3. **Thread-keyed entry** — accept `thread_id` (the inbox is thread-keyed; a WA thread may have no linked ticket). Keep the legacy `ticket_id`→phone path for the old WhatsAppPanel. Resolve thread by `thread_id` when provided, else by ticket phone.
4. **⚠️ CRITICAL — stamp the 24h window on WA inbound.** `biteSpeedMessageCreated` does **not** set `cs_wa_threads.customer_window_until` (only the Meta path does), so `withinCustomerWindow(thread)` is always false for WA → `sendWaMessage` would block **every** free-form reply. Fix: on each **inbound** WA message, patch the thread `customer_window_until = now + 24h` (mirror `metaHandleMessage` line ~3271 / the meta inbound patch). Without this, send never works.
5. **Gate inert** — if `!env.BITESPEED_API_TOKEN`, return `{ ok:true, skipped:'bitespeed_not_configured' }` / a clear 503, exactly like the Meta `meta_not_configured` pattern, so it ships safe before the token is set.

### Inbox (`apps/pitstop/src/app/(auth)/inbox/page.js`)
6. Flip WhatsApp `sendable: true` in `CHANNELS`. In `send()`, branch by `convo.thread.channel`: WhatsApp → `csopsPost('sendWaMessage', { thread_id, kind:'text', body:text })`; IG/FB → existing `sendMetaMessage`. Notes/emoji/canned already work channel-agnostically. Keep the "Open in BiteSpeed" link as a secondary escape hatch. The window pill starts working once step 4 lands.

### Then
7. Flip `cs_routing_config.whatsapp.auto_assign_enabled = true` (admin → `/admin/shifts` routing card, or SQL). Round-robin then routes **new** WA inbound only — the ~4,767 historical threads stay claimable, never bulk-assigned.

## Fast-follow (defer — fiddlier)
- **Out-of-window template send** via the API — Chatwoot's template-send payload is more involved (`content_type`/`content_attributes` or BiteSpeed's own template route); confirm BiteSpeed's exact shape. Within-window free-form covers most replies, so v1 can ship without it (out-of-window → keep the BiteSpeed deep-link).
- **WA attachment send** (multipart upload to Chatwoot, then attach) — mirrors `sendMetaAttachment`.

## Open question to settle at build
- Is **out-of-window template send** needed for v1, or is within-window free-form enough to start? (Recommend: free-form v1, templates fast-follow.)

## Gotchas
- Double-record → handled by `provider_message_id` UNIQUE (step 2).
- 24h window MUST be tracked for WA (step 4) or all sends block.
- WhatsApp has **no double-capture** concern (BiteSpeed is the only WA path) — unlike IG, which double-captures via BiteSpeed + direct Meta.
- BiteSpeed API availability is the gating unknown — confirm before building the send call (everything else can be built inert meanwhile).

## Files / anchors
- `csops-worker/src/index.js`: `sendWaMessage` (the stub), `biteSpeedMessageCreated` (add window stamp), `findOrCreateWaThread`, `withinCustomerWindow`, dispatch `case 'sendWaMessage'`.
- `apps/pitstop/src/app/(auth)/inbox/page.js`: `CHANNELS` map, `send()`.
- Deploy: `cd 05_Throttle/csops-worker && npx wrangler deploy` (Pitstop-only blast radius). App auto-deploys on push.
