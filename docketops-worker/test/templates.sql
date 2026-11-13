-- F9 R9a (migration 0028) — plan templates: save shape / rights, apply all-or-nothing through plan_create and the
-- task triggers, restricted anchor → the Founders' space, history + source, the week entry, archive. One DO block
-- that always rolls back (ends by raising RESULT …). Before 0028 is applied it runs the migration inside the
-- block (execute $mig$ … $mig$, generated verbatim from migrations/0028_plan_templates.sql); after, it only checks.
-- Run via execute_sql.
-- EXPECT: 1:true/false
--   2:name_required,name_too_long,bad_audience,bad_shape,bad_shape@r,done_when_required@m,done_when_required@r,bad_offset@m,
--     role_required@m,duplicate_key@m,bad_shape@x,bad_shape@m,bad_shape@r2,too_many_nodes,
--   3:forbidden,forbidden,OK,forbidden,forbidden,OK,3,not_found  4:not_found,bad_anchor,bad_date,role_unmapped,bad_role,owner_inactive,bad_source,0
--   5:zz_boom,key,0,0,reset  6:OK,milestone/proposed+milestone/agreed+result/agreed,G18:00+G18:00,6,3,1,linked,3/2,reset  7:OK,F
--   8:anchor_not_found,not_found,bad_anchor,anchor_not_found,anchor_not_found,OK,zz res+zz lead ms
--   9:forbidden,not_found,OK,archived,archived,OK,OK,not_found  10:forbidden_space,0  11:bad_shape,leaf,bad_shape,task,0/0
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';     -- a super actor
  A1 uuid := '00000000-0000-4000-8000-0000000000a1'; A2 uuid := '00000000-0000-4000-8000-0000000000a2'; A3 uuid := '00000000-0000-4000-8000-0000000000a3';
  A4 uuid := '00000000-0000-4000-8000-0000000000a4';     -- a plan admin outside the Founders' space
  G uuid;   -- the ZZ team space every apply targets (made below; General is retired, 0039, and plan_template_apply's
            -- old no-space fallback to it is now refused). The worker always sends p_payload.space_id; so does this test.
  E1 uuid := (select id from podium.employees e where status = 'active' and department_id is not null
               and not exists (select 1 from docket.plan_items i where i.owner_employee_id = e.id) order by id limit 1);
  E2 uuid := (select id from podium.employees e where status = 'active' and department_id is not null
               and not exists (select 1 from docket.plan_items i where i.owner_employee_id = e.id) order by id offset 1 limit 1);
  E3 uuid := (select id from podium.employees e where status = 'active' and department_id is not null
               and not exists (select 1 from docket.plan_items i where i.owner_employee_id = e.id) order by id offset 2 limit 1);
  EX uuid := (select id from podium.employees where status = 'exited' order by id limit 1);
  today text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD');
  th uuid; thr uuid; ms uuid; ms2 uuid; rs uuid; tl uuid; tf uuid; tb uuid; lt jsonb; ft jsonb; roles jsonb; j jsonb; out text := ''; agg text;
begin
  if to_regclass('docket.plan_templates') is null then
    execute $mig$
-- 0028_plan_templates.sql — F9 R9a (docket_plan_templates_v1): plan templates (spec §11).
-- A template is a reusable tree of milestones / results / tasks with ROLE labels and day offsets; applying it
-- to an anchor (a theme for a `founders` template, a milestone for a `leads` one) creates every node through
-- the normal path — plan items through docket.plan_create, tasks as createTaskCore writes them — in ONE
-- transaction, all-or-nothing. No template and no plan content is seeded (the container only).
--
-- Milestone state on apply: a milestone WITH done_when is created `agreed` (so results can sit under it, §4.3
-- "parent milestone must be agreed"); without it, `proposed` (spec §11). The save RPC therefore requires
-- done_when on a milestone that has children, and on every result (results are agreed on creation).
--
-- Additive + idempotent. Tables: RLS on, no policies (the worker is service_role). Every function is
-- service_role only, like every docket RPC. Applied by the lane before the worker that calls it deploys.

-- ── tables ───────────────────────────────────────────────────────────────────
create table if not exists docket.plan_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  audience text not null check (audience in ('founders', 'leads')),
  created_by uuid not null,
  created_by_employee_id uuid references podium.employees(id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists docket.plan_template_nodes (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.plan_templates(id) on delete cascade,
  parent_node_id uuid references docket.plan_template_nodes(id) on delete cascade,
  kind text not null check (kind in ('milestone', 'result', 'task')),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  role_label text not null check (char_length(btrim(role_label)) between 1 and 40),
  offset_days int not null check (offset_days between -365 and 730),
  done_when text check (done_when is null or char_length(done_when) <= 2000),
  sort int not null default 0
);
create index if not exists plan_template_nodes_template on docket.plan_template_nodes(template_id);
alter table docket.plan_templates enable row level security;
alter table docket.plan_template_nodes enable row level security;
revoke all on docket.plan_templates, docket.plan_template_nodes from public, anon, authenticated;
grant all on docket.plan_templates, docket.plan_template_nodes to service_role;

-- plan_create writes its history row without a source; inside an apply the RPC sets docket.source (as
-- task_set_deadline does), so the generated items' `created` rows say 'connector' when the connector applied
-- them. Every other writer leaves the setting unset → 'app', as before.
alter table docket.plan_item_history alter column source set default coalesce(nullif(current_setting('docket.source', true), ''), 'app');

-- ── who is a lead: owns an agreed milestone or result (anywhere — owning is owning) ─────
create or replace function docket.plan_is_lead(p_employee uuid)
returns boolean
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  select p_employee is not null and exists (
    select 1 from docket.plan_items i
     where i.owner_employee_id = p_employee and i.kind in ('milestone', 'result') and i.state = 'agreed');
$function$;

-- ── save: replace a template's whole node set, atomically ────────────────────
-- p_template = { id?, name, description?, audience, nodes: [{ key, parent_key|null, kind, title, role_label,
--                offset_days, done_when?, sort? }] } → { ok, id } | { ok:false, code, key? }
-- Shape: founders — roots are milestones, a result's parent a milestone, a task's a milestone or result.
--        leads    — roots are results or tasks, a task's parent (if any) a result. Tasks have no children.
-- (Each kind's parent is strictly a "higher" kind, so the tree has no cycle and depth ≤ 3 by construction.)
create or replace function docket.plan_template_save(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_template jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  v_id uuid; v_t docket.plan_templates;
  v_name text; v_desc text; v_aud text; v_nodes jsonb; n jsonb;
  v_key text; v_pkey text; v_kind text; v_pkind text; v_title text; v_role text; v_off int; v_dw text; v_sort int;
  v_kinds jsonb := '{}'; v_ids jsonb := '{}'; v_children jsonb := '{}'; v_i int := 0; v_nid uuid; v_pass text;
begin
  if jsonb_typeof(p_template) is distinct from 'object' then return jsonb_build_object('ok', false, 'code', 'bad_node'); end if;
  v_name := btrim(coalesce(p_template->>'name', ''));
  if v_name = '' then return jsonb_build_object('ok', false, 'code', 'name_required'); end if;
  if char_length(v_name) > 120 then return jsonb_build_object('ok', false, 'code', 'name_too_long'); end if;
  v_desc := nullif(btrim(coalesce(p_template->>'description', '')), '');
  if char_length(v_desc) > 2000 then return jsonb_build_object('ok', false, 'code', 'description_too_long'); end if;
  v_aud := p_template->>'audience';
  if v_aud is null or v_aud not in ('founders', 'leads') then return jsonb_build_object('ok', false, 'code', 'bad_audience'); end if;

  -- Rights. New: founders → super; leads → super or a lead. Existing: super or its creator; only super
  -- changes the audience; archived is read-only.
  if nullif(p_template->>'id', '') is not null then
    v_id := docket.plan_try_uuid(p_template->>'id');
    if v_id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
    perform pg_advisory_xact_lock(hashtext('docket.plan_template:' || v_id::text));
    select * into v_t from docket.plan_templates where id = v_id for update;
    -- One the caller can't even see (as the reads decide it) is missing; one they see but didn't make is forbidden.
    if v_t.id is null or (not v_super and (v_t.audience = 'founders'
         or (v_t.created_by is distinct from p_actor and not docket.plan_is_lead(p_actor_employee)))) then
      return jsonb_build_object('ok', false, 'code', 'not_found');
    end if;
    if not v_super and v_t.created_by is distinct from p_actor then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
    if v_t.archived_at is not null then return jsonb_build_object('ok', false, 'code', 'archived'); end if;
    if not v_super and v_aud <> v_t.audience then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
  else
    if v_aud = 'founders' and not v_super then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
    if v_aud = 'leads' and not v_super and not docket.plan_is_lead(p_actor_employee) then
      return jsonb_build_object('ok', false, 'code', 'forbidden');
    end if;
  end if;

  -- Nodes: each one on its own, then the shape.
  v_nodes := p_template->'nodes';
  if jsonb_typeof(v_nodes) is distinct from 'array' or jsonb_array_length(v_nodes) = 0 then
    return jsonb_build_object('ok', false, 'code', 'bad_shape');
  end if;
  if jsonb_array_length(v_nodes) > 200 then return jsonb_build_object('ok', false, 'code', 'too_many_nodes'); end if;
  for n in select * from jsonb_array_elements(v_nodes) loop
    if jsonb_typeof(n) is distinct from 'object' then return jsonb_build_object('ok', false, 'code', 'bad_node'); end if;
    v_key := nullif(btrim(coalesce(n->>'key', '')), '');
    if v_key is null or char_length(v_key) > 100 then return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key); end if;
    if v_kinds ? v_key then return jsonb_build_object('ok', false, 'code', 'duplicate_key', 'key', v_key); end if;
    v_kind := n->>'kind';
    if v_kind is null or v_kind not in ('milestone', 'result', 'task') then return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key); end if;
    v_title := btrim(coalesce(n->>'title', ''));
    if char_length(v_title) not between 1 and 300 then return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key); end if;
    v_role := btrim(coalesce(n->>'role_label', ''));
    if char_length(v_role) not between 1 and 40 then return jsonb_build_object('ok', false, 'code', 'role_required', 'key', v_key); end if;
    if jsonb_typeof(n->'offset_days') is distinct from 'number' or (n->>'offset_days') !~ '^-?[0-9]{1,3}$'
       or (n->>'offset_days')::int not between -365 and 730 then
      return jsonb_build_object('ok', false, 'code', 'bad_offset', 'key', v_key);
    end if;
    if char_length(btrim(coalesce(n->>'done_when', ''))) > 2000 then return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key); end if;
    if n ? 'sort' and jsonb_typeof(n->'sort') not in ('number', 'null') then return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key); end if;
    if (n ? 'sort') and jsonb_typeof(n->'sort') = 'number' and (n->>'sort') !~ '^-?[0-9]{1,6}$' then
      return jsonb_build_object('ok', false, 'code', 'bad_node', 'key', v_key);
    end if;
    v_kinds := v_kinds || jsonb_build_object(v_key, v_kind);
  end loop;
  for n in select * from jsonb_array_elements(v_nodes) loop
    v_key := btrim(n->>'key'); v_kind := n->>'kind';
    v_pkey := nullif(btrim(coalesce(n->>'parent_key', '')), '');
    if v_pkey is not null and not (v_kinds ? v_pkey) then return jsonb_build_object('ok', false, 'code', 'bad_shape', 'key', v_key); end if;
    v_pkind := case when v_pkey is null then null else v_kinds->>v_pkey end;
    if not coalesce(case v_aud
      when 'founders' then (v_kind = 'milestone' and v_pkind is null) or (v_kind = 'result' and v_pkind = 'milestone')
                           or (v_kind = 'task' and v_pkind in ('milestone', 'result'))
      else (v_kind = 'result' and v_pkind is null) or (v_kind = 'task' and (v_pkind is null or v_pkind = 'result'))
    end, false) then   -- coalesce: a root's parent kind is null, and `not null` would let it through
      return jsonb_build_object('ok', false, 'code', 'bad_shape', 'key', v_key);
    end if;
    if v_pkey is not null then v_children := v_children || jsonb_build_object(v_pkey, true); end if;
  end loop;
  for n in select * from jsonb_array_elements(v_nodes) loop
    v_key := btrim(n->>'key'); v_kind := n->>'kind';
    if (v_kind = 'result' or (v_kind = 'milestone' and v_children ? v_key)) and btrim(coalesce(n->>'done_when', '')) = '' then
      return jsonb_build_object('ok', false, 'code', 'done_when_required', 'key', v_key);
    end if;
  end loop;

  -- Write: the template row, then the node set (delete + insert), parents before children.
  if v_id is null then
    insert into docket.plan_templates (name, description, audience, created_by, created_by_employee_id)
    values (v_name, v_desc, v_aud, p_actor, p_actor_employee) returning id into v_id;
  else
    update docket.plan_templates set name = v_name, description = v_desc, audience = v_aud, updated_at = now() where id = v_id;
    delete from docket.plan_template_nodes where template_id = v_id;
  end if;
  foreach v_pass in array array['milestone', 'result', 'task'] loop
    v_i := 0;
    for n in select * from jsonb_array_elements(v_nodes) loop
      v_i := v_i + 1;
      continue when n->>'kind' <> v_pass;
      v_key := btrim(n->>'key'); v_pkey := nullif(btrim(coalesce(n->>'parent_key', '')), '');
      v_sort := case when jsonb_typeof(n->'sort') = 'number' then (n->>'sort')::int else v_i * 10 end;
      insert into docket.plan_template_nodes (template_id, parent_node_id, kind, title, role_label, offset_days, done_when, sort)
      values (v_id, case when v_pkey is null then null else (v_ids->>v_pkey)::uuid end, v_pass, btrim(n->>'title'),
              btrim(n->>'role_label'), (n->>'offset_days')::int, nullif(btrim(coalesce(n->>'done_when', '')), ''), v_sort)
      returning id into v_nid;
      v_ids := v_ids || jsonb_build_object(v_key, v_nid);
    end loop;
  end loop;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- ── archive / unarchive ──────────────────────────────────────────────────────
-- Answers like the reads: a template the caller can't see → not_found (the caller's employee is the one linked
-- to their auth user, as the worker resolves it); visible but not theirs → forbidden.
create or replace function docket.plan_template_archive(p_actor uuid, p_is_super boolean, p_id uuid, p_archive boolean)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare v_t docket.plan_templates; v_super boolean := coalesce(p_is_super, false);
begin
  select * into v_t from docket.plan_templates where id = p_id for update;
  if v_t.id is null or (not v_super and (v_t.audience = 'founders'
       or (v_t.created_by is distinct from p_actor
           and not docket.plan_is_lead((select e.id from podium.employees e where e.auth_user_id = p_actor limit 1))))) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not v_super and v_t.created_by is distinct from p_actor then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
  update docket.plan_templates
     set archived_at = case when coalesce(p_archive, true) then coalesce(archived_at, now()) end, updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'archived', coalesce(p_archive, true));
end;
$function$;

-- ── apply ────────────────────────────────────────────────────────────────────
-- p_payload = { anchor_id, anchor_date: 'YYYY-MM-DD', roles: { "<label>": "<employee uuid>", … } }
-- → { ok:true, items: [{ key, id, code, kind, state }], tasks: [{ key, id, task_no }] } (key = the template
--   node id) | { ok:false, code, key?, label? }. All-or-nothing: the generation runs in an inner block whose
--   exception handler rolls back every node already written and returns the code (never raises).
create or replace function docket.plan_template_apply(p_actor uuid, p_actor_employee uuid, p_is_super boolean,
  p_template_id uuid, p_payload jsonb, p_source text default 'app')
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  v_t docket.plan_templates; v_anchor docket.plan_items; v_anchor_id uuid; v_date date; v_roles jsonb;
  v_restricted boolean; v_space uuid; v_label text; v_emp uuid; v_status text; v_dept uuid;
  v_map jsonb := '{}';      -- lower(label) → employee id
  v_ids jsonb := '{}';      -- node id → created item id
  v_items jsonb := '[]'; v_tasks jsonb := '[]';
  nd docket.plan_template_nodes; j jsonb; v_parent uuid; v_due date; v_deadline timestamptz; v_tid uuid; v_tno text;
  v_fail jsonb; v_cur text; k text; v_pkind text;
begin
  if p_source is null or p_source not in ('app', 'connector') then return jsonb_build_object('ok', false, 'code', 'bad_source'); end if;
  select * into v_t from docket.plan_templates where id = p_template_id for share;
  -- A template the caller can't see is a missing one (no oracle).
  if v_t.id is null or (v_t.audience = 'founders' and not v_super)
     or (v_t.audience = 'leads' and not v_super and not docket.plan_is_lead(p_actor_employee)) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_t.archived_at is not null then return jsonb_build_object('ok', false, 'code', 'archived'); end if;

  v_anchor_id := docket.plan_try_uuid(p_payload->>'anchor_id');
  select * into v_anchor from docket.plan_items where id = v_anchor_id;
  -- Below F the only anchor that exists is an agreed, unrestricted milestone the caller owns: anything else —
  -- missing, someone else's, the wrong kind or state — is the same anchor_not_found (no oracle).
  if v_anchor.id is null or (not v_super and (docket.plan_restricted(v_anchor.id) or v_anchor.kind <> 'milestone'
       or v_anchor.state <> 'agreed' or v_anchor.owner_employee_id is distinct from p_actor_employee)) then
    return jsonb_build_object('ok', false, 'code', 'anchor_not_found');
  end if;
  if v_anchor.state <> 'agreed' or v_anchor.kind <> (case v_t.audience when 'founders' then 'theme' else 'milestone' end) then
    return jsonb_build_object('ok', false, 'code', 'bad_anchor');
  end if;

  if coalesce(p_payload->>'anchor_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return jsonb_build_object('ok', false, 'code', 'bad_date'); end if;
  begin
    v_date := (p_payload->>'anchor_date')::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'bad_date');
  end;

  -- Roles: every label (case-insensitive, trimmed) → an active employee; nothing else in `roles`.
  v_roles := coalesce(p_payload->'roles', '{}');
  if jsonb_typeof(v_roles) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_role'); end if;
  for k in select jsonb_object_keys(v_roles) loop
    if not exists (select 1 from docket.plan_template_nodes x where x.template_id = v_t.id and lower(btrim(x.role_label)) = lower(btrim(k))) then
      return jsonb_build_object('ok', false, 'code', 'bad_role', 'label', k);
    end if;
    v_map := v_map || jsonb_build_object(lower(btrim(k)), v_roles->>k);
  end loop;
  for v_label in select min(btrim(x.role_label)) from docket.plan_template_nodes x where x.template_id = v_t.id
                  group by lower(btrim(x.role_label)) order by 1 loop
    v_emp := docket.plan_try_uuid(v_map->>lower(v_label));
    if v_emp is null then return jsonb_build_object('ok', false, 'code', 'role_unmapped', 'label', v_label); end if;
    select e.status into v_status from podium.employees e where e.id = v_emp;
    if not found then return jsonb_build_object('ok', false, 'code', 'role_unmapped', 'label', v_label); end if;
    if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'owner_inactive', 'label', v_label); end if;
    v_map := v_map || jsonb_build_object(lower(v_label), v_emp);
  end loop;

  -- Tasks land in General, or — under a restricted anchor — the Founders' space (tasks_plan_guard insists).
  v_restricted := docket.plan_restricted(v_anchor.id);
  if v_restricted then
    select s.id into v_space from docket.spaces s where s.is_founders and s.archived_at is null order by s.created_at limit 1;
    if v_space is null then return jsonb_build_object('ok', false, 'code', 'founders_space_missing'); end if;
  else
    select s.id into v_space from docket.spaces s where s.is_default order by s.created_at limit 1;
  end if;
  -- The space gate beats admin (RULE-DOCKET-003): exactly the worker's canAccessSpace — General, its owner, or a
  -- member. A plan admin outside the Founders' space can't put tasks there (createTaskCore: forbidden_space).
  if not exists (select 1 from docket.spaces s where s.id = v_space and (s.is_default or s.owner_user_id = p_actor
                   or exists (select 1 from docket.space_members m where m.space_id = s.id and m.user_id = p_actor))) then
    return jsonb_build_object('ok', false, 'code', 'forbidden_space');
  end if;

  perform set_config('docket.source', p_source, true);
  begin
    -- Parents before children: every node's parent is a strictly higher kind.
    for nd in select * from docket.plan_template_nodes x where x.template_id = v_t.id
               order by case x.kind when 'milestone' then 1 when 'result' then 2 else 3 end, x.sort, x.id loop
      v_cur := nd.id::text;
      -- The save RPC enforced the shape; re-check it here (a node set edited outside it must never produce an
      -- unlinked task or a misplaced item): the parent node must be generated already, and the kinds must fit.
      v_pkind := (select x.kind from docket.plan_template_nodes x where x.id = nd.parent_node_id);
      if (nd.parent_node_id is not null and not (v_ids ? nd.parent_node_id::text)) or not coalesce(case v_t.audience
           when 'founders' then (nd.kind = 'milestone' and v_pkind is null) or (nd.kind = 'result' and v_pkind = 'milestone')
                                or (nd.kind = 'task' and v_pkind in ('milestone', 'result'))
           else (nd.kind = 'result' and v_pkind is null) or (nd.kind = 'task' and (v_pkind is null or v_pkind = 'result'))
         end, false) then
        v_fail := jsonb_build_object('code', 'bad_shape');
        raise exception 'plan_template_apply_abort';
      end if;
      v_emp := (v_map->>lower(btrim(nd.role_label)))::uuid;
      v_due := v_date + nd.offset_days;
      v_parent := case when nd.parent_node_id is null then v_anchor.id else (v_ids->>nd.parent_node_id::text)::uuid end;
      if nd.kind in ('milestone', 'result') then
        j := docket.plan_create(p_actor, p_actor_employee, v_super, jsonb_strip_nulls(jsonb_build_object(
          'kind', nd.kind, 'parent_id', v_parent, 'title', nd.title, 'owner_employee_id', v_emp, 'due_date', v_due,
          'done_when', nd.done_when,
          'state', case when nd.kind = 'milestone' then case when nd.done_when is not null then 'agreed' else 'proposed' end end)));
        if not coalesce((j->>'ok')::boolean, false) then
          v_fail := j - 'ok';
          raise exception 'plan_template_apply_abort';
        end if;
        v_ids := v_ids || jsonb_build_object(nd.id::text, j->>'id');
        v_items := v_items || jsonb_build_object('key', nd.id, 'id', j->>'id', 'code', j->>'code', 'kind', nd.kind,
          'state', (select i.state from docket.plan_items i where i.id = (j->>'id')::uuid));
      else
        select e.department_id into v_dept from podium.employees e where e.id = v_emp;
        v_deadline := ((v_due::timestamp + time '18:00') at time zone 'Asia/Kolkata');
        v_tno := docket.next_task_seq();
        insert into docket.tasks (task_no, title, department_id, owner_employee_id, status, priority, created_by_user_id,
                                  deadline, space_id, plan_item_id)
        values (v_tno, nd.title, v_dept, v_emp, 'not_started', 'P2', p_actor, v_deadline, v_space, v_parent)
        returning id into v_tid;
        insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, source) values
          (v_tid, p_actor, 'created', null, null, p_source),
          (v_tid, p_actor, 'deadline_set', 'deadline', docket.iso_utc(v_deadline), p_source),
          (v_tid, p_actor, 'plan_item_id_changed', 'plan_item_id', v_parent::text, p_source);
        v_tasks := v_tasks || jsonb_build_object('key', nd.id, 'id', v_tid, 'task_no', v_tno);
      end if;
    end loop;
  exception when others then
    perform set_config('docket.source', '', true);   -- as task_set_deadline: the setting never outlives the call
    if sqlerrm = 'plan_template_apply_abort' then
      return jsonb_build_object('ok', false, 'key', v_cur) || v_fail;
    end if;
    return jsonb_build_object('ok', false, 'code', sqlerrm, 'key', v_cur);
  end;
  perform set_config('docket.source', '', true);
  return jsonb_build_object('ok', true, 'items', v_items, 'tasks', v_tasks);
end;
$function$;

revoke all on function docket.plan_is_lead(uuid) from public, anon, authenticated;
revoke all on function docket.plan_template_save(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_template_archive(uuid, boolean, uuid, boolean) from public, anon, authenticated;
revoke all on function docket.plan_template_apply(uuid, uuid, boolean, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function docket.plan_is_lead(uuid) to service_role;
grant execute on function docket.plan_template_save(uuid, uuid, boolean, jsonb) to service_role;
grant execute on function docket.plan_template_archive(uuid, boolean, uuid, boolean) to service_role;
grant execute on function docket.plan_template_apply(uuid, uuid, boolean, uuid, jsonb, text) to service_role;

notify pgrst, 'reload schema';
$mig$;
  end if;
  -- ── fixtures (all rolled back) ──
  insert into docket.plan_items (kind, code, title, state) values ('theme', 'ZZT1', 'zz theme', 'agreed') returning id into th;
  insert into docket.plan_items (kind, code, title, state, restricted) values ('theme', 'ZZT2', 'zz secret theme', 'agreed', true) returning id into thr;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('milestone', 'ZZM1', th, 'zz lead ms', E1, 'agreed', current_date + 30, 'zz') returning id into ms;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('milestone', 'ZZM2', th, 'zz other ms', E2, 'agreed', current_date + 30, 'zz') returning id into ms2;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('result', 'ZZM1.R9', ms, 'zz other res', E2, 'agreed', current_date + 20, 'zz') returning id into rs;
  -- each actor is linked to its employee (as the worker resolves auth.employeeId); A is in the Founders' space
  update podium.employees set auth_user_id = A1 where id = E1;
  update podium.employees set auth_user_id = A2 where id = E2;
  update podium.employees set auth_user_id = A3 where id = E3;
  insert into docket.space_members (space_id, user_id)
    select s.id, A from docket.spaces s where s.is_founders and not exists (select 1 from docket.space_members m where m.space_id = s.id and m.user_id = A);
  -- the target team space: A owns it, the lead A1 is a member (both pass plan_template_apply's space gate)
  insert into docket.spaces (name, is_private, is_default, is_personal, owner_user_id, created_by_user_id)
    values ('ZZ tpl team', true, false, false, A, A) returning id into G;
  insert into docket.space_members (space_id, user_id) values (G, A), (G, A1);

  -- 1 lead: E1 owns an agreed milestone, E3 owns nothing
  out := out || '1:' || docket.plan_is_lead(E1)::text || '/' || docket.plan_is_lead(E3)::text || ' ';

  -- 2 save: shape + field errors (super, founders)
  agg := '';
  for j in select * from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('name', ' ', 'audience', 'founders', 'nodes', '[]'::jsonb),
      jsonb_build_object('name', repeat('x', 121), 'audience', 'founders', 'nodes', '[]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'staff', 'nodes', '[]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"r","kind":"result","title":"t","role_label":"A","offset_days":1,"done_when":"d"}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1},{"key":"r","parent_key":"m","kind":"result","title":"t","role_label":"A","offset_days":1,"done_when":"d"}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1,"done_when":"d"},{"key":"r","parent_key":"m","kind":"result","title":"t","role_label":"A","offset_days":1}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":731}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":" ","offset_days":1}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1},{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1,"done_when":"d"},{"key":"t","parent_key":"m","kind":"task","title":"t","role_label":"A","offset_days":1},{"key":"x","parent_key":"t","kind":"task","title":"t","role_label":"A","offset_days":1}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'leads', 'nodes', '[{"key":"m","kind":"milestone","title":"t","role_label":"A","offset_days":1}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'leads', 'nodes', '[{"key":"r","kind":"result","title":"t","role_label":"A","offset_days":1,"done_when":"d"},{"key":"r2","parent_key":"r","kind":"result","title":"t","role_label":"A","offset_days":1,"done_when":"d"}]'::jsonb),
      jsonb_build_object('name', 'zz', 'audience', 'founders', 'nodes', (select jsonb_agg(jsonb_build_object('key', 'k' || gs.n, 'kind', 'milestone', 'title', 't', 'role_label', 'A', 'offset_days', 1)) from generate_series(1, 201) gs(n)))
    )) loop
    agg := agg || coalesce(docket.plan_template_save(A, null, true, j)->>'code', 'OK') || coalesce('@' || (docket.plan_template_save(A, null, true, j)->>'key'), '') || ',';
  end loop;
  out := out || '2:' || agg || ' ';

  -- 3 rights: a non-lead can't make a leads template; a lead can't make a founders one; a lead makes a leads
  --   one; another lead can't edit it; the creator can't change its audience
  lt := '{"name":"zz leads tpl","audience":"leads","nodes":[{"key":"r","kind":"result","title":"zz res","role_label":"Owner","offset_days":3,"done_when":"d"},{"key":"t","parent_key":"r","kind":"task","title":"zz lead task","role_label":"owner ","offset_days":0},{"key":"t2","kind":"task","title":"zz root task","role_label":"Helper","offset_days":-2}]}';
  out := out || '3:' || coalesce(docket.plan_template_save(A3, E3, false, lt)->>'code', 'OK') || ','
               || coalesce(docket.plan_template_save(A1, E1, false, jsonb_set(lt, '{audience}', '"founders"'))->>'code', 'OK') || ',';
  j := docket.plan_template_save(A1, E1, false, lt);
  tl := (j->>'id')::uuid;
  out := out || coalesce(j->>'code', 'OK') || ','
               || coalesce(docket.plan_template_save(A2, E2, false, lt || jsonb_build_object('id', tl))->>'code', 'OK') || ','
               || coalesce(docket.plan_template_save(A1, E1, false, jsonb_set(lt, '{audience}', '"founders"') || jsonb_build_object('id', tl))->>'code', 'OK') || ','
               || coalesce(docket.plan_template_save(A1, E1, false, jsonb_set(lt, '{name}', '"zz leads tpl v2"') || jsonb_build_object('id', tl))->>'code', 'OK') || ','
               || (select count(*) from docket.plan_template_nodes where template_id = tl)::text || ','
               || coalesce(docket.plan_template_save(A3, E3, false, lt || jsonb_build_object('id', tl))->>'code', 'OK') || ' ';

  -- 4 the founders template: M (agreed) → R + T under R + T under M; a leaf milestone (proposed)
  ft := '{"name":"zz founders tpl","audience":"founders","nodes":[
    {"key":"m","kind":"milestone","title":"zz gen ms","role_label":"Lead","offset_days":30,"done_when":"d"},
    {"key":"r","parent_key":"m","kind":"result","title":"zz gen res","role_label":"Lead","offset_days":20,"done_when":"d"},
    {"key":"t","parent_key":"r","kind":"task","title":"zz gen task","role_label":"Doer","offset_days":0},
    {"key":"t2","parent_key":"m","kind":"task","title":"zz gen task2","role_label":"Doer","offset_days":5},
    {"key":"l","kind":"milestone","title":"zz gen leaf","role_label":"Lead","offset_days":40}]}';
  tf := (docket.plan_template_save(A, null, true, ft)->>'id')::uuid;
  roles := jsonb_build_object('lead', E1, 'DOER', E2);
  -- a lead can't see / apply it; bad inputs refused before anything is written
  out := out || '4:' || coalesce(docket.plan_template_apply(A1, E1, false, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', '2026-02-30', 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', jsonb_build_object('Lead', E1)))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles || jsonb_build_object('Nobody', E1)))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', jsonb_build_object('Lead', E1, 'Doer', EX)))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles), 'mcp')->>'code', 'OK') || ','
    || (select count(*) from docket.plan_items where title like 'zz gen%')::text || ' ';

  -- 5 all-or-nothing: a trigger exception on the LAST task rolls back the items + tasks already written
  create function pg_temp.zz_boom() returns trigger language plpgsql as $b$ begin
    if new.title = 'zz gen task2' then raise exception 'zz_boom'; end if; return new; end $b$;
  create trigger zz_boom before insert on docket.tasks for each row execute function pg_temp.zz_boom();
  j := docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles), 'connector');
  out := out || '5:' || coalesce(j->>'code', 'OK') || ',' || (case when j->>'key' is not null then 'key' else 'NOKEY' end) || ','
    || (select count(*) from docket.plan_items where title like 'zz gen%')::text || ','
    || (select count(*) from docket.tasks where title like 'zz gen%')::text || ','
    || case when coalesce(current_setting('docket.source', true), '') = '' then 'reset' else 'LEFT' end || ' ';
  drop trigger zz_boom on docket.tasks;

  -- 6 apply for real (connector): states, codes, the picked space (G), deadlines 18:00 IST, history + source,
  --   the week entry for the task dated today
  j := docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles), 'connector');
  out := out || '6:' || coalesce(j->>'code', 'OK') || ','
    || (select string_agg(i.kind || '/' || i.state, '+' order by i.title) from docket.plan_items i where i.title like 'zz gen%') || ','
    || (select string_agg(case when t.space_id = G then 'G' else 'X' end || to_char(t.deadline at time zone 'Asia/Kolkata', 'HH24:MI'), '+' order by t.title)
          from docket.tasks t where t.title like 'zz gen%') || ','
    || (select count(*) from docket.task_history h join docket.tasks t on t.id = h.task_id where t.title like 'zz gen%' and h.source = 'connector'
          and h.event_type in ('created', 'deadline_set', 'plan_item_id_changed') and h.actor_user_id = A)::text || ','
    || (select count(*) from docket.plan_item_history h join docket.plan_items i on i.id = h.item_id where i.title like 'zz gen%' and h.source = 'connector')::text || ','
    || (select count(*) from docket.week_commitments w join docket.tasks t on t.id = w.task_id where t.title = 'zz gen task' and w.entry_reason = 'first_commitment')::text || ','
    || (select case when t.plan_item_id = (select id from docket.plan_items where title = 'zz gen res') and t.owner_employee_id = E2
                     and t.department_id is not distinct from (select department_id from podium.employees where id = E2) then 'linked' else 'WRONG' end
          from docket.tasks t where t.title = 'zz gen task') || ','
    || jsonb_array_length(j->'items')::text || '/' || jsonb_array_length(j->'tasks')::text || ','
    || case when coalesce(current_setting('docket.source', true), '') = '' then 'reset' else 'LEFT:' || current_setting('docket.source', true) end || ' ';

  -- 7 a restricted anchor → the tasks land in the Founders' space
  j := docket.plan_template_apply(A, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', thr, 'anchor_date', today, 'roles', roles));
  out := out || '7:' || coalesce(j->>'code', 'OK') || ','
    || coalesce((select string_agg(distinct case when s.is_founders then 'F' else 'NOTF' end, '') from docket.tasks t join docket.spaces s on s.id = t.space_id
          where t.id in (select (x->>'id')::uuid from jsonb_array_elements(coalesce(j->'tasks', '[]')) x)), 'NONE') || ' ';

  -- 8 leads apply: the anchor milestone's owner (a lead) yes; another lead on someone else's milestone → anchor_not_found;
  --   a non-lead → not_found; a theme anchor → bad_anchor
  roles := jsonb_build_object('Owner', E1, 'Helper', E2);
  out := out || '8:' || coalesce(docket.plan_template_apply(A2, E2, false, tl, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A3, E3, false, tl, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A, null, true, tl, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A1, E1, false, tl, jsonb_build_object('space_id', G, 'anchor_id', rs, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A1, E1, false, tl, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ',';
  j := docket.plan_template_apply(A1, E1, false, tl, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles));
  out := out || coalesce(j->>'code', 'OK') || ','
    || coalesce((select string_agg(coalesce(p.title, 'NONE'), '+' order by t.title) from docket.tasks t left join docket.plan_items p on p.id = t.plan_item_id
          where t.id in (select (x->>'id')::uuid from jsonb_array_elements(coalesce(j->'tasks', '[]')) x)), 'NONE') || ' ';

  -- 9 archive blocks apply (and only super / the creator may archive); unarchive restores
  out := out || '9:' || coalesce(docket.plan_template_archive(A2, false, tl, true)->>'code', 'OK') || ','
    || coalesce(docket.plan_template_archive(A3, false, tl, true)->>'code', 'OK') || ','
    || coalesce(docket.plan_template_archive(A1, false, tl, true)->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A1, E1, false, tl, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_save(A1, E1, false, lt || jsonb_build_object('id', tl))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_archive(A1, false, tl, false)->>'code', 'OK') || ','
    || coalesce(docket.plan_template_apply(A1, E1, false, tl, jsonb_build_object('space_id', G, 'anchor_id', ms, 'anchor_date', today, 'roles', roles))->>'code', 'OK') || ','
    || coalesce(docket.plan_template_archive(A1, false, tf, true)->>'code', 'OK') || ' ';

  -- 10 the space gate beats admin: a plan admin who isn't in the Founders' space can't apply under a restricted
  --    theme (nothing written)
  j := docket.plan_template_apply(A4, null, true, tf, jsonb_build_object('space_id', G, 'anchor_id', thr, 'anchor_date', today, 'roles', jsonb_build_object('lead', E1, 'DOER', E2)), 'connector');
  out := out || '10:' || coalesce(j->>'code', 'OK') || ','
    || (select count(*) from docket.plan_items i where i.title like 'zz gen%' and i.created_by_user_id = A4)::text || ' ';

  -- 11 apply re-checks the shape: a node edited outside the save RPC (a root result in a founders template; a task
  --    whose parent node belongs to another template) aborts with bad_shape + its key and leaves nothing
  tb := (docket.plan_template_save(A, null, true, '{"name":"zz bad tpl","audience":"founders","nodes":[
    {"key":"m","kind":"milestone","title":"zz bad ms","role_label":"Lead","offset_days":3,"done_when":"d"},
    {"key":"t","parent_key":"m","kind":"task","title":"zz bad task","role_label":"Lead","offset_days":1},
    {"key":"l","kind":"milestone","title":"zz bad leaf","role_label":"Lead","offset_days":4}]}'::jsonb)->>'id')::uuid;
  update docket.plan_template_nodes set kind = 'result', done_when = 'd' where template_id = tb and title = 'zz bad leaf';
  j := docket.plan_template_apply(A, null, true, tb, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', jsonb_build_object('Lead', E1)));
  out := out || '11:' || coalesce(j->>'code', 'OK') || ','
    || case when j->>'key' = (select id::text from docket.plan_template_nodes where template_id = tb and title = 'zz bad leaf') then 'leaf' else 'WRONGKEY' end || ',';
  update docket.plan_template_nodes set kind = 'milestone', done_when = null where template_id = tb and title = 'zz bad leaf';
  update docket.plan_template_nodes set parent_node_id = (select id from docket.plan_template_nodes where template_id = tl and kind = 'result')
   where template_id = tb and title = 'zz bad task';
  j := docket.plan_template_apply(A, null, true, tb, jsonb_build_object('space_id', G, 'anchor_id', th, 'anchor_date', today, 'roles', jsonb_build_object('Lead', E1)));
  out := out || coalesce(j->>'code', 'OK') || ','
    || case when j->>'key' = (select id::text from docket.plan_template_nodes where template_id = tb and title = 'zz bad task') then 'task' else 'WRONGKEY' end || ','
    || (select count(*) from docket.plan_items where title like 'zz bad%')::text || '/' || (select count(*) from docket.tasks where title like 'zz bad%')::text;

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $$;
