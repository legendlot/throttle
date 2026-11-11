-- 0019_plan_r3.sql — F9 Release 3: lifecycle depth (spec 2026-11-11-docket-plan-layer.md §4.3 split,
-- §4.3.1, §4.4 measure, §4.5 proposals, §12 R3)
--
-- 1. The matrix gains `split` (plan_can: super only; plan_state_ok: an AGREED milestone or result).
--    plan-core.mjs mirrors it (and apps/docket lib/plan.js mirrors that) — change all three together.
-- 2. docket.plan_split — ONE transaction: N agreed siblings (split_from_id = the original), every result
--    under a split milestone moved to a child or dropped, every OPEN top-level task linked to the original
--    (or to a result being dropped) re-linked, the original → `split` (terminal, read-only: plan_update /
--    plan_act refuse it through plan_state_ok). Super only; below F the item does not exist (not_found).
--    "Open" = status not done/abandoned AND not archived (an archived task is hidden everywhere, 0015, and
--    keeps its link like a done one). Task history: one `plan_item_id_changed` row per re-linked task,
--    ids only, never titles or codes (§5.3) — the same shape logHistory writes.
-- 3. Measure (§4.4): the SQL keeps validating `measure` is an object; the WORKER validates system + metric
--    against src/plan-metrics.mjs and sets source_ok from it (never trusted from the client).
-- 4. docket.plan_proposals + plan_propose / plan_proposal_decide / plan_proposals_for (§4.5). A proposer
--    sees only their own submissions and the outcome; an accepted item's code + title only when
--    plan_items_for gives them that item (F / O). Accepting a milestone runs docket.plan_create in the
--    same transaction.
--
-- Additive + idempotent. Every function is service_role only, like every docket RPC.

begin;

-- ── 1. the matrix: + split ───────────────────────────────────────────────────
create or replace function docket.plan_can(p_kind text, p_action text, p_super boolean, p_owner boolean, p_parent_owner boolean)
returns boolean
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select case
    when p_kind not in ('theme', 'milestone', 'result') then false
    when p_action not in ('create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'split', 'drop', 'done', 'reopen') then false
    when coalesce(p_super, false) then true
    when p_kind <> 'result' then false
    when p_action in ('edit', 'done') then coalesce(p_owner, false) or coalesce(p_parent_owner, false)
    when p_action in ('create', 'owner', 'redate') then coalesce(p_parent_owner, false)
    else false
  end;
$function$;

-- WHEN. `split` the action: an agreed milestone or result. `split` the state: terminal and read-only —
-- no action lists it.
create or replace function docket.plan_state_ok(p_kind text, p_action text, p_state text)
returns boolean
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select coalesce(case p_action
    when 'edit'       then p_state in ('proposed', 'agreed')
    when 'edit_admin' then p_state in ('proposed', 'agreed')
    when 'owner'      then p_state in ('proposed', 'agreed')
    when 'agree'      then p_kind = 'milestone' and p_state = 'proposed'
    when 'redate'     then p_kind <> 'theme' and p_state = 'agreed'
    when 'split'      then p_kind in ('milestone', 'result') and p_state = 'agreed'
    when 'drop'       then case when p_kind = 'milestone' then p_state in ('proposed', 'agreed') else p_state = 'agreed' end
    when 'done'       then p_kind <> 'theme' and p_state = 'agreed'
    when 'reopen'     then case when p_kind = 'theme' then p_state = 'dropped' else p_state in ('done', 'dropped') end
    else false
  end, false);
$function$;

-- ── 2. split (§4.3.1) ────────────────────────────────────────────────────────
-- Payload helpers (SQL does not promise AND/OR evaluation order, so no cast sits behind a guard in the
-- same expression): a text → uuid or null; a jsonb whole number in 0..n-1 → int or null.
create or replace function docket.plan_try_uuid(p text)
returns uuid
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end;
$function$;
create or replace function docket.plan_child_index(p jsonb, p_n int)
returns int
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select case when jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,3}$'
              then case when (p #>> '{}')::int < p_n then (p #>> '{}')::int end end;
$function$;

-- p_payload: { reason, children: [{ title, owner_employee_id, due_date, done_when, code?, measure? } ×2..10],
--   results: { <result id>: <child index> | "drop" }   (milestone split only; EVERY result under it, any state,
--            must be covered — a done/dropped/split result may fall back to tasks_default's child),
--   result_drop_reason?,                               (required when any result is dropped)
--   tasks: { <task id>: <child index> | <id of a live result moving under a child> },
--   tasks_default: <child index> }                     (covers every open linked task not in `tasks` —
--            including ones in private spaces the founder can't open)
-- Errors carry `field` (children[i] / a result id / a task id), `fields`, `ids` or `count`.
create or replace function docket.plan_split(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  it docket.plan_items; v_parent docket.plan_items; r docket.plan_items; c docket.plan_items;
  v_reason text; v_drop_reason text;
  v_children jsonb; v_n int; i int; ch jsonb; f text;
  v_title text; v_code text; v_done_when text; v_owner uuid; v_status text; v_dept uuid; v_due date;
  a_title text[] := '{}'; a_code text[] := '{}'; a_dw text[] := '{}'; a_owner uuid[] := '{}';
  a_dept uuid[] := '{}'; a_due date[] := '{}'; a_measure jsonb[] := '{}';
  v_missing text[];
  v_default int; v_rmap jsonb; v_tmap jsonb; v_val jsonb; v_key text; v_idx int;
  v_unmapped uuid[] := '{}';
  m_ids uuid[] := '{}'; m_to int[] := '{}'; v_live_moved uuid[] := '{}'; d_ids uuid[] := '{}';
  v_child_ids uuid[] := '{}'; v_child_codes text[] := '{}';
  v_target uuid; v_n_unmapped int := 0; v_relinked int := 0;
  t record;
begin
  if jsonb_typeof(v_p) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_payload'); end if;
  -- Super only; below F the item does not exist (no existence oracle) — checked BEFORE any lock, so a
  -- non-super can't hold the plan lock (review R3 #5).
  if not v_super then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  -- One writer at a time: auto codes are read-then-insert (as plan_create).
  perform pg_advisory_xact_lock(hashtext('docket.plan_items'));
  select * into it from docket.plan_items where id = p_id for update;
  if it.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not docket.plan_can(it.kind, 'split', v_super, false, false) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if not docket.plan_state_ok(it.kind, 'split', it.state) then
    return jsonb_build_object('ok', false, 'code', 'bad_state');
  end if;
  select * into v_parent from docket.plan_items where id = it.parent_id;
  if v_parent.state is distinct from 'agreed' then return jsonb_build_object('ok', false, 'code', 'parent_not_agreed'); end if;

  v_reason := nullif(btrim(coalesce(v_p->>'reason', '')), '');
  if v_reason is null then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;

  -- children: 2..10, each a full agreed item
  v_children := v_p->'children';
  if v_children is null or jsonb_typeof(v_children) <> 'array' then return jsonb_build_object('ok', false, 'code', 'bad_children'); end if;
  v_n := jsonb_array_length(v_children);
  if v_n < 2 or v_n > 10 then return jsonb_build_object('ok', false, 'code', 'bad_children'); end if;
  for i in 0 .. v_n - 1 loop
    ch := v_children->i; f := 'children[' || i || ']';
    if jsonb_typeof(ch) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_children', 'field', f); end if;
    v_title := nullif(btrim(coalesce(ch->>'title', '')), '');
    if v_title is null then return jsonb_build_object('ok', false, 'code', 'title_required', 'field', f); end if;
    v_code := nullif(btrim(coalesce(ch->>'code', '')), '');
    if v_code is not null then
      if v_code !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$' then return jsonb_build_object('ok', false, 'code', 'bad_code', 'field', f); end if;
      if v_code = any(a_code) or exists (select 1 from docket.plan_items where code = v_code) then
        return jsonb_build_object('ok', false, 'code', 'duplicate_code', 'value', v_code, 'field', f);
      end if;
    end if;
    v_owner := null; v_dept := null;
    if nullif(ch->>'owner_employee_id', '') is null then return jsonb_build_object('ok', false, 'code', 'owner_required', 'field', f); end if;
    begin
      v_owner := (ch->>'owner_employee_id')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'code', 'bad_owner', 'field', f);
    end;
    select e.status, e.department_id into v_status, v_dept from podium.employees e where e.id = v_owner;
    if not found then return jsonb_build_object('ok', false, 'code', 'owner_not_found', 'field', f); end if;
    if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'owner_inactive', 'field', f); end if;
    begin
      v_due := nullif(ch->>'due_date', '')::date;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bad_date', 'field', f);
    end;
    v_done_when := nullif(btrim(coalesce(ch->>'done_when', '')), '');
    v_missing := '{}';
    if v_due is null then v_missing := array_append(v_missing, 'due_date'); end if;
    if v_done_when is null then v_missing := array_append(v_missing, 'done_when'); end if;
    if cardinality(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'code', 'missing_fields', 'fields', to_jsonb(v_missing), 'field', f);
    end if;
    if ch ? 'measure' and jsonb_typeof(ch->'measure') not in ('object', 'null') then
      return jsonb_build_object('ok', false, 'code', 'bad_measure', 'field', f);
    end if;
    a_title := array_append(a_title, v_title); a_code := array_append(a_code, v_code);
    a_dw := array_append(a_dw, v_done_when); a_owner := array_append(a_owner, v_owner);
    a_dept := array_append(a_dept, v_dept); a_due := array_append(a_due, v_due);
    a_measure := array_append(a_measure, case when jsonb_typeof(ch->'measure') = 'object' then ch->'measure' end);
  end loop;

  -- tasks_default: a child index
  if v_p ? 'tasks_default' and jsonb_typeof(v_p->'tasks_default') <> 'null' then
    v_default := docket.plan_child_index(v_p->'tasks_default', v_n);
    if v_default is null then return jsonb_build_object('ok', false, 'code', 'bad_tasks_default'); end if;
  end if;

  -- results: every result under a split milestone, mapped to a child or dropped
  v_rmap := coalesce(v_p->'results', '{}'::jsonb);
  if jsonb_typeof(v_rmap) not in ('object', 'null') then return jsonb_build_object('ok', false, 'code', 'bad_results'); end if;
  if jsonb_typeof(v_rmap) = 'null' then v_rmap := '{}'::jsonb; end if;
  if it.kind = 'result' and v_rmap <> '{}'::jsonb then return jsonb_build_object('ok', false, 'code', 'bad_results'); end if;
  for v_key in select jsonb_object_keys(v_rmap) loop
    if not coalesce((select true from docket.plan_items x
                      where x.id = docket.plan_try_uuid(v_key) and x.parent_id = it.id and x.kind = 'result'), false) then
      return jsonb_build_object('ok', false, 'code', 'bad_results', 'field', v_key);
    end if;
  end loop;
  if it.kind = 'milestone' then
    for r in select * from docket.plan_items x where x.parent_id = it.id order by x.sort, x.code for update loop
      v_val := v_rmap->(r.id::text);
      if v_val is null or jsonb_typeof(v_val) = 'null' then
        if r.state in ('proposed', 'agreed') or v_default is null then
          v_unmapped := v_unmapped || r.id;
        else
          m_ids := m_ids || r.id; m_to := m_to || v_default;
        end if;
      elsif jsonb_typeof(v_val) = 'string' and v_val #>> '{}' = 'drop' then
        if r.state not in ('proposed', 'agreed') then
          return jsonb_build_object('ok', false, 'code', 'cannot_drop', 'field', r.id);
        end if;
        d_ids := d_ids || r.id;
      elsif docket.plan_child_index(v_val, v_n) is not null then
        m_ids := m_ids || r.id; m_to := m_to || docket.plan_child_index(v_val, v_n);
        if r.state in ('proposed', 'agreed') then v_live_moved := v_live_moved || r.id; end if;
      else
        return jsonb_build_object('ok', false, 'code', 'bad_results', 'field', r.id);
      end if;
    end loop;
    if cardinality(v_unmapped) > 0 then
      return jsonb_build_object('ok', false, 'code', 'unmapped_results', 'ids', to_jsonb(v_unmapped));
    end if;
  end if;
  v_drop_reason := nullif(btrim(coalesce(v_p->>'result_drop_reason', '')), '');
  if cardinality(d_ids) > 0 and v_drop_reason is null then
    return jsonb_build_object('ok', false, 'code', 'reason_required', 'field', 'result_drop_reason');
  end if;

  -- tasks: each value a child index or a live result moving under a child
  v_tmap := coalesce(v_p->'tasks', '{}'::jsonb);
  if jsonb_typeof(v_tmap) = 'null' then v_tmap := '{}'::jsonb; end if;
  if jsonb_typeof(v_tmap) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_tasks'); end if;
  for v_key, v_val in select k, v from jsonb_each(v_tmap) as e(k, v) loop
    if docket.plan_try_uuid(v_key) is null then
      return jsonb_build_object('ok', false, 'code', 'bad_tasks', 'field', v_key);
    end if;
    if jsonb_typeof(v_val) = 'number' then
      if docket.plan_child_index(v_val, v_n) is null then
        return jsonb_build_object('ok', false, 'code', 'bad_tasks', 'field', v_key);
      end if;
    elsif jsonb_typeof(v_val) = 'string' then
      if not coalesce(docket.plan_try_uuid(v_val #>> '{}') = any(v_live_moved), false) then
        return jsonb_build_object('ok', false, 'code', 'bad_tasks', 'field', v_key);
      end if;
    else
      return jsonb_build_object('ok', false, 'code', 'bad_tasks', 'field', v_key);
    end if;
  end loop;
  -- Every open top-level task on the original or on a result being dropped needs a target. The RPC sees
  -- them ALL, including private-space ones the founder can't open — tasks_default covers those.
  select count(*) into v_n_unmapped
  from docket.tasks k
  where k.parent_task_id is null and k.archived_at is null and k.status not in ('done', 'abandoned')
    and (k.plan_item_id = it.id or k.plan_item_id = any(d_ids))
    and not (v_tmap ? k.id::text);
  if v_n_unmapped > 0 and v_default is null then
    return jsonb_build_object('ok', false, 'code', 'unmapped_tasks', 'count', v_n_unmapped);
  end if;

  -- ── writes ──
  for i in 1 .. v_n loop
    v_code := coalesce(a_code[i], docket.plan_next_code(it.kind, v_parent.code));
    -- RAISE, never RETURN, here: earlier children are already written, and only an exception (caught by
    -- the block's unique_violation handler) rolls them back (review R3 #1).
    if exists (select 1 from docket.plan_items where code = v_code) then
      raise exception 'duplicate_code' using errcode = 'unique_violation';
    end if;
    insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, department_id, done_when, measure,
      due_date, state, split_from_id, sort, created_by_user_id, agreed_by_user_id, agreed_at)
    values (it.kind, v_code, it.parent_id, a_title[i], a_owner[i], a_dept[i], a_dw[i], a_measure[i],
      a_due[i], 'agreed', it.id, it.sort + i, p_actor, p_actor, now())
    returning * into c;
    insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id)
    values (c.id, 'created', null, docket.plan_snap(c), 'split from ' || it.code, p_actor);
    v_child_ids := v_child_ids || c.id; v_child_codes := v_child_codes || c.code;
  end loop;

  for i in 1 .. coalesce(cardinality(m_ids), 0) loop
    update docket.plan_items set parent_id = v_child_ids[m_to[i] + 1], updated_by_user_id = p_actor, updated_at = now()
     where id = m_ids[i];
    insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id)
    values (m_ids[i], 'moved', jsonb_build_object('parent_id', it.id), jsonb_build_object('parent_id', v_child_ids[m_to[i] + 1]),
      'split from ' || it.code, p_actor);
  end loop;

  for i in 1 .. coalesce(cardinality(d_ids), 0) loop
    select * into r from docket.plan_items where id = d_ids[i];
    update docket.plan_items set state = 'dropped', dropped_at = now(), dropped_by_user_id = p_actor, drop_reason = v_drop_reason,
      updated_by_user_id = p_actor, updated_at = now()
     where id = d_ids[i];
    insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id)
    values (d_ids[i], 'dropped', jsonb_build_object('state', r.state), jsonb_build_object('state', 'dropped'), v_drop_reason, p_actor);
  end loop;

  -- Re-link (the R2 triggers re-check: the children and moved results are agreed and share the theme, so
  -- the restricted status — and so the Founders'-space rule — is unchanged).
  for t in
    select k.id, k.plan_item_id from docket.tasks k
     where k.parent_task_id is null and k.archived_at is null and k.status not in ('done', 'abandoned')
       and (k.plan_item_id = it.id or k.plan_item_id = any(d_ids))
     order by k.created_at
     for update
  loop
    v_val := v_tmap->(t.id::text);
    v_target := case
      when v_val is null then v_child_ids[v_default + 1]
      when jsonb_typeof(v_val) = 'number' then v_child_ids[docket.plan_child_index(v_val, v_n) + 1]
      else docket.plan_try_uuid(v_val #>> '{}') end;
    update docket.tasks set plan_item_id = v_target, updated_by = p_actor, updated_at = now() where id = t.id;
    -- ids only (§5.3); the note carries no code or title.
    insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, new_value, note)
    values (t.id, p_actor, 'plan_item_id_changed', 'plan_item_id', t.plan_item_id::text, v_target::text, 'plan item split');
    v_relinked := v_relinked + 1;
  end loop;

  update docket.plan_items set state = 'split', updated_by_user_id = p_actor, updated_at = now() where id = it.id;
  insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id)
  values (it.id, 'split', jsonb_build_object('state', it.state),
    jsonb_build_object('state', 'split', 'split_into', to_jsonb(v_child_codes)), v_reason, p_actor);

  return jsonb_build_object('ok', true, 'id', it.id, 'state', 'split',
    'children', (select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code) order by x.ord)
                   from unnest(v_child_ids, v_child_codes) with ordinality as x(id, code, ord)),
    'moved', coalesce(cardinality(m_ids), 0), 'dropped', coalesce(cardinality(d_ids), 0), 'relinked', v_relinked);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'duplicate_code');
end;
$function$;

-- ── 4. proposals (§4.5) ──────────────────────────────────────────────────────
create table if not exists docket.plan_proposals (
  id uuid primary key default gen_random_uuid(),
  proposer_user_id uuid not null,
  title text not null check (btrim(title) <> '' and length(title) <= 200),
  why text not null check (btrim(why) <> '' and length(why) <= 2000),
  kind_hint text not null default 'milestone' check (kind_hint in ('milestone', 'risk')),
  suggested_theme_id uuid references docket.plan_items(id),
  suggested_owner_employee_id uuid references podium.employees(id),
  suggested_date date,
  status text not null default 'submitted' check (status in ('submitted', 'accepted', 'declined')),
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  accepted_item_id uuid references docket.plan_items(id),
  created_at timestamptz not null default now(),
  -- decided ⇔ stamped; only an accepted one points at an item; a decline carries its reason
  constraint plan_proposals_decided check ((status = 'submitted') = (decided_at is null and decided_by is null)),
  constraint plan_proposals_accepted_item check (accepted_item_id is null or status = 'accepted'),
  constraint plan_proposals_decline_note check (status <> 'declined' or (decision_note is not null and btrim(decision_note) <> ''))
);
create index if not exists plan_proposals_proposer on docket.plan_proposals(proposer_user_id, created_at desc);
create index if not exists plan_proposals_status on docket.plan_proposals(status, decided_at desc);
alter table docket.plan_proposals enable row level security;
revoke all on docket.plan_proposals from public, anon, authenticated;
grant all on docket.plan_proposals to service_role;

-- Anyone signed in. p_payload: { title, why, kind_hint? (milestone|risk), suggested_theme_id?,
-- suggested_owner_employee_id?, suggested_date? }. A theme that isn't a live unrestricted theme (or any live
-- theme, for a super admin) and an owner who isn't an active employee are IGNORED (→ null), not refused —
-- a refusal would tell a non-founder that a restricted theme id exists.
create or replace function docket.plan_propose(p_actor uuid, p_is_super boolean, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_title text; v_why text; v_kind text; v_theme uuid; v_owner uuid; v_date date; v_id uuid;
begin
  if p_actor is null then return jsonb_build_object('ok', false, 'code', 'forbidden'); end if;
  if jsonb_typeof(v_p) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_payload'); end if;
  v_title := nullif(btrim(coalesce(v_p->>'title', '')), '');
  if v_title is null then return jsonb_build_object('ok', false, 'code', 'title_required'); end if;
  if length(v_title) > 200 then return jsonb_build_object('ok', false, 'code', 'text_too_long', 'field', 'title'); end if;
  v_why := nullif(btrim(coalesce(v_p->>'why', '')), '');
  if v_why is null then return jsonb_build_object('ok', false, 'code', 'why_required'); end if;
  if length(v_why) > 2000 then return jsonb_build_object('ok', false, 'code', 'text_too_long', 'field', 'why'); end if;
  v_kind := coalesce(nullif(v_p->>'kind_hint', ''), 'milestone');
  if v_kind not in ('milestone', 'risk') then return jsonb_build_object('ok', false, 'code', 'bad_kind'); end if;
  begin
    v_theme := nullif(v_p->>'suggested_theme_id', '')::uuid;
  exception when invalid_text_representation then v_theme := null;
  end;
  if v_theme is not null and not exists (
       select 1 from docket.plan_items x where x.id = v_theme and x.kind = 'theme' and x.state = 'agreed'
          and (not x.restricted or coalesce(p_is_super, false))) then
    v_theme := null;
  end if;
  begin
    v_owner := nullif(v_p->>'suggested_owner_employee_id', '')::uuid;
  exception when invalid_text_representation then v_owner := null;
  end;
  if v_owner is not null and not exists (select 1 from podium.employees e where e.id = v_owner and e.status = 'active') then
    v_owner := null;
  end if;
  begin
    v_date := nullif(v_p->>'suggested_date', '')::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'bad_date');
  end;
  -- A queue, not a firehose: at most 20 undecided per person (count under a per-proposer lock).
  perform pg_advisory_xact_lock(hashtext('plan_proposals:' || p_actor::text));
  if (select count(*) from docket.plan_proposals where proposer_user_id = p_actor and status = 'submitted') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'too_many_open');
  end if;
  insert into docket.plan_proposals (proposer_user_id, title, why, kind_hint, suggested_theme_id, suggested_owner_employee_id, suggested_date)
  values (p_actor, v_title, v_why, v_kind, v_theme, v_owner, v_date)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'submitted');
end;
$function$;

-- Super only (below F: not_found). p_payload: { decision: accept|decline, note?, theme_id?, owner_employee_id?,
-- due_date?, done_when?, state? (proposed|agreed), title? }. Only a `submitted` proposal is decidable.
--   decline              → note required.
--   accept, milestone    → docket.plan_create (same transaction; its refusal is returned as-is, nothing written);
--                          theme / owner / date default to the proposal's suggestions, title to its title.
--   accept, risk         → creates a milestone only when a theme is given; otherwise nothing, and a note is required.
create or replace function docket.plan_proposal_decide(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  pr docket.plan_proposals;
  v_decision text; v_note text; v_theme text; v_item jsonb; j jsonb; v_item_id uuid;
begin
  if not coalesce(p_is_super, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if jsonb_typeof(v_p) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_payload'); end if;
  select * into pr from docket.plan_proposals where id = p_id for update;
  if pr.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if pr.status <> 'submitted' then return jsonb_build_object('ok', false, 'code', 'already_decided'); end if;
  v_decision := v_p->>'decision';
  if v_decision is null or v_decision not in ('accept', 'decline') then return jsonb_build_object('ok', false, 'code', 'bad_decision'); end if;
  v_note := nullif(btrim(coalesce(v_p->>'note', '')), '');
  if v_note is not null and length(v_note) > 2000 then return jsonb_build_object('ok', false, 'code', 'text_too_long', 'field', 'note'); end if;

  if v_decision = 'decline' then
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'note_required'); end if;
    update docket.plan_proposals set status = 'declined', decision_note = v_note, decided_by = p_actor, decided_at = now() where id = pr.id;
    return jsonb_build_object('ok', true, 'id', pr.id, 'status', 'declined');
  end if;

  v_theme := coalesce(nullif(v_p->>'theme_id', ''), pr.suggested_theme_id::text);
  if pr.kind_hint = 'risk' and nullif(v_p->>'theme_id', '') is null then
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'note_required'); end if;
  else
    if v_theme is null then return jsonb_build_object('ok', false, 'code', 'theme_required'); end if;
    v_item := jsonb_strip_nulls(jsonb_build_object(
      'kind', 'milestone', 'parent_id', v_theme,
      'title', coalesce(nullif(btrim(coalesce(v_p->>'title', '')), ''), pr.title),
      'owner_employee_id', coalesce(nullif(v_p->>'owner_employee_id', ''), pr.suggested_owner_employee_id::text),
      'due_date', coalesce(nullif(v_p->>'due_date', ''), pr.suggested_date::text),
      'done_when', nullif(btrim(coalesce(v_p->>'done_when', '')), ''),
      'state', coalesce(nullif(v_p->>'state', ''), 'proposed')));
    if v_item->>'state' not in ('proposed', 'agreed') then return jsonb_build_object('ok', false, 'code', 'bad_state'); end if;
    j := docket.plan_create(p_actor, p_actor_employee, true, v_item);
    if not coalesce((j->>'ok')::boolean, false) then return j; end if;
    v_item_id := (j->>'id')::uuid;
  end if;

  update docket.plan_proposals set status = 'accepted', decision_note = v_note, decided_by = p_actor, decided_at = now(),
    accepted_item_id = v_item_id
  where id = pr.id;
  return jsonb_build_object('ok', true, 'id', pr.id, 'status', 'accepted', 'item_id', v_item_id, 'item_code', j->>'code');
end;
$function$;

-- Reads. Super: the queue — every submitted proposal, everything decided in the last 30 days, and their own.
-- Everyone else: ONLY their own, with the outcome: the decline reason; for an accepted one the item's id /
-- code / title only when plan_items_for gives them the item (F / O) — never the theme it joined. The theme
-- they SUGGESTED comes back only while it is visible to them (level T: unrestricted).
create or replace function docket.plan_proposals_for(p_actor uuid, p_actor_employee uuid, p_is_super boolean)
returns table(id uuid, mine boolean, proposer_user_id uuid, title text, why text, kind_hint text,
              suggested_theme_id uuid, suggested_theme_code text, suggested_theme_title text,
              suggested_owner_employee_id uuid, suggested_date date, status text, decision_note text,
              decided_by uuid, decided_at timestamptz, accepted_item_id uuid, accepted_item_code text,
              accepted_item_title text, created_at timestamptz)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with pf as (
    select p.id, p.kind, p.code, p.title, p.level from docket.plan_items_for(p_actor_employee, coalesce(p_is_super, false)) p
  ), rows as (
    select x.* from docket.plan_proposals x
    where case when coalesce(p_is_super, false)
               then x.status = 'submitted' or x.decided_at > now() - interval '30 days' or x.proposer_user_id = p_actor
               else p_actor is not null and x.proposer_user_id = p_actor end
  )
  select r.id, r.proposer_user_id = p_actor,
         case when coalesce(p_is_super, false) then r.proposer_user_id end,
         r.title, r.why, r.kind_hint,
         th.id, th.code, th.title,
         r.suggested_owner_employee_id, r.suggested_date, r.status,
         case when coalesce(p_is_super, false) or r.status = 'declined' then r.decision_note end,
         case when coalesce(p_is_super, false) then r.decided_by end,
         r.decided_at,
         ai.id, ai.code, ai.title,
         r.created_at
  from rows r
  left join pf th on th.id = r.suggested_theme_id and th.kind = 'theme'
  left join pf ai on ai.id = r.accepted_item_id and ai.level in ('F', 'O')
  order by (r.status = 'submitted') desc, coalesce(r.decided_at, r.created_at) desc, r.id;
$function$;

revoke all on function docket.plan_can(text, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function docket.plan_state_ok(text, text, text) from public, anon, authenticated;
revoke all on function docket.plan_try_uuid(text) from public, anon, authenticated;
revoke all on function docket.plan_child_index(jsonb, int) from public, anon, authenticated;
revoke all on function docket.plan_split(uuid, uuid, boolean, uuid, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_propose(uuid, boolean, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_proposal_decide(uuid, uuid, boolean, uuid, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_proposals_for(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function docket.plan_can(text, text, boolean, boolean, boolean) to service_role;
grant execute on function docket.plan_state_ok(text, text, text) to service_role;
grant execute on function docket.plan_split(uuid, uuid, boolean, uuid, jsonb) to service_role;
grant execute on function docket.plan_propose(uuid, boolean, jsonb) to service_role;
grant execute on function docket.plan_proposal_decide(uuid, uuid, boolean, uuid, jsonb) to service_role;
grant execute on function docket.plan_proposals_for(uuid, uuid, boolean) to service_role;

-- ── review R3 #2: tasks_plan_guard reads the item's state AFTER locking it ────────────────
-- (0018 read state, then took FOR SHARE: a link racing a split/drop/done saw the old 'agreed'.)
create or replace function docket.tasks_plan_guard()
returns trigger
language plpgsql
set search_path to 'docket', 'public'
as $function$
declare
  v_state text; v_link uuid; v_founders boolean;
begin
  v_link := new.plan_item_id;
  if v_link is null and new.parent_task_id is not null then
    select t.plan_item_id into v_link from docket.tasks t where t.id = new.parent_task_id;
  end if;
  -- Lock the link's chain (item → milestone → theme) FOR SHARE first; every read below sees it settled.
  if v_link is not null then
    perform 1 from docket.plan_items x
     where x.id = v_link
        or x.id = (select i.parent_id from docket.plan_items i where i.id = v_link)
        or x.id = (select p.parent_id from docket.plan_items i join docket.plan_items p on p.id = i.parent_id where i.id = v_link)
     for share;
  end if;
  if new.plan_item_id is not null and (tg_op = 'INSERT' or new.plan_item_id is distinct from old.plan_item_id) then
    select state into v_state from docket.plan_items where id = new.plan_item_id;
    if v_state is null or v_state not in ('proposed', 'agreed') then
      raise exception 'plan_item_closed' using errcode = 'check_violation';
    end if;
  end if;
  if v_link is not null and docket.plan_restricted(v_link) then
    select s.is_founders into v_founders from docket.spaces s where s.id = new.space_id;
    if not coalesce(v_founders, false) then
      raise exception 'restricted_needs_founders_space' using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' and new.plan_item_id is distinct from old.plan_item_id and exists (
         select 1 from docket.tasks k left join docket.spaces s on s.id = k.space_id
          where k.parent_task_id = new.id and not coalesce(s.is_founders, false)) then
      raise exception 'restricted_needs_founders_space' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$;

-- ── review R3 #3: a new milestone/result needs its parent agreed AT INSERT, under a lock ──────
-- plan_create checks the parent's state before its advisory lock; a split/drop/done committing in between
-- would leave a child under a closed parent. This re-reads the parent FOR SHARE on every insert.
create or replace function docket.plan_items_parent_live()
returns trigger
language plpgsql
set search_path to 'docket', 'public'
as $function$
declare v_state text;
begin
  if new.kind = 'theme' or new.parent_id is null then return new; end if;
  select state into v_state from docket.plan_items where id = new.parent_id for share;
  if v_state is distinct from 'agreed' then
    raise exception 'parent_not_agreed' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
drop trigger if exists plan_items_parent_live on docket.plan_items;
create trigger plan_items_parent_live before insert on docket.plan_items
  for each row execute function docket.plan_items_parent_live();
revoke all on function docket.plan_items_parent_live() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
