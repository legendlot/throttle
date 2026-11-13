-- F8 P2 (migration 0032) — record checklists: kind / version on templates (the 1 live template reads 'routine', v1;
-- the kind CHECK), docket.checklist_records / _record_items / task_checklist_links / _record_history /
-- checklist_template_history: the CHECKs (state, status, na needs a reason, archived ⇔ archived_at), UNIQUE
-- (record_id, source_item_id) with NULLs distinct (copy-only items); the history triggers (every event, its count,
-- every actor = the stamping user, a cascade unlink logged with no actor); the status trigger (completes when every
-- item is done / N/A, re-opens on an open or newly added item, takes FOR NO KEY UPDATE, RAISES on an item change of an
-- archived record but lets a task_id-only change through); the link trigger's task_history rows (event + source);
-- FKs (items / links / history cascade with the record, a deleted task nulls the item's task_id and drops its links,
-- a template with records can't be deleted); RLS + grants, trigger functions not callable by anon.
-- One DO block that always rolls back (ends by raising RESULT …). Before 0032 is applied it runs the migration
-- inside the block (execute $mig$ … $mig$, generated verbatim from migrations/0032_checklist_records.sql); after,
-- it only checks. Run via execute_sql.
-- EXPECT: 1:routine,1,kind_checked  2:5,uniq,na_checked,state_checked,origin_checked,status_checked,archive_shape,h=created,item_added,item_added,items_copied/3
--   3:complete/true,completed=1,open/true,reopened=1,complete,open,archived_raises,attach_raises,nokey,seq_ok,clock,ev=archived:1 created:1
--   item_added:3 item_done:5 item_na:1 item_reopened:1 item_task_created:1 items_copied:1 record_completed:2 record_reopened:2 title_changed:1,actors_ok
--   4:link_uniq,th=checklist_linked/app checklist_linked/app checklist_unlinked/connector,unl_actor_ok,0,setnull,unl=2,tmpl_restrict,0,0,0
--   5:checklist_record_history=true/false/false/true checklist_record_items=true/false/false/true checklist_records=true/false/false/true
--     checklist_template_history=true/false/false/true task_checklist_links=true/false/false/true,fn=false,trg=5,seqgrant=false/true
-- (every string_agg orders with collate "C", so the line doesn't depend on the database's collation)
do $clrec$
declare
  A uuid := gen_random_uuid(); G uuid; T uuid; S uuid; I1 uuid; I2 uuid; I3 uuid; C2 uuid; N uuid; R uuid; X uuid; out text := '';
begin
  if to_regclass('docket.checklist_records') is null then
    execute $mig$
-- 0032_checklist_records.sql — F8 P2 (docket_checklist_records_v1): record checklists
-- (spec docs/superpowers/specs/2026-11-11-docket-checklists-v2.md §3.2, decisions C3–C6).
--
-- A checklist template now has a kind: 'routine' (every S127 / P1 template — recurring, assigned, ticked per
-- date) or 'record' (copied per subject — a product launch — and ticked once, on the copy). `version` is bumped
-- by saveChecklistTemplate whenever items are added, removed, renamed or reordered; every save is logged in
-- docket.checklist_template_history.
--
-- docket.checklist_records            one copy ("Launch: Badger"); visibility = its space, exactly like a task.
--                                     `product` is an optional public.product_master family name (C5 — the
--                                     catalog lags the launch, so no FK; the worker checks it exists).
-- docket.checklist_record_items       the snapshot of the template's items at creation (later template edits
--                                     never rewrite it). source_item_id = the template item it came from, NO FK
--                                     (a template item deleted later stays on old records, "no longer in
--                                     template"); null = added only to this copy. UNIQUE (record_id,
--                                     source_item_id) — NULLs distinct — so pulling template updates twice adds
--                                     nothing twice (C3, on_conflict … ignore-duplicates).
-- docket.task_checklist_links         a record ↔ many tasks.
-- docket.checklist_record_history     every change — written ONLY by the triggers below, in the same statement
--                                     as the change, so a change and its history commit together. Actor = the
--                                     row's updated_by_user_id / created_by_user_id / removed_by_user_id (the
--                                     worker stamps it in the same write; an unlink stamps removed_by first,
--                                     then deletes).
--
-- Triggers (AFTER, row unless noted; on one table they fire in name order — the log before the status sync):
--   checklist_record_items_a_log        UPDATE: item_done / item_na / item_reopened / item_note / item_task_created
--   checklist_record_items_a_log_ins    INSERT, per statement, from each row's `origin` (the worker's intent):
--                                       'snapshot' → items_copied, 'pull' → template_pulled (C3), counted per
--                                       record; 'added' (or no origin) → item_added per row
--   checklist_record_items_status_sync  the record finishes itself: locks the record row (FOR NO KEY UPDATE, so
--                                       two last ticks at once can't both miss it), 'complete' when it has ≥1
--                                       item and none open, back to 'open' when one opens (or a new one is added),
--                                       logged record_completed / record_reopened. An item change on an ARCHIVED
--                                       record RAISES 'record_archived' (the worker answers 409) — including a task
--                                       newly attached to an item; a task_id cleared by a deleted task (FK set
--                                       null) or a change of only the stamps passes.
--   checklist_records_log               created; title / product / owner changed; archived / unarchived
--   task_checklist_links_log            INSERT / DELETE: task_linked / task_unlinked on the record AND
--                                       checklist_linked / checklist_unlinked on docket.task_history (field
--                                       'checklist', value = the record id, rendered behind the gate by getTask;
--                                       source = the link's source / removed_source). A cascade from a deleted
--                                       record or task logs only on the side that still exists.
--
-- No CHECK is widened: kind / state / status / event are new columns, and docket.task_history.event_type has no
-- CHECK (only source, whose four values are reused here). Feeder: saveChecklistTemplate is the only writer of
-- kind; the 1 template (archived; measured 2026-11-13) takes the 'routine' default.
-- Additive + idempotent (no begin/commit: test/checklist-records.sql embeds it verbatim inside its DO block).
-- RLS on, no policies, service_role only (the docket convention).

alter table docket.checklist_templates add column if not exists kind text not null default 'routine';
do $$ begin
  alter table docket.checklist_templates add constraint checklist_templates_kind_chk check (kind in ('routine', 'record'));
exception when duplicate_object then null; end $$;
alter table docket.checklist_templates add column if not exists version int not null default 1;

create table if not exists docket.checklist_template_history (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id) on delete cascade,
  event text not null check (event ~ '^[a-z_]{1,40}$'),
  actor_user_id uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists checklist_template_history_tmpl_idx on docket.checklist_template_history (template_id, at);

create table if not exists docket.checklist_records (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id),
  template_version int not null default 1,
  title text not null check (length(btrim(title)) between 1 and 200),
  product text check (product is null or length(btrim(product)) between 1 and 200),
  space_id uuid not null references docket.spaces(id),
  owner_employee_id uuid references podium.employees(id),
  status text not null default 'open' check (status in ('open', 'complete', 'archived')),
  created_by_user_id uuid not null,
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  completed_at timestamptz,
  archived_at timestamptz,
  check ((status = 'archived') = (archived_at is not null))
);
create index if not exists checklist_records_space_idx on docket.checklist_records (space_id);
create index if not exists checklist_records_template_idx on docket.checklist_records (template_id);

create table if not exists docket.checklist_record_items (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references docket.checklist_records(id) on delete cascade,
  source_item_id uuid,
  section_title text,
  title text not null check (length(btrim(title)) between 1 and 300),
  help_text text,
  sort_order int not null default 0,
  state text not null default 'open' check (state in ('open', 'done', 'na')),
  na_reason text,
  done_by_user_id uuid,
  done_at timestamptz,
  note text,
  task_id uuid references docket.tasks(id) on delete set null,
  updated_by_user_id uuid,
  origin text check (origin is null or origin in ('snapshot', 'pull', 'added')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  check (state <> 'na' or length(btrim(coalesce(na_reason, ''))) between 1 and 300),
  unique (record_id, source_item_id)
);
create index if not exists checklist_record_items_task_idx on docket.checklist_record_items (task_id) where task_id is not null;

create table if not exists docket.task_checklist_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  record_id uuid not null references docket.checklist_records(id) on delete cascade,
  created_by_user_id uuid not null,
  source text not null default 'app' check (source in ('app', 'connector', 'slack', 'system')),
  removed_by_user_id uuid,
  removed_source text check (removed_source is null or removed_source in ('app', 'connector', 'slack', 'system')),
  created_at timestamptz not null default now(),
  unique (task_id, record_id)
);
create index if not exists task_checklist_links_record_idx on docket.task_checklist_links (record_id);

create table if not exists docket.checklist_record_history (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references docket.checklist_records(id) on delete cascade,
  item_id uuid references docket.checklist_record_items(id) on delete set null,
  event text not null check (event ~ '^[a-z_]{1,40}$'),
  actor_user_id uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default clock_timestamp(),   -- several rows in one statement still read in order
  seq bigserial                                         -- the tiebreak (at desc, seq desc)
);
create index if not exists checklist_record_history_record_idx on docket.checklist_record_history (record_id, at, seq);

-- ── item history (UPDATE) ──
create or replace function docket.checklist_record_items_log() returns trigger
language plpgsql set search_path = docket, pg_temp as $fn$
begin
  if new.state is distinct from old.state or (new.state = 'na' and new.na_reason is distinct from old.na_reason) then
    insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
      values (new.record_id, new.id,
              case new.state when 'done' then 'item_done' when 'na' then 'item_na' else 'item_reopened' end,
              new.updated_by_user_id,
              jsonb_strip_nulls(jsonb_build_object('state', new.state, 'na_reason', case when new.state = 'na' then new.na_reason end)));
  end if;
  if new.note is distinct from old.note then
    insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
      values (new.record_id, new.id, 'item_note', new.updated_by_user_id, '{}'::jsonb);
  end if;
  if new.task_id is not null and old.task_id is null then
    insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
      values (new.record_id, new.id, 'item_task_created', new.updated_by_user_id, jsonb_build_object('task_id', new.task_id));
  end if;
  return null;
end $fn$;
drop trigger if exists checklist_record_items_a_log on docket.checklist_record_items;
create trigger checklist_record_items_a_log after update on docket.checklist_record_items
  for each row execute function docket.checklist_record_items_log();

-- ── item history (INSERT, per statement) ──
create or replace function docket.checklist_record_items_log_ins() returns trigger
language plpgsql set search_path = docket, pg_temp as $fn$
begin
  insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
    select g.record_id, null, case g.origin when 'snapshot' then 'items_copied' else 'template_pulled' end,
           g.actor, jsonb_build_object('added', g.n)
      from (select record_id, origin, count(*)::int as n, (array_agg(updated_by_user_id))[1] as actor
              from new_items where origin in ('snapshot', 'pull') group by record_id, origin) g;
  insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
    select record_id, id, 'item_added', updated_by_user_id, jsonb_build_object('title', title)
      from new_items where origin is null or origin = 'added';
  return null;
end $fn$;
drop trigger if exists checklist_record_items_a_log_ins on docket.checklist_record_items;
create trigger checklist_record_items_a_log_ins after insert on docket.checklist_record_items
  referencing new table as new_items for each statement execute function docket.checklist_record_items_log_ins();

-- ── the record finishes itself ──
create or replace function docket.checklist_record_status_sync() returns trigger
language plpgsql set search_path = docket, pg_temp as $fn$
declare
  cur text; n_items int; n_open int;
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state and new.na_reason is not distinct from old.na_reason
     and new.note is not distinct from old.note and new.title is not distinct from old.title
     and new.help_text is not distinct from old.help_text and new.section_title is not distinct from old.section_title
     and new.sort_order is not distinct from old.sort_order and new.record_id is not distinct from old.record_id then
    -- only task_id / the stamps changed: passes, unless a task is newly attached to an archived record's item
    if new.task_id is null or old.task_id is not null then return null; end if;
    select status into cur from docket.checklist_records where id = new.record_id for no key update;
    if cur = 'archived' then raise exception 'record_archived' using errcode = 'check_violation'; end if;
    return null;
  end if;
  select status into cur from docket.checklist_records where id = new.record_id for no key update;
  if cur is null then return null; end if;
  if cur = 'archived' then
    raise exception 'record_archived' using errcode = 'check_violation';
  end if;
  select count(*), count(*) filter (where state = 'open') into n_items, n_open
    from docket.checklist_record_items where record_id = new.record_id;
  if cur = 'open' and n_items > 0 and n_open = 0 then
    update docket.checklist_records set status = 'complete', completed_at = now(), updated_at = now() where id = new.record_id;
    insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
      values (new.record_id, new.id, 'record_completed', new.updated_by_user_id, jsonb_build_object('items', n_items));
  elsif cur = 'complete' and n_open > 0 then
    update docket.checklist_records set status = 'open', completed_at = null, updated_at = now() where id = new.record_id;
    insert into docket.checklist_record_history (record_id, item_id, event, actor_user_id, detail)
      values (new.record_id, new.id, 'record_reopened', new.updated_by_user_id, jsonb_build_object('open', n_open));
  end if;
  return null;
end $fn$;
drop trigger if exists checklist_record_items_status_sync on docket.checklist_record_items;
create trigger checklist_record_items_status_sync
  after insert or update on docket.checklist_record_items
  for each row execute function docket.checklist_record_status_sync();

-- ── record history ──
create or replace function docket.checklist_records_log() returns trigger
language plpgsql set search_path = docket, pg_temp as $fn$
begin
  if tg_op = 'INSERT' then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.id, 'created', new.created_by_user_id, jsonb_build_object('template_version', new.template_version));
    return null;
  end if;
  if new.title is distinct from old.title then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.id, 'title_changed', new.updated_by_user_id, jsonb_build_object('old', old.title, 'new', new.title));
  end if;
  if new.product is distinct from old.product then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.id, 'product_changed', new.updated_by_user_id, jsonb_build_object('old', old.product, 'new', new.product));
  end if;
  if new.owner_employee_id is distinct from old.owner_employee_id then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.id, 'owner_changed', new.updated_by_user_id, jsonb_build_object('old', old.owner_employee_id, 'new', new.owner_employee_id));
  end if;
  if new.status = 'archived' and old.status <> 'archived' then
    insert into docket.checklist_record_history (record_id, event, actor_user_id) values (new.id, 'archived', new.updated_by_user_id);
  elsif old.status = 'archived' and new.status <> 'archived' then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.id, 'unarchived', new.updated_by_user_id, jsonb_build_object('status', new.status));
  end if;
  return null;
end $fn$;
drop trigger if exists checklist_records_log on docket.checklist_records;
create trigger checklist_records_log after insert or update on docket.checklist_records
  for each row execute function docket.checklist_records_log();

-- ── link history (the record's and the task's) ──
create or replace function docket.task_checklist_links_log() returns trigger
language plpgsql set search_path = docket, pg_temp as $fn$
begin
  if tg_op = 'INSERT' then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (new.record_id, 'task_linked', new.created_by_user_id, jsonb_build_object('task_id', new.task_id));
    insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, source)
      values (new.task_id, new.created_by_user_id, 'checklist_linked', 'checklist', new.record_id::text, new.source);
    return null;
  end if;
  if exists (select 1 from docket.checklist_records where id = old.record_id) then
    insert into docket.checklist_record_history (record_id, event, actor_user_id, detail)
      values (old.record_id, 'task_unlinked', old.removed_by_user_id, jsonb_build_object('task_id', old.task_id));
  end if;
  if exists (select 1 from docket.tasks where id = old.task_id) then
    insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, source)
      values (old.task_id, old.removed_by_user_id, 'checklist_unlinked', 'checklist', old.record_id::text, coalesce(old.removed_source, 'app'));
  end if;
  return null;
end $fn$;
drop trigger if exists task_checklist_links_log on docket.task_checklist_links;
create trigger task_checklist_links_log after insert or delete on docket.task_checklist_links
  for each row execute function docket.task_checklist_links_log();

do $$
declare t text; f text;
begin
  foreach t in array array['checklist_template_history', 'checklist_records', 'checklist_record_items',
                           'task_checklist_links', 'checklist_record_history'] loop
    execute format('alter table docket.%I enable row level security', t);
    execute format('revoke all on docket.%I from public, anon, authenticated', t);
    execute format('grant all on docket.%I to service_role', t);
  end loop;
  revoke all on sequence docket.checklist_record_history_seq_seq from public, anon, authenticated;
  grant usage, select on sequence docket.checklist_record_history_seq_seq to service_role;
  foreach f in array array['checklist_record_items_log', 'checklist_record_items_log_ins', 'checklist_record_status_sync',
                           'checklist_records_log', 'task_checklist_links_log'] loop
    execute format('revoke all on function docket.%I() from public, anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
$mig$;
  end if;
  -- 1. kind / version defaults on what exists; the kind CHECK
  out := '1:' || coalesce((select string_agg(distinct kind, ',') from docket.checklist_templates), 'none')
    || ',' || coalesce((select string_agg(distinct version::text, ',') from docket.checklist_templates), 'none');
  begin insert into docket.checklist_templates (name, recurrence, created_by_user_id, kind) values ('zz', '{"freq":"none"}', A, 'launch'); out := out || ',KIND_OPEN';
  exception when check_violation then out := out || ',kind_checked'; end;

  -- 2. a record template, a record, its items (the snapshot in one statement); the CHECKs, the UNIQUE, the history
  insert into docket.checklist_templates (name, recurrence, created_by_user_id, kind) values ('zz launch', '{"freq":"none"}', A, 'record') returning id into T;
  insert into docket.checklist_template_sections (template_id, title) values (T, 'zz s') returning id into S;
  insert into docket.checklist_template_items (section_id, title, sort_order) values (S, 'zz i1', 0) returning id into I1;
  insert into docket.checklist_template_items (section_id, title, sort_order) values (S, 'zz i2', 1) returning id into I2;
  insert into docket.checklist_template_items (section_id, title, sort_order) values (S, 'zz i3', 2) returning id into I3;
  insert into docket.checklist_template_history (template_id, event, actor_user_id) values (T, 'created', A);
  select id into G from docket.spaces where is_default limit 1;
  insert into docket.checklist_records (template_id, title, space_id, created_by_user_id, updated_by_user_id) values (T, 'zz Launch: Badger', G, A, A) returning id into R;
  insert into docket.checklist_record_items (record_id, source_item_id, title, sort_order, updated_by_user_id, origin)
    values (R, I1, 'zz i1', 0, A, 'snapshot'), (R, I2, 'zz i2', 10, A, 'snapshot'), (R, I3, 'zz i3', 20, A, 'snapshot'), (R, null, 'zz c1', 30, A, null);
  insert into docket.checklist_record_items (record_id, source_item_id, title, sort_order, updated_by_user_id) values (R, null, 'zz c2', 40, A) returning id into C2;
  out := out || '  2:' || (select count(*) from docket.checklist_record_items where record_id = R);   -- two NULL sources coexist
  begin insert into docket.checklist_record_items (record_id, source_item_id, title) values (R, I1, 'zz dup'); out := out || ',DUP_OPEN';
  exception when unique_violation then out := out || ',uniq'; end;
  begin insert into docket.checklist_record_items (record_id, title, state) values (R, 'zz na', 'na'); out := out || ',NA_OPEN';
  exception when check_violation then out := out || ',na_checked'; end;
  begin insert into docket.checklist_record_items (record_id, title, state) values (R, 'zz bad', 'maybe'); out := out || ',STATE_OPEN';
  exception when check_violation then out := out || ',state_checked'; end;
  begin insert into docket.checklist_record_items (record_id, title, origin) values (R, 'zz bad', 'import'); out := out || ',ORIGIN_OPEN';
  exception when check_violation then out := out || ',origin_checked'; end;
  begin insert into docket.checklist_records (template_id, title, space_id, created_by_user_id, status) values (T, 'zz', G, A, 'paused'); out := out || ',STATUS_OPEN';
  exception when check_violation then out := out || ',status_checked'; end;
  begin insert into docket.checklist_records (template_id, title, space_id, created_by_user_id, status) values (T, 'zz', G, A, 'archived'); out := out || ',ARCH_OPEN';
  exception when check_violation then out := out || ',archive_shape'; end;
  out := out || ',h=' || (select string_agg(event, ',' order by event collate "C") from docket.checklist_record_history where record_id = R)
    || '/' || (select detail->>'added' from docket.checklist_record_history where record_id = R and event = 'items_copied');

  -- 3. the status trigger + item / record history
  update docket.checklist_record_items set state = 'done', updated_by_user_id = A where record_id = R and id <> C2;
  update docket.checklist_record_items set state = 'na', na_reason = 'zz no tooling', updated_by_user_id = A where id = C2;
  out := out || '  3:' || (select status || '/' || (completed_at is not null)::text from docket.checklist_records where id = R)
    || ',completed=' || (select count(*) from docket.checklist_record_history where record_id = R and event = 'record_completed');
  update docket.checklist_record_items set state = 'open', updated_by_user_id = A where record_id = R and source_item_id = I1;
  out := out || ',' || (select status || '/' || (completed_at is null)::text from docket.checklist_records where id = R)
    || ',reopened=' || (select count(*) from docket.checklist_record_history where record_id = R and event = 'record_reopened');
  update docket.checklist_record_items set state = 'done', updated_by_user_id = A where record_id = R and source_item_id = I1;
  out := out || ',' || (select status from docket.checklist_records where id = R);
  insert into docket.checklist_record_items (record_id, title, updated_by_user_id) values (R, 'zz new', A) returning id into N;
  out := out || ',' || (select status from docket.checklist_records where id = R);   -- a new open item re-opens it
  insert into docket.tasks (task_no, title, created_by_user_id, space_id) values ('DKT-ZZ0032', 'zz task', A, G) returning id into X;
  update docket.checklist_record_items set task_id = X, updated_by_user_id = A where record_id = R and source_item_id = I2;   -- open record: attach passes
  update docket.checklist_records set title = 'zz renamed', updated_by_user_id = A where id = R;
  update docket.checklist_records set status = 'archived', archived_at = now(), updated_by_user_id = A where id = R;
  begin update docket.checklist_record_items set state = 'done', updated_by_user_id = A where id = N; out := out || ',ARCHIVED_WRITABLE';
  exception when check_violation then out := out || ',archived_raises'; end;
  begin update docket.checklist_record_items set task_id = X, updated_by_user_id = A where record_id = R and source_item_id = I3; out := out || ',ARCHIVED_ATTACHABLE';
  exception when check_violation then out := out || ',attach_raises'; end;
  out := out || ',' || (case when pg_get_functiondef('docket.checklist_record_status_sync'::regproc) ilike '%for no key update%' then 'nokey' else 'LOCK_WRONG' end)
    || ',' || (case when (select min(seq) from docket.checklist_record_history where record_id = R and event = 'record_completed')
                       > (select seq from docket.checklist_record_history where record_id = R and event = 'item_na') then 'seq_ok' else 'SEQ_WRONG' end)
    || ',' || (case when (select column_default from information_schema.columns where table_schema = 'docket'
                          and table_name = 'checklist_record_history' and column_name = 'at') ilike '%clock_timestamp%' then 'clock' else 'NOW_DEFAULT' end)
    || ',ev=' || (select string_agg(event || ':' || cnt, ' ' order by event collate "C") from
                   (select event, count(*) cnt from docket.checklist_record_history where record_id = R group by event) e)
    || ',' || (case when exists (select 1 from docket.checklist_record_history where record_id = R and actor_user_id is distinct from A)
                    then 'ACTOR_WRONG' else 'actors_ok' end);

  -- 4. links (+ task_history), FKs
  insert into docket.task_checklist_links (task_id, record_id, created_by_user_id) values (X, R, A);
  begin insert into docket.task_checklist_links (task_id, record_id, created_by_user_id) values (X, R, A); out := out || '  4:LINK_DUP_OPEN';
  exception when unique_violation then out := out || '  4:link_uniq'; end;
  update docket.task_checklist_links set removed_by_user_id = A, removed_source = 'connector' where task_id = X and record_id = R;
  delete from docket.task_checklist_links where task_id = X and record_id = R;
  insert into docket.task_checklist_links (task_id, record_id, created_by_user_id) values (X, R, A);
  out := out || ',th=' || (select string_agg(event_type || '/' || source, ' ' order by event_type collate "C", source collate "C") from docket.task_history
                           where task_id = X and field = 'checklist' and coalesce(new_value, old_value) = R::text)
    || ',' || (case when (select actor_user_id from docket.checklist_record_history where record_id = R and event = 'task_unlinked') = A
                    then 'unl_actor_ok' else 'UNL_ACTOR_WRONG' end);
  delete from docket.tasks where id = X;   -- archived record: the FK set-null of I2's task_id passes
  out := out || ',' || (select count(*) from docket.task_checklist_links where record_id = R)
    || ',' || (case when (select task_id from docket.checklist_record_items where record_id = R and source_item_id = I2) is null then 'setnull' else 'TASK_KEPT' end)
    || ',unl=' || (select count(*) from docket.checklist_record_history where record_id = R and event = 'task_unlinked');
  begin delete from docket.checklist_templates where id = T; out := out || ',TMPL_DELETED';
  exception when foreign_key_violation then out := out || ',tmpl_restrict'; end;
  delete from docket.checklist_records where id = R;
  out := out || ',' || (select count(*) from docket.checklist_record_items where record_id = R)
    || ',' || (select count(*) from docket.checklist_record_history where record_id = R);
  delete from docket.checklist_templates where id = T;
  out := out || ',' || (select count(*) from docket.checklist_template_history where template_id = T);

  -- 5. RLS on, no anon / authenticated grant, service_role all; the trigger functions not callable by anon; 5 triggers
  out := out || '  5:' || (select string_agg(c.relname || '=' || c.relrowsecurity::text
      || '/' || has_table_privilege('anon', c.oid, 'select')::text
      || '/' || has_table_privilege('authenticated', c.oid, 'insert')::text
      || '/' || has_table_privilege('service_role', c.oid, 'insert')::text, ' ' order by c.relname collate "C")
    from pg_class c where c.relnamespace = 'docket'::regnamespace and c.relkind = 'r'
      and c.relname in ('checklist_records', 'checklist_record_items', 'task_checklist_links', 'checklist_record_history', 'checklist_template_history'))
    || ',fn=' || (select bool_or(has_function_privilege('anon', p.oid, 'execute'))::text from pg_proc p
                  where p.pronamespace = 'docket'::regnamespace and p.proname in ('checklist_record_items_log', 'checklist_record_items_log_ins',
                    'checklist_record_status_sync', 'checklist_records_log', 'task_checklist_links_log'))
    || ',trg=' || (select count(*) from pg_trigger where not tgisinternal and tgname in ('checklist_record_items_a_log', 'checklist_record_items_a_log_ins',
                    'checklist_record_items_status_sync', 'checklist_records_log', 'task_checklist_links_log'))
    || ',seqgrant=' || has_sequence_privilege('anon', 'docket.checklist_record_history_seq_seq', 'usage')::text
    || '/' || has_sequence_privilege('service_role', 'docket.checklist_record_history_seq_seq', 'usage')::text;

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $clrec$;
