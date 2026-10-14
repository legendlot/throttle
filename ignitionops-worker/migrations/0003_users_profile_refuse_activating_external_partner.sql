-- Applied 2026-10-14 as `users_profile_refuse_activating_external_partner` (S419 hostile review).
-- A partner is isolated only because their users_profile stays inactive; refuse active=true for anyone
-- holding an ignition_external role, whatever the path. To make them staff, delete those role rows first.
create or replace function store.refuse_active_external_partner()
returns trigger language plpgsql security definer set search_path = store, pg_temp as $$
begin
  if new.active and exists (
    select 1 from store.ignition_user_roles ur
    join store.ignition_roles r on r.role_key = ur.role_key
    where ur.user_id = new.id and coalesce((r.permissions->>'ignition_external')::boolean, false)
  ) then
    raise exception 'users_profile % holds an external-partner Ignition role; partners must stay inactive (S419). Remove the role rows first.', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function store.refuse_active_external_partner() from public, anon, authenticated;
create trigger trg_refuse_active_external_partner
before insert or update of active on store.users_profile
for each row when (new.active) execute function store.refuse_active_external_partner();
