-- ============================================================================
-- 0002_podium_storage_and_perms
-- (a) Private Storage bucket for employee documents.
-- (b) Grant the four podium_* permission keys to the founder roles.
--
-- Run AFTER 0001. These touch `storage` + `store` (not the podium schema), so
-- they're kept separate from the schema migration. Both are non-destructive.
-- ============================================================================

-- (a) PRIVATE bucket — never public (RULE-PODIUM access model). The worker
-- (service_role) bypasses storage RLS; no public policy is added, so the only
-- way to read an object is a worker-minted short-TTL signed URL.
insert into storage.buckets (id, name, public)
values ('podium-documents', 'podium-documents', false)
on conflict (id) do nothing;

-- (b) Founder access. v1 is founder-facing first — only admin + super_admin get
-- Podium. Add dedicated podium_hr / podium_comp roles later as the team grows.
update store.roles
set permissions = permissions
      || '{"podium_view":true,"podium_hr":true,"podium_comp":true,"podium_admin":true}'::jsonb,
    updated_at = now()
where role_id in ('admin', 'super_admin');
