-- 0005 (S396, 2026-09-22) — appraisal overview + calibrated comp + lock-in (Afshaan).
-- Spec: docs/superpowers/specs/2026-09-22-podium-appraisal-overview.md
-- Manager side (seen by the reviewing manager + super admins, never the subject):
--   manager_comments            internal additional comments, submitted with the review
--   manager_suggested_bonus     one-time bonus ₹ recommendation
--   manager_recommendation_note adjustments beyond increment + OTB
-- Calibration (super admin + comp allow-list): calibrated_* stay a DRAFT on the appraisal until
-- "lock in" writes compensation_events and stamps comp_locked_at/by (then read-only).
-- self_review_waived_at/by: a super admin lets the manager submit without a self-review.
ALTER TABLE podium.appraisals
  ADD COLUMN IF NOT EXISTS manager_comments text,
  ADD COLUMN IF NOT EXISTS manager_suggested_bonus numeric(12,2)
    CHECK (manager_suggested_bonus IS NULL OR manager_suggested_bonus >= 0),
  ADD COLUMN IF NOT EXISTS manager_recommendation_note text,
  ADD COLUMN IF NOT EXISTS calibrated_increment_pct numeric(5,2)
    CHECK (calibrated_increment_pct IS NULL OR calibrated_increment_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS calibrated_bonus numeric(12,2)
    CHECK (calibrated_bonus IS NULL OR calibrated_bonus >= 0),
  ADD COLUMN IF NOT EXISTS comp_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS comp_locked_by uuid,
  ADD COLUMN IF NOT EXISTS self_review_waived_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_review_waived_by uuid;

-- Cycle budget: a % of the pre-appraisal annual CTC total, or an absolute ₹ amount.
ALTER TABLE podium.appraisal_cycles
  ADD COLUMN IF NOT EXISTS budget_type text CHECK (budget_type IS NULL OR budget_type IN ('pct', 'amount')),
  ADD COLUMN IF NOT EXISTS budget_value numeric(14,2) CHECK (budget_value IS NULL OR budget_value >= 0);
