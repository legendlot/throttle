# Relay Journey-Rebuild Track — Inventory (BiteSpeed exit)

> 2026-07-15. Maps BiteSpeed's 10 live journeys (reference/bitespeed.md §5) onto Relay's
> engine + current event/channel coverage, so we can rebuild + validate them in Relay
> BEFORE any live-number cutover (breaking the "lose the journeys to test them" catch-22 —
> the engine + WA adapter are already proven; the sandbox validates the full trigger→send→
> deliver path to internal phones while BiteSpeed keeps running untouched).

## Ground truth (2026-07-15)

**Events actually ingested to `comms.events`** (name · source · ~volume · live?):
- `order_placed` · shopify_webhook · 2,368 · ✅ (carries `financial_status`)
- `order_fulfilled` · shopify_webhook · 2,105 · ✅ (= fulfillment *created*, NOT delivered)
- `order_cancelled` · shopify_webhook · 535 · ✅
- `checkout_started` · shopify_pixel + shopify_webhook · 5,426 · ✅
- `add_to_cart` · shopify_pixel · 18,065 · ✅
- `checkout_abandoned` · shopflo · 62 · ✅ (the new Shopflo seam)
- `whatsapp_inbound` · whatsapp_webhook · 1 (sandbox test only)
- `email_*` engagement · resend · S187 test only
- **NOT flowing:** any Shiprocket event, `order_delivered`, popup-optin, `shopflo_order_completed`, Shopflo `add_to_cart`.

**Channels with a Relay adapter:** email (Resend, live) · WhatsApp (Cloud API, sandbox-proven). **NOT built:** Web Push, SMS, RCS.

**Engine capability (J0/J1/J2, live):** event trigger (+ equality `filter`) · `wait` (duration) · `condition` (event/attr since-enrol) · `send` (per-step channel + template) · `wait_response` · **ambient `exit_rules` (exit-on-event is first-class now)** · `max_duration` · `on_skip`. **Gaps:** no **segment-entry trigger**; `filter` is equality-only (set-membership needs 2 journeys or a condition step); non-event triggers (popup) not modelled.

## The 10 journeys → verdict

| # | BiteSpeed journey | Trigger (+filter) | Trigger in Relay? | Channel | Wait/Exit | **Verdict** |
|---|---|---|---|---|---|---|
| 7 | **Review** | `FULFILLMENT_CREATED`, exit `ORDER_CANCELLED` | ✅ `order_fulfilled` + exit `order_cancelled` | WA | wait 60m ✅ + exit ✅ | **BUILDABLE NOW** |
| 9 | **Shipment Update** | `FULFILLMENT_CREATED` | ✅ `order_fulfilled` | WA | — | **BUILDABLE NOW** |
| 10 | **Order Placed** | `ORDER_PLACED` where pay∈{paid,authorized} | ✅ `order_placed` (filter on `financial_status`) | WA + Web Push | — | **WA leg NOW**; push leg needs the channel |
| — | *(new) Abandoned Cart* | Shopflo `checkout_abandoned` | ✅ live (62) | WA/email | wait/verify | **BUILDABLE NOW** (not a BiteSpeed journey — our new seam) |
| 3 | **Delivered WA** | `FULFILLMENT_DELIVERED` | ❌ no delivered feed | WA | — | **NEEDS FEED** (Shiprocket delivered) |
| 4 | **RTO – Delivered** | `SHIPROCKET_..._RTO_DELIVERED` | ❌ | WA | — | **NEEDS FEED** (Shiprocket RTO) |
| 5 | **RTO – Out for Delivery** | `SHIPROCKET_..._RTO_OUT_FOR_DELIVERY` | ❌ | WA | — | **NEEDS FEED** (Shiprocket RTO) |
| 6 | **RTO picked up** | `SHIPROCKET_..._RTO_IN_TRANSIT` | ❌ | WA | — | **NEEDS FEED** (Shiprocket RTO) |
| 2 | **Winback WA** | segment-entry `winback90` | ⚠️ no segment-entry trigger | WA | — | **NEEDS ENGINE FEATURE** (segment-entry trigger, or scheduled segment enrolment) |
| 8 | **Cod to prepaid** | `ORDER_PLACED` where COD | ⚠️ cleanest via `shopflo_order_completed` (payment_mode=COD, pending routing) | WA (interactive) | — | **= J3, Cashfree-gated** (pay-link + reconciliation) |
| 1 | **Welcome (web push)** | `POPUP_OPTIN` | ❌ no popup feed | Web Push | — | **NEEDS FEED + CHANNEL** (lowest priority / drop candidate) |

## Buckets

- **A — Buildable now (trigger + channel + engine all present):** Review, Shipment Update, Order Placed (WA leg), + the new Shopflo Abandoned Cart. → rebuild as **draft/inert** journeys, validate on the sandbox to internal phones.
- **B — Needs an upstream feed (Shiprocket → `/ingest`):** Delivered + RTO×3 (and a more-accurate Shipment/Delivered split). One integration unlocks 4 journeys. Biggest single lever.
- **C — Needs a channel:** Web Push (Welcome, Order Placed push leg); SMS/RCS if any. Decide rebuild vs drop-at-cutover.
- **D — Needs an engine feature:** segment-entry trigger (Winback) — or reframe as a `*/N` cron that enrols a materialized segment (cheaper; the segment `winback90` = attr `last_order_at < now-90d`, expressible today).
- **E — J3 / Cashfree-gated:** Cod to prepaid (already tracked — pay-link=Cashfree, reconciliation crux).

## Cross-cutting dependencies

1. **Template catalog (blocks the WA *send* of every A/B journey).** Each BiteSpeed WA send uses an approved template with positional `{{1}}` vars; Relay uses named-slot templates on our WABA. So each journey's template must be re-authored/approved on our WABA and bound in the journey. **Gated on granting the live WABA to the "relay wa bot" system user** (then I can pull the catalog via Graph). Journey *structure* can be built now (inert); template binding follows.
2. **Sandbox validation** — each A-bucket journey can be proven end-to-end (trigger event → wait → WA send → delivery) on the +1 555 sandbox to ≤5 internal phones, TEST-MODE-allowlisted. This is also the WhatsApp internal test.
3. **`shopflo_order_completed` routing** — confirm Shopflo actually routes it to us (COD trigger for J8; not observed live yet).

## Recommended build order

1. **A-bucket structures now** (inert/draft): Review, Shipment Update, Order Placed (WA), Abandoned Cart — engine is proven, events are live. Zero risk (draft journeys don't enrol; TEST MODE holds).
2. **Shiprocket feed** (B) — a `/ingest` producer for delivered + RTO events → unlocks 4 journeys at once. Scope its auth/events next.
3. **Template catalog** once the WABA is granted → bind + sandbox-validate the A-bucket.
4. **Decide C + D scope** (Web Push rebuild vs drop; Winback via cron-segment vs new trigger).
5. **E (COD)** follows Cashfree enablement.

**Cutover per number = its journeys pre-built + validated + activated in one window; rollback = re-register to the BSP (BiteSpeed journeys resume).** Support number additionally needs the inbound bot decision (separate, biggest long pole — rebuild vs human-only).
