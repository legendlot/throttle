-- M9 — Dead-letter capture. A queue message that exhausts max_retries lands on the
-- commsops-dlq queue; its DLQ consumer writes one row here + fires a Slack alert, so a
-- poisoned enrol/campaign/backfill message is durably visible instead of silently lost.
-- Applied 2026-07-10.
CREATE TABLE IF NOT EXISTS comms.queue_failures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text,
  body       jsonb,
  error      text,
  failed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE comms.queue_failures ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.queue_failures TO service_role;
CREATE INDEX IF NOT EXISTS queue_failures_failed_at_idx ON comms.queue_failures (failed_at DESC);

NOTIFY pgrst, 'reload schema';
