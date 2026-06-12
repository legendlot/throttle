# Docket Checklist Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured, role-linked checklist **templates** (sections → items, tags, per-section comments, assign-to-people) to Docket, plus a manager/assigner **Oversight** view and surfaced **completion timestamps + late flags** — coexisting with the flat S124 recurring-task model.

**Architecture:** New `docket` tables hold templates/sections/items/assignments and per-person-per-day completions + section comments. Templates live **outside `docket.tasks`**, so the board (`list_tasks`) and founder dashboard (`dashboard_stats`) need no change. A "run" (a person's copy of a template on a date) is **derived** from completions/comments — nothing is spawned per day. The `docketops` worker (service_role, sole DB client) gains template CRUD, assignment, completion, an extended `getChecklist`, and `getChecklistOversight`. The `/checklist` Next page becomes three tabs: My day · Manage · Oversight.

**Tech Stack:** Cloudflare Worker (`docketops-worker/src/index.js`, PostgREST via `sbDocket`/`sbPodium`/`sbStore`), Supabase Postgres (`docket` schema), Next.js static export (`apps/docket`), shared `@throttle/ui` + `@throttle/auth`.

**Testing reality:** this stack has **no worker/Next unit-test harness**. Verification per task = `apply_migration`/SQL `execute_sql` checks, `npx turbo build --filter=docket` (zero errors), `npx wrangler deploy` + a `?action=ping` curl, and (at the end) a manual live browser smoke. "Verify" steps below are those, not pytest.

**Spec:** `docs/superpowers/specs/2026-06-12-docket-checklist-templates-design.md`. **Rule:** RULE-DOCKET-009 (new).

**Conventions (do not violate):**
- PostgREST returns numerics as strings → wrap arithmetic in `Number()`; integer inserts `Math.round()`.
- Never loop `await` per row — batch with `in.(...)` / array inserts (50-subrequest limit).
- Every new `docket` table: RLS enabled + `GRANT ALL ... TO service_role`, no anon grants (RULE-RLS-001).
- Cross-repo git: `git -C 05_Throttle ...`. Wrangler: `cd 05_Throttle/docketops-worker && npx wrangler deploy`.
- Commit + push after each task (Afshaan standing pref). Worker: edit → commit → push → deploy.
- `execute_sql` multi-statement returns only the LAST statement's rows — run diagnostics one statement per call.

---

## Phase 1 — Database + worker (no UI)

### Task 1: Migration — 6 checklist-template tables

**Files:**
- Create: `05_Throttle/docketops-worker/migrations/0008_checklist_templates.sql`
- Apply via Supabase MCP `apply_migration` (name `docket_checklist_templates_v1`, project `jkxcnjabmrkteanzoofj`).

- [ ] **Step 1: Write the migration file**

```sql
-- Docket — Structured checklist templates (role-linked SOP checklists). RULE-DOCKET-009.
-- Applied to Supabase lot-production as migration `docket_checklist_templates_v1`.
-- Coexists with the flat recurring-task model (RULE-DOCKET-008); templates live OUTSIDE
-- docket.tasks, so list_tasks / dashboard_stats are untouched.
-- Spec: docs/superpowers/specs/2026-06-12-docket-checklist-templates-design.md.

create table if not exists docket.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role_label text,
  department_id uuid,                         -- → podium.departments (cross-schema, no FK)
  description text,
  recurrence jsonb not null,                  -- {freq, days_of_week[]?, day_of_month?, until?} — NO time
  is_active boolean not null default true,
  archived_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by_user_id uuid
);
alter table docket.checklist_templates enable row level security;
grant all on docket.checklist_templates to service_role;

create table if not exists docket.checklist_template_sections (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id) on delete cascade,
  title text not null,
  subtitle text,
  due_time text,                              -- 'HH:MM' IST, optional → drives late-flagging
  sort_order int not null default 0
);
create index if not exists docket_cl_sections_tmpl_idx on docket.checklist_template_sections(template_id);
alter table docket.checklist_template_sections enable row level security;
grant all on docket.checklist_template_sections to service_role;

create table if not exists docket.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references docket.checklist_template_sections(id) on delete cascade,
  title text not null,
  help_text text,
  tags text[] not null default '{}',          -- subset of {Critical, QC, Deadline, Ongoing}
  sort_order int not null default 0
);
create index if not exists docket_cl_items_section_idx on docket.checklist_template_items(section_id);
alter table docket.checklist_template_items enable row level security;
grant all on docket.checklist_template_items to service_role;

create table if not exists docket.checklist_assignments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id) on delete cascade,
  employee_id uuid not null,                  -- → podium.employees
  assigned_by_user_id uuid not null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz
);
create unique index if not exists docket_cl_assign_active_uniq
  on docket.checklist_assignments(template_id, employee_id) where unassigned_at is null;
create index if not exists docket_cl_assign_emp_idx
  on docket.checklist_assignments(employee_id) where unassigned_at is null;
create index if not exists docket_cl_assign_tmpl_idx on docket.checklist_assignments(template_id);
alter table docket.checklist_assignments enable row level security;
grant all on docket.checklist_assignments to service_role;

create table if not exists docket.checklist_item_completions (
  id uuid primary key default gen_random_uuid(),
  template_item_id uuid not null references docket.checklist_template_items(id) on delete cascade,
  employee_id uuid not null,
  occurrence_date date not null,              -- IST date of this occurrence
  completed_at timestamptz not null default now(),
  completed_by_user_id uuid not null,
  unique (template_item_id, employee_id, occurrence_date)
);
create index if not exists docket_cl_itemcompl_emp_date_idx
  on docket.checklist_item_completions(employee_id, occurrence_date);
alter table docket.checklist_item_completions enable row level security;
grant all on docket.checklist_item_completions to service_role;

create table if not exists docket.checklist_section_comments (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references docket.checklist_template_sections(id) on delete cascade,
  employee_id uuid not null,
  occurrence_date date not null,
  body text,
  author_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (section_id, employee_id, occurrence_date)
);
create index if not exists docket_cl_seccomments_emp_date_idx
  on docket.checklist_section_comments(employee_id, occurrence_date);
alter table docket.checklist_section_comments enable row level security;
grant all on docket.checklist_section_comments to service_role;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP `apply_migration` tool: `project_id='jkxcnjabmrkteanzoofj'`, `name='docket_checklist_templates_v1'`, `query=`(the SQL above). It is additive CREATE/ALTER (no DROP/TRUNCATE/DELETE) → runs without the destructive-SQL prompt.

- [ ] **Step 3: Verify the tables exist + RLS is on**

Run via `execute_sql` (one statement):
```sql
SELECT c.relname, c.relrowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='docket' AND c.relname LIKE 'checklist_%' ORDER BY c.relname;
```
Expected: `checklist_assignments, checklist_item_completions, checklist_section_comments, checklist_template_items, checklist_template_sections, checklist_templates` — every `relrowsecurity = true`.

- [ ] **Step 4: Verify advisor-clean (no new RLS/security warnings)**

Use Supabase MCP `get_advisors` (`type='security'`). Expected: no new warnings naming the `checklist_*` tables (RLS enabled, no anon grants).

- [ ] **Step 5: Commit**

```bash
git -C 05_Throttle add docketops-worker/migrations/0008_checklist_templates.sql
git -C 05_Throttle commit -m "docket: migration 0008 — checklist template tables (RULE-DOCKET-009)"
git -C 05_Throttle push
```

---

### Task 2: Worker — helpers (recurrence/tags/late/scope)

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — add a helper block right after the existing checklist helpers (after `canViewChecklistOf`, ~line 244).

- [ ] **Step 1: Add the helper block**

Insert after the `canViewChecklistOf` function:
```js
// ── Checklist TEMPLATES (structured, role-linked SOPs). RULE-DOCKET-009. ─────
// A template (docket.checklist_templates) has sections → items, is assigned to people
// (checklist_assignments), and runs per its own recurrence (no single time — times live
// on sections). A "run" for (template, person, date) is DERIVED from item completions +
// section comments. Templates are NOT docket.tasks → off the board + dashboard.
const CHECKLIST_TAGS = ['Critical', 'QC', 'Deadline', 'Ongoing'];

// Template recurrence is like a task recurrence but WITHOUT `time` (sections carry times).
function validateTemplateRecurrence(rec) {
  if (!rec || typeof rec !== 'object') return 'recurrence required';
  if (!['daily', 'weekly', 'monthly'].includes(rec.freq)) return 'invalid freq';
  if (rec.freq === 'weekly') {
    if (!Array.isArray(rec.days_of_week) || !rec.days_of_week.length) return 'weekly needs days_of_week';
    if (rec.days_of_week.some(x => !Number.isInteger(Number(x)) || x < 0 || x > 6)) return 'days_of_week must be 0..6';
  }
  if (rec.freq === 'monthly') {
    const dom = Number(rec.day_of_month);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return 'day_of_month must be 1..31';
  }
  if (rec.until != null && rec.until !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) return 'invalid until (YYYY-MM-DD)';
  }
  return null;
}
function normalizeTemplateRecurrence(rec) {
  const out = { freq: rec.freq };
  if (rec.freq === 'weekly') out.days_of_week = uniq(rec.days_of_week.map(Number)).sort((a, b) => a - b);
  if (rec.freq === 'monthly') out.day_of_month = Number(rec.day_of_month);
  if (rec.until) out.until = rec.until;
  return out;
}
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return uniq(tags.filter(t => CHECKLIST_TAGS.includes(t)));
}
function canEditTemplate(auth, tmpl) {
  return isAdmin(auth) || tmpl.created_by_user_id === auth.userId;
}
async function loadTemplate(id, env) {
  const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
// IST 'HH:MM' for an ISO timestamp (used for late detection + display).
function istHM(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
// Late = completed after the section's due_time (IST). No due_time → never late.
function lateFlag(completedAtIso, dueTime) {
  if (!dueTime || !completedAtIso) return false;
  return istHM(completedAtIso) > dueTime;
}
// The set of employee_ids a caller may MONITOR (Oversight scope, R1):
// view_all → everyone; else direct reports ∪ people I assigned a template/recurring task to.
async function peopleInScope(auth, env) {
  if (canViewAll(auth)) {
    const r = await sbPodium(`/rest/v1/employees?status=eq.active&select=id`, env);
    return new Set((r.ok ? r.data : []).map(e => e.id));
  }
  const ids = new Set();
  const [rep, ta, rt] = await Promise.all([
    auth.employeeId
      ? sbPodium(`/rest/v1/employees?status=eq.active&manager_id=eq.${enc(auth.employeeId)}&select=id`, env)
      : Promise.resolve({ ok: true, data: [] }),
    sbDocket(`/rest/v1/checklist_assignments?assigned_by_user_id=eq.${enc(auth.userId)}&unassigned_at=is.null&select=employee_id`, env),
    sbDocket(`/rest/v1/tasks?is_recurring=eq.true&status=neq.abandoned&created_by_user_id=eq.${enc(auth.userId)}&select=owner_employee_id`, env),
  ]);
  (rep.ok ? rep.data : []).forEach(e => ids.add(e.id));
  (ta.ok ? ta.data : []).forEach(a => ids.add(a.employee_id));
  (rt.ok ? rt.data : []).forEach(t => { if (t.owner_employee_id && t.owner_employee_id !== auth.employeeId) ids.add(t.owner_employee_id); });
  return ids;
}
```

- [ ] **Step 2: Verify the worker still parses**

Run: `cd 05_Throttle/docketops-worker && npx wrangler deploy --dry-run`
Expected: bundles with no syntax error (dry-run does not publish). If `--dry-run` is unsupported on the installed wrangler, instead run `node --check src/index.js` (it's plain ESM JS).

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — checklist-template helpers (recurrence/tags/late/scope)"
git -C 05_Throttle push
```

---

### Task 3: Worker — template CRUD (save / list / get / archive)

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — add GET handlers near `getChecklist` (~line 551) and POST handlers near `createRecurringTask` (~line 672).

- [ ] **Step 1: Add `getChecklistTemplates` + `getChecklistTemplate` (GET handlers)**

Add after `getChecklist`:
```js
// Templates the caller can see for the Manage tab: active, non-archived. (Authoring is open;
// edit is gated per-template via _can_edit.) Returns counts, not full nested structure.
async function getChecklistTemplates(url, auth, env) {
  const tRes = await sbDocket(
    `/rest/v1/checklist_templates?archived_at=is.null&select=*&order=name.asc`, env);
  if (!tRes.ok) return err('db_error', 500);
  const tmpls = tRes.data || [];
  if (!tmpls.length) return ok([]);
  const ids = tmpls.map(t => t.id);
  const [secRes, asgRes, deptRes] = await Promise.all([
    sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(ids)}&select=id,template_id`, env),
    sbDocket(`/rest/v1/checklist_assignments?template_id=in.${inList(ids)}&unassigned_at=is.null&select=template_id,employee_id`, env),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
  ]);
  const secByT = {}; (secRes.data || []).forEach(s => { (secByT[s.template_id] ||= []).push(s.id); });
  const secIds = (secRes.data || []).map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=section_id`, env)
    : { data: [] };
  const itemBySec = {}; (itemRes.data || []).forEach(i => { itemBySec[i.section_id] = (itemBySec[i.section_id] || 0) + 1; });
  const asgCount = {}; (asgRes.data || []).forEach(a => { asgCount[a.template_id] = (asgCount[a.template_id] || 0) + 1; });
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
  return ok(tmpls.map(t => {
    const sIds = secByT[t.id] || [];
    return {
      ...t,
      department_name: deptName[t.department_id] || null,
      section_count: sIds.length,
      item_count: sIds.reduce((n, sid) => n + (itemBySec[sid] || 0), 0),
      assignee_count: asgCount[t.id] || 0,
      _can_edit: canEditTemplate(auth, t),
    };
  }));
}

// Full nested template (sections → items) + active assignees, for the editor.
async function getChecklistTemplate(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const tmpl = await loadTemplate(id, env);
  if (!tmpl) return err('not_found', 404);
  const secRes = await sbDocket(
    `/rest/v1/checklist_template_sections?template_id=eq.${enc(id)}&select=*&order=sort_order.asc`, env);
  const sections = secRes.data || [];
  const secIds = sections.map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=*&order=sort_order.asc`, env)
    : { data: [] };
  const itemsBySec = {}; (itemRes.data || []).forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(id)}&unassigned_at=is.null&select=employee_id&order=assigned_at.asc`, env);
  const empIds = uniq((asgRes.data || []).map(a => a.employee_id));
  const empRes = empIds.length
    ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const empName = {}; (empRes.data || []).forEach(e => { empName[e.id] = e.full_name; });
  return ok({
    ...tmpl,
    sections: sections.map(s => ({ ...s, items: itemsBySec[s.id] || [] })),
    assignees: empIds.map(eid => ({ employee_id: eid, full_name: empName[eid] || null })),
    _can_edit: canEditTemplate(auth, tmpl),
  });
}
```

- [ ] **Step 2: Add `saveChecklistTemplate` + `archiveChecklistTemplate` (POST handlers)**

Add after `updateRecurrence`:
```js
// Create or update a template + its sections/items in one call (diff-upsert).
// Author = any authenticated user; edit of an existing template = creator or admin.
async function saveChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  const recErr = validateTemplateRecurrence(d.recurrence); if (recErr) return err(recErr, 400);
  const rec = normalizeTemplateRecurrence(d.recurrence);
  const sectionsIn = Array.isArray(d.sections) ? d.sections : [];

  let template;
  if (d.id) {
    template = await loadTemplate(d.id, env);
    if (!template) return err('not_found', 404);
    if (!canEditTemplate(auth, template)) return err('forbidden', 403);
    const upd = {
      name: String(d.name).trim(), role_label: d.role_label || null,
      department_id: d.department_id || null, description: d.description || null,
      recurrence: rec, is_active: d.is_active !== false,
      updated_at: nowIso(), updated_by_user_id: auth.userId,
    };
    const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(d.id)}`, env, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(upd) });
    if (!r.ok || !r.data?.[0]) return err('update_failed: ' + JSON.stringify(r.data), 400);
    template = r.data[0];
  } else {
    const r = await sbDocket(`/rest/v1/checklist_templates`, env, {
      method: 'POST', body: JSON.stringify([{
        name: String(d.name).trim(), role_label: d.role_label || null,
        department_id: d.department_id || null, description: d.description || null,
        recurrence: rec, created_by_user_id: auth.userId,
      }]) });
    if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
    template = r.data[0];
  }

  // Diff-upsert sections + items. Delete sections/items not present in the payload
  // (CASCADE drops their items + any completions/comments — acceptable: editing structure).
  const existSecRes = await sbDocket(
    `/rest/v1/checklist_template_sections?template_id=eq.${enc(template.id)}&select=id`, env);
  const existSecIds = (existSecRes.data || []).map(s => s.id);
  const keepSecIds = sectionsIn.map(s => s.id).filter(Boolean);
  const dropSecIds = existSecIds.filter(id => !keepSecIds.includes(id));
  if (dropSecIds.length) {
    await sbDocket(`/rest/v1/checklist_template_sections?id=in.${inList(dropSecIds)}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
  }

  // Upsert each section (in order), then diff-upsert its items.
  for (let si = 0; si < sectionsIn.length; si++) {
    const s = sectionsIn[si];
    const secRow = {
      template_id: template.id, title: String(s.title || '').trim() || 'Section',
      subtitle: s.subtitle || null,
      due_time: (s.due_time && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.due_time)) ? s.due_time : null,
      sort_order: si,
    };
    let sectionId = s.id;
    if (sectionId) {
      await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(sectionId)}`, env,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(secRow) });
    } else {
      const sr = await sbDocket(`/rest/v1/checklist_template_sections`, env,
        { method: 'POST', body: JSON.stringify([secRow]) });
      if (!sr.ok || !sr.data?.[0]) return err('section_failed: ' + JSON.stringify(sr.data), 400);
      sectionId = sr.data[0].id;
    }
    const itemsIn = Array.isArray(s.items) ? s.items : [];
    const existItemRes = await sbDocket(
      `/rest/v1/checklist_template_items?section_id=eq.${enc(sectionId)}&select=id`, env);
    const existItemIds = (existItemRes.data || []).map(i => i.id);
    const keepItemIds = itemsIn.map(i => i.id).filter(Boolean);
    const dropItemIds = existItemIds.filter(id => !keepItemIds.includes(id));
    if (dropItemIds.length) {
      await sbDocket(`/rest/v1/checklist_template_items?id=in.${inList(dropItemIds)}`, env,
        { method: 'DELETE', prefer: 'return=minimal' });
    }
    const toInsert = [];
    for (let ii = 0; ii < itemsIn.length; ii++) {
      const it = itemsIn[ii];
      const itemRow = {
        section_id: sectionId, title: String(it.title || '').trim() || 'Item',
        help_text: it.help_text || null, tags: sanitizeTags(it.tags), sort_order: ii,
      };
      if (it.id) {
        await sbDocket(`/rest/v1/checklist_template_items?id=eq.${enc(it.id)}`, env,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(itemRow) });
      } else {
        toInsert.push(itemRow);
      }
    }
    if (toInsert.length) {
      await sbDocket(`/rest/v1/checklist_template_items`, env,
        { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(toInsert) });
    }
  }
  return ok({ id: template.id });
}

async function archiveChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const tmpl = await loadTemplate(d.id, env);
  if (!tmpl) return err('not_found', 404);
  if (!canEditTemplate(auth, tmpl)) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ archived_at: nowIso(), is_active: false, updated_at: nowIso(), updated_by_user_id: auth.userId }) });
  if (!r.ok) return err('archive_failed: ' + JSON.stringify(r.data), 400);
  return ok({ archived: d.id });
}
```

> **Note on per-row loops:** the diff-upsert loops over sections/items with `await`. A template has on the order of 7 sections × ~8 items, well under the 50-subrequest limit for one request. Do NOT generalize this to unbounded fan-out; it is bounded by template size. Item INSERTs within a section are batched into one array insert.

- [ ] **Step 3: Verify parse**

Run: `cd 05_Throttle/docketops-worker && node --check src/index.js` → no error. (Handlers are wired into the dispatch registry in Task 8; not callable yet.)

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — checklist template CRUD (save/list/get/archive)"
git -C 05_Throttle push
```

---

### Task 4: Worker — assignment

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — add after `archiveChecklistTemplate`.

- [ ] **Step 1: Add assign/unassign POST handlers**

```js
// Assign a template to a person. Open authoring → any authenticated user may assign.
async function assignChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.template_id || !d.employee_id) return err('template_id + employee_id required', 400);
  const tmpl = await loadTemplate(d.template_id, env);
  if (!tmpl) return err('template_not_found', 404);
  // Idempotent: the active-partial unique index makes a duplicate active row a conflict → ignore.
  const r = await sbDocket(`/rest/v1/checklist_assignments`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ template_id: d.template_id, employee_id: d.employee_id, assigned_by_user_id: auth.userId }) });
  if (!r.ok) return err('assign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ template_id: d.template_id, employee_id: d.employee_id });
}
async function unassignChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.template_id || !d.employee_id) return err('template_id + employee_id required', 400);
  const r = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(d.template_id)}&employee_id=eq.${enc(d.employee_id)}&unassigned_at=is.null`,
    env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ unassigned_at: nowIso() }) });
  if (!r.ok) return err('unassign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ template_id: d.template_id, employee_id: d.employee_id, unassigned: true });
}
```

> **Note:** the `ignore-duplicates` upsert needs a conflict target. PostgREST resolves the partial unique index automatically only when columns match; if a duplicate active assignment returns a 409 instead of being ignored, fall back to a pre-check: `SELECT 1 FROM checklist_assignments WHERE template_id=… AND employee_id=… AND unassigned_at IS NULL` before insert. Verify in Step 2.

- [ ] **Step 2: Verify parse**

Run: `cd 05_Throttle/docketops-worker && node --check src/index.js` → no error.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — checklist template assign/unassign"
git -C 05_Throttle push
```

---

### Task 5: Worker — run completion (toggle item + section comment)

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — add after `unassignChecklistTemplate`.

- [ ] **Step 1: Add a shared assignee-check helper + the two handlers**

```js
// You may complete / comment on a template run only if you are its assignee (or admin).
async function isAssignee(auth, templateId, env) {
  if (isAdmin(auth)) return true;
  if (!auth.employeeId) return false;
  const r = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(templateId)}&employee_id=eq.${enc(auth.employeeId)}&unassigned_at=is.null&select=id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
// Resolve an item → its template_id (via section) for the assignee check.
async function templateIdOfItem(itemId, env) {
  const ir = await sbDocket(`/rest/v1/checklist_template_items?id=eq.${enc(itemId)}&select=section_id&limit=1`, env);
  const sectionId = ir.ok && ir.data?.[0]?.section_id;
  if (!sectionId) return null;
  const sr = await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(sectionId)}&select=template_id&limit=1`, env);
  return (sr.ok && sr.data?.[0]?.template_id) || null;
}

// Check/uncheck one item for the caller's own run on a date (default IST today).
async function toggleChecklistItem(body, auth, env) {
  const d = body.data || body;
  if (!d.template_item_id) return err('template_item_id required', 400);
  if (!auth.employeeId) return err('no_employee', 400);
  const templateId = await templateIdOfItem(d.template_item_id, env);
  if (!templateId) return err('item_not_found', 404);
  if (!(await isAssignee(auth, templateId, env))) return err('forbidden', 403);
  const date = d.date || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const completed = d.completed === true || d.completed === 'true';
  if (completed) {
    const r = await sbDocket(`/rest/v1/checklist_item_completions?on_conflict=template_item_id,employee_id,occurrence_date`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
      body: JSON.stringify({ template_item_id: d.template_item_id, employee_id: auth.employeeId, occurrence_date: date, completed_by_user_id: auth.userId }) });
    if (!r.ok) return err('complete_failed: ' + JSON.stringify(r.data), 400);
  } else {
    await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=eq.${enc(d.template_item_id)}&employee_id=eq.${enc(auth.employeeId)}&occurrence_date=eq.${date}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
  }
  return ok({ template_item_id: d.template_item_id, date, completed });
}

// Save (upsert) the caller's per-section comment for a date.
async function saveSectionComment(body, auth, env) {
  const d = body.data || body;
  if (!d.section_id) return err('section_id required', 400);
  if (!auth.employeeId) return err('no_employee', 400);
  const sr = await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(d.section_id)}&select=template_id&limit=1`, env);
  const templateId = sr.ok && sr.data?.[0]?.template_id;
  if (!templateId) return err('section_not_found', 404);
  if (!(await isAssignee(auth, templateId, env))) return err('forbidden', 403);
  const date = d.date || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const r = await sbDocket(`/rest/v1/checklist_section_comments?on_conflict=section_id,employee_id,occurrence_date`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ section_id: d.section_id, employee_id: auth.employeeId, occurrence_date: date, body: d.body || '', author_user_id: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err('comment_failed: ' + JSON.stringify(r.data), 400);
  return ok({ section_id: d.section_id, date });
}
```

- [ ] **Step 2: Verify parse** — `cd 05_Throttle/docketops-worker && node --check src/index.js` → no error.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — checklist run completion (toggle item + section comment)"
git -C 05_Throttle push
```

---

### Task 6: Worker — extend `getChecklist` (template runs + R2 fields)

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — replace the body of `getChecklist` (~lines 516-551). Keep the existing personal-recurring logic; add template runs + completion timestamps; widen the view gate.

- [ ] **Step 1: Replace `getChecklist`**

Replace the whole `getChecklist` function with:
```js
// Per-person checklist for a date: flat personal recurring items + assigned template runs.
// ?employee_id= optional (default = caller). ?date= optional (default IST today).
async function getChecklist(url, auth, env) {
  const targetId = url.searchParams.get('employee_id') || auth.employeeId;
  if (!targetId) return err('no_employee', 400);
  const date = url.searchParams.get('date') || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const empRes = await sbPodium(
    `/rest/v1/employees?id=eq.${enc(targetId)}&select=id,full_name,department_id&limit=1`, env);
  const target = empRes.ok && empRes.data?.[0];
  if (!target) return err('employee_not_found', 404);
  // View gate: the existing rule, OR (R1) the caller monitors this person.
  let allowed = canViewChecklistOf(auth, target);
  if (!allowed) allowed = (await peopleInScope(auth, env)).has(targetId);
  if (!allowed) return err('forbidden', 403);
  const isOwn = auth.employeeId && targetId === auth.employeeId;

  // ── Flat personal recurring tasks (RULE-DOCKET-008), now with completion timestamps. ──
  const tRes = await sbDocket(
    `/rest/v1/tasks?is_recurring=eq.true&owner_employee_id=eq.${enc(targetId)}&status=neq.abandoned&select=*&order=created_at.asc`, env);
  if (!tRes.ok) return err('db_error', 500);
  const live = (tRes.data || []).filter(t => !isExpired(t.recurrence, date));
  const recRows = await hydrateTasks(live, auth, env);
  const recIds = recRows.map(t => t.id);
  const complMap = {};
  if (recIds.length) {
    const cRes = await sbDocket(
      `/rest/v1/checklist_completions?task_id=in.${inList(recIds)}&occurrence_date=eq.${date}&select=task_id,completed_at,completed_by_user_id`, env);
    (cRes.ok ? cRes.data : []).forEach(c => { complMap[c.task_id] = c; });
  }
  // Resolve completer names across both models in one read.
  const completerIds = uniq(Object.values(complMap).map(c => c.completed_by_user_id));
  const recurring_items = recRows.map(t => {
    const c = complMap[t.id];
    return {
      ...t,
      due_today: isDueOn(t.recurrence, date),
      completed_today: !!c,
      completed_at: c?.completed_at || null,
      completed_by_user_id: c?.completed_by_user_id || null,
      late: c ? lateFlag(c.completed_at, t.recurrence?.time) : false,
      _can_complete: isOwn,   // you complete your own checklist only
    };
  });

  // ── Assigned template runs due on `date`. ──
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?employee_id=eq.${enc(targetId)}&unassigned_at=is.null&select=template_id`, env);
  const tmplIds = uniq((asgRes.data || []).map(a => a.template_id));
  let template_runs = [];
  let allCompleterIds = completerIds.slice();
  if (tmplIds.length) {
    const tmplRes = await sbDocket(
      `/rest/v1/checklist_templates?id=in.${inList(tmplIds)}&archived_at=is.null&is_active=eq.true&select=*`, env);
    const dueTmpls = (tmplRes.data || []).filter(t => isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date));
    if (dueTmpls.length) {
      const dueIds = dueTmpls.map(t => t.id);
      const [secRes, deptRes] = await Promise.all([
        sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(dueIds)}&select=*&order=sort_order.asc`, env),
        sbPodium(`/rest/v1/departments?select=id,name`, env),
      ]);
      const sections = secRes.data || [];
      const secIds = sections.map(s => s.id);
      const [itemRes, secCommRes] = await Promise.all([
        secIds.length ? sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=*&order=sort_order.asc`, env) : Promise.resolve({ data: [] }),
        secIds.length ? sbDocket(`/rest/v1/checklist_section_comments?section_id=in.${inList(secIds)}&employee_id=eq.${enc(targetId)}&occurrence_date=eq.${date}&select=section_id,body`, env) : Promise.resolve({ data: [] }),
      ]);
      const items = itemRes.data || [];
      const itemIds = items.map(i => i.id);
      const itemComplRes = itemIds.length
        ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itemIds)}&employee_id=eq.${enc(targetId)}&occurrence_date=eq.${date}&select=template_item_id,completed_at,completed_by_user_id`, env)
        : { data: [] };
      const itemCompl = {}; (itemComplRes.data || []).forEach(c => { itemCompl[c.template_item_id] = c; });
      allCompleterIds = uniq([...allCompleterIds, ...Object.values(itemCompl).map(c => c.completed_by_user_id)]);
      const commBySec = {}; (secCommRes.data || []).forEach(c => { commBySec[c.section_id] = c.body || ''; });
      const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
      const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
      const secByT = {}; sections.forEach(s => { (secByT[s.template_id] ||= []).push(s); });
      template_runs = dueTmpls.map(t => ({
        template: { id: t.id, name: t.name, role_label: t.role_label, department_name: deptName[t.department_id] || null },
        _can_complete: isOwn,
        sections: (secByT[t.id] || []).map(s => ({
          id: s.id, title: s.title, subtitle: s.subtitle, due_time: s.due_time,
          comment: commBySec[s.id] || '',
          items: (itemsBySec[s.id] || []).map(it => {
            const c = itemCompl[it.id];
            return {
              id: it.id, title: it.title, help_text: it.help_text, tags: it.tags || [],
              completed: !!c, completed_at: c?.completed_at || null,
              completed_by_user_id: c?.completed_by_user_id || null,
              late: c ? lateFlag(c.completed_at, s.due_time) : false,
            };
          }),
        })),
      }));
    }
  }

  // Completer names (both models).
  let completerName = {};
  if (allCompleterIds.length) {
    const up = await sbStore(`/rest/v1/users_profile?id=in.${inList(allCompleterIds)}&select=id,full_name`, env);
    (up.ok ? up.data : []).forEach(u => { completerName[u.id] = u.full_name; });
  }
  recurring_items.forEach(r => { r.completed_by = r.completed_by_user_id ? (completerName[r.completed_by_user_id] || null) : null; });
  template_runs.forEach(run => run.sections.forEach(s => s.items.forEach(it => {
    it.completed_by = it.completed_by_user_id ? (completerName[it.completed_by_user_id] || null) : null;
  })));

  return ok({
    owner: { id: target.id, full_name: target.full_name, department_id: target.department_id },
    date, recurring_items, template_runs,
  });
}
```

> **Back-compat:** the frontend (Task 13) is updated in the same release; the old `items`/`today` shape is replaced by `recurring_items`/`template_runs`/`date`. No other caller exists.

- [ ] **Step 2: Verify parse** — `node --check src/index.js` → no error.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — getChecklist returns template runs + completion timestamps + late"
git -C 05_Throttle push
```

---

### Task 7: Worker — `getChecklistOversight`

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — add a GET handler after `getChecklist`.

- [ ] **Step 1: Add the handler**

```js
// Oversight (R1): per-person adherence for a date, scoped to people the caller may monitor.
async function getChecklistOversight(url, auth, env) {
  const date = url.searchParams.get('date') || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const scope = await peopleInScope(auth, env);
  const ids = [...scope];
  if (!ids.length) return ok({ date, people: [] });

  const [empRes, deptRes] = await Promise.all([
    sbPodium(`/rest/v1/employees?id=in.${inList(ids)}&status=eq.active&select=id,full_name,department_id&order=full_name.asc`, env),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
  ]);
  const emps = empRes.data || [];
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });

  // Flat recurring tasks for everyone in scope (one read), then completions for the date.
  const recRes = await sbDocket(
    `/rest/v1/tasks?is_recurring=eq.true&status=neq.abandoned&owner_employee_id=in.${inList(ids)}&select=id,owner_employee_id,recurrence`, env);
  const recByEmp = {}; (recRes.data || []).forEach(t => {
    if (isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date)) (recByEmp[t.owner_employee_id] ||= []).push(t.id);
  });
  const allRecIds = Object.values(recByEmp).flat();
  const recDone = new Set();
  if (allRecIds.length) {
    const cRes = await sbDocket(`/rest/v1/checklist_completions?task_id=in.${inList(allRecIds)}&occurrence_date=eq.${date}&select=task_id`, env);
    (cRes.ok ? cRes.data : []).forEach(c => recDone.add(c.task_id));
  }

  // Assignments → templates due today → items; completions for the date.
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?employee_id=in.${inList(ids)}&unassigned_at=is.null&select=template_id,employee_id`, env);
  const asg = asgRes.data || [];
  const tmplIds = uniq(asg.map(a => a.template_id));
  const tmplRes = tmplIds.length
    ? await sbDocket(`/rest/v1/checklist_templates?id=in.${inList(tmplIds)}&archived_at=is.null&is_active=eq.true&select=id,name,recurrence`, env)
    : { data: [] };
  const tmplById = {}; (tmplRes.data || []).forEach(t => { tmplById[t.id] = t; });
  const dueTmplIds = (tmplRes.data || []).filter(t => isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date)).map(t => t.id);
  const secRes = dueTmplIds.length
    ? await sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(dueTmplIds)}&select=id,template_id,title&order=sort_order.asc`, env)
    : { data: [] };
  const sections = secRes.data || [];
  const secIds = sections.map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=id,section_id`, env)
    : { data: [] };
  const items = itemRes.data || [];
  const itemIds = items.map(i => i.id);
  // Completions across ALL people in scope for the date (one read), keyed by item+employee.
  const itemComplRes = itemIds.length
    ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itemIds)}&occurrence_date=eq.${date}&select=template_item_id,employee_id`, env)
    : { data: [] };
  const doneByEmpItem = new Set((itemComplRes.data || []).map(c => `${c.employee_id}|${c.template_item_id}`));

  // Index helpers.
  const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i.id); });
  const secByTmpl = {}; sections.forEach(s => { (secByTmpl[s.template_id] ||= []).push(s); });
  const tmplsByEmp = {}; asg.forEach(a => { if (tmplById[a.template_id]) (tmplsByEmp[a.employee_id] ||= []).push(a.template_id); });

  const people = emps.map(e => {
    const recIds = recByEmp[e.id] || [];
    const recurring = { done: recIds.filter(id => recDone.has(id)).length, total: recIds.length };
    const templates = (tmplsByEmp[e.id] || []).filter(tid => dueTmplIds.includes(tid)).map(tid => {
      const secs = secByTmpl[tid] || [];
      let done = 0, total = 0; const incompleteSections = [];
      for (const s of secs) {
        const sItemIds = itemsBySec[s.id] || [];
        const sDone = sItemIds.filter(iid => doneByEmpItem.has(`${e.id}|${iid}`)).length;
        done += sDone; total += sItemIds.length;
        if (sItemIds.length && sDone < sItemIds.length) incompleteSections.push(s.title);
      }
      return { template_id: tid, name: tmplById[tid].name, done, total, incomplete_sections: incompleteSections };
    });
    return {
      employee_id: e.id, full_name: e.full_name, department_name: deptName[e.department_id] || null,
      recurring, templates,
    };
  });
  // Only surface people who actually have something scheduled today.
  return ok({ date, people: people.filter(p => p.recurring.total > 0 || p.templates.length > 0) });
}
```

- [ ] **Step 2: Verify parse** — `node --check src/index.js` → no error.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — getChecklistOversight (R1 monitoring)"
git -C 05_Throttle push
```

---

### Task 8: Worker — register actions + deploy + smoke

**Files:**
- Modify: `05_Throttle/docketops-worker/src/index.js` — the `GET_ACTIONS` (~line 1149) and `POST_ACTIONS` (~line 1157) registries.

- [ ] **Step 1: Add to `GET_ACTIONS`**

Change the `getChecklist,` line to:
```js
  getChecklist, getChecklistTemplates, getChecklistTemplate, getChecklistOversight,
```

- [ ] **Step 2: Add to `POST_ACTIONS`**

Change the `createRecurringTask, updateRecurrence, toggleChecklistOccurrence,` line to:
```js
  createRecurringTask, updateRecurrence, toggleChecklistOccurrence,
  saveChecklistTemplate, archiveChecklistTemplate,
  assignChecklistTemplate, unassignChecklistTemplate,
  toggleChecklistItem, saveSectionComment,
```

- [ ] **Step 3: Deploy**

```bash
cd 05_Throttle/docketops-worker && npx wrangler deploy
```
Expected: a new version id printed, no error.

- [ ] **Step 4: Smoke the worker is live**

```bash
curl -s "https://docketops.afshaan.workers.dev/?action=ping"
```
Expected: `{"ok":true,"data":{"pong":true}}`.

- [ ] **Step 5: Smoke an authed action end-to-end via SQL seed (no login needed)**

Insert a tiny template directly, confirm `getChecklistTemplates` shape by querying the DB the handler reads (sanity, not the HTTP path):
```sql
-- create a throwaway template + section + item, then read it back, then clean up
WITH t AS (
  INSERT INTO docket.checklist_templates (name, recurrence, created_by_user_id)
  VALUES ('SMOKE TEST', '{"freq":"daily"}'::jsonb, '00000000-0000-0000-0000-000000000000')
  RETURNING id)
INSERT INTO docket.checklist_template_sections (template_id, title, due_time, sort_order)
SELECT id, 'Sec A', '09:00', 0 FROM t RETURNING template_id, id;
```
Then `SELECT count(*) FROM docket.checklist_templates WHERE name='SMOKE TEST';` → 1. Clean up: `DELETE FROM docket.checklist_templates WHERE name='SMOKE TEST';` (cascades). *(This DELETE will hit the destructive-SQL gate prompt — approve it; it's a test-row cleanup.)*

- [ ] **Step 6: Commit (registry change)**

```bash
git -C 05_Throttle add docketops-worker/src/index.js
git -C 05_Throttle commit -m "docket: worker — register checklist template actions + deploy"
git -C 05_Throttle push
```

---

## Phase 2 — Frontend: templates + runs

### Task 9: lib/recurrence.js — template helpers + RecurrenceEditor `hideTime`

**Files:**
- Modify: `05_Throttle/apps/docket/src/lib/recurrence.js`
- Modify: `05_Throttle/apps/docket/src/components/RecurrenceEditor.js`

- [ ] **Step 1: Add template-recurrence helpers to `lib/recurrence.js`**

Append:
```js
// Template recurrences have no single `time` (times live on sections). RULE-DOCKET-009.
export function isValidTemplateRecurrence(rec) {
  if (!rec || !['daily', 'weekly', 'monthly'].includes(rec.freq)) return false;
  if (rec.until && !/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) return false;
  if (rec.freq === 'weekly') return Array.isArray(rec.days_of_week) && rec.days_of_week.length > 0;
  if (rec.freq === 'monthly') { const d = Number(rec.day_of_month); return Number.isInteger(d) && d >= 1 && d <= 31; }
  return true;
}
export function templateRecurrenceSummary(rec) {
  if (!rec || !rec.freq) return '—';
  const until = rec.until ? ` · until ${fmtISTDateShort(rec.until)}` : '';
  if (rec.freq === 'daily') return 'Daily' + until;
  if (rec.freq === 'weekly') {
    const days = (rec.days_of_week || []).slice().map(Number).sort((a, b) => a - b);
    if (days.length === 7) return 'Every day' + until;
    if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Weekdays' + until;
    return `Weekly · ${days.map(d => WEEKDAYS[d]?.label).filter(Boolean).join(', ')}` + until;
  }
  if (rec.freq === 'monthly') return `Monthly on the ${ordinal(Number(rec.day_of_month))}` + until;
  return '—';
}
```

- [ ] **Step 2: Add a `hideTime` prop to `RecurrenceEditor`**

In `RecurrenceEditor.js`, (a) accept `hideTime` in the signature: `export function RecurrenceEditor({ value, onChange, hideTime = false }) {`, (b) when `hideTime`, `setFreq` must not add a `time`:
```js
  function setFreq(freq) {
    if (freq === rec.freq) return;
    const base = hideTime ? {} : { time: rec.time || '09:00' };
    if (freq === 'daily') onChange({ freq, ...base });
    else if (freq === 'weekly') onChange({ freq, ...base, days_of_week: rec.days_of_week?.length ? rec.days_of_week : [1] });
    else onChange({ freq, ...base, day_of_month: rec.day_of_month || 1 });
  }
```
and (c) wrap the "At / time" row in `{!hideTime && ( … )}`. Leave the weekly/monthly/Ends rows unchanged.

- [ ] **Step 3: Verify build**

Run: `cd 05_Throttle && npx turbo build --filter=docket`
Expected: build succeeds, zero errors. (The existing checklist page still imports `isValidRecurrence`/`recurrenceSummary`, untouched.)

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add apps/docket/src/lib/recurrence.js apps/docket/src/components/RecurrenceEditor.js
git -C 05_Throttle commit -m "docket: recurrence lib — template (time-optional) helpers + RecurrenceEditor hideTime"
git -C 05_Throttle push
```

---

### Task 10: TagPill + lib/checklist client helpers

**Files:**
- Create: `05_Throttle/apps/docket/src/components/TagPill.js`
- Create: `05_Throttle/apps/docket/src/lib/checklist.js`

- [ ] **Step 1: Write `TagPill.js`**

```js
'use client';
// Checklist item tag pill. Fixed vocabulary (RULE-DOCKET-009). Themed via CSS classes.
export const CHECKLIST_TAGS = ['Critical', 'QC', 'Deadline', 'Ongoing'];
const CLS = { Critical: 'tag-critical', QC: 'tag-qc', Deadline: 'tag-deadline', Ongoing: 'tag-ongoing' };
export function TagPill({ tag }) {
  if (!CHECKLIST_TAGS.includes(tag)) return null;
  return <span className={'cl-tag ' + (CLS[tag] || '')}>{tag}</span>;
}
export default TagPill;
```

- [ ] **Step 2: Write `lib/checklist.js`**

```js
// Client helpers for checklist runs (progress + completion-time display). RULE-DOCKET-009.
export function runProgress(run) {
  let done = 0, total = 0;
  (run?.sections || []).forEach(s => (s.items || []).forEach(i => { total++; if (i.completed) done++; }));
  return { done, total };
}
// 'h:MM AM/PM' in IST for an ISO timestamp (completion time display).
export function fmtClockIST(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}
```

- [ ] **Step 3: Verify build** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds (new modules unused yet, must still compile).

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add apps/docket/src/components/TagPill.js apps/docket/src/lib/checklist.js
git -C 05_Throttle commit -m "docket: TagPill + lib/checklist client helpers"
git -C 05_Throttle push
```

---

### Task 11: ChecklistRun component (renders one template run)

**Files:**
- Create: `05_Throttle/apps/docket/src/components/ChecklistRun.js`

**Contract:** renders ONE `template_run` (shape from `getChecklist.template_runs[i]`). Props:
`{ run, canComplete, onToggleItem(itemId, completed), onSaveComment(sectionId, body) }`.
- Header: template name + `role_label` chip + department chip + overall `done/total` from `runProgress`.
- Each section: title, subtitle, a `due_time` label (`fmtTime`), and items.
- Each item: a checkbox (disabled when `!canComplete`), title, `help_text` (muted), `TagPill`s, and — when `completed` — the completion time (`fmtClockIST(completed_at)`) + a "late" pill when `item.late`.
- Per-section comment: a `<textarea>` seeded with `section.comment`, debounced (600ms) → `onSaveComment(section.id, body)`; disabled when `!canComplete`.

- [ ] **Step 1: Write `ChecklistRun.js`**

```js
'use client';
import { useState, useRef, useCallback } from 'react';
import { Check } from 'lucide-react';
import { TagPill } from './TagPill.js';
import { runProgress, fmtClockIST } from '../lib/checklist.js';
import { fmtTime } from '../lib/recurrence.js';

function SectionComment({ section, canComplete, onSaveComment }) {
  const [body, setBody] = useState(section.comment || '');
  const timer = useRef(null);
  const onChange = useCallback((v) => {
    setBody(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSaveComment(section.id, v), 600);
  }, [section.id, onSaveComment]);
  return (
    <textarea className="cl-seccomment" placeholder="Comments…" value={body}
      disabled={!canComplete} onChange={e => onChange(e.target.value)}
      onBlur={() => { if (timer.current) { clearTimeout(timer.current); onSaveComment(section.id, body); } }} />
  );
}

export function ChecklistRun({ run, canComplete, onToggleItem, onSaveComment }) {
  const { done, total } = runProgress(run);
  return (
    <section className="cl-run">
      <div className="cl-run-head">
        <div className="cl-run-title">
          <h4>{run.template.name}</h4>
          {run.template.role_label && <span className="chip soft">{run.template.role_label}</span>}
          {run.template.department_name && <span className="chip soft">{run.template.department_name}</span>}
        </div>
        <span className="cl-run-prog">{done}/{total}</span>
      </div>
      {(run.sections || []).map(s => {
        const sd = (s.items || []).filter(i => i.completed).length;
        return (
          <div className="cl-section" key={s.id}>
            <div className="cl-section-head">
              <div>
                <h5>{s.title}</h5>
                {s.subtitle && <span className="cl-section-sub">{s.subtitle}</span>}
              </div>
              <div className="cl-section-meta">
                {s.due_time && <span className="cl-due">by {fmtTime(s.due_time)}</span>}
                <span className="cl-section-prog">{sd}/{(s.items || []).length}</span>
              </div>
            </div>
            <ul className="cl-items">
              {(s.items || []).map(it => (
                <li key={it.id} className={'cl-item' + (it.completed ? ' done' : '')}>
                  <button className={'cl-check' + (it.completed ? ' on' : '')} disabled={!canComplete}
                    title={canComplete ? '' : 'You can only complete your own checklist'}
                    onClick={() => onToggleItem(it.id, !it.completed)}>
                    {it.completed && <Check size={14} />}
                  </button>
                  <div className="cl-item-main">
                    <div className="cl-item-title">{it.title}</div>
                    {it.help_text && <div className="cl-item-help">{it.help_text}</div>}
                    <div className="cl-item-meta">
                      {(it.tags || []).map(t => <TagPill key={t} tag={t} />)}
                      {it.completed && it.completed_at && (
                        <span className={'cl-done-at' + (it.late ? ' late' : '')}>
                          {it.late ? 'late · ' : ''}{fmtClockIST(it.completed_at)}
                          {it.completed_by ? ` · ${it.completed_by}` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <SectionComment section={s} canComplete={canComplete} onSaveComment={onSaveComment} />
          </div>
        );
      })}
    </section>
  );
}
export default ChecklistRun;
```

- [ ] **Step 2: Verify build** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add apps/docket/src/components/ChecklistRun.js
git -C 05_Throttle commit -m "docket: ChecklistRun component (sectioned run + per-item time/late + section comments)"
git -C 05_Throttle push
```

---

### Task 12: ChecklistTemplateEditor component

**Files:**
- Create: `05_Throttle/apps/docket/src/components/ChecklistTemplateEditor.js`

**Contract:** create/edit a template. Props: `{ templateId|null, employees, departments, session, onSaved(), onCancel() }`.
- On mount, if `templateId`, GET `getChecklistTemplate` to seed; else start a blank draft `{ name:'', role_label:'', department_id:'', description:'', recurrence:{freq:'daily'}, sections:[], assignees:[] }`.
- Fields: name, role_label, department (Combobox), description, `RecurrenceEditor hideTime`.
- Sections list: each editable (title, subtitle, due_time `<input type=time>`), reorder via up/down (swap `sort_order`), delete; "+ Add section".
- Items within a section: title, help_text, tag toggles (from `CHECKLIST_TAGS`), delete, "+ Add item".
- Assignees: a Combobox to add an employee (calls `assignChecklistTemplate` immediately when editing an existing template; for a NEW template, collect locally then assign after save), and a removable chip list (calls `unassignChecklistTemplate`).
- Save: POST `saveChecklistTemplate` with the nested `{id?, name, role_label, department_id, description, recurrence, sections:[{id?,title,subtitle,due_time,items:[{id?,title,help_text,tags}]}]}`; then for a new template, assign any locally-collected assignees; then `onSaved()`.

- [ ] **Step 1: Write `ChecklistTemplateEditor.js`**

```js
'use client';
import { useEffect, useState, useCallback } from 'react';
import { Combobox, useToast } from '@throttle/ui';
import { Plus, Trash2, ChevronUp, ChevronDown, Check, X } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { RecurrenceEditor } from './RecurrenceEditor.js';
import { CHECKLIST_TAGS } from './TagPill.js';
import { isValidTemplateRecurrence } from '../lib/recurrence.js';

const blankItem = () => ({ id: null, title: '', help_text: '', tags: [] });
const blankSection = () => ({ id: null, title: '', subtitle: '', due_time: '', items: [blankItem()] });

export function ChecklistTemplateEditor({ templateId, employees, departments, session, onSaved, onCancel }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState(null);
  const [assignees, setAssignees] = useState([]);     // [{employee_id, full_name}]
  const [busy, setBusy] = useState(false);
  const isNew = !templateId;

  useEffect(() => {
    if (!templateId) {
      setDraft({ id: null, name: '', role_label: '', department_id: '', description: '', recurrence: { freq: 'daily' }, sections: [blankSection()] });
      setAssignees([]);
      return;
    }
    docketopsGet('getChecklistTemplate', { id: templateId }, session).then(t => {
      setDraft({
        id: t.id, name: t.name || '', role_label: t.role_label || '', department_id: t.department_id || '',
        description: t.description || '', recurrence: t.recurrence || { freq: 'daily' },
        sections: (t.sections || []).map(s => ({ id: s.id, title: s.title, subtitle: s.subtitle || '', due_time: s.due_time || '', items: (s.items || []).map(i => ({ id: i.id, title: i.title, help_text: i.help_text || '', tags: i.tags || [] })) })),
      });
      setAssignees(t.assignees || []);
    }).catch(e => showToast(e.message || 'Failed to load', 'error'));
  }, [templateId, session, showToast]);

  const patch = useCallback((p) => setDraft(d => ({ ...d, ...p })), []);
  const setSection = (si, p) => setDraft(d => ({ ...d, sections: d.sections.map((s, i) => i === si ? { ...s, ...p } : s) }));
  const setItem = (si, ii, p) => setDraft(d => ({ ...d, sections: d.sections.map((s, i) => i === si ? { ...s, items: s.items.map((it, j) => j === ii ? { ...it, ...p } : it) } : s) }));
  const moveSection = (si, dir) => setDraft(d => { const a = d.sections.slice(); const j = si + dir; if (j < 0 || j >= a.length) return d; [a[si], a[j]] = [a[j], a[si]]; return { ...d, sections: a }; });
  const toggleTag = (si, ii, tag) => setItem(si, ii, { tags: (draft.sections[si].items[ii].tags || []).includes(tag) ? draft.sections[si].items[ii].tags.filter(t => t !== tag) : [...(draft.sections[si].items[ii].tags || []), tag] });

  async function addAssignee(empId) {
    if (!empId || assignees.some(a => a.employee_id === empId)) return;
    const emp = employees.find(e => e.id === empId);
    setAssignees(a => [...a, { employee_id: empId, full_name: emp?.full_name || '' }]);
    if (!isNew) { try { await docketopsPost('assignChecklistTemplate', { template_id: templateId, employee_id: empId }, session); } catch (e) { showToast(e.message, 'error'); } }
  }
  async function removeAssignee(empId) {
    setAssignees(a => a.filter(x => x.employee_id !== empId));
    if (!isNew) { try { await docketopsPost('unassignChecklistTemplate', { template_id: templateId, employee_id: empId }, session); } catch (e) { showToast(e.message, 'error'); } }
  }

  async function save() {
    if (!draft.name.trim()) { showToast('Name required', 'error'); return; }
    if (!isValidTemplateRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try {
      const res = await docketopsPost('saveChecklistTemplate', {
        id: draft.id, name: draft.name.trim(), role_label: draft.role_label || null,
        department_id: draft.department_id || null, description: draft.description || null,
        recurrence: draft.recurrence,
        sections: draft.sections.map(s => ({ id: s.id, title: s.title, subtitle: s.subtitle || null, due_time: s.due_time || null, items: s.items.map(i => ({ id: i.id, title: i.title, help_text: i.help_text || null, tags: i.tags || [] })) })),
      }, session);
      const newId = res?.id || draft.id;
      if (isNew && newId) {
        for (const a of assignees) { await docketopsPost('assignChecklistTemplate', { template_id: newId, employee_id: a.employee_id }, session); }
      }
      showToast('Saved', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!draft) return null;
  return (
    <div className="cl-editor">
      <div className="cl-editor-grid">
        <label className="cl-field"><span>Name</span>
          <input className="cl-input" value={draft.name} placeholder="e.g. Senior Production Manager — Daily" onChange={e => patch({ name: e.target.value })} /></label>
        <label className="cl-field"><span>Role label</span>
          <input className="cl-input" value={draft.role_label} placeholder="e.g. Senior Production Manager" onChange={e => patch({ role_label: e.target.value })} /></label>
        <label className="cl-field"><span>Team</span>
          <Combobox value={draft.department_id} allowClear style={{ width: '100%' }}
            options={[{ value: '', label: '— None —' }, ...departments.map(d => ({ value: d.id, label: d.name }))]}
            onChange={v => patch({ department_id: v || '' })} /></label>
      </div>
      <label className="cl-field"><span>Description</span>
        <textarea className="cl-textarea" value={draft.description} onChange={e => patch({ description: e.target.value })} /></label>

      <div className="cl-field"><span>Schedule</span>
        <RecurrenceEditor value={draft.recurrence} hideTime onChange={r => patch({ recurrence: r })} /></div>

      <div className="cl-field"><span>Assigned to</span>
        <div className="cl-assignees">
          {assignees.map(a => (
            <span className="chip" key={a.employee_id}>{a.full_name}
              <button className="chip-x" onClick={() => removeAssignee(a.employee_id)}><X size={11} /></button></span>
          ))}
          <Combobox value="" allowClear={false} placeholder="+ Add person" style={{ width: 200 }}
            options={employees.filter(e => !assignees.some(a => a.employee_id === e.id)).map(e => ({ value: e.id, label: e.full_name }))}
            onChange={v => addAssignee(v)} />
        </div>
      </div>

      <div className="cl-sections-edit">
        {draft.sections.map((s, si) => (
          <div className="cl-section-edit" key={si}>
            <div className="cl-section-edit-head">
              <input className="cl-input" placeholder="Section title" value={s.title} onChange={e => setSection(si, { title: e.target.value })} />
              <input className="cl-time" type="time" value={s.due_time} onChange={e => setSection(si, { due_time: e.target.value })} title="Due by (optional)" />
              <button className="dr-icon" onClick={() => moveSection(si, -1)}><ChevronUp size={14} /></button>
              <button className="dr-icon" onClick={() => moveSection(si, 1)}><ChevronDown size={14} /></button>
              <button className="dr-icon" onClick={() => setDraft(d => ({ ...d, sections: d.sections.filter((_, i) => i !== si) }))}><Trash2 size={14} /></button>
            </div>
            <input className="cl-input cl-sub-input" placeholder="Section help line (optional)" value={s.subtitle} onChange={e => setSection(si, { subtitle: e.target.value })} />
            <ul className="cl-items-edit">
              {s.items.map((it, ii) => (
                <li key={ii} className="cl-item-edit">
                  <input className="cl-input" placeholder="Item" value={it.title} onChange={e => setItem(si, ii, { title: e.target.value })} />
                  <input className="cl-input cl-help-input" placeholder="Help text (optional)" value={it.help_text} onChange={e => setItem(si, ii, { help_text: e.target.value })} />
                  <div className="cl-tag-toggles">
                    {CHECKLIST_TAGS.map(t => (
                      <button key={t} className={'cl-tagbtn' + ((it.tags || []).includes(t) ? ' on' : '')} onClick={() => toggleTag(si, ii, t)}>{t}</button>
                    ))}
                    <button className="dr-icon" onClick={() => setSection(si, { items: s.items.filter((_, j) => j !== ii) })}><Trash2 size={13} /></button>
                  </div>
                </li>
              ))}
            </ul>
            <button className="btn btn-ghost btn-sm" onClick={() => setSection(si, { items: [...s.items, blankItem()] })}><Plus size={13} /> Add item</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => setDraft(d => ({ ...d, sections: [...d.sections, blankSection()] }))}><Plus size={14} /> Add section</button>
      </div>

      <div className="cl-editor-actions">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={save}><Check size={14} /> Save template</button>
      </div>
    </div>
  );
}
export default ChecklistTemplateEditor;
```

- [ ] **Step 2: Verify build** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds.

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add apps/docket/src/components/ChecklistTemplateEditor.js
git -C 05_Throttle commit -m "docket: ChecklistTemplateEditor (sections/items/tags/schedule/assignees)"
git -C 05_Throttle push
```

---

### Task 13: `/checklist` page — My day + Manage tabs

**Files:**
- Modify: `05_Throttle/apps/docket/src/app/(auth)/checklist/page.js` (full rewrite, preserving the personal-recurring create/edit/stop flow).

**Contract:** segmented control `My day · Manage · Oversight` (Oversight added in Task 15; render its tab as a placeholder import here so the control is stable). State: `tab`, `me`, `employees`, `departments`, `personId`, `data` (`{owner,date,recurring_items,template_runs}`), `loading`, plus the existing create/edit/stop state for personal recurring.
- **My day** = the existing person picker + a "Today" card built from `recurring_items.filter(due_today)` (now showing completion time + late via `fmtClockIST`/`late`) **followed by** each `template_runs[i]` rendered with `<ChecklistRun run canComplete={run._can_complete} onToggleItem onSaveComment />`. `onToggleItem` → POST `toggleChecklistItem` (optimistic) ; `onSaveComment` → POST `saveSectionComment`. Keep the personal-recurring check-off via `toggleChecklistOccurrence` as today.
- **Manage** = the existing "All recurring tasks" personal list (create/edit-schedule/stop, unchanged) PLUS a "Checklist templates" section: GET `getChecklistTemplates`, list rows (name, role chip, section/item/assignee counts, schedule summary), "+ New template" → `ChecklistTemplateEditor` (templateId=null), row click (if `_can_edit`) → editor; archive button → POST `archiveChecklistTemplate` (confirm).

- [ ] **Step 1: Rewrite `page.js`**

Use this structure (preserves the S124 personal-recurring handlers verbatim; adds tabs + templates + run rendering). Replace the entire file with:
```js
'use client';
// Checklist — per-person recurring tasks (flat, RULE-DOCKET-008) + structured template
// runs (RULE-DOCKET-009), with a My day / Manage / Oversight tab set.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Check, Repeat, Pencil, Ban, Archive } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { RecurrenceEditor } from '../../../components/RecurrenceEditor.js';
import { ChecklistRun } from '../../../components/ChecklistRun.js';
import { ChecklistTemplateEditor } from '../../../components/ChecklistTemplateEditor.js';
import { OversightPanel } from '../../../components/OversightPanel.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { recurrenceSummary, templateRecurrenceSummary, fmtTime, fmtISTDate, isValidRecurrence } from '../../../lib/recurrence.js';
import { fmtClockIST } from '../../../lib/checklist.js';
import { PRIORITIES } from '../../../lib/tasks.js';

const timeKey = (i) => (i.recurrence?.time) || '99:99';
const byTime = (a, b) => timeKey(a).localeCompare(timeKey(b)) || (a.title || '').localeCompare(b.title || '');

export default function ChecklistPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState('day');           // 'day' | 'manage' | 'oversight'
  const [me, setMe] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [personId, setPersonId] = useState('');
  const [data, setData] = useState(null);          // { owner, date, recurring_items, template_runs }
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);
  const [busy, setBusy] = useState(false);
  // personal-recurring create/edit/stop (unchanged from S124)
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState(null);
  const [editSchedId, setEditSchedId] = useState(null);
  const [schedDraft, setSchedDraft] = useState(null);
  // templates (manage)
  const [templates, setTemplates] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTemplateId, setEditorTemplateId] = useState(null);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getMe', {}, session),
      docketopsGet('getEmployees', {}, session),
      docketopsGet('getDepartments', {}, session),
    ]).then(([m, emps, depts]) => {
      setMe(m); setEmployees(emps || []); setDepartments(depts || []);
      setPersonId(m?.employee_id || '');
      if (!m?.employee_id) setLoading(false);
    }).catch(e => { showToast(e.message || 'Failed to load', 'error'); setLoading(false); });
  }, [session, showToast]);

  const viewAll = !!(me?.permissions?.docket_admin || me?.permissions?.docket_view_all);
  const viewablePeople = useMemo(() => {
    if (!me) return [];
    return (employees || []).filter(e => e.id === me.employee_id || viewAll || (me.department_id && e.department_id === me.department_id));
  }, [me, employees, viewAll]);

  const load = useCallback(async (pid) => {
    if (!session || !pid) return;
    setLoading(true);
    try { setData(await docketopsGet('getChecklist', { employee_id: pid }, session)); }
    catch (e) { showToast(e.message || 'Failed to load checklist', 'error'); setData(null); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { if (personId && tab === 'day') load(personId); }, [personId, tab, load]);

  const loadTemplates = useCallback(async () => {
    if (!session) return;
    try { setTemplates(await docketopsGet('getChecklistTemplates', {}, session) || []); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }, [session, showToast]);
  useEffect(() => { if (tab === 'manage') loadTemplates(); }, [tab, loadTemplates]);

  const recItems = data?.recurring_items || [];
  const runs = data?.template_runs || [];
  const today = data?.date;
  const dueToday = useMemo(() => recItems.filter(i => i.due_today).sort(byTime), [recItems]);
  const doneCount = dueToday.filter(i => i.completed_today).length;
  const allSorted = useMemo(() => recItems.slice().sort(byTime), [recItems]);
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const isOwn = personId === me?.employee_id;

  // ── personal recurring toggle (flat) ──
  async function toggleRecurring(item) {
    if (!item._can_complete) return;
    const next = !item.completed_today;
    setData(d => ({ ...d, recurring_items: d.recurring_items.map(i => i.id === item.id ? { ...i, completed_today: next } : i) }));
    try { await docketopsPost('toggleChecklistOccurrence', { id: item.id, completed: next }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); load(personId); }
  }
  // ── template run handlers ──
  async function toggleItem(itemId, completed) {
    setData(d => ({ ...d, template_runs: d.template_runs.map(run => ({ ...run, sections: run.sections.map(s => ({ ...s, items: s.items.map(it => it.id === itemId ? { ...it, completed, completed_at: completed ? new Date().toISOString() : null, completed_by: completed ? (me?.full_name || null) : null } : it) })) })) }));
    try { await docketopsPost('toggleChecklistItem', { template_item_id: itemId, completed }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); load(personId); }
  }
  async function saveComment(sectionId, body) {
    try { await docketopsPost('saveSectionComment', { section_id: sectionId, body }, session); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  // ── personal recurring create/edit/stop (unchanged) ──
  function openCreate() { setDraft({ title: '', recurrence: { freq: 'daily', time: '09:00' }, owner_employee_id: personId, priority: 'P2', department_id: '', description: '' }); setShowCreate(true); }
  async function submitCreate() {
    if (!draft.title.trim()) { showToast('Title required', 'error'); return; }
    if (!isValidRecurrence(draft.recurrence)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try {
      await docketopsPost('createRecurringTask', { title: draft.title.trim(), recurrence: draft.recurrence, owner_employee_id: draft.owner_employee_id || null, priority: draft.priority, department_id: draft.department_id || null, description: draft.description || null }, session);
      setShowCreate(false); setDraft(null); showToast('Recurring task added', 'success'); load(personId);
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  function openEditSched(item) { setEditSchedId(item.id); setSchedDraft(item.recurrence || { freq: 'daily', time: '09:00' }); }
  async function saveSched() {
    if (!isValidRecurrence(schedDraft)) { showToast('Pick a valid schedule', 'error'); return; }
    setBusy(true);
    try { await docketopsPost('updateRecurrence', { id: editSchedId, recurrence: schedDraft }, session); setEditSchedId(null); setSchedDraft(null); load(personId); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function stopTask(item) {
    const reason = window.prompt('Stop this recurring task? It leaves the checklist (logged, not deleted). Reason:');
    if (reason == null) return;
    if (!reason.trim()) { showToast('Reason required', 'error'); return; }
    try { await docketopsPost('abandonTask', { id: item.id, reason: reason.trim() }, session); showToast('Stopped', 'success'); load(personId); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function archiveTemplate(t) {
    if (!window.confirm(`Archive "${t.name}"? It stops appearing on assignees' checklists.`)) return;
    try { await docketopsPost('archiveChecklistTemplate', { id: t.id }, session); showToast('Archived', 'success'); loadTemplates(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (!me) return <Spinner />;
  if (!me.employee_id) return (<div className="screen"><div className="screen-head"><p>Your account isn’t linked to an employee profile yet, so you have no checklist. Ask an admin to link you in Podium.</p></div></div>);

  return (
    <div className="screen checklist">
      <div className="cl-tabs">
        <button className={'cl-tab' + (tab === 'day' ? ' on' : '')} onClick={() => setTab('day')}>My day</button>
        <button className={'cl-tab' + (tab === 'manage' ? ' on' : '')} onClick={() => setTab('manage')}>Manage</button>
        <button className={'cl-tab' + (tab === 'oversight' ? ' on' : '')} onClick={() => setTab('oversight')}>Oversight</button>
      </div>

      {tab === 'day' && (<>
        <div className="screen-head cl-head">
          <p>Recurring tasks{isOwn ? ' on your checklist' : ` on ${data?.owner?.full_name || 'this'}’s checklist`}. Check them off as you go.</p>
          {viewablePeople.length > 1 && (
            <div className="cl-person">
              <Combobox value={personId} allowClear={false} style={{ width: 260 }}
                options={viewablePeople.map(e => ({ value: e.id, label: e.id === me.employee_id ? `${e.full_name} (me)` : e.full_name }))}
                onChange={(v) => { if (v) setPersonId(v); }} />
            </div>
          )}
        </div>
        {loading ? <Spinner /> : (<>
          <section className="cl-card">
            <div className="cl-card-head">
              <div><h3>Today</h3><span className="cl-sub">{fmtISTDate(today)}</span></div>
              {dueToday.length > 0 && (<div className="cl-progress"><span>{doneCount}/{dueToday.length} done</span><div className="cl-bar"><i style={{ width: `${dueToday.length ? (doneCount / dueToday.length * 100) : 0}%` }} /></div></div>)}
            </div>
            {dueToday.length === 0 ? <div className="cl-empty">Nothing personal scheduled for today.</div> : (
              <ul className="cl-today">
                {dueToday.map(i => {
                  const overdue = !i.completed_today && i.recurrence?.time && i.recurrence.time < nowHM;
                  return (
                    <li key={i.id} className={'cl-item' + (i.completed_today ? ' done' : '')}>
                      <button className={'cl-check' + (i.completed_today ? ' on' : '')} disabled={!i._can_complete} title={i._can_complete ? '' : 'You can only complete your own checklist'} onClick={() => toggleRecurring(i)}>{i.completed_today && <Check size={14} />}</button>
                      <div className="cl-item-main">
                        <button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                        <div className="cl-item-meta">
                          <span className={'cl-time' + (overdue ? ' over' : '')}>{fmtTime(i.recurrence?.time)}</span>
                          <PriorityBadge priority={i.priority} />
                          {i.department_name && <span className="chip soft">{i.department_name}</span>}
                          {i.completed_today && i.completed_at && (<span className={'cl-done-at' + (i.late ? ' late' : '')}>{i.late ? 'late · ' : ''}{fmtClockIST(i.completed_at)}{i.completed_by ? ` · ${i.completed_by}` : ''}</span>)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {runs.map(run => (
            <ChecklistRun key={run.template.id} run={run} canComplete={run._can_complete && isOwn}
              onToggleItem={toggleItem} onSaveComment={saveComment} />
          ))}
        </>)}
      </>)}

      {tab === 'manage' && (
        <div className="cl-manage-wrap">
          {/* personal recurring (unchanged S124 UI) */}
          <section className="cl-card">
            <div className="cl-card-head">
              <div><h3>My recurring tasks</h3><span className="cl-sub">{allSorted.length} total</span></div>
              {!showCreate && <button className="btn btn-primary" onClick={openCreate}><Plus size={14} /> New</button>}
            </div>
            {showCreate && draft && (
              <div className="cl-create">
                <input className="cl-input" autoFocus placeholder="What needs doing, on a schedule?" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
                <RecurrenceEditor value={draft.recurrence} onChange={r => setDraft(d => ({ ...d, recurrence: r }))} />
                <div className="cl-create-grid">
                  <label className="cl-field"><span>Assign to</span><Combobox value={draft.owner_employee_id} allowClear={false} style={{ width: '100%' }} options={employees.map(e => ({ value: e.id, label: e.full_name }))} onChange={v => setDraft(d => ({ ...d, owner_employee_id: v }))} /></label>
                  <label className="cl-field"><span>Priority</span><Combobox value={draft.priority} allowClear={false} style={{ width: '100%' }} options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))} onChange={v => setDraft(d => ({ ...d, priority: v || 'P2' }))} /></label>
                  <label className="cl-field"><span>Team</span><Combobox value={draft.department_id} allowClear style={{ width: '100%' }} options={[{ value: '', label: '— None —' }, ...departments.map(dp => ({ value: dp.id, label: dp.name }))]} onChange={v => setDraft(d => ({ ...d, department_id: v || '' }))} /></label>
                </div>
                <textarea className="cl-textarea" placeholder="Description (optional)" value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
                <div className="cl-create-actions"><button className="btn btn-ghost" onClick={() => { setShowCreate(false); setDraft(null); }}>Cancel</button><button className="btn btn-primary" disabled={busy || !draft.title.trim() || !isValidRecurrence(draft.recurrence)} onClick={submitCreate}><Check size={13} /> Add</button></div>
              </div>
            )}
            {allSorted.length === 0 ? <div className="cl-empty">No recurring tasks yet.</div> : (
              <ul className="cl-manage">
                {allSorted.map(i => (
                  <li key={i.id} className="cl-mrow">
                    <div className="cl-mrow-top">
                      <div className="cl-mrow-main"><button className="cl-item-title" onClick={() => setDrawerId(i.id)}>{i.title}</button>
                        <div className="cl-item-meta"><span className="cl-rec"><Repeat size={12} /> {recurrenceSummary(i.recurrence)}</span>{i.department_name && <span className="chip soft">{i.department_name}</span>}<PriorityBadge priority={i.priority} /></div></div>
                      {i._can_complete && (<div className="cl-mrow-actions"><button className="dr-icon" title="Edit schedule" onClick={() => openEditSched(i)}><Pencil size={14} /></button><button className="dr-icon" title="Stop (abandon)" onClick={() => stopTask(i)}><Ban size={14} /></button></div>)}
                    </div>
                    {editSchedId === i.id && (<div className="cl-sched-edit"><RecurrenceEditor value={schedDraft} onChange={setSchedDraft} /><div className="cl-sched-actions"><button className="btn btn-ghost" onClick={() => { setEditSchedId(null); setSchedDraft(null); }}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={saveSched}><Check size={13} /> Save</button></div></div>)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* checklist templates (new) */}
          <section className="cl-card">
            <div className="cl-card-head">
              <div><h3>Checklist templates</h3><span className="cl-sub">{templates.length} total</span></div>
              {!editorOpen && <button className="btn btn-primary" onClick={() => { setEditorTemplateId(null); setEditorOpen(true); }}><Plus size={14} /> New template</button>}
            </div>
            {editorOpen ? (
              <ChecklistTemplateEditor templateId={editorTemplateId} employees={employees} departments={departments} session={session}
                onSaved={() => { setEditorOpen(false); setEditorTemplateId(null); loadTemplates(); }}
                onCancel={() => { setEditorOpen(false); setEditorTemplateId(null); }} />
            ) : templates.length === 0 ? <div className="cl-empty">No templates yet. Create one to define a role’s daily checklist.</div> : (
              <ul className="cl-manage">
                {templates.map(t => (
                  <li key={t.id} className="cl-mrow">
                    <div className="cl-mrow-top">
                      <div className="cl-mrow-main">
                        <button className="cl-item-title" disabled={!t._can_edit} onClick={() => { if (t._can_edit) { setEditorTemplateId(t.id); setEditorOpen(true); } }}>{t.name}</button>
                        <div className="cl-item-meta">
                          {t.role_label && <span className="chip soft">{t.role_label}</span>}
                          <span className="cl-rec"><Repeat size={12} /> {templateRecurrenceSummary(t.recurrence)}</span>
                          <span className="cl-sub">{t.section_count} sections · {t.item_count} items · {t.assignee_count} assigned</span>
                        </div>
                      </div>
                      {t._can_edit && <div className="cl-mrow-actions"><button className="dr-icon" title="Archive" onClick={() => archiveTemplate(t)}><Archive size={14} /></button></div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === 'oversight' && <OversightPanel session={session} employees={employees} departments={departments} />}

      {drawerId && (<TaskDrawer id={drawerId} session={session} departments={departments} employees={employees} onClose={() => setDrawerId(null)} onMutated={() => load(personId)} />)}
    </div>
  );
}
```

> **Task 15 dependency:** this file imports `OversightPanel`. Create a minimal stub now if executing this task before Task 15: `export function OversightPanel() { return <div className="cl-empty">Loading…</div>; } export default OversightPanel;` at `components/OversightPanel.js`, replaced in Task 15.

- [ ] **Step 2: Create the OversightPanel stub** (only if Task 15 not yet done) at `05_Throttle/apps/docket/src/components/OversightPanel.js` with the one-line stub above.

- [ ] **Step 3: Verify build** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds.

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add apps/docket/src/app/\(auth\)/checklist/page.js apps/docket/src/components/OversightPanel.js
git -C 05_Throttle commit -m "docket: /checklist — My day (runs) + Manage (templates) tabs"
git -C 05_Throttle push
```

---

### Task 14: CSS for new checklist classes

**Files:**
- Modify: `05_Throttle/apps/docket/src/app/globals.css` — append a checklist-templates block. (Existing `.cl-*` classes from S124 stay.)

- [ ] **Step 1: Append styles**

Append a block styling the new classes used above, themed via the existing CSS vars (`--accent`, `--surface`, `--t1`, `--t2`, `--mono`, etc. — match neighbouring `.cl-*` rules). Cover at minimum: `.cl-tabs`/`.cl-tab`/`.cl-tab.on`, `.cl-run`/`.cl-run-head`/`.cl-run-title`/`.cl-run-prog`, `.cl-section`/`.cl-section-head`/`.cl-section-sub`/`.cl-section-meta`/`.cl-due`/`.cl-section-prog`, `.cl-item-help`, `.cl-tag` + `.tag-critical`/`.tag-qc`/`.tag-deadline`/`.tag-ongoing` (distinct accent colours; Critical = red/danger, QC = blue, Deadline = amber, Ongoing = neutral), `.cl-done-at` + `.cl-done-at.late` (late = danger colour), `.cl-seccomment` (textarea), `.cl-editor`/`.cl-editor-grid`/`.cl-field`/`.cl-sections-edit`/`.cl-section-edit`/`.cl-section-edit-head`/`.cl-sub-input`/`.cl-help-input`/`.cl-items-edit`/`.cl-item-edit`/`.cl-tag-toggles`/`.cl-tagbtn`/`.cl-tagbtn.on`/`.cl-editor-actions`, `.cl-assignees`/`.chip-x`, `.cl-manage-wrap`, `.btn-sm`. Inspect the existing `.cl-card`/`.cl-item`/`.chip` rules first and reuse their tokens so the new UI matches the S113 redesign palette.

- [ ] **Step 2: Verify build + eyeball** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds. (Visual check happens in the final live smoke.)

- [ ] **Step 3: Commit**

```bash
git -C 05_Throttle add apps/docket/src/app/globals.css
git -C 05_Throttle commit -m "docket: checklist-template styles (tabs/run/sections/tags/editor)"
git -C 05_Throttle push
```

---

## Phase 3 — Oversight + final wiring

### Task 15: OversightPanel component

**Files:**
- Modify (replace stub): `05_Throttle/apps/docket/src/components/OversightPanel.js`

**Contract:** Props `{ session, employees, departments }`. State: `date` (default `todayIST()`), `data` (`getChecklistOversight` result), `loading`, `openPerson` (employee_id | null). On mount + date change, GET `getChecklistOversight?date=`. If the response is empty `people`, show a "Nothing to monitor" empty state (also covers users with no scope). Each person row: name, department, recurring `done/total`, and per-template `name done/total` with incomplete-section chips; click → fetch `getChecklist?employee_id=&date=` and render read-only `ChecklistRun`s (`canComplete={false}`) below/in a panel.

- [ ] **Step 1: Write `OversightPanel.js`**

```js
'use client';
import { useEffect, useState, useCallback } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { ChevronRight } from 'lucide-react';
import { docketopsGet } from '../lib/docketopsFetch.js';
import { ChecklistRun } from './ChecklistRun.js';
import { todayIST, fmtISTDate } from '../lib/recurrence.js';

export function OversightPanel({ session }) {
  const { showToast } = useToast();
  const [date, setDate] = useState(todayIST());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [personData, setPersonData] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try { setData(await docketopsGet('getChecklistOversight', { date }, session)); }
    catch (e) { showToast(e.message || 'Failed', 'error'); setData(null); }
    finally { setLoading(false); }
  }, [session, date, showToast]);
  useEffect(() => { load(); }, [load]);

  async function openPerson(empId) {
    if (openId === empId) { setOpenId(null); setPersonData(null); return; }
    setOpenId(empId); setPersonData(null);
    try { setPersonData(await docketopsGet('getChecklist', { employee_id: empId, date }, session)); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  const people = data?.people || [];
  return (
    <div className="cl-oversight">
      <div className="screen-head cl-head">
        <p>Checklist adherence for people you manage or have assigned to.</p>
        <input className="cl-date" type="date" value={date} onChange={e => { setDate(e.target.value || todayIST()); setOpenId(null); setPersonData(null); }} />
      </div>
      {loading ? <Spinner /> : people.length === 0 ? (
        <div className="cl-empty">Nothing to monitor for {fmtISTDate(date)}.</div>
      ) : (
        <ul className="cl-ovr-list">
          {people.map(p => (
            <li key={p.employee_id} className="cl-ovr-row">
              <button className="cl-ovr-head" onClick={() => openPerson(p.employee_id)}>
                <ChevronRight size={14} className={'cl-ovr-chev' + (openId === p.employee_id ? ' open' : '')} />
                <span className="cl-ovr-name">{p.full_name}</span>
                {p.department_name && <span className="chip soft">{p.department_name}</span>}
                <span className="cl-ovr-stats">
                  {p.recurring.total > 0 && <span className={'cl-ovr-stat' + (p.recurring.done >= p.recurring.total ? ' ok' : '')}>tasks {p.recurring.done}/{p.recurring.total}</span>}
                  {p.templates.map(t => (
                    <span key={t.template_id} className={'cl-ovr-stat' + (t.done >= t.total && t.total > 0 ? ' ok' : '')} title={t.incomplete_sections.join(', ')}>
                      {t.name} {t.done}/{t.total}
                    </span>
                  ))}
                </span>
              </button>
              {openId === p.employee_id && (
                <div className="cl-ovr-detail">
                  {!personData ? <Spinner /> : (
                    <>
                      {(personData.recurring_items || []).filter(i => i.due_today).length > 0 && (
                        <div className="cl-ovr-recurring">
                          <h5>Recurring tasks</h5>
                          <ul className="cl-today">
                            {(personData.recurring_items || []).filter(i => i.due_today).map(i => (
                              <li key={i.id} className={'cl-item' + (i.completed_today ? ' done' : '')}>
                                <span className={'cl-check' + (i.completed_today ? ' on' : '')} />
                                <div className="cl-item-main"><div className="cl-item-title">{i.title}</div></div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(personData.template_runs || []).map(run => (
                        <ChecklistRun key={run.template.id} run={run} canComplete={false} onToggleItem={() => {}} onSaveComment={() => {}} />
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export default OversightPanel;
```

- [ ] **Step 2: Add Oversight CSS** to `globals.css`: `.cl-oversight`, `.cl-date`, `.cl-ovr-list`/`.cl-ovr-row`/`.cl-ovr-head`/`.cl-ovr-chev`(+`.open` rotate 90deg)/`.cl-ovr-name`/`.cl-ovr-stats`/`.cl-ovr-stat`(+`.ok` success colour)/`.cl-ovr-detail`/`.cl-ovr-recurring`. Reuse existing tokens.

- [ ] **Step 3: Verify build** — `cd 05_Throttle && npx turbo build --filter=docket` → succeeds.

- [ ] **Step 4: Commit**

```bash
git -C 05_Throttle add apps/docket/src/components/OversightPanel.js apps/docket/src/app/globals.css
git -C 05_Throttle commit -m "docket: OversightPanel (R1 — per-person adherence + read-only drill-in)"
git -C 05_Throttle push
```

---

### Task 16: Deploy frontend + knowledge files + rule

**Files:**
- Modify: `BUSINESS_RULES.md`, `systems/docket.md`, `CORE.md`, `BACKLOG.md` (workspace root, `legendlot/lot-migration-kit`).

- [ ] **Step 1: Confirm the monorepo auto-deploys** — the prior commits to `main` already trigger the `deploy-docket.yml` GitHub Action (3-4 min). Confirm the latest run is green:

```bash
gh -R legendlot/throttle run list --workflow deploy-docket.yml --limit 1
```
Expected: latest run `completed / success`. (No manual deploy step for the app.)

- [ ] **Step 2: Add RULE-DOCKET-009 to `BUSINESS_RULES.md`**

Add under the Docket rules, summarising: structured checklist **templates** (sections → items, tags Critical/QC/Deadline/Ongoing, per-section comments) live outside `docket.tasks` (off board + dashboard); assign-to-people with a free-text `role_label` (reassign on holder change; no Podium-role binding); runs are derived (no per-day row); completion logged per `(item, employee, date)` with `completed_at`; late = completed after the section `due_time` (IST); anyone authors + assigns, edit/archive = creator/admin, complete = assignee only; Oversight scope = reports ∪ people-I-assigned ∪ view_all. Note it **coexists with** RULE-DOCKET-008 (flat recurring tasks, unchanged). Bump the file's `Last updated`.

- [ ] **Step 3: Update `systems/docket.md`** — extend the Checklists section with the template model (the 6 tables, worker actions `getChecklistTemplates`/`getChecklistTemplate`/`getChecklistOversight` + `saveChecklistTemplate`/`assign|unassignChecklistTemplate`/`toggleChecklistItem`/`saveSectionComment`/`archiveChecklistTemplate`, the My day/Manage/Oversight tabs, new components `ChecklistRun`/`ChecklistTemplateEditor`/`OversightPanel`/`TagPill`, `getChecklist` new shape) + R2 timestamp surfacing. Link this spec + plan. Bump `Last updated`.

- [ ] **Step 4: Update `CORE.md`** — in the `docket` schema bullet, list the 6 new tables. Bump `Last updated`.

- [ ] **Step 5: Update `BACKLOG.md`** — add `[docket] [P1] Live browser smoke — checklist templates + oversight + completion timestamps` (the Task 17 script) and close any now-superseded checklist follow-ups. Bump `Last updated`.

- [ ] **Step 6: Commit knowledge files**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add BUSINESS_RULES.md systems/docket.md CORE.md BACKLOG.md
git commit -m "docket: knowledge files — RULE-DOCKET-009 (structured checklist templates + oversight)"
git push
```

---

### Task 17: Live browser smoke (manual, needs a Google login)

> Code-side verification is done; this is the human pass on `docket.legendoftoys.com` after the Action deploys. Record results in the BACKLOG item.

- [ ] **Manage tab:** create a template "SPM — Daily", role label "Senior Production Manager", daily schedule; add 2 sections (one with a `due_time` of 09:00), 2-3 items each with help text + tags; assign it to yourself + one teammate. Save → it appears in the templates list with correct counts.
- [ ] **My day tab (self):** the template run renders with its sections/items/tags; check items off → they persist on reload; the completion time shows; checking an item after its section due time shows a **late** pill; type a section comment → it persists on reload.
- [ ] **My day tab (teammate, if you can view them):** their run shows but the checkboxes are disabled.
- [ ] **R2 on personal recurring:** check off a personal recurring task → its completion time shows; if checked after its scheduled time, a late pill shows.
- [ ] **Oversight tab:** appears (you assigned + manage people); shows the teammate's adherence for today with `done/total` + incomplete-section hint; drill in → read-only run, boxes disabled; change the date → empty/“nothing to monitor” for a day with nothing due.
- [ ] **Board/dashboard unaffected:** `/tasks` and `/dashboard` show no template rows.

---

## Self-review (completed during planning)

**Spec coverage:**
- R1 monitoring → Task 7 (`getChecklistOversight`) + Task 15 (`OversightPanel`) + `getChecklist` view-gate widening (Task 6) + `peopleInScope` (Task 2). ✓
- R2 timestamps → Task 6 (`completed_at`/`completed_by`/`late` on both models) + rendering in Tasks 11/13/15. No schema change (column pre-exists). ✓
- R3 structured templates → Tasks 1 (schema), 3 (CRUD), 4 (assign), 5 (complete + comment), 6 (runs in getChecklist), 11/12/13/14 (UI). ✓
- Coexist-not-replace flat model → Task 6 keeps `recurring_items`; Task 13 keeps the S124 create/edit/stop handlers verbatim. ✓
- "Anyone authors / assignee completes" → `saveChecklistTemplate` open + `canEditTemplate` for edit + `isAssignee` for toggle/comment (Tasks 3/5). ✓
- Off board/dashboard → templates aren't `docket.tasks`; no `list_tasks`/`dashboard_stats` change (stated Task 1). ✓
- Tags fixed set → `CHECKLIST_TAGS` + `sanitizeTags` (worker) + `TagPill` (client). ✓

**Type/name consistency:** worker returns `recurring_items`/`template_runs`/`date` (Task 6) — consumed by Task 13 page + Task 15 panel. `template_runs[i]` shape (`.template`, `.sections[].items[]`, `_can_complete`) matches `ChecklistRun` props (Task 11). `getChecklistOversight.people[]` (`recurring{done,total}`, `templates[]{template_id,name,done,total,incomplete_sections}`) matches `OversightPanel` (Task 15). Worker actions registered (Task 8) match every `docketopsPost`/`docketopsGet` action string used in the UI. `hideTime` prop (Task 9) used by the editor (Task 12). ✓

**Placeholder scan:** CSS tasks (14, 15-step2) describe class lists rather than full stylesheets — intentional (theming must match the live S113 palette by inspecting neighbours); every functional JS step has complete code.
