-- ignition_partner_role_v1 — external partner access (§S419-ClearshotPartner, 2026-10-14)
--
-- ⛔ APPLY BEFORE DEPLOYING THE WORKER. ignitionops getIgnitionPerms now filters
-- `ignition_user_roles` on `expires_at`; PostgREST errors on an unknown column, the worker reads
-- that as "no role row", and EVERY Ignition user would be locked out until this lands.
--
-- 1. Per-assignment expiry. NULL = no expiry (every existing staff row stays NULL, unchanged).
alter table store.ignition_user_roles add column if not exists expires_at timestamptz;

comment on column store.ignition_user_roles.expires_at is
  'Ignition access ends at this instant (NULL = never). Set by invitePartner for external partners; '
  'getIgnitionPerms treats a row past it exactly like active=false.';

-- 2. The external partner role. `ignition_external` is what ignitionops reads to (a) admit an
-- INACTIVE users_profile and (b) switch on partner mode: deny-by-default GET allowlist, every POST
-- refused, response field strip, Roster-only scope. Toggles (partner_contacts, partner_campaigns,
-- partner_all_influencers, ignition_reports_view, ignition_connects) start absent = OFF and are
-- flipped from Admin → Users via setIgnitionRolePermission. partner_money starts ON (Afshaan).
insert into store.ignition_roles (role_key, label, description, permissions, is_system)
values (
  'ignition_partner',
  'Partner (external)',
  'External agency (e.g. Clearshot). Own-email sign-in, read-only, Roster influencers only; contacts hidden. Invite from this page — never grant.',
  '{"ignition_view": true, "ignition_external": true, "partner_money": true}'::jsonb,
  false
)
on conflict (role_key) do nothing;
