-- 0024_comms_payment_links_enabled — the J3 payment-link go-live switch. The journey
-- `action:payment_link` node mints NOTHING while this is false (returns 'failed' with
-- reason payment_links_disabled), so the action can be authored + a COD journey built
-- entirely inert. Flip to true (super-admin) only when WA is live + reconciliation is
-- decided. Default false / fail-safe off. Applied as comms_payment_links_enabled_v1.
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS payment_links_enabled boolean NOT NULL DEFAULT false;
