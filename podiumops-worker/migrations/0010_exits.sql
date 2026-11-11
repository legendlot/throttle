-- podium_exits_v1 — X1: exits + no-dues. The exit flow is the ONLY path to employees.status = 'exited'.
-- Plan: docs/superpowers/plans/2026-11-11-podium-x1-exits.md · depends on 0009 (google_admin_log, work_accounts).
-- AUTHORIZATION STAYS IN THE WORKER (as 0007-0009): every function trusts its caller (service_role only).
--
-- ⚠️ There is NO `notice` status (plan deviation 1). During notice the employee stays `active`; "on notice" =
-- an `open` employee_exits row. sales.f_podium_salary_run / _coverage / f_podium_sga_excluded / f_analytics_* /
-- f_okr_cycle, both auth-link triggers and the worker's queries all key on 'active' — a `notice` status would
-- drop people serving notice out of payroll and SG&A. ('notice' stays allowed by the employees CHECK, unused.)
-- Live values checked 2026-11-11: store.assets.status ∈ in_use|in_storage|damaged|in_repair|retired (no
-- 'disposed'); docket.tasks closed = done|abandoned; store.payment_requests open = submitted|pending_approval|
-- approved|held (src/exits.js mirrors all three).

-- ── Default notice period (LWD = notice date + this, unless HR overrides with a reason) ──
alter table podium.settings add column exit_notice_days int not null default 30
  check (exit_notice_days between 0 and 365);

-- ── The no-dues TEMPLATE (admin data, L8). Editing it never changes a started exit (items are a snapshot). ──
create table podium.exit_checklist_lines (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),   -- no ':' — 'tool:<id>' keys can never collide
  title text not null check (length(btrim(title)) between 1 and 120),
  owner text not null check (owner in ('hr', 'manager', 'it', 'admin', 'finance', 'store')),
  required boolean not null default true,
  allow_na boolean not null default false,
  applies_to text[] not null default '{}',   -- employment types; empty = all
  auto_source text check (auto_source in ('snorkel_assets', 'open_work', 'payment_requests', 'lot_access')),
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger exit_checklist_lines_touch before update on podium.exit_checklist_lines for each row execute function podium.touch_updated_at();

insert into podium.exit_checklist_lines (key, title, owner, required, allow_na, auto_source, sort) values
  ('notice_served',          'Notice served, or waiver / buyout recorded',     'hr',      true,  false, null,               10),
  ('assets_returned',        'Assets returned (live from Snorkel)',            'store',   true,  false, 'snorkel_assets',   20),
  ('id_card_keys',           'ID card, access card and keys returned',         'admin',   true,  false, null,               30),
  ('company_sim',            'Company SIM / number returned or ported',        'it',      true,  true,  null,               40),
  ('lot_access',             'LOT app access revoked (done by the close)',     'hr',      true,  false, 'lot_access',       50),
  ('open_work_handed_over',  'Open work handed over (live from Docket)',       'manager', true,  false, 'open_work',        60),
  ('advances_reimbursements','Advances / reimbursements / imprest settled',    'finance', true,  false, 'payment_requests', 70),
  ('leave_balance',          'Leave balance confirmed',                        'hr',      true,  false, null,               80),
  ('fnf',                    'Full & final — later phase',                     'finance', false, false, null,               90),
  ('relieving_letters',      'Relieving + experience letters issued',          'hr',      true,  false, null,              100),
  ('exit_interview',         'Exit interview',                                 'hr',      false, false, null,              110);

-- ── Other tools (L4 starter list, admin data). Each active tool becomes a `tool:<id>` line at exit start. ──
create table podium.exit_tools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger exit_tools_touch before update on podium.exit_tools for each row execute function podium.touch_updated_at();

insert into podium.exit_tools (name, sort) values
  ('Slack', 10), ('Shopify admin', 20), ('Amazon Seller Central', 30), ('Flipkart Seller Hub', 40),
  ('Meta Business / WhatsApp Business', 50), ('Uniware', 60), ('Delhivery', 70),
  ('Cashfree / Razorpay dashboards', 80), ('RazorpayX', 90), ('Bank portals', 100), ('Tally / accounts', 110),
  ('GitHub', 120), ('Cloudflare', 130), ('Supabase', 140), ('Shared logins in a password manager', 150);

-- ── One row per employment exit ──────────────────────────────────────────────
-- rehire_eligible is HR-only (the worker strips it for everyone else). fnf_* are L7 placeholders (later phase).
create table podium.employee_exits (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  initiated_by text not null check (initiated_by in ('employee', 'manager', 'hr', 'backfill')),
  started_by uuid,
  reason_code text not null check (reason_code in ('resignation', 'termination', 'absconding', 'end_of_internship',
    'end_of_contract', 'other')),
  reason_note text check (reason_note is null or length(reason_note) <= 2000),
  notice_date date,
  lwd date not null,
  lwd_override_reason text,
  rehire_eligible boolean,
  exit_interview text check (exit_interview is null or length(exit_interview) <= 8000),
  fnf_amount numeric,
  fnf_paid_on date,
  fnf_document_id uuid references podium.documents(id) on delete set null,
  closed_at timestamptz,
  closed_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (notice_date is null or lwd >= notice_date),
  check (initiated_by = 'backfill' or notice_date is not null),
  check (status <> 'closed' or closed_at is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) > 0))
);
-- One OPEN exit per employee (a rehire later gets a new row; closed/cancelled ones are history).
create unique index employee_exits_one_open on podium.employee_exits (employee_id) where status = 'open';
create index employee_exits_employee_idx on podium.employee_exits (employee_id, created_at desc);
create trigger employee_exits_touch before update on podium.employee_exits for each row execute function podium.touch_updated_at();

-- ── The checklist SNAPSHOT taken at start ────────────────────────────────────
create table podium.exit_checklist_items (
  id uuid primary key default gen_random_uuid(),
  exit_id uuid not null references podium.employee_exits(id),
  line_key text not null,
  title text not null,
  owner text not null check (owner in ('hr', 'manager', 'it', 'admin', 'finance', 'store')),
  required boolean not null,
  allow_na boolean not null,
  auto_source text check (auto_source in ('snorkel_assets', 'open_work', 'payment_requests', 'lot_access')),
  sort int not null default 100,
  status text not null default 'open' check (status in ('open', 'done', 'na')),
  note text check (note is null or length(note) <= 2000),
  document_id uuid references podium.documents(id) on delete set null,
  done_by uuid,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exit_id, line_key),
  check (status <> 'na' or (allow_na and length(btrim(coalesce(note, ''))) > 0)),
  check (status = 'open' or done_at is not null)
);
create trigger exit_checklist_items_touch before update on podium.exit_checklist_items for each row execute function podium.touch_updated_at();

-- ── The post-exit Google prompt (L5/L6) — an HR item, NOT a close gate ──────
-- A `kept` item whose keep_until has passed is due again (computed by the worker, no cron).
-- transfer_pending = Drive transfer started + account suspended; "Check transfer" (transfers.get) moves it to
-- transferred_suspended once Google says completed, or back to open (transfer_id cleared, last_error set) if it
-- failed. gone = Google has no account for the address any more (terminal, logged).
-- acting_id / acting_until = a 2-minute claim (J1's attempt pattern): one Google admin acts at a time, and every
-- write during the action is guarded on acting_id.
-- exit_id is null only for an item opened from the backfill review (exited before X1, no exit record yet).
create table podium.google_exit_items (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  exit_id uuid references podium.employee_exits(id),
  work_email text not null,
  google_user_id text,          -- null when the employee row never carried one; resolved (and verified) on action
  status text not null default 'open'
    check (status in ('open', 'kept', 'transfer_pending', 'transferred_suspended', 'suspended', 'gone')),
  keep_until date,
  keep_reason text,
  transfer_id text,
  transfer_to_employee_id uuid references podium.employees(id),
  last_error text,
  acting_id uuid,
  acting_until timestamptz,
  acted_by uuid,
  acted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'kept' or (keep_until is not null and length(btrim(coalesce(keep_reason, ''))) > 0)),
  check (status not in ('transfer_pending', 'transferred_suspended') or transfer_id is not null)
);
-- One live (open, kept or transfer_pending) item per employee.
create unique index google_exit_items_one_live on podium.google_exit_items (employee_id)
  where status in ('open', 'kept', 'transfer_pending');
create trigger google_exit_items_touch before update on podium.google_exit_items for each row execute function podium.touch_updated_at();

-- ── Exit events: the X1 writes that are not on an exit row (append-only) ─────
create table podium.exit_events (
  id bigint generated always as identity primary key,
  employee_id uuid not null references podium.employees(id),
  exit_id uuid references podium.employee_exits(id),
  actor uuid,
  event text not null check (event in ('access_revoked', 'google_item_opened')),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index exit_events_employee_idx on podium.exit_events (employee_id, created_at desc);
create trigger exit_events_no_update before update or delete on podium.exit_events
  for each row execute function podium.refuse_event_mutation();

-- ── google_admin_log: + the X1 actions ───────────────────────────────────────
-- 'keep_active' is not a Google write, but the spec says every outcome of the prompt is logged here.
alter table podium.google_admin_log drop constraint google_admin_log_action_check;
alter table podium.google_admin_log add constraint google_admin_log_action_check
  check (action in ('create_user', 'link_existing', 'suspend_user', 'reset_password', 'suspend_exited', 'drive_transfer',
    'keep_active', 'transfer_checked', 'account_gone'));

-- ── RLS: on, no policies; service_role only (as 0009) ────────────────────────
do $$
declare t text;
begin
  foreach t in array array['exit_checklist_lines', 'exit_tools', 'employee_exits', 'exit_checklist_items', 'google_exit_items',
                           'exit_events'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── Start: the exit + its checklist snapshot, in one transaction ─────────────
-- p = { employee_id, initiated_by, started_by, reason_code, reason_note, notice_date, lwd, lwd_override_reason,
--       rehire_eligible, items: [{line_key, title, owner, required, allow_na, auto_source, sort}] }
-- The worker decides who may start, the reason, the LWD and the snapshot (src/exits.js); this only guards the row.
-- Raises podium_<code>: employee_not_found · already_exited · exit_already_open · notice_before_joining.
create or replace function podium.exit_start(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e    podium.employees;
  v_x    podium.employee_exits;
  v_item jsonb;
  v_n    int := 0;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status = 'exited' then raise exception 'podium_already_exited'; end if;
  if exists (select 1 from podium.employee_exits where employee_id = v_e.id and status = 'open') then
    raise exception 'podium_exit_already_open';
  end if;
  if v_e.date_joined is not null and (p->>'notice_date')::date < v_e.date_joined then
    raise exception 'podium_notice_before_joining';
  end if;

  insert into podium.employee_exits (employee_id, status, initiated_by, started_by, reason_code, reason_note, notice_date,
    lwd, lwd_override_reason, rehire_eligible)
  values (v_e.id, 'open', p->>'initiated_by', nullif(p->>'started_by', '')::uuid, p->>'reason_code',
    nullif(btrim(coalesce(p->>'reason_note', '')), ''), (p->>'notice_date')::date, (p->>'lwd')::date,
    nullif(btrim(coalesce(p->>'lwd_override_reason', '')), ''), (p->>'rehire_eligible')::boolean)
  returning * into v_x;

  for v_item in select value from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    insert into podium.exit_checklist_items (exit_id, line_key, title, owner, required, allow_na, auto_source, sort)
    values (v_x.id, v_item->>'line_key', v_item->>'title', v_item->>'owner', (v_item->>'required')::boolean,
      (v_item->>'allow_na')::boolean, nullif(v_item->>'auto_source', ''), coalesce((v_item->>'sort')::int, 100));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('exit_id', v_x.id, 'employee_id', v_e.id, 'lwd', v_x.lwd, 'items', v_n);
end $$;

-- ── Close: the ONLY place an employee becomes `exited` ───────────────────────
-- p = { exit_id, actor_user_id }. "Today" is the DB's IST date, not the caller's.
-- Raises podium_<code>: exit_not_found · exit_not_open · already_exited · before_lwd · checklist_incomplete ·
-- assets_outstanding · open_work (the last three carry the count/keys in DETAIL).
-- Reports are reassigned by the worker right after (reassignReportsOnExit, RULE-PODIUM-010).
create or replace function podium.exit_close(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_x       podium.employee_exits;
  v_e       podium.employees;
  v_actor   uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_open    text;
  v_assets  int := 0;
  v_tasks   int := 0;
  v_profile int := 0;
  v_roles   int := 0;
  v_comp    int := 0;
  v_gadmin  int := 0;
  v_gitem   uuid;
  v_emp_id  uuid;
begin
  -- Lock order = exit_start's (employee, then exit), so a start and a close can never deadlock.
  select employee_id into v_emp_id from podium.employee_exits where id = (p->>'exit_id')::uuid;
  if not found then raise exception 'podium_exit_not_found'; end if;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_x from podium.employee_exits where id = (p->>'exit_id')::uuid for update;
  if v_x.status <> 'open' then raise exception 'podium_exit_not_open'; end if;
  if v_e.status = 'exited' then raise exception 'podium_already_exited'; end if;
  if v_today < v_x.lwd then raise exception 'podium_before_lwd' using detail = v_x.lwd::text; end if;

  -- Every required line done, or n/a where n/a is allowed. lot_access is completed BY this close.
  select string_agg(line_key, ',' order by sort) into v_open from podium.exit_checklist_items
   where exit_id = v_x.id and required and coalesce(auto_source, '') <> 'lot_access'
     and not (status = 'done' or (status = 'na' and allow_na));
  if v_open is not null then raise exception 'podium_checklist_incomplete' using detail = v_open; end if;

  -- Live checks — a ticked line is not enough if the source still says otherwise.
  if v_e.auth_user_id is not null then
    select count(*) into v_assets from store.assets
     where custodian_user_id = v_e.auth_user_id and status <> 'retired';
  end if;
  if v_assets > 0 then raise exception 'podium_assets_outstanding' using detail = v_assets::text; end if;
  select count(*) into v_tasks from docket.tasks
   where (assignee_employee_id = v_e.id or owner_employee_id = v_e.id)
     and status not in ('done', 'abandoned') and archived_at is null;
  if v_tasks > 0 then raise exception 'podium_open_work' using detail = v_tasks::text; end if;

  update podium.employees set status = 'exited', date_exited = v_x.lwd, exit_reason = v_x.reason_code, updated_at = now()
   where id = v_e.id;
  update podium.employee_exits set status = 'closed', closed_at = now(), closed_by = v_actor where id = v_x.id;
  update podium.exit_checklist_items set status = 'done', done_at = now(), done_by = v_actor,
         note = coalesce(note, 'Completed by the exit close')
   where exit_id = v_x.id and auto_source = 'lot_access' and status = 'open';

  -- LOT app access ends: login off, Podium role, salary access and Google-admin power removed.
  if v_e.auth_user_id is not null then
    update store.users_profile set active = false where id = v_e.auth_user_id and active;
    get diagnostics v_profile = row_count;
    delete from store.podium_user_roles where user_id = v_e.auth_user_id;
    get diagnostics v_roles = row_count;
    delete from podium.comp_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_comp = row_count;
    delete from podium.google_admin_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_gadmin = row_count;
  end if;

  -- The Google prompt (L5): never a suspension, only an HR item that survives the exit.
  if v_e.work_email is not null
     and not exists (select 1 from podium.google_exit_items where employee_id = v_e.id
                       and status in ('open', 'kept', 'transfer_pending')) then
    insert into podium.google_exit_items (employee_id, exit_id, work_email, google_user_id)
    values (v_e.id, v_x.id, lower(v_e.work_email), v_e.google_user_id)
    returning id into v_gitem;
  end if;

  return jsonb_build_object('exit_id', v_x.id, 'employee_id', v_e.id, 'date_exited', v_x.lwd,
    'exit_reason', v_x.reason_code, 'login_deactivated', v_profile > 0, 'podium_roles_removed', v_roles,
    'comp_access_removed', v_comp > 0, 'google_admin_removed', v_gadmin > 0, 'google_exit_item_id', v_gitem);
end $$;

-- ── Backfill: a closed exit record for someone exited before X1 ──────────────
-- p = { employee_id, reason_code, lwd (HR-confirmed), actor_user_id }. The old free-text exit_reason is preserved
-- as reason_note; employees.exit_reason becomes the code and date_exited the confirmed LWD. No checklist items.
-- Raises podium_<code>: employee_not_found · not_exited · already_backfilled · bad_lwd · lwd_before_joining.
create or replace function podium.exit_backfill(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e     podium.employees;
  v_x     podium.employee_exits;
  v_lwd   date;
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status <> 'exited' then raise exception 'podium_not_exited'; end if;
  if exists (select 1 from podium.employee_exits where employee_id = v_e.id) then
    raise exception 'podium_already_backfilled';
  end if;
  begin
    v_lwd := (p->>'lwd')::date;
  exception when others then raise exception 'podium_bad_lwd';
  end;
  if v_lwd is null or v_lwd > (now() at time zone 'Asia/Kolkata')::date then raise exception 'podium_bad_lwd'; end if;
  if v_e.date_joined is not null and v_lwd < v_e.date_joined then raise exception 'podium_lwd_before_joining'; end if;

  insert into podium.employee_exits (employee_id, status, initiated_by, started_by, reason_code, reason_note, lwd,
    closed_at, closed_by)
  values (v_e.id, 'closed', 'backfill', v_actor, p->>'reason_code', nullif(btrim(coalesce(v_e.exit_reason, '')), ''),
    v_lwd, now(), v_actor)
  returning * into v_x;

  update podium.employees set exit_reason = v_x.reason_code, date_exited = v_lwd, updated_at = now() where id = v_e.id;

  return jsonb_build_object('exit_id', v_x.id, 'employee_id', v_e.id, 'date_exited', v_lwd,
    'previous_date_exited', v_e.date_exited, 'previous_exit_reason', v_e.exit_reason);
end $$;

-- ── Tick a checklist line, under the exit lock ──────────────────────────────
-- p = { item_id, status: open|done|na, note, document_id? (key present = set it, '' / null = clear), actor_user_id,
--       role: 'hr' | 'manager' (the worker's canTickItem decided; re-checked here as defence in depth) }
-- Locks employee → exit (the exit_start / exit_close order), so a tick and a close serialise: a close can never
-- run between "assets checked" and "line written". The live checks are re-run HERE, not trusted from the caller.
-- Raises podium_<code>: item_not_found · exit_not_open · bad_item_status · set_by_close · forbidden_item ·
-- na_not_allowed · na_note_required · assets_outstanding · assets_unverifiable · open_work · bad_document.
create or replace function podium.exit_update_item(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_it       podium.exit_checklist_items;
  v_x        podium.employee_exits;
  v_e        podium.employees;
  v_status   text := p->>'status';
  v_role     text := p->>'role';
  v_note     text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor    uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_doc      uuid := nullif(p->>'document_id', '')::uuid;
  v_exit_id  uuid;
  v_emp_id   uuid;
  v_n        int;
begin
  select exit_id into v_exit_id from podium.exit_checklist_items where id = (p->>'item_id')::uuid;
  if not found then raise exception 'podium_item_not_found'; end if;
  select employee_id into v_emp_id from podium.employee_exits where id = v_exit_id;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_x from podium.employee_exits where id = v_exit_id for update;
  if v_x.status <> 'open' then raise exception 'podium_exit_not_open'; end if;
  select * into v_it from podium.exit_checklist_items where id = (p->>'item_id')::uuid for update;

  if v_status is null or v_status not in ('open', 'done', 'na') then raise exception 'podium_bad_item_status'; end if;
  if v_it.auto_source = 'lot_access' then raise exception 'podium_set_by_close'; end if;
  if v_role is null or v_role not in ('hr', 'manager') or (v_role = 'manager' and v_it.owner <> 'manager') then
    raise exception 'podium_forbidden_item';
  end if;
  if v_status = 'na' and not v_it.allow_na then raise exception 'podium_na_not_allowed'; end if;
  if v_status = 'na' and v_note is null then raise exception 'podium_na_note_required'; end if;

  if v_status = 'done' and v_it.auto_source = 'snorkel_assets' then
    if v_e.auth_user_id is not null then
      select count(*) into v_n from store.assets where custodian_user_id = v_e.auth_user_id and status <> 'retired';
      if v_n > 0 then raise exception 'podium_assets_outstanding' using detail = v_n::text; end if;
    end if;
    -- Unverifiable: no auth link, or assets held under the person's NAME with no custodian user.
    select count(*) into v_n from store.assets
     where custodian_user_id is null and status <> 'retired'
       and lower(btrim(coalesce(custodian_name, ''))) = lower(btrim(v_e.full_name));
    if (v_e.auth_user_id is null or v_n > 0) and (v_role <> 'hr' or v_note is null) then
      raise exception 'podium_assets_unverifiable' using detail = v_n::text;
    end if;
  end if;
  if v_status = 'done' and v_it.auto_source = 'open_work' then
    select count(*) into v_n from docket.tasks
     where (assignee_employee_id = v_e.id or owner_employee_id = v_e.id)
       and status not in ('done', 'abandoned') and archived_at is null;
    if v_n > 0 then raise exception 'podium_open_work' using detail = v_n::text; end if;
  end if;
  if p ? 'document_id' and v_doc is not null
     and not exists (select 1 from podium.documents where id = v_doc and employee_id = v_e.id) then
    raise exception 'podium_bad_document';
  end if;

  update podium.exit_checklist_items set
    status = v_status, note = v_note,
    done_by = case when v_status = 'open' then null else v_actor end,
    done_at = case when v_status = 'open' then null else now() end,
    document_id = case when p ? 'document_id' then v_doc else document_id end
   where id = v_it.id
  returning * into v_it;
  return to_jsonb(v_it);
end $$;

-- ── Backfill review: revoke what an already-exited person can still reach ───
-- Never automatic (decided by the lane): HR presses it per person. p = { employee_id, actor_user_id }.
-- Raises podium_<code>: employee_not_found · not_exited.
create or replace function podium.exit_revoke_access(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e       podium.employees;
  v_actor   uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_profile int := 0;
  v_roles   int := 0;
  v_comp    int := 0;
  v_gadmin  int := 0;
  v_out     jsonb;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status <> 'exited' then raise exception 'podium_not_exited'; end if;
  if v_e.auth_user_id is not null then
    update store.users_profile set active = false where id = v_e.auth_user_id and active;
    get diagnostics v_profile = row_count;
    delete from store.podium_user_roles where user_id = v_e.auth_user_id;
    get diagnostics v_roles = row_count;
    delete from podium.comp_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_comp = row_count;
    delete from podium.google_admin_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_gadmin = row_count;
  end if;
  v_out := jsonb_build_object('employee_id', v_e.id, 'auth_linked', v_e.auth_user_id is not null,
    'login_deactivated', v_profile > 0, 'podium_roles_removed', v_roles, 'comp_access_removed', v_comp > 0,
    'google_admin_removed', v_gadmin > 0);
  insert into podium.exit_events (employee_id, actor, event, detail) values (v_e.id, v_actor, 'access_revoked', v_out);
  return v_out;
end $$;

-- ── Backfill review: open the Google prompt for someone exited before X1 ────
-- Only when the person has NO google_exit_items row at all. p = { employee_id, actor_user_id }. Raises podium_<code>: employee_not_found · not_exited · no_work_email ·
-- google_item_exists.
create or replace function podium.exit_open_google_item(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e     podium.employees;
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_exit  uuid;
  v_id    uuid;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status <> 'exited' then raise exception 'podium_not_exited'; end if;
  if v_e.work_email is null then raise exception 'podium_no_work_email'; end if;
  -- Any item at all (live or already actioned) — an actioned account is never re-opened from here.
  if exists (select 1 from podium.google_exit_items where employee_id = v_e.id) then
    raise exception 'podium_google_item_exists';
  end if;
  select id into v_exit from podium.employee_exits where employee_id = v_e.id and status = 'closed'
   order by closed_at desc nulls last limit 1;
  insert into podium.google_exit_items (employee_id, exit_id, work_email, google_user_id)
  values (v_e.id, v_exit, lower(v_e.work_email), v_e.google_user_id)
  returning id into v_id;
  insert into podium.exit_events (employee_id, exit_id, actor, event, detail)
  values (v_e.id, v_exit, v_actor, 'google_item_opened', jsonb_build_object('google_exit_item_id', v_id));
  return jsonb_build_object('google_exit_item_id', v_id, 'employee_id', v_e.id);
end $$;

revoke all on function podium.exit_start(jsonb) from public, anon, authenticated;
revoke all on function podium.exit_close(jsonb) from public, anon, authenticated;
revoke all on function podium.exit_backfill(jsonb) from public, anon, authenticated;
revoke all on function podium.exit_update_item(jsonb) from public, anon, authenticated;
revoke all on function podium.exit_revoke_access(jsonb) from public, anon, authenticated;
revoke all on function podium.exit_open_google_item(jsonb) from public, anon, authenticated;
grant execute on function podium.exit_update_item(jsonb) to service_role;
grant execute on function podium.exit_revoke_access(jsonb) to service_role;
grant execute on function podium.exit_open_google_item(jsonb) to service_role;
grant execute on function podium.exit_start(jsonb) to service_role;
grant execute on function podium.exit_close(jsonb) to service_role;
grant execute on function podium.exit_backfill(jsonb) to service_role;

notify pgrst, 'reload schema';
