-- 0036 (docket_personal_spaces_v1): one personal space per login, made on first use, only ever its owner.
-- One DO block that always rolls back (ends by raising RESULT …).
-- EXPECT: 1:made,same,member,hist=1 2:mem=personal_space 3:team=personal_space 4:shape=check 5:second=unique 6:afshaan=1 7:grants_ok
do $ps$
declare
  U uuid := gen_random_uuid(); V uuid := gen_random_uuid(); D uuid := (select id from podium.departments order by id limit 1);
  a uuid; b uuid; out text := '';
begin
  -- 1: made once, the same id after, owner is its member, one history row
  a := docket.ensure_personal_space(U); b := docket.ensure_personal_space(U);
  out := '1:' || case when a is not null then 'made' else 'NULL' end || ',' || case when a = b then 'same' else 'DIFFERENT' end
    || ',' || case when exists (select 1 from docket.space_members where space_id = a and user_id = U) then 'member' else 'NOMEMBER' end
    || ',hist=' || (select count(*) from docket.space_history where space_id = a)::text;
  -- 2: nobody else joins it
  begin insert into docket.space_members (space_id, user_id) values (a, V); out := out || ' 2:mem=ACCEPTED';
  exception when others then out := out || ' 2:mem=' || split_part(sqlerrm, ':', 1); end;
  -- 3: no team gets it
  begin insert into docket.space_teams (space_id, department_id) values (a, D); out := out || ' 3:team=ACCEPTED';
  exception when others then out := out || ' 3:team=' || split_part(sqlerrm, ':', 1); end;
  -- 4: a personal space can't be the Founders' / General / public
  begin update docket.spaces set is_private = false where id = a; out := out || ' 4:shape=ACCEPTED';
  exception when check_violation then out := out || ' 4:shape=check'; end;
  -- 5: a second live personal space for the same person is refused
  begin insert into docket.spaces (name, is_private, is_default, is_personal, owner_user_id) values ('x', true, false, true, U); out := out || ' 5:second=ACCEPTED';
  exception when unique_violation then out := out || ' 5:second=unique'; end;
  -- 6: the backfill flagged exactly one existing space (Afshaan's "Personal")
  out := out || ' 6:afshaan=' || (select count(*) from docket.spaces where is_personal and owner_user_id = '107ea993-f5ed-4221-ba97-b08e38dcd00c')::text;
  -- 7: service_role only
  out := out || ' 7:' || case when has_function_privilege('service_role', 'docket.ensure_personal_space(uuid)', 'execute')
      and not has_function_privilege('anon', 'docket.ensure_personal_space(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'docket.ensure_personal_space(uuid)', 'execute') then 'grants_ok' else 'GRANTS_WRONG' end;
  raise exception 'RESULT %', out;
end $ps$;
