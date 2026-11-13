-- 0040 (docket_announcements_v1): the constraints (title / body length, audience, slack shape), a team row refused
-- on an everyone-post, Seen unique per post · login, a delete cascading to teams + seen, the defaults, grants
-- service_role only, RLS on, and the settings row seeded. One DO block that always rolls back (ends by raising
-- RESULT …). Run via execute_sql after 0040.
-- EXPECT: 1:title_empty=check 2:title_long=check 3:body_long=check 4:audience=check 5:slack_shape=check 6:everyone_team=announcement_audience 7:seen_dup=unique 8:cascade=teams0,seen0 9:defaults=ok 10:grants_ok 11:rls_on 12:settings=present
do $an$
declare
  ACTR uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';   -- an author (auth user id only)
  RDR uuid := '207ea993-f5ed-4221-ba97-b08e38dcd00c';    -- a reader
  DEPT uuid := (select id from podium.departments order by id limit 1);
  P_ALL uuid; P_TEAM uuid; n1 int; n2 int; out text := ''; ok_grants boolean := true; tb text;
begin
  -- 1–5: the row constraints
  begin insert into docket.announcements (title, body, author_user_id, audience) values ('  ', 'ZZ body', ACTR, 'everyone');
    out := out || '1:title_empty=ACCEPTED';
  exception when check_violation then out := out || '1:title_empty=check'; end;
  begin insert into docket.announcements (title, body, author_user_id, audience) values (repeat('z', 201), 'ZZ body', ACTR, 'everyone');
    out := out || ' 2:title_long=ACCEPTED';
  exception when check_violation then out := out || ' 2:title_long=check'; end;
  begin insert into docket.announcements (title, body, author_user_id, audience) values ('ZZ t', repeat('z', 5001), ACTR, 'everyone');
    out := out || ' 3:body_long=ACCEPTED';
  exception when check_violation then out := out || ' 3:body_long=check'; end;
  begin insert into docket.announcements (title, body, author_user_id, audience) values ('ZZ t', 'ZZ body', ACTR, 'zz');
    out := out || ' 4:audience=ACCEPTED';
  exception when check_violation then out := out || ' 4:audience=check'; end;
  begin insert into docket.announcements (title, body, author_user_id, audience, slack) values ('ZZ t', 'ZZ body', ACTR, 'everyone', '{}'::jsonb);
    out := out || ' 5:slack_shape=ACCEPTED';
  exception when check_violation then out := out || ' 5:slack_shape=check'; end;

  -- 6: a team row on an everyone-post is refused; on a teams post it goes in
  insert into docket.announcements (title, body, author_user_id, audience) values ('ZZ an all', E'ZZ line one\nZZ line two', ACTR, 'everyone') returning id into P_ALL;
  insert into docket.announcements (title, body, author_user_id, audience, pinned) values ('ZZ an team', 'ZZ body', ACTR, 'teams', true) returning id into P_TEAM;
  insert into docket.announcement_teams (announcement_id, department_id) values (P_TEAM, DEPT);
  begin insert into docket.announcement_teams (announcement_id, department_id) values (P_ALL, DEPT);
    out := out || ' 6:everyone_team=ACCEPTED';
  exception when check_violation then out := out || ' 6:everyone_team=' || split_part(sqlerrm, ':', 1); end;

  -- 7: Seen once per post · login
  insert into docket.announcement_seen (announcement_id, user_id) values (P_TEAM, RDR), (P_TEAM, ACTR), (P_ALL, RDR);
  begin insert into docket.announcement_seen (announcement_id, user_id) values (P_TEAM, RDR);
    out := out || ' 7:seen_dup=ACCEPTED';
  exception when unique_violation then out := out || ' 7:seen_dup=unique'; end;

  -- 8: deleting a post takes its teams and seen rows with it (the other post's seen row stays)
  delete from docket.announcements where id = P_TEAM;
  select count(*) into n1 from docket.announcement_teams where announcement_id = P_TEAM;
  select count(*) into n2 from docket.announcement_seen where announcement_id = P_TEAM;
  out := out || ' 8:cascade=teams' || n1 || ',seen' || n2
    || case when (select count(*) from docket.announcement_seen where announcement_id = P_ALL) = 1 then '' else ',OTHER_LOST' end;

  -- 9: defaults — not pinned, no expiry / archive, slack [], line breaks kept
  out := out || ' 9:defaults=' || (select case when not pinned and expires_at is null and archived_at is null and slack = '[]'::jsonb
      and body = E'ZZ line one\nZZ line two' and created_at is not null and updated_at is not null then 'ok' else 'BAD' end
    from docket.announcements where id = P_ALL);

  -- 10/11: service_role only; RLS on; the guard function not callable
  foreach tb in array array['docket.announcements', 'docket.announcement_teams', 'docket.announcement_seen'] loop
    if not (has_table_privilege('service_role', tb, 'select') and has_table_privilege('service_role', tb, 'insert')
        and has_table_privilege('service_role', tb, 'update') and has_table_privilege('service_role', tb, 'delete')
        and not has_table_privilege('anon', tb, 'select') and not has_table_privilege('authenticated', tb, 'select')
        and not has_table_privilege('anon', tb, 'insert') and not has_table_privilege('authenticated', tb, 'insert')) then ok_grants := false; end if;
  end loop;
  if has_function_privilege('anon', 'docket.announcement_teams_guard()', 'execute')
     or has_function_privilege('authenticated', 'docket.announcement_teams_guard()', 'execute') then ok_grants := false; end if;
  out := out || ' 10:' || case when ok_grants then 'grants_ok' else 'GRANTS_BAD' end;
  out := out || ' 11:' || case when (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'docket' and c.relname in ('announcements', 'announcement_teams', 'announcement_seen')) then 'rls_on' else 'RLS_OFF' end;

  -- 12: the settings row (an admin may have changed its value since — only its presence and shape are checked)
  out := out || ' 12:settings=' || coalesce((select case when value ? 'mode' and value ? 'team_channels' and value ? 'test_employee_ids' then 'present' else 'MALFORMED' end
    from docket.settings where key = 'announcements'), 'MISSING');

  raise exception 'RESULT %', out;
end $an$;
