-- Applied 2026-10-14 as `revoke_definer_rpc_from_logged_in_users` (S419 hostile review).
-- SECURITY DEFINER functions in PostgREST-exposed schemas were EXECUTE-able by `authenticated`, so any
-- valid login (inactive profile, external partner, open email-OTP signup) could POST /rest/v1/rpc/<fn>
-- past every worker gate. 24h edge logs: 0 rpc calls as `authenticated`. 67 revoked; kept
-- brand.get_my_role() (brand RLS) + trigger functions. Snapshot: store.safety_fn_acl_2026_10_14.
create table store.safety_fn_acl_2026_10_14 as
select p.oid::regprocedure::text as fn, p.proacl::text as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','store','brand','ignition','podium','docket','manifest','sales','comms','outpost')
  and p.prosecdef and p.prokind = 'f'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','store','brand','ignition','podium','docket','manifest','sales','comms','outpost')
      and p.prosecdef and p.prokind = 'f'
      and p.prorettype <> 'trigger'::regtype
      and p.oid <> 'brand.get_my_role()'::regprocedure
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('grant execute on function %s to service_role', r.f);
    execute format('revoke execute on function %s from public, anon, authenticated', r.f);
  end loop;
end $$;
