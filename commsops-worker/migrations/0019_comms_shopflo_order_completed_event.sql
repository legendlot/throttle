-- 0019_comms_shopflo_order_completed_event — register the `shopflo_order_completed`
-- event the Shopflo webhook emits for a completed Shopflo checkout. Distinct from
-- `order_placed` (Shopify orders/create) on purpose: order_placed bumps lifetime and
-- reusing it here would double-count. This event carries `payment_mode` (COD detection
-- for the COD→prepaid journey — trigger.filter {payment_mode:'COD'}). `checkout_abandoned`
-- + `add_to_cart` already exist (0008 seed). events.name has no FK — registry is advisory.
-- Idempotent. Applied via Supabase apply_migration as comms_shopflo_order_completed_event_v1.
INSERT INTO comms.event_definitions (name, description) VALUES
 ('shopflo_order_completed','Shopflo checkout completed (Shop Pass webhook; carries payment_mode for COD→prepaid)')
ON CONFLICT (name) DO NOTHING;
