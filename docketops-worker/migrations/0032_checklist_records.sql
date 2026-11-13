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
