# Relay — Link Tracking + UTM Sub-tool (Phase-A: UTM tagging + email click capture)

> Design spec. Status: approved for planning. Author: Afshaan + Claude. Date: 2026-07-01.
> System: Relay (`commsops` worker + `comms` schema). See `systems/relay.md`, PRD `2026-06-25-relay-foundation-design.md`.

## Context & goal

Relay sends outbound customer email (SMS/WhatsApp later). Two capabilities are missing:

1. **Attribution** — when a Relay email drives a website visit, GA4 has no way to attribute it to Relay, so the visit shows as "direct"/untagged. This breaks the **Relay-send → GA4 → Odo** attribution loop that is the Odo control-plane vision. Odo's `/funnel` already keys GA4 traffic **by source**, so a consistent `utm_source` makes Relay traffic first-class there.
2. **Clicks as substrate events** — a link click is a first-class customer signal that should live in `comms.events` so segments/journeys/analytics can key off it. Today Resend's `email.clicked` webhook is handled but the clicked URL is dropped and clicks are collapsed to one-per-message.

This spec covers **Phase A only**: UTM tagging on outbound email + capturing clicks as `link_clicked` events. It deliberately does **not** build the first-party click-redirect wrapper (`/r/<code>` route, `comms.links` table, render-time URL shortening, short domain) — that is **Phase B**, needed only by SMS/WhatsApp (no ESP wraps links there) and built alongside SMS Phase 2. Email needs no redirect because Resend does native click tracking.

## Scope

**In scope (Phase A):**
- Append `utm_*` params to LOT-owned destination URLs in outbound **marketing** email at send time.
- Emit a channel-agnostic `link_clicked` event (carrying the clicked URL) from Resend's `email.clicked` webhook.

**Out of scope (Phase B — deferred to SMS):**
- First-party click redirect (`/r/<code>`), `comms.links` table, per-recipient codes, render-time URL wrapping/shortening, short-domain registration.
- SMS/WhatsApp click capture (will emit the same `link_clicked` event name via the Phase-B redirect).

## Approach

UTM tagging happens **at send time in the worker** (chosen over template-author-managed UTM, which is inconsistent and error-prone). A new isolated pure module rewrites the rendered body; `send.js` composes it after `renderEmail`, keeping it channel-agnostic and unit-testable.

## Components

### 1. `src/tracking.js` (NEW — pure, no I/O)

The isolated UTM-tagging unit. No DB, no network — pure string/URL functions, fully unit-testable.

**Exports:**
- `appendUtm(url, params)` → string. Parses `url`; if its host is LOT-owned and it does **not** already carry any `utm_*` param, appends the provided `utm_*` params (preserving existing query/fragment); otherwise returns `url` unchanged. Malformed/relative/non-http(s) URLs returned unchanged.
- `tagLinks(body, { params, skip })` → string. Rewrites every `href="..."`/`href='...'` in an HTML body (and bare URLs in a text body) through `appendUtm`. `skip` is a set of exact URLs to leave alone (the `unsubscribe_url`). Applies to both HTML and text forms.
- `LOT_HOSTS` — module constant: the allowlist of LOT-owned hosts. v1 = `legendoftoys.com` (+ subdomains) and the Shopify store domain `ed7e3f-cf.myshopify.com`. Host match is suffix-based (`host === h || host.endsWith('.'+h)`). Extend here if new owned domains appear (follows the `LUMP_SUM_PARTS` hardcoded-set precedent).

**Rules baked in:**
- **LOT hosts only** — third-party links (e.g. a partner URL) are never tagged.
- **Idempotent** — a URL that already has `utm_*` is left as-is (never double-tagged).
- **Unsubscribe skipped** — the `unsubscribe_url` is always in `skip`.

### 2. Send-context threading (`send.js` + callers)

`send()` gains an optional `tracking: { campaign?, content? }` opt.

- After `renderEmail` succeeds and **only when `purpose === 'marketing'`**, `send.js` builds `params = { utm_source:'relay', utm_medium: channel, utm_campaign: tracking.campaign, utm_content: tracking.content }` (dropping undefined keys) and runs `tagLinks` over the rendered `html` and `text`, with `skip = {unsubscribe_url}`.
- `utm_source` is always `relay`; `utm_medium` is the channel (`email` now).
- `utm_campaign` comes from `tracking.campaign` (absent → omitted).
- `utm_content` **defaults to the loaded template's `name`** — `send.js` already fetches the template row, so callers need not supply it; `tracking.content` may override.
- Transactional/utility sends: no UTM tagging (keeps campaign attribution clean).

**Callers populate `tracking.campaign` (content auto-derives from the template):**
- `campaigns.js` (broadcast fan-out) → `{ campaign: <campaign name> }`.
- `journey-workflow.js` `#doSend` → `{ campaign: <journey name> }` (the journey name is loaded in a workflow step — extend `load-definition` to also select the parent `journeys.name`, or add it to `load-enrolment`).
- `sendTest` → `{}` (no campaign; content still auto-derives).

Values are used verbatim as UTM values (URL-encoded by `appendUtm`); no slugification in v1 (GA4 handles spaces). Revisit if reports get noisy.

### 3. `link_clicked` event (`adapters/email.js` + `webhooks.js` + migration `0012`)

**`adapters/email.js` `parseStatusWebhook`:**
- Extract the clicked link from Resend's `email.clicked` payload (`data.click.link`), exposed as `clicked_url`.
- `EVENT_MAP['email.clicked']` → `link_clicked` (renamed from `email_clicked`; the message row's canonical status stays `clicked`, so message-level "was clicked" is still captured on `messages`).

**`webhooks.js` `handleResendWebhook`:**
- When the engagement event is `link_clicked`, write the `comms.events` row with enriched `properties: { url: clicked_url, channel: msg.channel, provider_message_id, message_id: msg.id }`.
- Idempotency key → `resend:clicked:<pmid>:<clicked_url>:<at>` (distinct link-clicks recorded; exact webhook retries deduped). Other event types keep their existing `resend:<type>:<pmid>` key.

**Migration `0012_comms_link_clicked_event.sql`:**
- `INSERT INTO comms.event_definitions (name, description, expected_props) VALUES ('link_clicked', ...) ON CONFLICT DO NOTHING`.
- `email_clicked` definition left in place (harmless; no new emitter). Existence-guarded / idempotent, matching prior seed migrations.

## Data flow

```
Broadcast/journey send
  → send() [purpose=marketing]
    → renderEmail() → {html,text}
    → tracking.js tagLinks(html/text, utm params, skip=unsubscribe)   ← UTM added to LOT links
    → gate → Resend adapter → messages row
Customer clicks a link in the email
  → Resend fires email.clicked  → POST /webhooks/resend (svix-verified)
    → parseStatusWebhook → {status:clicked, event:link_clicked, clicked_url}
    → messages.status='clicked'
    → comms.events {name:link_clicked, properties:{url,channel,message_id,...}}   ← substrate event
Landing session in GA4 carries utm_source=relay → Odo /funnel by-source → attribution loop closed
```

## Edge cases

- **No LOT links in body** — `tagLinks` is a no-op; send proceeds normally.
- **URL already has `utm_*`** — left unchanged (author intent wins; no double-tag).
- **Relative / `mailto:` / `tel:` / malformed href** — `appendUtm` returns it unchanged.
- **Missing `tracking`** — source+medium still applied; campaign/content omitted.
- **`email.clicked` with no `data.click.link`** — no `link_clicked` event written (guard on presence); message status may still update.
- **Repeated clicks / multiple links** — each distinct `(pmid,url,timestamp)` yields its own event; exact retries dedupe.
- **Non-marketing purpose** — never UTM-tagged.

## Testing

- **Node unit tests (pure `tracking.js`):** LOT-host tagging; third-party untouched; unsubscribe skipped; already-utm'd untouched; relative/mailto untouched; existing query/fragment preserved; text-body URL tagging; all four utm params present; missing campaign/content → omitted.
- **`wrangler deploy --dry-run`** — bundle clean.
- **Live (inside TEST MODE):** test-send a marketing template with a `legendoftoys.com` link to internal staff → inspect the received email's link carries `utm_source=relay&utm_medium=email&utm_campaign=...&utm_content=...`; click it → confirm a `link_clicked` event lands in `comms.events` with the URL + message linkage.

## Files touched

- NEW `src/tracking.js` (pure UTM module)
- `src/send.js` (apply tagging post-render for marketing)
- `src/campaigns.js`, `src/journey-workflow.js` (populate `tracking`)
- `src/adapters/email.js` (`parseStatusWebhook` → clicked_url + `link_clicked`)
- `src/webhooks.js` (write enriched `link_clicked` event + idempotency key)
- NEW migration `migrations/0012_comms_link_clicked_event.sql`
- Docs: `systems/relay.md`, BACKLOG `[relay]`

## Deployment & risk

- Deploy: `cd 05_Throttle/commsops-worker && npx wrangler deploy` (single worker, own blast radius = Relay only).
- All new behaviour is inert on customers: sends remain behind TEST MODE; the only journey is draft. UTM tagging only alters link query strings on LOT-owned URLs (harmless to the destination). No schema change beyond an additive event definition.
