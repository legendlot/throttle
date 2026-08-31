-- S325 (2026-08-31) — Delhivery invoice ingestion: per-shipment D2C freight cost.
--
-- WHY THIS EXISTS. `/pnl` logistics was ₹34.8L over Mar–Aug and **100% Amazon FBA**
-- (`settlement_fact`); every non-Amazon channel, Website included, contributed **ZERO** shipping
-- cost, so D2C CM1 was overstated by the whole of its freight. The long-standing
-- "needs the Delhivery B2B/B2C access grant" tag was wrong twice over: the grant was never needed,
-- and it would never have sufficed — Delhivery's tracking APIs carry
-- `AWB · NSLCode · PickUpDate · ReferenceNo · Sortcode · Status` and **no money at all**.
--
-- ⭐ THE SOURCE IS THE INVOICE CSV, one row per shipment, downloaded from Delhivery One →
-- Finances → Invoices. Verified on `EPH26251110` (Aug 2026): 1,893 rows, and
-- **Σ`total_amount` = ₹2,29,545.67 vs the portal's ₹2,29,542.09 — ₹3.58 (0.0016%), rounding.**
-- The file IS the invoice, line by line.
--
-- ⛔ THERE IS NO API FOR IT. Delhivery One's report builder carries **no charge fields at all**
-- (only Order Type / Status / Sub-status / frequency), so this is an UPLOAD path — same shape as
-- QC's `csv_text` — not a poller. Do not go looking for an endpoint.
--
-- ⚠️ AN INVOICE PERIOD IS NOT A CALENDAR MONTH. `EPH26251110` spans `pickup_date`
-- 2026-07-09 → 2026-08-14. The monthly P&L figure is therefore derived from the ROWS
-- (`pickup_at` month, IST), never from the invoice date. Two invoices can contribute to one month.
-- ⚠️ THE FILENAME LIES: the file arrives as `I5694122026<something>_….csv` reading 16 Aug while its
-- content is the 20 Aug invoice. **Key on `serial_number` inside the file, never the filename.**
-- ⚠️ Do NOT ingest the companion `EPVASH*` file — that is **Communication VAS** (per-SMS billing:
-- `message_id`, `charge_vas`), not freight. Adding it would inflate logistics.
--
-- THE JOIN, measured rather than assumed. `order_id` in the CSV is the **Shopify order NAME**
-- (`#LOT41952`) = `ecom_shipments.shopify_order_name`. Raw match on a random 200-row sample was
-- **189/200 = 94.5%**; the 11 misses were a NAMED class, not random loss — `R_`/`R__` prefixes
-- (replacements), `-Exp` suffixes, and one literal `Sample Order`. `order_name` below normalises
-- those, and **all 8 real variants tested then resolved**; only `Sample Order` does not, correctly.
-- It is a GENERATED column so the normalisation cannot drift from the raw value it came from.

CREATE TABLE IF NOT EXISTS sales.stg_delhivery_invoice (
  invoice_no      text NOT NULL,                    -- serial_number, e.g. EPH26251110
  waybill_num     text NOT NULL,
  order_id        text,                             -- raw, as Delhivery sent it
  -- Normalised Shopify order name. Strips a leading '#', an 'R_'/'R__' replacement prefix and a
  -- trailing '-Exp', then re-prefixes '#'. GENERATED so it can never disagree with order_id.
  order_name      text GENERATED ALWAYS AS (
                    CASE WHEN COALESCE(btrim(order_id),'') = '' THEN NULL
                         ELSE '#' || upper(regexp_replace(
                                regexp_replace(btrim(order_id), '^#?R_+|^#', '', 'i'),
                                '-EXP$', '', 'i'))
                    END) STORED,
  pickup_at       timestamptz,
  status          text,                             -- Delivered | RTO | DTO
  charged_weight  numeric,
  zone            text,
  payment_mode    text,
  product_value   numeric,
  cod_amount      numeric,
  -- The four splits the P&L ladder actually distinguishes. RTO/DTO/COD are separable from forward
  -- freight, which is what lets shipping cost be attributed to returns vs sales.
  charge_forward  numeric,                          -- charge_DL
  charge_rto      numeric,
  charge_dto      numeric,
  charge_cod      numeric,
  igst            numeric,
  cgst            numeric,
  sgst            numeric,
  gross_amount    numeric,
  total_amount    numeric,                          -- the per-shipment cost; sums to the invoice
  charges         jsonb,                            -- all 24 charge_* columns, verbatim
  raw             jsonb,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_no, waybill_num)             -- re-uploading the same invoice is a no-op
);

CREATE INDEX IF NOT EXISTS stg_delhivery_invoice_order_idx  ON sales.stg_delhivery_invoice (order_name);
CREATE INDEX IF NOT EXISTS stg_delhivery_invoice_pickup_idx ON sales.stg_delhivery_invoice (pickup_at);

ALTER TABLE sales.stg_delhivery_invoice ENABLE ROW LEVEL SECURITY;   -- RULE-RLS-001
GRANT ALL ON sales.stg_delhivery_invoice TO service_role;

-- ── Roll per-shipment cost into the monthly P&L line ─────────────────────────
-- ⭐ Writes into `sales.pnl_manual`, which `f_pnl` ALREADY reads
-- (`logistics = st.logistics_auto + man['logistics']`). **`f_pnl` is deliberately NOT modified** —
-- it is the live P&L function and the smallest safe change is to feed the slot it already has.
-- ⚠️ So one `pnl_manual` row is DERIVED, not hand-entered. It is stamped in `note` and keyed
-- (month, channel_key='website', line_key='logistics'), so this function OWNS that row: a human
-- edit to it will be overwritten on the next upload. Any other line_key/channel_key is untouched.
CREATE OR REPLACE FUNCTION sales.recompute_delhivery_logistics()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO sales.pnl_manual (month, channel_key, line_key, amount_inr, note, updated_at)
  SELECT date_trunc('month', (d.pickup_at AT TIME ZONE 'Asia/Kolkata'))::date,
         'website', 'logistics',
         ROUND(SUM(d.total_amount)::numeric, 2),
         'auto: sales.recompute_delhivery_logistics from Delhivery invoice CSV ('
           || string_agg(DISTINCT d.invoice_no, ', ' ORDER BY d.invoice_no) || ')',
         now()
  FROM sales.stg_delhivery_invoice d
  WHERE d.pickup_at IS NOT NULL AND d.total_amount IS NOT NULL
  GROUP BY 1
  ON CONFLICT (month, channel_key, line_key) DO UPDATE
    SET amount_inr = EXCLUDED.amount_inr,
        note       = EXCLUDED.note,
        updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

GRANT EXECUTE ON FUNCTION sales.recompute_delhivery_logistics() TO service_role;

-- Per-order freight, for unit economics. LEFT-joined from the invoice so an unmatched shipment
-- stays VISIBLE (the `Sample Order` class) rather than silently vanishing.
CREATE OR REPLACE FUNCTION sales.f_order_freight(p_from date, p_to date)
RETURNS TABLE (
  order_name text, shipments bigint, status text,
  freight_total numeric, forward numeric, rto numeric, dto numeric, cod numeric,
  charged_weight numeric, matched_shipment boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $fn$
  SELECT d.order_name,
         count(*)::bigint,
         string_agg(DISTINCT d.status, '/' ORDER BY d.status),
         ROUND(SUM(d.total_amount)::numeric, 2),
         ROUND(SUM(COALESCE(d.charge_forward,0))::numeric, 2),
         ROUND(SUM(COALESCE(d.charge_rto,0))::numeric, 2),
         ROUND(SUM(COALESCE(d.charge_dto,0))::numeric, 2),
         ROUND(SUM(COALESCE(d.charge_cod,0))::numeric, 2),
         ROUND(SUM(COALESCE(d.charged_weight,0))::numeric, 2),
         bool_or(e.id IS NOT NULL)
  FROM sales.stg_delhivery_invoice d
  LEFT JOIN public.ecom_shipments e ON e.shopify_order_name = d.order_name
  WHERE (d.pickup_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_from AND p_to
  GROUP BY d.order_name
  ORDER BY 4 DESC;
$fn$;

GRANT EXECUTE ON FUNCTION sales.f_order_freight(date, date) TO service_role;

NOTIFY pgrst, 'reload schema';
