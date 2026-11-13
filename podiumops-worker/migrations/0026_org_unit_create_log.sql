-- podium_org_unit_create_log_v1 — Google org units follow Podium teams (syncTeamOrgUnits, 2026-11-14). Every
-- orgunits.insert Podium makes is logged in google_admin_log as `create_org_unit` (ok or failed; target_email
-- carries the OU path — the column is NOT NULL and an OU has no address). Widens the action CHECK only. Re-runnable.
alter table podium.google_admin_log drop constraint if exists google_admin_log_action_check;
alter table podium.google_admin_log add constraint google_admin_log_action_check
  check (action in ('create_user', 'link_existing', 'suspend_user', 'reset_password', 'suspend_exited', 'drive_transfer',
    'keep_active', 'transfer_checked', 'account_gone', 'sync_fields', 'sync_fields_failed', 'create_org_unit'));
