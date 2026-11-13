-- podium_org_unit_delete_log_v1 — Podium deletes the Google org units left empty after people moved to team OUs
-- (deleteEmptyOrgUnits, 2026-11-14). Every orgunits.delete Podium makes is logged in google_admin_log as
-- `delete_org_unit` (ok or failed; target_email carries the OU path, as create_org_unit). Widens the action CHECK
-- only. Re-runnable.
alter table podium.google_admin_log drop constraint if exists google_admin_log_action_check;
alter table podium.google_admin_log add constraint google_admin_log_action_check
  check (action in ('create_user', 'link_existing', 'suspend_user', 'reset_password', 'suspend_exited', 'drive_transfer',
    'keep_active', 'transfer_checked', 'account_gone', 'sync_fields', 'sync_fields_failed', 'create_org_unit',
    'delete_org_unit'));
