-- M14 (WS-A) — WhatsApp 24-hour customer-service window state.
-- One tiny hot row per WA identifier (E.164 / wa_id). The inbound webhook upserts
-- last_inbound_at; send() for a whatsapp+text (free-form) message checks that it is
-- within the last 24h before allowing a non-template send. Template sends skip the check.
CREATE TABLE IF NOT EXISTS comms.wa_windows (
  identifier_value text PRIMARY KEY,           -- E.164 phone / wa_id, no '+' normalisation assumed here
  last_inbound_at  timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comms.wa_windows ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.wa_windows TO service_role;

-- Register the WhatsApp inbound/engagement event primitives (advisory — events.name has no FK).
INSERT INTO comms.event_definitions (name, description, expected_props)
VALUES
  ('whatsapp_inbound',   'A customer WhatsApp message received on an owned WABA', '{"channel":"string","message_id":"string"}'::jsonb),
  ('whatsapp_delivered', 'A WhatsApp message we sent was delivered',             '{"channel":"string","message_id":"string"}'::jsonb),
  ('whatsapp_read',      'A WhatsApp message we sent was read',                  '{"channel":"string","message_id":"string"}'::jsonb)
ON CONFLICT (name) DO NOTHING;
