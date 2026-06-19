-- 0005_sales_stg_orders_upsert_key.sql  (Session 157, 2026-06-19)
-- Make sales.stg_orders upsert-friendly for the worker's stageOrders():
-- non-null refund_id ('' for 'order' rows) + a plain 4-col unique index so PostgREST
-- on_conflict=channel_id,source_order_id,row_kind,refund_id can target it (the COALESCE
-- expression index from 0004 can't be inferred for ON CONFLICT). Additive; table is empty.
ALTER TABLE sales.stg_orders ALTER COLUMN refund_id SET DEFAULT '';
UPDATE sales.stg_orders SET refund_id='' WHERE refund_id IS NULL;
ALTER TABLE sales.stg_orders ALTER COLUMN refund_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stg_orders_uc
  ON sales.stg_orders (channel_id, source_order_id, row_kind, refund_id);
