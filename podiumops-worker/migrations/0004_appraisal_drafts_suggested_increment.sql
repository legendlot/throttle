-- 0004 (S396, 2026-09-22) — appraisal drafts + manager-suggested increment (Afshaan).
-- Drafts live in their own jsonb columns so a half-written review never touches the submitted
-- columns the other side reads: self_draft is returned only to the subject, manager_draft only to
-- the reviewing manager. Submitting clears the draft.
-- manager_suggested_increment_pct: the reviewing manager's suggestion; seen by that manager and by
-- super admins (calibration), never by the subject. The applied increment stays in
-- compensation_events (super admin + comp allow-list).
ALTER TABLE podium.appraisals
  ADD COLUMN IF NOT EXISTS self_draft jsonb,
  ADD COLUMN IF NOT EXISTS self_draft_saved_at timestamptz,
  ADD COLUMN IF NOT EXISTS manager_draft jsonb,
  ADD COLUMN IF NOT EXISTS manager_draft_saved_at timestamptz,
  ADD COLUMN IF NOT EXISTS manager_suggested_increment_pct numeric(5,2)
    CHECK (manager_suggested_increment_pct IS NULL OR manager_suggested_increment_pct BETWEEN 0 AND 100);
