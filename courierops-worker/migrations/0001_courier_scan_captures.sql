-- 0001_courier_scan_captures — landing table for direct courier scan webhooks (Delhivery ScanPush).
--
-- Applied as `courier_scan_captures_v1`.
--
-- WHY A CAPTURE TABLE AND NOT A DIRECT WRITE: the receiver ships in DISCOVERY MODE. Every scan is
-- recorded here with the lifecycle we WOULD have applied (`mapped_lifecycle`) and the shipment we
-- resolved it to (`matched_shipment_id`), but `public.ecom_shipments` is NOT mutated until the
-- mapping is confirmed against real traffic. This is the Shopflo pattern, and it matters more here:
-- `ecom_shipments.lifecycle` is what commsops' emitter reads to fire `order_delivered`/`order_rto`,
-- so a wrong mapping would not merely store bad data, it would message real customers that an order
-- arrived when it had actually come back to us. Flip `applied` on by setting DELHIVERY_SCANPUSH_APPLY
-- on the worker once the captured rows look right.
--
-- Idempotency against the Uniware poller is NOT this table's job — it stays with
-- `ecom_shipments.emitted_lifecycles`, which commsops already uses to guarantee one event per
-- (shipment, lifecycle) regardless of which feed observed the transition first.

CREATE TABLE IF NOT EXISTS public.courier_scan_captures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  courier             text        NOT NULL DEFAULT 'delhivery',
  awb                 text,
  status              text,
  status_type         text,
  nsl_code            text,
  status_location     text,
  instructions        text,
  reference_no        text,
  status_at           timestamptz,               -- courier's own scan time, IST-corrected at parse
  mapped_lifecycle    text,                      -- NULL = unclassifiable; the discovery signal
  matched_shipment_id uuid REFERENCES public.ecom_shipments(id) ON DELETE SET NULL,
  applied             boolean     NOT NULL DEFAULT false,   -- did we write ecom_shipments?
  apply_note          text,                                 -- why not, when we didn't
  headers             jsonb,
  body                jsonb       NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);

-- Operational reads: "what came in lately", "everything for this AWB", and the two discovery
-- queries that decide when to leave discovery mode (unmapped scans / unmatched AWBs).
CREATE INDEX IF NOT EXISTS courier_scan_captures_received_idx
  ON public.courier_scan_captures (received_at DESC);
CREATE INDEX IF NOT EXISTS courier_scan_captures_awb_idx
  ON public.courier_scan_captures (awb, received_at DESC);
CREATE INDEX IF NOT EXISTS courier_scan_captures_unmapped_idx
  ON public.courier_scan_captures (received_at DESC)
  WHERE mapped_lifecycle IS NULL OR matched_shipment_id IS NULL;

-- RLS on at creation, service_role only (RULE-RLS-001 — supabase_admin's default ACL still
-- auto-grants anon on new public tables, so RLS-on is the backstop).
ALTER TABLE public.courier_scan_captures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.courier_scan_captures FROM anon, authenticated;
GRANT ALL ON public.courier_scan_captures TO service_role;

COMMENT ON TABLE public.courier_scan_captures IS
  'Raw direct-courier webhook scans (Delhivery ScanPush). Discovery-mode landing table: carries the '
  'lifecycle we would apply and the shipment we matched, without mutating ecom_shipments until the '
  'mapping is proven. Backup feed only — the Uniware poller remains primary.';
