-- M9 — Warm-up send budget + alert dedup timestamp.
--   • settings.daily_send_budget (null = unlimited; a warm-up throttle e.g. 500→2k→5k→null)
--   • settings.last_alert_at (rate-limits the deliverability-spike Slack alert to ≤1/hour)
--   • send_counters — per-IST-day marketing send tally, incremented atomically by the gate.
-- consume_send_budget() is the ONLY writer: a single INSERT…ON CONFLICT…WHERE statement so
-- concurrent queue consumers can't race past the cap (the conflict WHERE holds the row lock).
-- Applied 2026-07-10.
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS daily_send_budget int;
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS last_alert_at timestamptz;

CREATE TABLE IF NOT EXISTS comms.send_counters (
  day   date PRIMARY KEY,
  used  int  NOT NULL DEFAULT 0
);
ALTER TABLE comms.send_counters ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.send_counters TO service_role;

-- Atomically consume one unit of today's (IST) marketing send budget.
-- Returns true when the send is allowed (budget null = unlimited, or still under cap),
-- false when the cap is reached. The gate calls this LAST (after every other check) so a
-- unit is never burned on an otherwise-skipped send.
CREATE OR REPLACE FUNCTION comms.consume_send_budget()
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_budget int;
  v_day    date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_used   int;
BEGIN
  SELECT daily_send_budget INTO v_budget FROM comms.settings WHERE id = 1;
  IF v_budget IS NULL THEN RETURN true; END IF;   -- unlimited
  IF v_budget < 1   THEN RETURN false; END IF;    -- 0/negative = block all

  INSERT INTO comms.send_counters (day, used) VALUES (v_day, 1)
    ON CONFLICT (day) DO UPDATE SET used = comms.send_counters.used + 1
      WHERE comms.send_counters.used < v_budget
    RETURNING used INTO v_used;

  -- NULL ⇒ the conflict-update WHERE was false (already at cap) ⇒ exhausted.
  RETURN v_used IS NOT NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION comms.consume_send_budget() TO service_role;

NOTIFY pgrst, 'reload schema';
