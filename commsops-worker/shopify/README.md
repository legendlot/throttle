# Relay M4 — Shopify live sync (webhooks + Web Pixel)

The customer backfill shipped S187. This is the **live-sync** layer that keeps the
`comms` substrate current and feeds the abandoned-cart journey. All of it stays inert
behind the **TEST MODE** send lock — it only writes substrate data, never sends.

## Pieces

| Piece | Where | Purpose |
|---|---|---|
| `POST /webhooks/shopify` | `src/shopify-webhooks.js` `handleShopifyWebhook` | HMAC-verified backend events: customers, orders, abandoned checkouts → `/ingest` |
| `POST /pixel` | `src/shopify-webhooks.js` `handlePixel` | Storefront `add_to_cart` / `checkout_started` from the Web Pixel |
| `shopifyRegisterWebhooks` / `shopifyListWebhooks` | `src/index.js` (super-admin POST) | Idempotent webhook subscription management |
| `web-pixel.js` | `shopify/` | The custom-pixel JS to paste into Shopify admin |

Mappers (pure, in `src/shopify.js`): `mapCustomerRest`, `mapOrderEvent`, `mapCheckoutEvent`,
`verifyWebhookHmac`, `registerWebhooks`, `listWebhooks`.

## Registered webhook topics
`customers/create`, `customers/update`, `orders/create` (→ `order_placed`),
`orders/fulfilled` (→ `order_fulfilled`), `orders/cancelled` (→ `order_cancelled`),
`checkouts/create` + `checkouts/update` (→ `checkout_started`).
> `orders/paid` is intentionally NOT subscribed — it would double-count `order_placed`
> (which bumps `lifetime_orders`/`lifetime_value` in `deriveAttributes`).

GDPR topics (`customers/redact`, `customers/data_request`, `shop/redact`) are handled if
received (redact → suppress the contact's channels); register them in the Partner/app
config, not via the API.

## Idempotency
- Customers → `comms.shopify_apply_customers` (identifiers dedup on `(type,value)`; consent
  dedup on the 6-tuple). Re-delivery is a no-op.
- Orders → `idempotency_key = shopify:<event>:<order_id>:<updated_at>`.
- Checkouts → `idempotency_key = shopify:checkout_started:<checkout_token>` — the SAME key
  the Web Pixel uses, so the pixel and the webhook **dedup against each other** for one
  checkout. Repeated `checkouts/update` deliveries collapse to one event.

## Setup (one-time, needs Afshaan)

1. **Secrets on commsops** (`cd 05_Throttle/commsops-worker`):
   - `SHOPIFY_WEBHOOK_SECRET` — already set (the app's client/API secret; verifies webhook HMAC).
   - `PIXEL_TOKEN` — a fresh low-value random string for the pixel:
     `openssl rand -hex 16 | npx wrangler secret put PIXEL_TOKEN`
2. **Register webhooks** — call the super-admin action once (Relay app or curl with a super-admin JWT):
   `POST {action:'shopifyRegisterWebhooks'}` → returns `{created, skipped, errors}`. Idempotent; re-run anytime.
   Verify with `{action:'shopifyListWebhooks'}`.
3. **Add the Web Pixel** — Shopify admin → Settings → Customer events → Add custom pixel →
   paste `web-pixel.js`, replace `__PIXEL_TOKEN__` with the `PIXEL_TOKEN` value → Save → Connect.
4. **Verify** (TEST MODE stays ON the whole time):
   - Place a test order → a `order_placed` event appears on that profile (`comms.events`).
   - Start a checkout → a `checkout_started` event appears (pixel and/or webhook, deduped).
   - Confirm a send to a real backfilled customer still returns `test_mode_blocked`.

## Trust model
`/webhooks/shopify` is HMAC-authenticated (Shopify-signed). `/pixel` is **low-trust** by
design — it runs client-side so it can't hold `INGEST_TOKEN`; it's guarded only by
`PIXEL_TOKEN` + a 2-event allowlist. A forged cart event's worst case is one spurious
abandoned-cart email, itself behind the send gate **and** TEST MODE. For production,
add a Cloudflare WAF rate-limit rule on `/pixel` (dashboard, not code).
