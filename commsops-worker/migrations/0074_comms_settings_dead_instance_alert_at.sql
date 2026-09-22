-- 0074 — dead-instance sweep alert throttle (S397, 2026-09-22).
-- Its own column so this alert can never mask, or be masked by, the stranded-queued,
-- deliverability or journey-health alerts (same reasoning as 0065's stranded_alert_at).
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS dead_instance_alert_at timestamptz;
NOTIFY pgrst, 'reload schema';
