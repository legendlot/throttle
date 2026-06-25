-- Seed v1 comms-relevant event vocabulary + settings singleton + email sender placeholder.
-- Applied 2026-06-25 (S170) via Supabase apply_migration.
INSERT INTO comms.event_definitions (name, description) VALUES
 ('order_placed','A Shopify order was created'),
 ('order_fulfilled','Order marked fulfilled'),
 ('order_delivered','Order delivered'),
 ('add_to_cart','Storefront add-to-cart (Web Pixel)'),
 ('checkout_started','Storefront checkout started (Web Pixel)'),
 ('checkout_abandoned','Checkout abandoned (no order within window)'),
 ('return_created','A return was created'),
 ('repair_status_changed','Repair/RMA status changed'),
 ('ticket_opened','A support ticket was opened'),
 ('email_delivered','Email delivered (engagement)'),
 ('email_opened','Email opened (engagement)'),
 ('email_clicked','Email link clicked (engagement)'),
 ('email_bounced','Email bounced (engagement)'),
 ('opted_out','Recipient opted out (engagement)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO comms.settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Email sender for comms.legendoftoys.com (status inactive until DNS verified in M5).
INSERT INTO comms.sender_identities (channel, address, purpose, provider, status, credentials_ref, metadata)
VALUES ('email','marketing@comms.legendoftoys.com','all','resend','inactive','RESEND_API_KEY',
        '{"dns_verified":false,"from_name":"Legend of Toys"}')
ON CONFLICT DO NOTHING;
