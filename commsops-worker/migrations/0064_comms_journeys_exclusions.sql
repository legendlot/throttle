-- 0064 — per-journey exclusions (S338, 2026-09-03)
--
-- Afshaan's call (reference/decisions.md §S338b): journeys get the SAME exclusion block campaigns
-- have — exclude segments · exclude named campaigns · exclude same-channel contacted-within-N-hours —
-- configured PER JOURNEY, evaluated at SEND time per step via comms.campaign_excluded(); an excluded
-- contact SKIPS the step and the enrolment CONTINUES. Column names mirror comms.campaigns exactly so
-- exclusionArgs() is shared. Additive; defaults mean every existing journey behaves as before.
ALTER TABLE comms.journeys
  ADD COLUMN IF NOT EXISTS exclude_segment_ids   uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exclude_campaign_ids  uuid[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exclude_contacted_hours integer;
NOTIFY pgrst, 'reload schema';
