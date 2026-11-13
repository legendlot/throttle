-- P3b DATA (General-space rethink, Afshaan's decisions 2026-11-13): empty General.
--   * every team with tasks in General gets ONE home space (spaces.home_department_id, 0038): owned by the team's
--     Podium head, shared with the team. A same-named space the head already owns is adopted (Customer Success);
--     a same-named space someone ELSE owns stops the run unless REUSE names it (Finance — Afshaan's call).
--   * a top-level task with a team → that team's home space; with no team → its creator's Personal space;
--     a sub-task → wherever its parent went. One space_changed history row each (source 'system').
--   * a record in General → the NPD home space if it is the Badger record, else its owner's team home space,
--     else its creator's Personal space.
-- Run AFTER 0038 and after the snapshots below. Run once with DRY := true (ends by raising the counts, rolls
-- back), then with DRY := false. Idempotent: a second run finds nothing in General.
--
-- Snapshots (run first, separately):
--   create table store.safety_docket_tasks_p3b_2026_11_13 as select id, space_id, parent_task_id, department_id from docket.tasks;
--   create table store.safety_docket_spaces_p3b_2026_11_13 as select * from docket.spaces;
--   create table store.safety_docket_space_teams_p3b_2026_11_13 as select * from docket.space_teams;
--   create table store.safety_docket_space_members_p3b_2026_11_13 as select * from docket.space_members;
--   create table store.safety_docket_records_p3b_2026_11_13 as select id, space_id from docket.checklist_records;
do $p3b$
declare
  DRY   boolean := true;
  -- { "<department name>": "<space id>" }: adopt this existing space as the team's home (owner unchanged).
  -- Finance → Mahesh's existing "Finance" space, shared with the whole Finance team (Afshaan 2026-11-13).
  REUSE jsonb   := '{"Finance": "d9a994a3-215a-411c-bc1a-3360b6f541fc"}'::jsonb;
  -- A team whose Podium head has exited (Analytics, Offline, Production on 2026-11-13): Afshaan owns its space for now
  -- (owner = management only; the team gets in through the team share) — transfer it once Podium names a head.
  INTERIM uuid := (select e.auth_user_id from podium.employees e join podium.departments d on d.head_employee_id = e.id
                    where d.name = 'Founder''s Office' and e.status <> 'exited' limit 1);
  v_interim boolean;
  G uuid := (select id from docket.spaces where is_default limit 1);
  r record; v_head uuid; v_sp uuid; v_npd uuid; v_need boolean; v_reuse text; v_matched text[] := '{}';
  n_skipped int := 0; n_teams int := 0; n_new int := 0; n_team int; n_pers int; n_sub int; n_rec int; n_left int; n_left_rec int; n_cross int;
begin
  if G is null then raise exception 'P3B no General space'; end if;
  -- Codex 2026-11-13 #3: hold General's rows still while we route them (a concurrent move can't be overwritten).
  perform 1 from docket.tasks where space_id = G for update;
  perform 1 from docket.checklist_records where space_id = G for update;
  create temp table p3b_target (task_id uuid primary key, target uuid, why text) on commit drop;

  -- 1. a home space per team that has tasks in General, a record in General, or is NPD when the Badger record is
  --    there (Codex #2). Other teams get theirs on demand (decision 3) — not here.
  for r in select d.id, d.name, d.head_employee_id,
                  (exists (select 1 from docket.tasks t where t.space_id = G and t.parent_task_id is null and t.department_id = d.id)
                   or exists (select 1 from docket.checklist_records cr join podium.employees e on e.id = cr.owner_employee_id
                               where cr.space_id = G and e.department_id = d.id)
                   or (lower(d.name) = 'npd' and exists (select 1 from docket.checklist_records cr where cr.space_id = G and cr.title ilike '%badger%'))) as need
             from podium.departments d
            order by d.name loop
    continue when not r.need;
    v_need := r.need; v_interim := false;
    v_sp := (select id from docket.spaces where home_department_id = r.id and archived_at is null);
    v_reuse := (select value from jsonb_each_text(REUSE) where lower(key) = lower(r.name) limit 1);
    if v_reuse is not null then v_matched := v_matched || lower(r.name); end if;
    if v_sp is null and v_reuse is not null then
      v_sp := v_reuse::uuid;
      update docket.spaces set home_department_id = r.id
       where id = v_sp and archived_at is null and is_private and not is_personal and not is_founders and not is_default
         and home_department_id is null;
      if not found then raise exception 'P3B REUSE % → % is not a live private team space without a home team', r.name, v_sp; end if;
    end if;
    if v_sp is null then
      v_head := (select e.auth_user_id from podium.employees e where e.id = r.head_employee_id and e.status <> 'exited');
      v_interim := v_head is null;
      if v_interim then v_head := INTERIM; end if;
      if v_head is null then raise exception 'P3B team % has no head with a login and no interim owner', r.name; end if;
      v_sp := (select id from docket.spaces where lower(name) = lower(r.name) and owner_user_id = v_head and archived_at is null
                 and is_private and not is_personal and not is_founders and not is_default and home_department_id is null
               order by created_at limit 1);
      if v_sp is not null then
        update docket.spaces set home_department_id = r.id where id = v_sp;
      else
        if exists (select 1 from docket.spaces where lower(name) = lower(r.name) and archived_at is null) then
          raise exception 'P3B team %: a space of that name exists with another owner — name it in REUSE, or rename it', r.name;
        end if;
        insert into docket.spaces (name, is_private, is_default, is_founders, is_personal, owner_user_id, created_by_user_id, home_department_id)
        values (r.name, true, false, false, false, v_head, v_head, r.id) returning id into v_sp;
        insert into docket.space_members (space_id, user_id, added_by_user_id) values (v_sp, v_head, v_head) on conflict do nothing;
        insert into docket.space_history (space_id, actor_user_id, action, note) values (v_sp, null, 'created',
          'team home space (P3b: General retired)' || case when v_interim then ' — interim owner: the Podium head has exited' else '' end);
        n_new := n_new + 1;
      end if;
    end if;
    n_teams := n_teams + 1;
    if not exists (select 1 from docket.space_teams where space_id = v_sp and department_id = r.id) then
      insert into docket.space_teams (space_id, department_id, added_by_user_id) values (v_sp, r.id, null);
      insert into docket.space_history (space_id, actor_user_id, action, note) values (v_sp, null, 'team_shared', r.name || ' (P3b)');
    end if;
    insert into p3b_target select t.id, v_sp, 'team' from docket.tasks t
     where t.space_id = G and t.parent_task_id is null and t.department_id = r.id;
  end loop;

  if exists (select 1 from jsonb_object_keys(REUSE) k where lower(k) <> all (v_matched)) then
    raise exception 'P3B a REUSE team name matched no department: %', REUSE;
  end if;
  -- 2. no team → the creator's Personal space if the creator is still here with a login, else the owner's
  --    (review #2: never a Personal space nobody will open); neither → stop (target null below)
  insert into p3b_target select t.id, coalesce(
      (select docket.ensure_personal_space(e.auth_user_id) from podium.employees e
        where e.auth_user_id = t.created_by_user_id and e.status <> 'exited' limit 1),
      (select docket.ensure_personal_space(e.auth_user_id) from podium.employees e
        where e.id = t.owner_employee_id and e.status <> 'exited' and e.auth_user_id is not null),
      -- both gone (18 archived Offline tasks, 2026-11-13): the owner's team space, else the creator's
      (select s.id from podium.employees e join docket.spaces s on s.home_department_id = e.department_id and s.archived_at is null
        where e.id = t.owner_employee_id),
      (select s.id from podium.employees e join docket.spaces s on s.home_department_id = e.department_id and s.archived_at is null
        where e.auth_user_id = t.created_by_user_id limit 1)), 'no team'
    from docket.tasks t where t.space_id = G and t.parent_task_id is null and t.department_id is null;
  -- 3. sub-tasks follow their parent
  insert into p3b_target select c.id, p.target, 'subtask' from docket.tasks c join p3b_target p on p.task_id = c.parent_task_id
   where c.space_id = G;
  if exists (select 1 from p3b_target where target is null) then
    raise exception 'P3B % no-team tasks have neither a current creator nor a current owner: %', (select count(*) from p3b_target where target is null),
      (select string_agg(t.task_no, ',') from p3b_target x join docket.tasks t on t.id = x.task_id where x.target is null);
  end if;

  -- 4. move, with history
  update docket.tasks t set space_id = x.target from p3b_target x where x.task_id = t.id and t.space_id = G;
  if (select count(*) from p3b_target) <> (select count(*) from docket.tasks t join p3b_target x on x.task_id = t.id and t.space_id = x.target) then
    raise exception 'P3B a task left General while routing — rerun';
  end if;
  insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, new_value, note, source)
  select task_id, null, 'space_changed', 'space_id', G::text, target::text, 'P3b: General retired (' || why || ')', 'system' from p3b_target;

  -- 5. records
  v_npd := (select s.id from docket.spaces s join podium.departments d on d.id = s.home_department_id
             where lower(d.name) = 'npd' and s.archived_at is null);
  if (select count(*) from docket.checklist_records where space_id = G and title ilike '%badger%') > 1 then
    raise exception 'P3B more than one Badger record in General — pin it by id';
  end if;
  if v_npd is null and exists (select 1 from docket.checklist_records where space_id = G and title ilike '%badger%') then
    raise exception 'P3B the Badger record has no NPD home space';
  end if;
  -- the owner's team home space; an owner with no team → the OWNER's Personal (records have no involvement rule,
  -- so the creator's Personal would hide it from its owner — Codex #2), else the creator's
  update docket.checklist_records cr set space_id = coalesce(
      case when cr.title ilike '%badger%' then v_npd end,
      (select s.id from docket.spaces s join podium.employees e on e.department_id = s.home_department_id
        where e.id = cr.owner_employee_id and s.archived_at is null),
      (select docket.ensure_personal_space(e.auth_user_id) from podium.employees e where e.id = cr.owner_employee_id and e.auth_user_id is not null),
      (select docket.ensure_personal_space(e.auth_user_id) from podium.employees e
        where e.auth_user_id = cr.created_by_user_id and e.status <> 'exited' limit 1))
   where cr.space_id = G;
  get diagnostics n_rec = row_count;

  select count(*) filter (where why = 'team'), count(*) filter (where why = 'no team'), count(*) filter (where why = 'subtask')
    into n_team, n_pers, n_sub from p3b_target;
  n_left := (select count(*) from docket.tasks where space_id = G);
  n_left_rec := (select count(*) from docket.checklist_records where space_id = G);
  -- Codex #1: a live task ↔ record link, or a record item's task, whose task and record now sit in different spaces
  -- where one side was moved by this run (the worker's link rule: same space, or General — gone now). The real run
  -- STOPS on any; the dry run lists the count so they can be routed by hand first.
  n_cross := (select count(*) from (
      select t.id as tid, cr.id as rid from docket.task_checklist_links l join docket.tasks t on t.id = l.task_id
        join docket.checklist_records cr on cr.id = l.record_id
       where l.removed_by_user_id is null and t.space_id <> cr.space_id
         and (exists (select 1 from p3b_target x where x.task_id = t.id) or exists (select 1 from store.safety_docket_records_p3b_2026_11_13 sr where sr.id = cr.id and sr.space_id = G))
      union
      select t.id as tid, cr.id as rid from docket.checklist_record_items i join docket.tasks t on t.id = i.task_id
        join docket.checklist_records cr on cr.id = i.record_id
       where t.space_id <> cr.space_id
         and (exists (select 1 from p3b_target x where x.task_id = t.id) or exists (select 1 from store.safety_docket_records_p3b_2026_11_13 sr where sr.id = cr.id and sr.space_id = G))) z);
  if n_left > 0 or n_left_rec > 0 then raise exception 'P3B General not empty: tasks=% records=%', n_left, n_left_rec; end if;
  if n_cross > 0 and not DRY then raise exception 'P3B % task↔record pairs would split across spaces — route them first', n_cross; end if;
  if DRY then
    raise exception 'P3B DRY teams=% new_spaces=% skipped_teams=% team_tasks=% personal_tasks=% subtasks=% records=% cross_links=% left=0',
      n_teams, n_new, n_skipped, n_team, n_pers, n_sub, n_rec, n_cross;
  end if;
  raise notice 'P3B DONE teams=% new_spaces=% skipped_teams=% team_tasks=% personal_tasks=% subtasks=% records=%',
    n_teams, n_new, n_skipped, n_team, n_pers, n_sub, n_rec;
end $p3b$;
