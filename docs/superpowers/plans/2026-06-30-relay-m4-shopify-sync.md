# Relay M4 — Shopify customer / consent / cart sync

> Sub-plan for BACKLOG [relay] M4. Authoritative design = PRD `2026-06-25-relay-foundation-design.md`
> §5.2–5.4 + §11 Phase-1. Current truth = `systems/relay.md`. Created S187 (2026-06-30).
> **Builds entirely behind the live TEST MODE lock** (`comms.settings.test_mode`, default ON) — every
> profile/consent row M4 creates is inert; no send can reach a real customer until a super-admin flips it off.

## Goal

Bring the real addressable audience into the `comms` substrate so segmentation + campaigns + the
abandoned-cart journey have real data to work on:
1. **Backfill** the **entire** Shopify customer base → `profiles` + `identifiers` + `consent` + attributes.
2. **Live webhooks** keep it current (customers, orders, checkouts).
3. **Web Pixel** emits storefront `add_to_cart` / `checkout_started` → makes the seeded abandoned-cart journey fire.

Afshaan (S187): load **all** customers (so segmentation logic + UI has the full base for meaningful sub-cuts);
phase the ingestion if one-shot is heavy. Backfill = customer records + order-**derived attributes**, not a
replay of historical order events (those flow forward via webhooks).

## Prerequisites (Afshaan provides — hard blockers)

- **Store domain** (e.g. `legendoftoys.myshopify.com`).
- **Custom app** in Shopify admin (Settings → Apps → Develop apps) with **Admin API access token**, scopes:
  `read_customers`, `read_orders` (+ `read_products` only if we enrich line items later). Token → commsops secret
  `SHOPIFY_ADMIN_TOKEN`.
- **API secret key** (the custom app's secret) → commsops secret `SHOPIFY_WEBHOOK_SECRET` (HMAC verification of webhooks).
- API version pinned (e.g. `2025-01`) → `SHOPIFY_API_VERSION` (or constant).
- Go-ahead to pull real PII (safe — inert behind TEST MODE).

## Architecture

All Shopify data enters through **one mapping module** → the existing `/ingest` + `resolve_identity` path, so
identity resolution, attribute derivation, and idempotency are reused unchanged.

### A. Mapping module — `commsops-worker/src/adapters/shopify.js`
Pure functions, no I/O, unit-testable:
- `customerToIngest(c)` → `{ identifiers:[…], name, properties, source:'shopify', idempotency_key }`
  - **identifiers:** `email` (lowercased), `phone` (E.164 — normalize Shopify's `phone`/default-address phone to `+91…`),
    `shopify_customer_id` (the strong key). Skip empties.
  - **name:** `first_name` (+ last for display elsewhere).
  - **properties (→ attributes):** `lifetime_orders` (orders_count), `total_spent`, `last_order_at`, `city`,
    `locale`, `tags[]`, `accepts_email_marketing`/`accepts_sms_marketing` (state mirror).
  - **idempotency_key:** `shopify:customer:<id>:<updated_at>`.
- `consentRowsFor(c)` → consent ledger rows: map `email_marketing_consent.state`
  (`subscribed`→`opted_in`, `unsubscribed`→`opted_out`, else `unknown`) for `(email, marketing)`; same for
  `sms_marketing_consent` → `(sms/whatsapp, marketing)`. `source='shopify_import'`, `captured_at` =
  the consent's `consent_updated_at` (original timestamp, per Phase-0). Transactional = `opted_in` (lawful basis: customer relationship).
- `orderToIngest(o)` / `checkoutToIngest(co)` → event envelopes (`order_placed`/`order_fulfilled`/`order_cancelled`/`checkout_started`)
  for the webhook path; `idempotency_key = shopify:<topic>:<id>:<updated_at>`.

> **Decision — `/ingest` does NOT write consent today.** It resolves identity + appends event + derives attributes.
> M4 needs consent written too. Cleanest: extend `/ingest` to accept an optional `consent:[…]` array and upsert
> ledger rows (append-only, dedup on `(profile,channel,purpose,state,source,captured_at)`), so the same seam serves
> backfill + webhooks + future callers. (Alt: a separate `recordConsent` bulk call — rejected, splits the seam.)

### B. Backfill — Shopify GraphQL **Bulk Operations** (best for "all customers")
REST cursor pagination (250/page) would be tens of thousands of calls. Shopify's **Bulk Operations API** runs one
async query server-side and returns a **JSONL** file URL — the right tool for a full export.
- New route/job `POST /admin/shopify/backfill` (relay_super_admin or internal token): kick a `bulkOperationRunQuery`
  over `customers { id email phone … emailMarketingConsent smsMarketingConsent numberOfOrders amountSpent … }`.
- Poll `currentBulkOperation` until `COMPLETED`; fetch the JSONL `url`.
- **Phased consumption (resumable):** stream JSONL → batch N customers/chunk → for each: `resolve_identity` +
  consent upsert + attribute merge. Drive batches via the existing `commsops-broadcast` Queue (new `kind:'shopify_backfill'`)
  or a cursor loop with a `connector_runs`-style progress row. Each chunk well under the 50-subrequest limit.
- **Idempotent + re-runnable:** identifiers dedup on `(type,value)`; consent dedup as above; attributes overwrite.
  Re-running the backfill is safe.
- **Dry-run first:** `?limit=5` (or a bulk query filtered to 5 ids) → write to comms → inspect mapping (identifiers,
  consent states, attributes) before the full run. This is also the **live proof the TEST MODE lock blocks a real
  customer address** (try a send to a backfilled customer → expect `test_mode_blocked`).

### C. Webhooks — `POST /webhooks/shopify`
- HMAC-SHA256 verify `X-Shopify-Hmac-Sha256` against `SHOPIFY_WEBHOOK_SECRET` (raw body), before JSON parse — like `/webhooks/resend`.
- Topic → mapping → `/ingest` (internal, idempotent). Topics: `customers/create`, `customers/update`,
  `customers/data_request`/`redact` (GDPR — log/handle), `orders/create`, `orders/paid`, `orders/fulfilled`,
  `orders/cancelled`, `checkouts/create`, `checkouts/update`.
- **Registration:** a one-time `registerWebhooks` admin action (idempotent — list existing, create missing) pointing
  topics at `https://commsops.afshaan.workers.dev/webhooks/shopify`.

### D. Web Pixel — storefront cart/checkout
- Storefront events (`product_added_to_cart`, `checkout_started`) run **client-side** → can't carry the secret
  `INGEST_TOKEN`. **Decision:** a dedicated **public** `POST /pixel` endpoint that (a) accepts ONLY the two cart
  event types, (b) validates the shop origin, (c) is rate-limited, (d) carries a low-value rotating `PIXEL_TOKEN`
  (not the ingest secret) — maps to the same `/ingest` internally. Documented as low-trust (a hostile caller could
  forge cart events; acceptable — worst case is a spurious abandoned-cart email, itself gated).
- Add a **Shopify Web Pixel** (custom pixel in admin, or app-embedded) posting to `/pixel`.
- **Deferred if cart is lower priority** — A+B+C deliver the addressable audience + order lifecycle; the pixel only
  feeds the abandoned-cart journey, which is itself draft behind the gate.

## Build order
1. `adapters/shopify.js` mapping + **unit tests** (pure functions — node-testable, like the test-mode logic).
2. Extend `/ingest` for the optional `consent[]` array (+ keep back-compat).
3. Backfill route + queue consumer; **dry-run 5** → eyeball → full phased run.
4. Webhook route + HMAC + registration action.
5. Web Pixel + `/pixel` endpoint (or defer).
6. Verify counts (`comms.profiles`/`identifiers`/`consent`) vs Shopify; spot-check 10 customers; confirm a send to a
   backfilled customer is `test_mode_blocked`.

## Safety / invariants
- **TEST MODE stays ON throughout** — no customer can be emailed. M4 only writes substrate data.
- All ingestion idempotent (idempotency_key + `(type,value)`/consent dedup) — webhooks + re-runs never double-count.
- Phone normalized to E.164 once, at the mapping boundary (identity resolution keys on it).
- PII: tokens are `wrangler secret put` only; no PII in logs; honor `customers/redact`.
- New secrets: `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, (`PIXEL_TOKEN` if pixel). Migration only if `/ingest`
  consent extension needs a dedup constraint.

## Open decisions for Afshaan
1. **Web Pixel now or defer?** (A+B+C = audience + lifecycle; pixel only feeds the draft abandoned-cart journey.)
2. **SMS/WhatsApp consent from Shopify** — store the `sms_marketing_consent` now as `(whatsapp, marketing)` for the
   future WA cutover, or only email for now? (Recommend: store it — it's free provenance.)
3. Multiple Shopify stores/markets, or one?
