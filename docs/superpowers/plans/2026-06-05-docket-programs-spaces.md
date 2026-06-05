# Docket Programs & Spaces — Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use `- [ ]`. The LOT codebase
> has **no automated test harness** — verification is `npx turbo build` (zero errors) +
> data-path/live checks, per `05_Throttle/CLAUDE.md`. Do NOT invent unit tests.

**Goal:** Add **Program** (global grouping label) and **Space** (hard access partition,
ClickUp-style sidebar) to Docket — schema, worker, RPCs, and frontend.

**Architecture:** Every task lives in exactly one `docket.spaces` row; **General**
(`is_default`) preserves today's behaviour; private spaces are membership-gated and hide
tasks even from admins. `list_tasks`/`dashboard_stats` become space-scoped. Sidebar lists
accessible spaces under TASKS via dynamic nav items routing to `/tasks?space=<id>`.

**Tech Stack:** Cloudflare Worker (`docketops`, REST→PostgREST, service_role), Supabase
Postgres (`docket` schema), Next.js static-export app (`apps/docket`), shared `@throttle/ui`.

**Spec:** `docs/superpowers/specs/2026-06-05-docket-programs-spaces-design.md`

**⚠️ Deploy prerequisite:** the migration (Task 1) must be applied to live Supabase
(`lot-production`) via the Supabase MCP **before** deploying the worker/frontend, or new
reads 500. The Supabase MCP was disconnected during planning — apply when reconnected.

---

## File map

- **Create** `docketops-worker/migrations/0002_programs_and_spaces.sql` — migration mirror.
- **Modify** `docketops-worker/src/index.js` — helpers, handlers, dispatch.
- **Modify** `apps/docket/src/app/(auth)/layout.js` — dynamic space nav + search-aware active key.
- **Modify** `apps/docket/src/lib/nav.js` — `buildNavGroups(perms, spaces)` helper.
- **Modify** `apps/docket/src/app/(auth)/tasks/page.js` — space scoping, Program column/group/filter, space header + settings, new-space modal.
- **Create** `apps/docket/src/components/SpaceSettings.js` — owner popover (rename/members/transfer/archive).
- **Modify** `apps/docket/src/app/(auth)/dashboard/page.js` — accept `?space=`.
- **Create** `apps/docket/src/app/(auth)/admin/spaces/page.js` — admin list + break-glass recover.
- **Modify** `apps/docket/src/lib/tasks.js` — add `GROUP_OPTS` Program entry / helpers if needed.
- **Modify** `systems/docket.md`, `BUSINESS_RULES.md`, `BACKLOG.md` — docs (RULE-DOCKET-003/004).

---

## Task 1: DB migration

**Files:** Create `docketops-worker/migrations/0002_programs_and_spaces.sql`

Authoritative SQL (also the body applied via `apply_migration` name `docket_programs_and_spaces_v1`):

```sql
-- Docket — Programs + Spaces. Applied to lot-production as `docket_programs_and_spaces_v1`.
-- Spaces = hard access partition; General is the open default. Programs = global label.

-- 1. spaces
create table docket.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_default boolean not null default false,
  is_private boolean not null default true,
  owner_user_id uuid,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index docket_spaces_one_default on docket.spaces(is_default) where is_default;

create table docket.space_members (
  space_id uuid not null references docket.spaces(id) on delete cascade,
  user_id uuid not null,
  added_by_user_id uuid,
  added_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index docket_space_members_user_idx on docket.space_members(user_id);

create table docket.programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index docket_programs_name_uniq on docket.programs(lower(name)) where archived_at is null;

create table docket.space_history (
  id bigint generated always as identity primary key,
  space_id uuid not null references docket.spaces(id) on delete cascade,
  action text not null,
  actor_user_id uuid,
  note text,
  at timestamptz not null default now()
);
create index docket_space_history_space_idx on docket.space_history(space_id, at);

-- RLS + grants (service_role only; RULE-RLS-001)
do $$ declare t text; begin
  foreach t in array array['spaces','space_members','programs','space_history'] loop
    execute format('alter table docket.%I enable row level security;', t);
    execute format('grant all on docket.%I to service_role;', t);
  end loop;
end $$;
grant usage, select on all sequences in schema docket to service_role;

-- 2. seed General
insert into docket.spaces (name, is_default, is_private, owner_user_id)
  values ('General', true, false, null);

-- 3. tasks columns. deadline is already nullable (V2). Backfill space_id → General.
alter table docket.tasks add column space_id uuid references docket.spaces(id);
alter table docket.tasks add column program_id uuid references docket.programs(id);
update docket.tasks set space_id = (select id from docket.spaces where is_default) where space_id is null;
alter table docket.tasks alter column space_id set not null;
alter table docket.tasks alter column space_id set default (select id from docket.spaces where is_default);
create index docket_tasks_space_idx on docket.tasks(space_id);
create index docket_tasks_program_idx on docket.tasks(program_id);

-- 4. list_tasks v2 (drop old signature first to avoid overload ambiguity)
drop function if exists docket.list_tasks(uuid,uuid,uuid,boolean,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text);
create or replace function docket.list_tasks(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_space_id uuid,
  p_status text default null, p_department_id uuid default null,
  p_employee_filter uuid default null, p_priority text default null,
  p_overdue boolean default false, p_revised boolean default false,
  p_parent_id uuid default null, p_mine boolean default false,
  p_q text default null, p_program_id uuid default null
) returns setof docket.tasks language sql stable security definer set search_path = docket, public as $$
  with sp as (select is_default from docket.spaces where id = p_space_id)
  select t.* from docket.tasks t, sp
  where t.space_id = p_space_id
  and (
    -- private space: caller membership is enforced by the worker → all in-space tasks visible
    (not sp.is_default)
    -- General (open default): existing baseline visibility
    or p_view_all
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
  and (p_program_id is null or t.program_id = p_program_id)
  and (not p_mine or t.owner_employee_id = p_employee or t.assignee_employee_id = p_employee
       or t.created_by_user_id = p_user
       or exists (select 1 from docket.task_collaborators c where c.task_id=t.id and c.employee_id=p_employee))
  and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;
grant execute on function docket.list_tasks(uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text,uuid) to service_role;

-- 5. dashboard_stats v2 — scoped to one space (drop old no-arg first)
drop function if exists docket.dashboard_stats();
create or replace function docket.dashboard_stats(p_space_id uuid)
returns jsonb language sql stable security definer set search_path = docket, public as $$
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from docket.tasks where space_id=p_space_id group by status) s),
    'overdue', (select count(*) from docket.tasks
       where space_id=p_space_id and status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from docket.tasks
       where space_id=p_space_id and status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from docket.tasks where space_id=p_space_id and revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from docket.tasks where space_id=p_space_id and status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.departments d on d.id=t.department_id
       where t.space_id=p_space_id group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.employees e on e.id=t.owner_employee_id
       where t.space_id=p_space_id group by e.id,e.full_name order by open desc) x)
  );
$$;
grant execute on function docket.dashboard_stats(uuid) to service_role;
```

- [ ] **Step 1:** Write the file above.
- [ ] **Step 2 (apply, needs Supabase MCP):** `apply_migration` name `docket_programs_and_spaces_v1` with the body. Then `get_advisors(security)` — expect no new criticals (RLS on all new tables).
- [ ] **Step 3 (verify):** `execute_sql` → `select name,is_default from docket.spaces;` (one General), `select count(*) from docket.tasks where space_id is null;` (0).
- [ ] **Step 4:** Commit the migration file.

---

## Task 2: Worker — helpers + space/program reads

**Files:** Modify `docketops-worker/src/index.js`

- [ ] **Step 1:** Add `sbDocket`-based space helpers after `loadTask`:

```js
// ── Space helpers ───────────────────────────────────────────────────────────
async function loadSpace(id, env) {
  const r = await sbDocket(`/rest/v1/spaces?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
async function defaultSpaceId(env) {
  const r = await sbDocket(`/rest/v1/spaces?is_default=eq.true&select=id&limit=1`, env);
  return (r.ok && r.data?.[0]?.id) || null;
}
async function isSpaceMember(spaceId, userId, env) {
  const r = await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(spaceId)}&user_id=eq.${enc(userId)}&select=user_id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
// Can the caller READ a space at all? General = everyone; private = owner or member.
async function canAccessSpace(auth, space, env) {
  if (!space) return false;
  if (space.is_default) return true;
  if (space.owner_user_id === auth.userId) return true;
  return isSpaceMember(space.id, auth.userId, env);
}
function isSpaceOwner(auth, space) { return !!space && space.owner_user_id === auth.userId; }
async function logSpace(env, spaceId, actor, action, note = null) {
  await sbDocket(`/rest/v1/space_history`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: spaceId, actor_user_id: actor, action, note }) });
}
// Accessible spaces for the sidebar: General + owned/member private spaces (non-archived).
async function accessibleSpaces(auth, env) {
  const [allDefault, memberRows] = await Promise.all([
    sbDocket(`/rest/v1/spaces?is_default=eq.true&archived_at=is.null&select=id,name,is_private,owner_user_id&limit=1`, env),
    sbDocket(`/rest/v1/space_members?user_id=eq.${enc(auth.userId)}&select=space_id`, env),
  ]);
  const memberIds = (memberRows.ok ? memberRows.data : []).map(m => m.space_id);
  const ownedRes = await sbDocket(`/rest/v1/spaces?is_private=eq.true&archived_at=is.null&or=(owner_user_id.eq.${enc(auth.userId)}${memberIds.length ? ',id.in.'+inList(memberIds) : ''})&select=id,name,is_private,owner_user_id&order=name.asc`, env);
  const general = (allDefault.ok && allDefault.data) || [];
  const privates = (ownedRes.ok && ownedRes.data) || [];
  return [...general, ...privates].map(s => ({ id: s.id, name: s.name, is_private: s.is_private, is_owner: s.owner_user_id === auth.userId }));
}
```

- [ ] **Step 2:** Extend `getMe` to include spaces:

```js
async function getMe(url, auth, env) {
  const spaces = await accessibleSpaces(auth, env);
  return ok({
    id: auth.userId, email: auth.email, role: auth.role, full_name: auth.fullName,
    permissions: auth.permissions || {}, employee_id: auth.employeeId, department_id: auth.departmentId,
    spaces,
  });
}
```

- [ ] **Step 3:** Add program + space read handlers:

```js
async function getPrograms(url, auth, env) {
  const r = await sbDocket(`/rest/v1/programs?archived_at=is.null&select=id,name,color&order=name.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function getSpaces(url, auth, env) { return ok(await accessibleSpaces(auth, env)); }
async function getAllSpaces(url, auth, env) { // admin break-glass list (metadata only, no task contents)
  const gate = requireAdmin(auth); if (gate) return gate;
  const [spaces, members] = await Promise.all([
    sbDocket(`/rest/v1/spaces?select=*&order=is_default.desc,name.asc`, env),
    sbDocket(`/rest/v1/space_members?select=space_id`, env),
  ]);
  if (!spaces.ok) return err('db_error', 500);
  const mCount = {}; (members.data || []).forEach(m => { mCount[m.space_id] = (mCount[m.space_id] || 0) + 1; });
  // owner names from users_profile
  const ownerIds = uniq((spaces.data || []).map(s => s.owner_user_id));
  const up = ownerIds.length ? await sbStore(`/rest/v1/users_profile?id=in.${inList(ownerIds)}&select=id,full_name`, env) : { data: [] };
  const oName = {}; (up.data || []).forEach(u => { oName[u.id] = u.full_name; });
  return ok((spaces.data || []).map(s => ({ ...s, owner_name: oName[s.owner_user_id] || null, member_count: mCount[s.id] || 0 })));
}
```

- [ ] **Step 4:** Build (`cd 05_Throttle/docketops-worker && npx wrangler deploy --dry-run` is not standard; instead lint via node parse): run `node --check docketops-worker/src/index.js`. Expected: no syntax error.
- [ ] **Step 5:** Commit.

---

## Task 3: Worker — space-aware task reads + writes

**Files:** Modify `docketops-worker/src/index.js`

- [ ] **Step 1:** `getTasks` — resolve + access-check the space, pass `p_space_id` + `p_program_id`:

```js
async function getTasks(url, auth, env) {
  const q = url.searchParams;
  const spaceId = q.get('space_id') || await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  const params = {
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_space_id: spaceId,
    p_status: q.get('status') || null, p_department_id: q.get('department_id') || null,
    p_employee_filter: q.get('employee_id') || null, p_priority: q.get('priority') || null,
    p_overdue: q.get('overdue') === '1' || q.get('overdue') === 'true',
    p_revised: q.get('revised') === '1' || q.get('revised') === 'true',
    p_parent_id: q.get('parent_id') || null, p_mine: q.get('lens') === 'mine',
    p_q: q.get('q') || null, p_program_id: q.get('program_id') || null,
  };
  const r = await sbDocket(`/rest/v1/rpc/list_tasks`, env, { method: 'POST', body: JSON.stringify(params) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const rows = await hydrateTasks(r.data || [], auth, env);
  return ok(rows);
}
```

- [ ] **Step 2:** Hydration — add program names. In `hydrateTasks`, batch-load programs and attach. After the existing `Promise.all`, add:

```js
  const progIds = uniq(rows.map(t => t.program_id));
  const progRes = progIds.length ? await sbDocket(`/rest/v1/programs?id=in.${inList(progIds)}&select=id,name,color`, env) : { data: [] };
  const progMap = {}; (progRes.data || []).forEach(p => { progMap[p.id] = p; });
```
and in the returned object add: `program: progMap[t.program_id] || null,`

- [ ] **Step 3:** `getTask` — enforce space access + return `space` and `program`:
  - After loading `task`, replace the `canSeeTask` gate with space-aware logic:
    ```js
    const space = await loadSpace(task.space_id, env);
    if (!space) return err('space_not_found', 404);
    if (space.is_default) { if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403); }
    else { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }
    ```
  - Add to the returned object: `space: { id: space.id, name: space.name, is_private: space.is_private },`
    and resolve `program` via a small read: `const prog = task.program_id ? (await sbDocket(\`/rest/v1/programs?id=eq.${enc(task.program_id)}&select=id,name,color&limit=1\`, env)).data?.[0] : null;` → `program: prog || null,`

- [ ] **Step 4:** `getDashboard` — accept `space_id`, enforce per-space:

```js
async function getDashboard(url, auth, env) {
  const spaceId = url.searchParams.get('space_id') || await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (space.is_default) { if (!canViewAll(auth)) return err('forbidden_docket_view_all', 403); }
  else { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }
  const r = await sbDocket(`/rest/v1/rpc/dashboard_stats`, env, { method: 'POST', body: JSON.stringify({ p_space_id: spaceId }) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  return ok(r.data || {});
}
```

- [ ] **Step 5:** `createTaskCore` — accept + validate `space_id` (default General; subtask forces parent's space); persist it. Add near the parent check:
  ```js
  let spaceId = d.space_id || null;
  if (parentId) { const parent = ...; spaceId = parent.space_id; }   // reuse loaded parent
  if (!spaceId) spaceId = await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  ```
  and add `space_id: spaceId, program_id: d.program_id || null,` to the insert row.

- [ ] **Step 6:** `updateTask` — add `program_id` to `EDITABLE`: `const EDITABLE = ['title','description','department_id','owner_employee_id','priority','program_id'];` (per-field history already handles it).

- [ ] **Step 7:** Add `moveTask`:

```js
async function moveTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.space_id) return err('id and space_id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const target = await loadSpace(d.space_id, env);
  if (!target) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, target, env))) return err('forbidden_space', 403);
  // move the task and any sub-tasks together (one level)
  await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id, updated_by: auth.userId, updated_at: nowIso() }) });
  await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id }) });
  await logHistory(env, task.id, auth.userId, 'space_changed', { field: 'space_id', old: task.space_id, new: d.space_id });
  return ok({ id: task.id, space_id: d.space_id });
}
```

- [ ] **Step 8:** `node --check`, commit.

---

## Task 4: Worker — program + space management writes

**Files:** Modify `docketops-worker/src/index.js`

- [ ] **Step 1:** Add handlers:

```js
async function createProgram(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  // case-insensitive reuse if it already exists (idempotent inline create)
  const existing = await sbDocket(`/rest/v1/programs?archived_at=is.null&name=ilike.${enc(String(d.name).trim())}&select=id,name,color&limit=1`, env);
  if (existing.ok && existing.data?.[0]) return ok(existing.data[0]);
  const r = await sbDocket(`/rest/v1/programs`, env, { method: 'POST',
    body: JSON.stringify([{ name: String(d.name).trim(), color: d.color || null, created_by_user_id: auth.userId }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data[0]);
}

async function createSpace(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  const r = await sbDocket(`/rest/v1/spaces`, env, { method: 'POST',
    body: JSON.stringify([{ name: String(d.name).trim(), is_private: true, is_default: false,
      owner_user_id: auth.userId, created_by_user_id: auth.userId }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  const space = r.data[0];
  await sbDocket(`/rest/v1/space_members`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: space.id, user_id: auth.userId, added_by_user_id: auth.userId }) });
  await logSpace(env, space.id, auth.userId, 'created', space.name);
  return ok({ id: space.id, name: space.name });
}

// owner (or recovered admin) only
async function requireSpaceOwner(auth, space) {
  if (!space) return err('space_not_found', 404);
  if (space.is_default) return err('general_is_system', 422);
  if (!isSpaceOwner(auth, space) && !isAdmin(auth)) return err('forbidden_space_owner', 403);
  return null;
}
async function renameSpace(body, auth, env) {
  const d = body.data || body; if (!d.id || !d.name) return err('id and name required', 400);
  const space = await loadSpace(d.id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ name: String(d.name).trim() }) });
  await logSpace(env, d.id, auth.userId, 'renamed', `${space.name} → ${d.name}`);
  return ok({ id: d.id, name: d.name });
}
async function archiveSpace(body, auth, env) {
  const d = body.data || body; if (!d.id) return err('id required', 400);
  const space = await loadSpace(d.id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ archived_at: nowIso() }) });
  await logSpace(env, d.id, auth.userId, 'archived', null);
  return ok({ id: d.id, archived: true });
}
async function addSpaceMember(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.user_id) return err('space_id and user_id required', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  await sbDocket(`/rest/v1/space_members?on_conflict=space_id,user_id`, env, { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, user_id: d.user_id, added_by_user_id: auth.userId }) });
  await logSpace(env, d.space_id, auth.userId, 'member_added', d.user_id);
  return ok({ space_id: d.space_id, user_id: d.user_id });
}
async function removeSpaceMember(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.user_id) return err('space_id and user_id required', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  if (space.owner_user_id === d.user_id) return err('cannot remove the owner — transfer ownership first', 422);
  await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(d.space_id)}&user_id=eq.${enc(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  await logSpace(env, d.space_id, auth.userId, 'member_removed', d.user_id);
  return ok({ removed: d.user_id });
}
async function transferSpaceOwnership(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.new_owner_user_id) return err('space_id and new_owner_user_id required', 400);
  const space = await loadSpace(d.space_id, env);
  if (!space) return err('space_not_found', 404);
  if (space.is_default) return err('general_is_system', 422);
  if (!isSpaceOwner(auth, space) && !isAdmin(auth)) return err('forbidden_space_owner', 403);
  // new owner must already be a member
  if (!(await isSpaceMember(d.space_id, d.new_owner_user_id, env))) return err('new owner must be a member first', 422);
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_user_id: d.new_owner_user_id }) });
  await logSpace(env, d.space_id, auth.userId, 'ownership_transferred', d.new_owner_user_id);
  return ok({ space_id: d.space_id, owner_user_id: d.new_owner_user_id });
}
async function recoverSpace(body, auth, env) { // break-glass, admin only, audited
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body; if (!d.space_id) return err('space_id required', 400);
  const space = await loadSpace(d.space_id, env);
  if (!space || space.is_default) return err('not_recoverable', 422);
  const newOwner = d.new_owner_user_id || auth.userId;
  await sbDocket(`/rest/v1/space_members?on_conflict=space_id,user_id`, env, { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, user_id: newOwner, added_by_user_id: auth.userId }) });
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_user_id: newOwner, archived_at: null }) });
  await logSpace(env, d.space_id, auth.userId, 'admin_recovered', `new owner ${newOwner}`);
  return ok({ space_id: d.space_id, owner_user_id: newOwner });
}
```

- [ ] **Step 2:** Register in dispatch maps:
  - `GET_ACTIONS`: add `getPrograms, getSpaces, getAllSpaces`.
  - `POST_ACTIONS`: add `moveTask, createProgram, createSpace, renameSpace, archiveSpace, addSpaceMember, removeSpaceMember, transferSpaceOwnership, recoverSpace`.

- [ ] **Step 3:** `node --check`, commit.

---

## Task 5: Frontend — dynamic space sidebar

**Files:** Modify `apps/docket/src/lib/nav.js`, `apps/docket/src/app/(auth)/layout.js`

- [ ] **Step 1:** `nav.js` — add a `buildNavGroups(perms, spaces)` that injects space items + a New-space item under the static Tasks item, and an Admin "Spaces" item for admins:

```js
import { LayoutDashboard, ListChecks, ShieldCheck, UserCog, Settings, Hash, Plus, FolderLock } from 'lucide-react';
// keep NAV_GROUPS + filterNavByPerms as the static base, then:
export function buildNavGroups(perms, spaces = []) {
  const base = filterNavByPerms(NAV_GROUPS, perms);
  const privates = spaces.filter(s => s.is_private);
  return base.map(g => {
    if (g.id !== 'tasks') {
      if (g.id === 'admin' && perms?.docket_admin) {
        return { ...g, items: [...g.items, { id: 'admin-spaces', label: 'Spaces', route: '/admin/spaces', icon: FolderLock }] };
      }
      return g;
    }
    const spaceItems = privates.map(s => ({ id: 'space-' + s.id, label: s.name, route: '/tasks?space=' + s.id, icon: Hash }));
    return { ...g, items: [...g.items, ...spaceItems, { id: 'space-new', label: 'New space', route: '/tasks?space=new', icon: Plus }] };
  });
}
```

- [ ] **Step 2:** `layout.js` — fetch spaces via `getMe`, build active key from pathname+`?space=`:

```js
import { useSearchParams } from 'next/navigation';
import { NAV_GROUPS, filterNavByPerms, buildNavGroups } from '../../lib/nav.js';
import { docketopsGet } from '../../lib/docketopsFetch.js';
// inside AuthLayoutInner:
const search = useSearchParams();
const [spaces, setSpaces] = useState([]);
useEffect(() => { if (session) docketopsGet('getMe', {}, session).then(me => setSpaces(me?.spaces || [])).catch(() => {}); }, [session]);
const navGroups = useMemo(() => buildNavGroups(perms || {}, spaces), [perms, spaces]);
const spaceParam = search.get('space');
const activeKey = pathname === '/tasks' && spaceParam ? `/tasks?space=${spaceParam}` : pathname;
// pass activeTab={activeKey}
```
(`session` is from `useAuth()` — add to the destructure.)

- [ ] **Step 3:** `npx turbo build --filter=docket`. Expected: success.
- [ ] **Step 4:** Commit.

---

## Task 6: Frontend — Tasks page space scoping + Program + space header

**Files:** Modify `apps/docket/src/app/(auth)/tasks/page.js`, Create `apps/docket/src/components/SpaceSettings.js`

- [ ] **Step 1:** Read the space param; load programs; pass `space_id` to `getTasks`:
  - `const search = useSearchParams(); const spaceParam = search.get('space');`
  - Treat `space === 'new'` → open the New-space modal (and fall back to General list behind it).
  - `const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';` → send `space_id: spaceId` in `getTasks` params (empty = worker defaults to General).
  - Load `programs` once (`getPrograms`) into state for the picker + filter + group labels.
  - Re-run `load` when `spaceId` changes (add to `useCallback` deps).

- [ ] **Step 2:** Header: show the current space name (from the `getMe`/`spaces` list passed down, or a small `getSpaces`), and for a private space the owner sees a **Settings** button → `SpaceSettings`. Show a **New space** modal when `space==='new'`.

- [ ] **Step 3:** Program field/column:
  - Add Program to `groupOpts`: `{ value: 'program', label: 'Group by program' }` and handle in `groups`/`keyOf` (`t.program?.name || 'No program'`).
  - Add a Program filter to `FilterPopover` (Combobox of programs) → send `program_id` to `getTasks`.
  - Add an inline-editable **Program** cell to the row (mirror the Team cell): a `Combobox` of programs with **create-on-type** — on a free-typed value call `createProgram` then `saveField(t,'program_id', newId)`. `saveField` already routes `program_id` through `updateTask`.
  - Add `program_id` patch handling in `saveField` (already generic — `[field]: value || null`; also set `patch.program = ...` for instant UI).
  - COLS: add a column for Program (and trim a low-value column on narrow widths, or place Program next to Team). Keep rows single-line.

- [ ] **Step 4:** `SpaceSettings.js` — owner popover/modal: rename (`renameSpace`), members list with add (employee Combobox → `user_id` via employees having `auth_user_id`; needs employees to expose `auth_user_id` — extend `getEmployees` select to include it) / remove (`addSpaceMember`/`removeSpaceMember`), transfer ownership (`transferSpaceOwnership`), archive (`archiveSpace`). On mutate, refresh.
  - ⚠️ `getEmployees` currently selects `id,full_name,department_id`. Add `auth_user_id` so the member picker can map employee→user. Space membership keys on `user_id`.

- [ ] **Step 5:** New-space modal: name input → `createSpace` → on success `router.push('/tasks?space='+id)` and refresh sidebar (re-fetch `getMe` in layout — simplest: full reload via `router.push` then the layout effect re-runs on session; or expose a refresh. Acceptable: `window.location.assign('/tasks?space='+id)` to force nav re-init).

- [ ] **Step 6:** `npx turbo build --filter=docket`. Commit.

---

## Task 7: Frontend — per-space dashboard + admin/spaces

**Files:** Modify `apps/docket/src/app/(auth)/dashboard/page.js`, Create `apps/docket/src/app/(auth)/admin/spaces/page.js`

- [ ] **Step 1:** `dashboard/page.js` — read `?space=`, pass `space_id` to `getDashboard`; show the space name in the heading. (General dashboard unchanged when no param.)
- [ ] **Step 2:** `admin/spaces/page.js` — `getAllSpaces` table (name, owner, members, archived); a **Recover** action per private space → `recoverSpace` → toast + on success route to `/tasks?space=<id>`. Gate the route on `docket_admin` (nav item already admin-only).
- [ ] **Step 3:** `npx turbo build --filter=docket`. Commit.

---

## Task 8: Apply migration + deploy (coordinated; needs Supabase MCP)

- [ ] **Step 1:** Apply Task 1 migration to live Supabase; verify (Task 1 Steps 2-3).
- [ ] **Step 2:** Deploy worker: `cd docketops-worker && npx wrangler deploy`. Smoke: `curl GET ?action=ping`.
- [ ] **Step 3:** Push the monorepo (`git push`) → `apps/docket` auto-deploys.
- [ ] **Step 4:** Live smoke (real login): General behaves as before; create a private space → appears in sidebar; add a member; a non-member (incl. an admin who isn't a member) can't see it; create a task in the space; group-by Program; per-space dashboard; admin/spaces recover.

---

## Task 9: Docs

**Files:** `systems/docket.md`, `BUSINESS_RULES.md`, `BACKLOG.md`

- [ ] Add RULE-DOCKET-003 (Spaces) + RULE-DOCKET-004 (Programs) to `BUSINESS_RULES.md`.
- [ ] Update `systems/docket.md`: schema (spaces/space_members/programs/space_history + tasks.space_id/program_id), permission model (space partition + break-glass), worker actions, frontend routes (sidebar spaces, `?space=`, admin/spaces, per-space dashboard).
- [ ] `BACKLOG.md`: close the build item; note live-smoke pending.

---

## Self-review

- **Spec coverage:** Program (Tasks 3/4/6) ✓; Space partition + General default (Task 1) ✓;
  strict-access incl. admins (list_tasks private branch trusts worker access-check; getTask/getDashboard gate) ✓;
  anyone-creates-owns (createSpace) ✓; sidebar (Task 5) ✓; per-space dashboard (Tasks 3/7) ✓;
  orphan transfer + break-glass (Task 4 + Task 7 admin/spaces) ✓; inline Program create (Task 6) ✓;
  migration + backfill (Task 1) ✓.
- **Signature consistency:** `list_tasks` new 15-arg signature used identically in SQL grant + worker params
  (`p_space_id` placed 5th, `p_program_id` last). `dashboard_stats(uuid)` matches worker `{p_space_id}`.
- **Known follow-ups:** member picker requires `getEmployees` to expose `auth_user_id` (Task 6 Step 4);
  login-less employees can't be members (documented). New-space sidebar refresh uses a hard nav (acceptable v1).
```
