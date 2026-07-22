-- 0030 — builder-managed TEST-send allowlist (S230, Afshaan's rule).
-- Separate from test_mode_allow (the super-admin crown-jewel send-lock list) so widening
-- TEST reach can never widen real-send reach. Exact addresses only (addTestAllowlist
-- rejects @domain patterns). Test sends may reach test_mode_allow ∪ test_allowlist and
-- in exchange bypass consent / freq cap / quiet hours / budget (gate isTest semantics).
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS test_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb;
