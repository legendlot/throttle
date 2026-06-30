-- 0011_comms_order_cancelled_event — register the order_cancelled event the M4
-- orders/cancelled webhook emits. events.name has no FK to event_definitions (the
-- registry is advisory), so this is tidiness/documentation only. Idempotent.
-- Applied via Supabase apply_migration as comms_order_cancelled_event_v1.
INSERT INTO comms.event_definitions (name, description) VALUES
 ('order_cancelled','Order cancelled (Shopify orders/cancelled webhook)')
ON CONFLICT (name) DO NOTHING;
