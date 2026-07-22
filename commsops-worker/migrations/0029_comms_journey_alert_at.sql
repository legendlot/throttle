-- 0029 — journey send-health watch rate-limit column (S230).
-- Its own column (not settings.last_alert_at) so an email-deliverability alert can't
-- mask a journey-send alert inside the same hour.
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS journey_alert_at timestamptz;
