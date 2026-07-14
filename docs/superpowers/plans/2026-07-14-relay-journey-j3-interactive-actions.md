# Relay Journey J3 — interactive send + reply-branch + action nodes

> Phase J3 of the journey-authoring program (design spec §3 palette, §4.6).
> Decision (Afshaan, S212): **build all of J3 now, INERT** behind TEST MODE + config
> gates (same posture as the M14 WA adapter). **Payment = Shopflo, NOT Razorpay**
> (Razorpay is the retired path; LOT's checkout is Shopflo).

## The Shopflo reality (reshapes the payment node)
Shopflo exposes **no documented outbound API** — it's why the abandoned-cart webhook
(`shopflo-webhooks.js`) is in *discovery mode*. There is no Shopflo API integration in the
fleet. So the **payment / COD-conversion action is discovery-gated**: we don't yet know if
Shopflo mints a payment link via API, or whether conversion is driven by Shopflo's own Shop
Pass and Relay merely links/triggers it. → Build the payment node as an **inert Shopflo
seam** (`shopflo_not_configured` until confirmed), authorable but not live. Likely final
shape: `action:payment_link` mints/sends a Shopflo pay link; the **`paid` signal arrives via
the existing Shopflo webhook** ("payment-initiated"/"order-completed") → `/ingest` → the J1
matcher (so `paid`/`failed` can even be a `wait_response`, not adapter polling). Confirm once
the S212 webhook discovery (Afshaan's Test) lands.

## Node model — extend the generalized handle system (J0)
Handles become **dynamic per step** (interactive buttons are data), so add
`handlesFor(step)` to `journey-graph.js` (shared by compile + interpreter + canvas):
- `send` (plain) → `['next']` (unchanged); `send` + `interactive` → `[<btn.id>…, 'no_reply']`.
- `action` by kind: `payment_link`→`['paid','failed']` · `order_modify`/`order_cancel`→`['done','not_done']` · `set_attr`→`['next']`.
- existing: `wait`/`wait_response`/`condition`/`exit` unchanged. `stepTargets` routes through `handlesFor`.

## Interpreter (`journey-workflow.js`) — new step handling (all replay-safe step.do names)
- **Interactive send** (`send` with `interactive`): `#doSend` (interactive content) → park on
  the button-reply event (reuse the J1 `wait_response` parking machinery + `enrolment_waits`)
  → route to the tapped button's handle, or `no_reply` on `within` timeout. Inert: WA adapter
  refuses interactive unless live (WS-B) → send skips → `no_reply`.
- **`action`** step type, dispatch by `kind`:
  - `set_attr` — REAL: PATCH `comms.profiles.attributes` (merge). → `next`.
  - `order_modify` / `order_cancel` — Shopify Admin API (already wired via `shopify.js`
    `getShopifyToken`) GraphQL mutation. Inert-safe: no order id / not-configured → `not_done`.
  - `payment_link` — INERT Shopflo seam (`src/adapters/shopflo.js` stub → `shopflo_not_configured`)
    → `failed` until Shopflo confirmed. Never throws.
- Every action logs an `enrolment_steps` row `{kind, outcome}` → per-branch funnel counts (J2).

## Compile (`journeys.js` `compile()`)
Accept `action` + interactive `send`; validate each declared outcome handle resolves via
`handlesFor`; keep cycle / reserved-id / unknown-type / dangling-target checks. Reject an
interactive send with zero buttons.

## Canvas (`apps/relay/.../journey-canvas/*` + `journeys/page.js`)
- Palette + nodes: Interactive send, Action (kind picker), keep existing. Per-kind outcome
  handles rendered from the app-side `HANDLES`/`handlesFor` mirror (graph.js).
- NodeDrawer configs: interactive buttons editor (id/label, ≤3 WA limit); action kind +
  per-kind fields (set_attr: attr/value; order_*: which op; payment_link: Shopflo note +
  "not live yet" badge). "Channels/actions without a live backend" show an inert badge.

## Inert / safety
TEST MODE ON throughout; WA not live (interactive skips → no_reply); Shopflo payment seam
returns not_configured; order actions no-op without an order id. Zero customer effect.
Build once — no schema surgery for future node types (handles are data).

## Verify
- Node tests: `handlesFor` (interactive/action kinds), compile accepts+rejects, action
  routing (set_attr merge, inert payment→failed, order no-id→not_done), interactive→no_reply.
- Bundle dry-run; build relay; worker tests green. Browser smoke (canvas) = Afshaan.

## Build order (stages)
1. `journey-graph.js` handlesFor + HANDLES + tests.  2. interpreter action + interactive.
3. compile updates + tests.  4. shopflo adapter seam + Shopify order mutation.
5. canvas palette/nodes/drawer.  6. build + deploy + doc/knowledge update.
