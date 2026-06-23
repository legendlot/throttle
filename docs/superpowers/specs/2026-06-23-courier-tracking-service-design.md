# Courier Tracking Service (`courierops`) — V1 Design

> **Status:** design approved 2026-06-23 (S165). **Scope:** V1 = automated Delhivery tracking for
> outbound Depot dispatch shipments, with a full scan timeline + current stage surfaced to the floor
> (Depot) and read-only to sales (Snorkel). Polling-first; webhooks, Shiprocket and Pitstop/returns
> are explicitly deferred to V2.
>
> Supersedes the deferred "Phase I" stub in `2026-06-22-snorkel-depot-fulfilment-flow-design.md`.
> Research basis: `scratchpad/courier-tracking-integration-brief.md` (Delhivery + Shiprocket, June 2026).

## 1. Goal & motivation

The fulfilment flow (S162/S164) gave each dispatch shipment manual tracking fields (`courier_partner`,
`tracking_number`, `tracking_link`, `expected_delivery_date`, `delivery_date` — entered by hand in the
Depot Shipments drawer, E3/S165). This service makes that tracking **automatic and live**: it pulls the
courier's scan history by AWB, normalizes it, and keeps each shipment's stage, expected-delivery and
delivered dates, and **full checkpoint timeline** fresh — so the floor team sees the latest courier update
as of that moment without leaving Depot, and the actual delivery date auto-starts the Snorkel payment-due
clock.

V1 is **Delhivery only** (the only courier in use, production token in hand) and **forward shipments only**.
The design keeps the courier logic behind a courier-agnostic interface so Shiprocket and Pitstop/returns
are additive later, not a rewrite.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Couriers in V1 | **Delhivery only**, production token ready (Shiprocket later, same interface) |
| 2 | Where it lives | **New worker `courierops`** (`05_Throttle/courierops-worker/`), `service_role`, own deploy + cron. Keeps lotopsproxy (Garage+Redline+Scanner) untouched; matches the one-worker-per-system isolation pattern |
| 3 | V1 coverage | **Forward dispatch shipments only** (`public.dispatch_shipments` with an AWB). Returns deferred |
| 4 | Storage | **Write back onto `public.dispatch_shipments`** (new normalized cols + checkpoints jsonb). No new tables, no joins; consumers light up with zero changes |
| 5 | Mechanism | **Polling-first** (cron). Webhooks deferred to V2 (Delhivery SPOC enablement, ~5–6 day lead) |
| 6 | Courier identity | E3 courier field becomes a **known-set dropdown** (Delhivery / Shiprocket / Other→free-text) writing a canonical string, so the poller targets `courier_partner = 'Delhivery'` deterministically |
| 7 | Timeline | Capture the **full `Scans[]` timeline** (`verbose=2`) + current stage; render a vertical timeline in Depot (and read-only in Snorkel) |

## 3. Architecture

```
courierops (new Cloudflare worker, service_role on the LOT Supabase project)
├── scheduled() cron handler         ← the V1 driver
├── adapters/delhivery.js            ← trackBulk(awbs[]) → TrackResult[]  (pure, courier-specific)
├── normalize.js                     ← TrackResult shape + normalized stage enum (courier-agnostic core)
└── db.js                            ← service-role Supabase helpers + the apply RPC call
```

- **Headless in V1.** No inbound browser calls, no JWT, no CORS. courierops only runs on its cron and
  writes to the DB. Depot and Snorkel keep reading `dispatch_shipments` through lotopsproxy/snorkelops
  exactly as today — the new columns simply start populating.
- **The reusable core is `normalize.js` + the adapter contract**, not a generic storage table. Adding a
  courier = one new `adapters/<courier>.js` that returns the shared `TrackResult`; no consumer changes.
- **Secrets** (via `wrangler secret put`): `DELHIVERY_API_TOKEN` (production), `SUPABASE_SERVICE_KEY`.
  Delhivery auth header is the literal `Authorization: Token <token>` (NOT `Bearer`). The staging token +
  webhook secret are V2.

### 3.1 Normalized interface

```ts
type CourierStage =
  | "manifested" | "in_transit" | "out_for_delivery" | "delivered"
  | "undelivered" | "rto_in_transit" | "rto_delivered" | "cancelled" | "lost" | "unknown";

interface Checkpoint {
  timestamp: string;      // ISO-8601 UTC (normalized from Delhivery IST)
  stage: CourierStage;    // normalized stage for this scan
  label: string;          // courier's own scan text, preserved
  status_code: string;    // raw courier code (Delhivery StatusCode / NSL) — preserved, never whitelisted
  location: string | null;
  description: string | null;
}

interface TrackResult {
  courier: "delhivery";
  awb: string;
  stage: CourierStage;                    // current normalized stage
  stage_label: string;                    // current courier status text (for display)
  expected_delivery_date: string | null;  // EDD, ISO date
  delivered_at: string | null;            // ISO-8601 UTC, set only when terminal-delivered (EOD-38)
  checkpoints: Checkpoint[];              // full timeline, newest-first
  fetched_at: string;                     // ISO-8601 UTC
}
```

## 4. Data model — additive migration `courier_tracking_v1`

On `public.dispatch_shipments` (additive, no backfill; existing rows just have nulls until first polled):

| Column | Type | Meaning |
|---|---|---|
| `tracking_status` | text | normalized current **stage** (the enum) |
| `tracking_stage_label` | text | courier's own latest status text, for display |
| `tracking_checkpoints` | jsonb | the **full chronological timeline** (`Checkpoint[]`, newest-first); overwritten each poll |
| `tracking_synced_at` | timestamptz | when courierops last refreshed this row (UI shows "updated X ago") |

Existing `expected_delivery_date` / `delivery_date` / `courier_partner` / `tracking_number` are reused:
courierops keeps EDD fresh and stamps `delivery_date` on the delivered scan (which then drives the Snorkel
payment-due clock). Manual entry in the Depot drawer continues to work; the poller does not clobber a
manually-set `delivery_date` with null.

Plus a Postgres RPC for the batched write (see §5):

```sql
-- single-statement bulk update from a jsonb array → one Cloudflare subrequest regardless of row count
create or replace function public.apply_courier_tracking(updates jsonb)
returns integer language plpgsql security definer as $$ ... $$;
-- grant execute to service_role
```

## 5. Poll flow (the cron)

Cloudflare cron trigger every **30 minutes** (parcel scans change a few times/day; Delhivery pull limit is
750 req/5min/IP — far above need).

1. **Select open shipments**: `tracking_number IS NOT NULL` AND `courier_partner = 'Delhivery'` AND
   `tracking_status` NOT IN the terminal set AND `created_at` within ~30 days (give up on stale AWBs).
2. **Bulk-track**: chunk AWBs 30-per-call to Delhivery `GET /api/v1/packages/json/?waybill=A,B,…&verbose=2`
   (`verbose=2` is required for the full scan timeline).
3. **Normalize** each shipment via the Delhivery adapter: map `Status.StatusType` + `Status.StatusCode`
   (never the free-text `Status.Status`) → stage; build the full `checkpoints[]` from `Shipment.Scans[]`
   (IST→UTC); read `ExpectedDeliveryDate`; set `delivered_at` when `StatusCode == "EOD-38"`.
4. **Apply all updates in one RPC** — `apply_courier_tracking(<jsonb array of {id, tracking_status,
   tracking_stage_label, tracking_checkpoints, expected_delivery_date, delivery_date, tracking_synced_at}>)`.
   One subrequest, so the 50-subrequest worker limit never bites no matter how many shipments are open.
5. **Terminal stages** (`delivered`, `rto_delivered`, `cancelled`, `lost`) drop out of the next sweep.

### 5.1 Delhivery stage mapping (forward families; RTO handled)

| Delhivery | Normalized stage |
|---|---|
| `StatusType=UD`, manifested codes | `manifested` |
| `StatusType=UD`, in-transit | `in_transit` |
| `StatusType=UD`, out-for-delivery | `out_for_delivery` |
| `StatusType=UD`, undelivered/NDR | `undelivered` |
| `StatusType=DL`, `StatusCode=EOD-38` | `delivered` (stamp `delivered_at`) |
| RTO in-transit family | `rto_in_transit` |
| RTO delivered (returned to origin) | `rto_delivered` |
| `StatusType=CN` | `cancelled` |
| unknown/new code | `unknown` (still stored with raw code; never dropped) |

Raw `StatusCode` is always preserved on each checkpoint so codes Delhivery adds over time never break ingestion.

## 6. UI — timeline + stage (the floor-facing payoff)

- **Depot** (`apps/depot` shipment detail drawer): under the existing Tracking panel, a vertical
  **tracking timeline** — current stage as a prominent badge + "updated X ago" (`tracking_synced_at`),
  then each checkpoint newest-first (time, stage dot, location, description). Appears once an AWB is polled;
  manual fields still editable. The **courier field becomes a known-set dropdown** (Delhivery / Shiprocket /
  Other→free-text) — decision #6.
- **Snorkel** (`apps/snorkel` SO shipments panel): the same timeline, read-only, so sales can answer
  "where's my order" without leaving Snorkel.
- Both render the already-served `tracking_status` / `tracking_stage_label` / `tracking_checkpoints` /
  `tracking_synced_at` fields. **No consumer-side worker changes** — lotopsproxy `getDispatchShipments` and
  snorkelops `getSalesOrder` already `select=*`, so the new columns flow through automatically.

## 7. Explicitly deferred to V2 (not built in this plan)

- **Webhooks (push)** — Delhivery POSTs each scan in real time, but registration is SPOC-gated (~5–6 working
  days) with a self-defined shared-secret header and a different (flat `{Shipment}`) payload. V2 adds a
  public secret-authed endpoint on courierops as the primary feed, with polling as the reconciliation
  backstop (and to refresh EDD, which is unreliable on the webhook payload).
- **Shiprocket adapter** — email/password→10-day JWT, per-AWB only (no bulk), `x-api-key` webhook secret.
  Slots in behind the same `TrackResult` interface.
- **Pitstop / returns consumer** — reverse AWBs use the same Delhivery endpoint with a reverse status
  vocabulary (PP/PU/DL-DTO, RTO); the normalizer already has the `rto_*` stages.
- **On-demand "Refresh now" button** — cron auto-refresh is sufficient for V1; an authenticated inbound
  call would need JWT + CORS on courierops.

## 8. Verification (no automated harness; per LOT conventions)

- **Schema:** `information_schema` check that the four new columns + RPC exist; `get_advisors` shows no new
  `rls_disabled_in_public` (dispatch_shipments RLS already on).
- **Adapter unit reasoning:** feed the brief's representative delivered/in-transit JSON through the
  normalizer and assert the stage, `delivered_at`, EDD and checkpoint ordering.
- **Live data-path smoke:** with the production token set, point the poller at 1–2 real in-flight Delhivery
  AWBs and confirm `tracking_status` / timeline / EDD / `delivery_date` populate and the Depot + Snorkel
  timelines render. (This is the one step that needs real creds + an authenticated browser pass.)
- **Regression:** a shipment with a manually-set `delivery_date` and a non-Delhivery courier is left
  untouched by the sweep.

## 9. Risks / notes

- Delhivery production token regeneration **instantly invalidates** the old token (no overlap) — coordinate
  any rotation with a redeploy.
- Tokens can be scoped per client/warehouse; if LOT has multiple, the poller may need the right token per
  AWB (single token assumed for V1; revisit if 401s appear on a subset).
- No sandbox: live smoke uses real low-volume AWBs.
- `apply_courier_tracking` RPC is the load-bearing piece that keeps the cron within the subrequest limit —
  it must do the whole batch in one statement (`update … from jsonb_to_recordset(...)`).
```
