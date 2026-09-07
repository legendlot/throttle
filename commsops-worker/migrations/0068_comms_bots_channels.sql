-- 0068_comms_bots_channels.sql — S355 (spec 2026-09-07-relay-flowbots-wa-web-design.md §5.2)
-- bots.channel was CHECK (channel = 'web'); the first whatsapp/shared insert would 23514.
ALTER TABLE comms.bots DROP CONSTRAINT IF EXISTS bots_channel_check;
ALTER TABLE comms.bots ADD CONSTRAINT bots_channel_check CHECK (channel IN ('web','whatsapp','shared'));

-- visitor_key is NOT NULL with no default (0058:37) and is a WEB identity; WhatsApp sessions have none.
ALTER TABLE comms.bot_sessions ALTER COLUMN visitor_key DROP NOT NULL;
ALTER TABLE comms.bot_sessions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS wa_from text,
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS sub_bot_id uuid REFERENCES comms.bots(id),
  ADD COLUMN IF NOT EXISTS sub_version integer,
  ADD COLUMN IF NOT EXISTS return_step text;
ALTER TABLE comms.bot_sessions DROP CONSTRAINT IF EXISTS bot_sessions_channel_check;
ALTER TABLE comms.bot_sessions ADD CONSTRAINT bot_sessions_channel_check CHECK (channel IN ('web','whatsapp'));
-- one live WhatsApp session per (customer, business number)
CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_wa_active_uq
  ON comms.bot_sessions (wa_from, phone_number_id)
  WHERE channel = 'whatsapp' AND status = 'active';

-- per-inbound-message claim: Meta redelivery / concurrent invocations must not double-advance
ALTER TABLE comms.bot_session_steps ADD COLUMN IF NOT EXISTS provider_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_session_steps_pmid_uq
  ON comms.bot_session_steps (provider_message_id) WHERE provider_message_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
