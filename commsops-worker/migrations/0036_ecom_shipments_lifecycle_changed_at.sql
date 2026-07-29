-- 0036 — public.ecom_shipments.lifecycle_changed_at
--
-- WHY. commsops' courier emitter (src/shipment-events.js) decides WHEN a lifecycle transition
-- happened via occurredAt(): `delivered_at` for delivered, and `uniware_updated_at` for
-- in_transit / out_for_delivery / rto. That was correct while the Uniware poller was the only
-- writer of `lifecycle`. Since the Delhivery ScanPush APPLY flip (2026-07-28) a SECOND feed
-- advances `lifecycle` — and it cannot touch `uniware_updated_at`, because odoops writes that
-- from Uniware's own `updated` field AND uses it as its poll cursor (odoops index.js ~2537;
-- there is an explicit comment there warning against stamping it now()).
--
-- Result: every ScanPush-driven transition was judged by Uniware's stale last-touch stamp,
-- fell below `comms.settings.courier_emit_from`, and was dropped as `stale`. Measured
-- 2026-07-29: 150 of 153 live `rto` rows silently dropped; only 2 order_rto events had ever
-- fired. `delivered` was unaffected only because ScanPush does stamp `delivered_at`.
--
-- THE COLUMN IS DELIBERATELY LEFT NULL ON EVERY EXISTING ROW — DO NOT BACKFILL IT.
-- occurredAt() falls back to the old stamp when this is null, so historical rows keep behaving
-- exactly as they do today (silent). Backfilling from `updated_at` would immediately release
-- 208 held events — 151 order_rto (harmless, those journeys are draft) but also 48
-- order_shipped and 9 order_delivered, whose journeys are LIVE. That is ~57 real WhatsApp
-- messages about parcels that moved days ago: precisely the bulk-reconciliation spam the age
-- cap and watermark in shipment-events.js exist to prevent.
--
-- Additive + nullable, so the Uniware path needs no change (its `uniware_updated_at` remains a
-- correct transition proxy for the rows it writes).

ALTER TABLE public.ecom_shipments
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at timestamptz;

COMMENT ON COLUMN public.ecom_shipments.lifecycle_changed_at IS
  'When `lifecycle` last actually CHANGED, stamped by whichever feed changed it (ScanPush uses '
  'the courier scan''s own timestamp). Read by commsops shipment-events.occurredAt() as the '
  'transition clock for non-delivered lifecycles. NULL on pre-2026-07-29 rows by design — the '
  'emitter falls back to uniware_updated_at, which keeps history silent. Never backfill.';

-- Partial index: the emitter filters on this column OR uniware_updated_at, and only ever cares
-- about rows that have a stamp at all.
CREATE INDEX IF NOT EXISTS ecom_shipments_lifecycle_changed_at_idx
  ON public.ecom_shipments (lifecycle_changed_at DESC)
  WHERE lifecycle_changed_at IS NOT NULL;

-- PostgREST caches the schema; a column added afterwards is invisible to it until reloaded,
-- and the failure is SILENT (writes drop the unknown key, reads just omit it). See CORE.md.
NOTIFY pgrst, 'reload schema';
