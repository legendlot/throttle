-- Discovery/debug capture for inbound third-party webhooks whose payload schema we
-- do NOT control — first use: the Shopflo Abandoned Cart Webhook (S211), which carries
-- the Shop Pass identity (phone/email) + cart context that Shopify's own feeds don't
-- surface. The receiving endpoint stores raw headers+body here so we can learn the exact
-- field shape BEFORE writing a mapper, and keeps a short audit trail. Prunable.
CREATE TABLE IF NOT EXISTS comms.webhook_captures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL,
  headers     jsonb,
  body        jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_captures_source_idx ON comms.webhook_captures (source, received_at DESC);

ALTER TABLE comms.webhook_captures ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.webhook_captures TO service_role;
