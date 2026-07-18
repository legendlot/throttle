-- 0023_comms_payment_link_events — register the Cashfree payment-link events the
-- /webhook/cashfree receiver emits (J3 COD→prepaid pay-link). events.name has no FK to
-- event_definitions (the registry is advisory), so this is tidiness/documentation only.
-- Idempotent. Applied via Supabase apply_migration as comms_payment_link_events_v1.
INSERT INTO comms.event_definitions (name, description) VALUES
 ('payment_link_paid',   'Cashfree payment link fully PAID (PAYMENT_LINK_EVENT). Wakes a J1 wait_response paid branch.'),
 ('payment_link_failed', 'Cashfree payment link EXPIRED/CANCELLED/USER_DROPPED (PAYMENT_LINK_EVENT). Wakes a J1 wait_response failed branch.')
ON CONFLICT (name) DO NOTHING;
