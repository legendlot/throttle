# Docket — Org Task Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Spec: `docs/superpowers/specs/2026-06-03-docket-design.md`. Read it first — this plan implements it.

**Goal:** Ship Docket — an org-wide task manager — as a new system in the Throttle monorepo: own worker (`docketops`), own `docket` schema in the shared `lot-production` DB, own permission layer in `store`, GH-Pages app at `docket.legendoftoys.com`.

**Architecture:** Clone the **Podium/Snorkel** stack 1:1. Worker = Cloudflare Worker (service_role, sole DB client) with `GET_ACTIONS`/`POST_ACTIONS` maps and per-schema `sb*` helpers. App = Next.js static export using `@throttle/{auth,db,ui,domain}`, `AuthProvider pingAction="getMe"`. People/departments read live from `podium.*`.

**Tech Stack:** Cloudflare Workers + Supabase (PostgREST + RLS), Next.js 14 static export, Turborepo, lucide-react, recharts.

**Verification model (LOT convention — NO unit-test harness in these apps):** each phase verified by (a) Supabase advisors clean / SQL data-path checks, (b) `curl` worker smoke with a real JWT where possible, (c) `npx turbo build --filter=@throttle/docket` zero-errors, (d) end-to-end data-path smoke. Frequent commits per CLAUDE.md (commit+push after each system-repo change).

---

## File structure (created/modified)

**Migration (Supabase):** one migration `docket_v1` (applied via MCP `apply_migration`).

**Worker — `05_Throttle/docketops-worker/`:**
- Create `wrangler.toml`, `package.json`, `src/index.js`, `migrations/0001_docket_v1.sql` (mirror of applied migration, for repo record).

**App — `05_Throttle/apps/docket/`:**
- Create `package.json`, `next.config.js`, `src/app/layout.js`, `src/app/globals.css`, `src/app/page.js`, `src/app/login/page.js`, `src/app/(auth)/layout.js`.
- Pages: `(auth)/tasks/page.js`, `(auth)/tasks/new/page.js`, `(auth)/tasks/detail/page.js`, `(auth)/dashboard/page.js`, `(auth)/admin/roles/page.js`, `(auth)/admin/users/page.js`.
- `src/lib/docketopsFetch.js`, `src/lib/nav.js`, `src/lib/format.js`, `src/lib/tasks.js` (status/priority labels + helpers).
- `src/components/DocketIcon.js`, `src/components/StatusBadge.js`, `src/components/PriorityBadge.js`, `src/components/TaskForm.js`, `src/components/CommentsPanel.js`, `src/components/HistoryPanel.js`, `src/components/SubtaskPanel.js`, `src/components/DocLinksPanel.js`.
- `public/` — Docket icon set (from `~/Downloads/docket-logo/`) + reuse `lot-logo.png` from podium.

**Deploy — root `05_Throttle/`:** Create `.github/workflows/deploy-docket.yml`. New GH repo `legendlot/docket`. DNS `docket.legendoftoys.com`.

---

## Phase 1 — Database (`docket_v1` migration)

### Task 1.1: Apply the `docket_v1` migration

**Files:** Supabase (MCP `apply_migration` name=`docket_v1`); mirror to `docketops-worker/migrations/0001_docket_v1.sql`.

- [ ] **Step 1: Pre-flight schema check** — confirm `podium.departments`/`podium.employees` PK columns + types (RULE: verify schema before FK).

Run (MCP `execute_sql`):
```sql
select table_name, column_name, data_type from information_schema.columns
where table_schema='podium' and table_name in ('departments','employees') and column_name='id';
select column_name,data_type from information_schema.columns where table_schema='store' and table_name='sequences' order by ordinal_position;
```
Expected: `podium.departments.id` + `podium.employees.id` are `uuid`. Confirm `store.sequences` shape (key/value).

- [ ] **Step 2: Apply migration.** Full SQL:

```sql
create schema if not exists docket;
grant usage on schema docket to service_role;

-- ── tasks ────────────────────────────────────────────────────────────────
create table docket.tasks (
  id uuid primary key default gen_random_uuid(),
  task_no text unique not null,
  title text not null,
  description text,
  department_id uuid references podium.departments(id),
  owner_employee_id uuid references podium.employees(id),
  assignee_employee_id uuid references podium.employees(id),
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','done','blocked','abandoned')),
  priority text not null default 'P2' check (priority in ('P0','P1','P2','P3')),
  parent_task_id uuid references docket.tasks(id),
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  deadline timestamptz not null,
  revised_deadline timestamptz,
  completed_at timestamptz,
  abandoned_at timestamptz,
  abandoned_by uuid,
  abandon_reason text,
  custom_fields jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz
);
create index docket_tasks_status_idx on docket.tasks(status);
create index docket_tasks_priority_idx on docket.tasks(priority);
create index docket_tasks_dept_idx on docket.tasks(department_id);
create index docket_tasks_owner_idx on docket.tasks(owner_employee_id);
create index docket_tasks_assignee_idx on docket.tasks(assignee_employee_id);
create index docket_tasks_parent_idx on docket.tasks(parent_task_id);
create index docket_tasks_creator_idx on docket.tasks(created_by_user_id);
create index docket_tasks_eff_deadline_idx on docket.tasks((coalesce(revised_deadline, deadline)));

create table docket.task_collaborators (
  task_id uuid not null references docket.tasks(id) on delete cascade,
  employee_id uuid not null references podium.employees(id),
  added_by uuid, added_at timestamptz not null default now(),
  primary key (task_id, employee_id)
);

create table docket.task_documents (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  title text, url text not null,
  added_by uuid, added_at timestamptz not null default now()
);
create index docket_task_documents_task_idx on docket.task_documents(task_id);

create table docket.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  author_user_id uuid not null, body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz, deleted_at timestamptz
);
create index docket_task_comments_task_idx on docket.task_comments(task_id);

create table docket.task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  actor_user_id uuid, event_type text not null,
  field text, old_value text, new_value text, note text,
  created_at timestamptz not null default now()
);
create index docket_task_history_task_idx on docket.task_history(task_id, created_at);

-- RLS: on + service_role only (RULE-RLS-001) ────────────────────────────────
do $$ declare t text; begin
  foreach t in array array['tasks','task_collaborators','task_documents','task_comments','task_history']
  loop
    execute format('alter table docket.%I enable row level security;', t);
    execute format('grant all on docket.%I to service_role;', t);
  end loop;
end $$;

-- ── sequence: DKT-NNNN ──────────────────────────────────────────────────────
insert into store.sequences (key, value) values ('docket_task', 0)
  on conflict (key) do nothing;

create or replace function docket.next_task_seq()
returns text language plpgsql security definer set search_path = store, docket as $$
declare n bigint;
begin
  update store.sequences set value = value + 1 where key = 'docket_task' returning value into n;
  if n is null then
    insert into store.sequences(key,value) values('docket_task',1) returning value into n;
  end if;
  return 'DKT-' || n::text;
end $$;
grant execute on function docket.next_task_seq() to service_role;

-- ── visibility + filter RPC ─────────────────────────────────────────────────
create or replace function docket.list_tasks(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_status text default null, p_department_id uuid default null,
  p_employee_filter uuid default null, p_priority text default null,
  p_overdue boolean default false, p_revised boolean default false,
  p_parent_id uuid default null, p_mine boolean default false, p_q text default null
) returns setof docket.tasks language sql stable security definer set search_path = docket, public as $$
  select t.* from docket.tasks t
  where (
    p_view_all
    or t.owner_employee_id = p_employee
    or t.assignee_employee_id = p_employee
    or t.created_by_user_id = p_user
    or (p_dept is not null and t.department_id = p_dept)
    or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
  )
  and (p_status is null or t.status = p_status)
  and (p_department_id is null or t.department_id = p_department_id)
  and (p_employee_filter is null or t.owner_employee_id = p_employee_filter or t.assignee_employee_id = p_employee_filter)
  and (p_priority is null or t.priority = p_priority)
  and (not p_overdue or (t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline) < now()))
  and (not p_revised or t.revised_deadline is not null)
  and (p_parent_id is null or t.parent_task_id = p_parent_id)
  and (not p_mine or t.owner_employee_id = p_employee or t.assignee_employee_id = p_employee
       or t.created_by_user_id = p_user
       or exists (select 1 from docket.task_collaborators c where c.task_id=t.id and c.employee_id=p_employee))
  and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;
grant execute on function docket.list_tasks(uuid,uuid,uuid,boolean,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text) to service_role;

-- ── permission layer (in store, mirrors podium) ─────────────────────────────
create table if not exists store.docket_roles (
  role_key text primary key,
  label text not null, description text,
  permissions jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz
);
create table if not exists store.docket_user_roles (
  user_id uuid primary key,
  role_key text not null references store.docket_roles(role_key),
  assigned_by uuid, assigned_at timestamptz not null default now()
);
alter table store.docket_roles enable row level security;
alter table store.docket_user_roles enable row level security;
grant all on store.docket_roles to service_role;
grant all on store.docket_user_roles to service_role;

insert into store.docket_roles (role_key,label,description,permissions,is_system) values
  ('admin','Admin','Full Docket administration + see all tasks',
     '{"docket_admin":true,"docket_view_all":true}'::jsonb, true),
  ('employee','Employee','Baseline — own + collaborator + own-department tasks',
     '{}'::jsonb, true),
  ('reviewer','Reviewer','Org-wide task visibility + review dashboard (no admin)',
     '{"docket_view_all":true}'::jsonb, false)
on conflict (role_key) do nothing;

-- ── dashboard aggregate RPC ─────────────────────────────────────────────────
create or replace function docket.dashboard_stats()
returns jsonb language sql stable security definer set search_path = docket, public as $$
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from docket.tasks group by status) s),
    'overdue', (select count(*) from docket.tasks
       where status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from docket.tasks
       where status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from docket.tasks where revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from docket.tasks where status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.departments d on d.id=t.department_id
       group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.employees e on e.id=t.owner_employee_id
       group by e.id,e.full_name order by open desc) x)
  );
$$;
grant execute on function docket.dashboard_stats() to service_role;
```

- [ ] **Step 3: Expose schema** — add `docket` to Supabase Data API → Exposed Schemas (`public, graphql_public, store, brand, ignition, podium, docket`). Verify with `curl` (see Task 1.3).

- [ ] **Step 4: Bootstrap founder admins.** Resolve user_ids + insert.
```sql
-- find the two founders by email (Afshaan + Vinay) in auth.users
select id, email from auth.users where email ilike 'afshaan@legendoftoys.com' or email ilike 'vinay%@legendoftoys.com';
-- then (substitute UUIDs):
insert into store.docket_user_roles (user_id, role_key, assigned_by)
values ('<afshaan-uuid>','admin','<afshaan-uuid>'), ('<vinay-uuid>','admin','<afshaan-uuid>')
on conflict (user_id) do update set role_key=excluded.role_key;
```

- [ ] **Step 5: Verify advisors clean.** MCP `get_advisors` type=security → 0 new `rls_disabled` on `docket.*`. Mirror the SQL into `docketops-worker/migrations/0001_docket_v1.sql`. Commit migration file.

---

## Phase 2 — `docketops` worker

### Task 2.1: Scaffold the worker

**Files:** Create `docketops-worker/{wrangler.toml,package.json}`.

- [ ] **Step 1:** `wrangler.toml`:
```toml
name = "docketops"
main = "src/index.js"
compatibility_date = "2026-05-28"
workers_dev = true

[vars]
SUPABASE_URL = "https://jkxcnjabmrkteanzoofj.supabase.co"
# Secrets via `wrangler secret put`: SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```
- [ ] **Step 2:** `package.json` — clone podiumops-worker/package.json with name `docketops-worker`.

### Task 2.2: Worker `src/index.js`

**Files:** Create `docketops-worker/src/index.js`.

Build from the podiumops skeleton (lines 26–149 verbatim for CORS/`json`/`err`/`ok`/`nowIso`/`sb`(rename helpers)/`verifyJWT`). Concrete deltas:

- [ ] **Step 1: Helpers + auth.** Three schema helpers: `sbDocket` (Accept/Content-Profile `docket`), `sbStore` (`store`), `sbPodium` (`podium`). `verifyJWT`: identity from `store.users_profile`; perms from `store.docket_user_roles → docket_roles.permissions` (no role → `{}`). Resolve caller employee: `sbPodium('/rest/v1/employees?auth_user_id=eq.<uid>&select=id,department_id,full_name&limit=1')` → `auth.employeeId`, `auth.departmentId`.

- [ ] **Step 2: Perm helpers.** `requireAdmin(auth)` (403 unless `permissions.docket_admin`); `canViewAll(auth)` = `docket_admin||docket_view_all`. `canEditTask(auth, task)` = `docket_admin || task.created_by_user_id===auth.userId || task.owner_employee_id===auth.employeeId || task.assignee_employee_id===auth.employeeId`. `normalizeDocketPerms(p)` = keep `docket_admin`/`docket_view_all`; force `docket_view_all` true when `docket_admin`. `DOCKET_PERM_KEYS=['docket_admin','docket_view_all']`. `logHistory(env, task_id, actor, event_type, {field,old,new,note})` → insert `docket.task_history`.

- [ ] **Step 3: GET handlers.**
  - `getMe(url,auth,env)` → `ok({ id, email, role, full_name, permissions, employee_id, department_id })` (AuthProvider reads `.permissions`).
  - `getDepartments` → `sbPodium('/rest/v1/departments?select=id,name&order=name')`.
  - `getEmployees` → `sbPodium('/rest/v1/employees?status=eq.active&select=id,full_name,department_id&order=full_name')`.
  - `getTasks` → call `sbDocket('/rest/v1/rpc/list_tasks', POST)` with all `p_*` args from query params + `p_view_all=canViewAll(auth)`, `p_user=auth.userId`, `p_employee=auth.employeeId`, `p_dept=auth.departmentId`. Then hydrate dept/owner/assignee names + counts (collab/doc/comment/child) via batched `in` reads (NEVER per-row await — RULE 50-subrequest). Support `group_by` by returning flat rows (app groups) — keep worker flat.
  - `getTask` → fetch task; if `!canViewAll && !visible` (re-run visibility predicate) → 403. Return task + parent ref + children (`parent_task_id=eq.id`) + collaborators(+names) + documents + comments(`deleted_at=is.null`) + history(order created_at). Add `_can_edit`.
  - `getDashboard` → `canViewAll` gate; `sbDocket('/rest/v1/rpc/dashboard_stats', POST)`.
  - `getDocketRoles` → `sbStore('/rest/v1/docket_roles?select=*&order=is_system.desc,label')`.
  - `getDocketUsers` → admin gate; clone podium `getPodiumUsers` (users_profile + docket_user_roles + auth emails).

- [ ] **Step 4: POST handlers.**
  - `createTask(body,auth,env)`: require `title,department_id,owner_employee_id,deadline`; mint `task_no` via `sbDocket('/rest/v1/rpc/next_task_seq',POST)`; enforce one-level parent guard if `parent_task_id` (reject if that parent has a parent); insert; insert collaborators[]; insert documents[]; `logHistory('created')`. Return `{id, task_no}`.
  - `updateTask`: load task; `canEditTask` gate; strip PROTECTED (`task_no,created_at,created_by_user_id,deadline,status,id`); diff each changed field → `logHistory('<field>_changed')`; PATCH; stamp `updated_by/at`.
  - `changeStatus`: gate; validate enum; set `completed_at` when→done; `logHistory('status_changed', old→new, note)`.
  - `reviseDeadline`: gate; require `new_deadline`+`reason`; set `revised_deadline`; `logHistory('deadline_revised', old=effective, new, note=reason)`.
  - `abandonTask`: gate; require `reason`; status→abandoned + `abandoned_at/by/reason`; `logHistory('abandoned')`.
  - `setParent`: gate; one-level guard (target parent must have null parent; this task must have no children); set/clear `parent_task_id`; `logHistory('parent_changed')`.
  - `createSubtask`: = createTask with `parent_task_id` required + guard.
  - `addCollaborator`/`removeCollaborator`: gate; upsert/delete row; `logHistory('collaborator_added'/'removed', new=employee_id)`.
  - `addDocument`: visible+(edit OR collaborator) ; validate `url ~ ^https?://`; insert; `logHistory('document_added')`. `removeDocument`: gate; delete; `logHistory('document_removed')`.
  - `addComment`: visible; insert (author=auth.userId). `editComment`/`deleteComment`: author or admin; `deleteComment` sets `deleted_at`.
  - `createDocketRole`/`updateDocketRole`/`deleteDocketRole`/`assignDocketRole`: clone podium handlers verbatim, `podium`→`docket`, `normalizeDocketPerms`.

- [ ] **Step 5: Maps + dispatch.** `GET_ACTIONS`/`POST_ACTIONS` objects; `handleGet`/`handlePost`/`export default` cloned from podium **but drop the SELF_SERVE / `podium_view` gate** — Docket baseline (no role) is a real authenticated tier (any verified user can create/see-own), so the gate is just `verifyJWT` + per-handler `canViewAll`/`canEditTask`/`requireAdmin`. Keep `ping` + `/health`.

### Task 2.3: Deploy worker

- [ ] **Step 1:** `cd 05_Throttle/docketops-worker && npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (paste the project `service_role` key — same as podiumops) + `SUPABASE_ANON_KEY`.
- [ ] **Step 2:** commit + push monorepo, then `cd 05_Throttle/docketops-worker && npx wrangler deploy`.
- [ ] **Step 3: Smoke.** `curl 'https://docketops.afshaan.workers.dev/?action=ping'` → `{ok:true,data:{pong:true}}`. (Authed actions smoke after app login or with a pasted JWT.)

---

## Phase 3 — `apps/docket`

### Task 3.1: Scaffold app + branding

**Files:** Create app config + public assets.
- [ ] **Step 1:** `package.json` (name `@throttle/docket`, deps clone podium incl. recharts+lucide), `next.config.js` (clone), `src/app/globals.css` (clone podium; set `--docket-accent:#F2CD1A`).
- [ ] **Step 2:** Copy logo: `cp ~/Downloads/docket-logo/docket.svg apps/docket/public/favicon.svg`; `docket-32.png`→`favicon.png`; `docket-180.png`→`apple-touch-icon.png`; `docket-512.png`→`logo.png`; copy `apps/podium/public/lot-logo.png`→`apps/docket/public/lot-logo.png`.
- [ ] **Step 3:** `src/components/DocketIcon.js` (img `/favicon.svg`).

### Task 3.2: App shell

**Files:** `src/app/{layout.js,page.js,login/page.js,(auth)/layout.js}`, `src/lib/{docketopsFetch.js,nav.js,format.js,tasks.js}`.
- [ ] **Step 1:** `layout.js` clone (title `Docket · Tasks`, `AuthProvider pingAction="getMe"`).
- [ ] **Step 2:** `docketopsFetch.js` clone podiumopsFetch → `docketopsGet/Post`, env `NEXT_PUBLIC_DOCKETOPS_URL` default `https://docketops.afshaan.workers.dev`.
- [ ] **Step 3:** `nav.js` — groups: TASKS [{Dashboard `/dashboard` requires `docket_view_all`}, {My Tasks `/tasks`}, {New Task `/tasks/new`}]; ADMIN [{Roles `/admin/roles` requires `docket_admin`},{Users `/admin/users` requires `docket_admin`}]. `filterNavByPerms` clone.
- [ ] **Step 4:** `tasks.js` — `STATUSES` ([{key,label,color}] not_started/in_progress/done/blocked/abandoned), `PRIORITIES` (P0 immediate/red … P3 low/grey), `effectiveDeadline(t)`, `isOverdue(t)`, label maps. `format.js` clone (date helpers).
- [ ] **Step 5:** `page.js` root landing → `perms.docket_view_all ? '/dashboard/' : '/tasks/'`. `login/page.js` clone (DocketIcon, "DOCKET", subtitle "Org Task Manager", accent var). `(auth)/layout.js` clone (appLabel "DOCKET", appShortLabel "DK", DocketIcon).
- [ ] **Step 6:** `StatusBadge.js` + `PriorityBadge.js` (pill components from `tasks.js` maps).

### Task 3.3: Task pages

- [ ] **Step 1: `(auth)/tasks/page.js`** — list. Loads `getTasks` (filters from URL/state) + `getDepartments` + `getEmployees` for filter pickers. Controls: status / department / person / priority selects, "Overdue" + "Revised" toggles, search box, **Group by** (none/person/department), "My tasks" toggle (`lens=mine`). Table rows: `DKT-NNNN`, title (link to detail), dept, owner/assignee, StatusBadge, PriorityBadge, effective deadline (red if overdue), counts. Grouping renders collapsible sections client-side.
- [ ] **Step 2: `(auth)/tasks/new/page.js`** — `TaskForm` (title, description, department select, owner select, assignee select, collaborators multi, **deadline date+time required**, priority select default P2, doc links repeatable {title,url}, optional parent task search). Submit → `createTask` → redirect `/tasks/detail/?id=`.
- [ ] **Step 3: `(auth)/tasks/detail/page.js`** — `?id=`. Header (DKT-NNNN, title, badges, ↑parent link if any). Sections: editable fields (inline `updateTask`); **Status** control (`changeStatus`); **Revise deadline** button → reason modal (`reviseDeadline`); **Abandon** button → reason modal (`abandonTask`, hidden once abandoned); `DocLinksPanel` (add/remove); `SubtaskPanel` (children + roll-up `done/total` + "Add sub-task" → new with parent preset); `CommentsPanel` (list/add/edit/delete own); tab/section **History** (`HistoryPanel` — full audit incl. deadline revisions w/ reason).
- [ ] **Step 4:** Components `TaskForm.js`, `CommentsPanel.js`, `HistoryPanel.js`, `SubtaskPanel.js`, `DocLinksPanel.js` — each self-contained, using `docketopsGet/Post`, toast via `const { showToast } = useToast()` + `showToast(msg,'success'|'error')` (NOT `toast(msg,'ok')`).

### Task 3.4: Dashboard + admin

- [ ] **Step 1: `(auth)/dashboard/page.js`** — gate `docket_view_all`. `getDashboard`. Tiles: overdue / due-soon / open / completed-30d / revised-count. Status distribution (recharts bar/pie). By-department table (open/done/blocked/overdue). By-person table. "Deadline-revision flags" list (link to `/tasks?revised=1`).
- [ ] **Step 2: `(auth)/admin/roles/page.js` + `(auth)/admin/users/page.js`** — clone podium `/admin/roles` (2-key matrix: docket_admin/docket_view_all, force view_all on admin, lock system roles) + `/admin/users` (per-user role select, "— none (self-only) —" default).

### Task 3.5: Build

- [ ] **Step 1:** add `apps/docket` to workspace if needed (root `package.json` workspaces already globs `apps/*`). `npm install` if new deps.
- [ ] **Step 2:** `npx turbo build --filter=@throttle/docket` → zero errors. Fix until clean.
- [ ] **Step 3:** commit + push.

---

## Phase 4 — Deploy pipeline

### Task 4.1: Repo + workflow + DNS

- [ ] **Step 1:** `gh repo create legendlot/docket --private` (gh-pages target).
- [ ] **Step 2:** `.github/workflows/deploy-docket.yml` — clone deploy-podium.yml: `--filter=@throttle/docket`, env `NEXT_PUBLIC_WORKER_URL` + `NEXT_PUBLIC_DOCKETOPS_URL` = `https://docketops.afshaan.workers.dev`, external_repository `legendlot/docket`, publish_dir `apps/docket/out`, cname `docket.legendoftoys.com`.
- [ ] **Step 3:** commit + push → Action builds + deploys. Enable Pages on `legendlot/docket` + HTTPS enforce (`gh api -X PUT repos/legendlot/docket/pages -F https_enforced=true`). Add DNS CNAME `docket` → `legendlot.github.io` (Cloudflare).
- [ ] **Step 4:** confirm `https://docket.legendoftoys.com/` serves 200.

---

## Phase 5 — Smoke + knowledge

### Task 5.1: End-to-end smoke
- [ ] Create DKT-0001 (owner/assignee/collaborator/deadline/priority/doc link); verify `task_no`, `created` history. Add comment. Create a sub-task (verify one-level guard rejects grand-child; roll-up shows). Revise deadline w/ reason (verify `deadline_revised` history + reason). Change status → done (verify `completed_at`). Abandon another w/ reason (verify no delete path; `abandoned` history). Confirm baseline visibility (own+dept+collab) vs `view_all` sees all. Confirm dashboard tiles. Assign a role at `/admin/users`.

### Task 5.2: Knowledge files
- [ ] Create `systems/docket.md` (current truth). Update `CORE.md` (systems/workers/DB-schema/exposed-schemas tables + add `docket`). Add `RULE-DOCKET-001` (no-delete/only-abandon + immutable deadline + audited revisions) + `RULE-DOCKET-002` (own perm layer) to `BUSINESS_RULES.md`. Update root `CLAUDE.md` systems+workers tables. Add `[docket]` section to `BACKLOG.md` (V2 deferrals). Append to `archive/SESSIONS.md`. Bump `05_Throttle/CLAUDE.md` workers table. Commit+push root + monorepo.

---

## Self-review notes
- **Spec coverage:** task creation/roles (3.2–3.3, createTask), docs-multiple (task_documents, DocLinksPanel), founder dashboard (3.4.1, dashboard_stats — all 4 metrics), departments-from-podium (getDepartments), list filter+group (3.3.1), sub-tasks (createSubtask/setParent + SubtaskPanel, one-level guard), comments (CommentsPanel), created/deadline/revised+audit (history + reviseDeadline), 5 statuses (enum + changeStatus), no-cancel-only-abandon (abandonTask, no delete handler), each task carries ID (task_no DKT-NNNN), parent⇄child (parent_task_id + setParent bidirectional), priority P0–P3, own user mgmt (docket_roles + admin pages), branding (3.1.2). ✔ all mapped.
- **No placeholders** except the two intentional UUID substitutions in Task 1.1 Step 4 (resolved at runtime from auth.users) and the secret values (entered interactively).
- **Type consistency:** `getMe` returns `permissions` (AuthProvider contract); perm keys `docket_admin`/`docket_view_all` consistent across worker + nav + admin pages; `docketopsGet/Post` names consistent with fetch lib.
