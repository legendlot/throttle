# Podium — Title / Level / Team: build plan (2026-11-14)

> Spec: `docs/superpowers/specs/2026-11-13-podium-title-level-team.md`. Afshaan confirmed the org sheet 2026-11-14.
> Migration `0024_title_level_team.sql` (`podium_title_level_team_v1`) is ALREADY APPLIED live:
> `podium.levels` (code L0–L10, name, rank, active), `employees.level_id`, `openings.level_id`,
> `departments.founder_owner_employee_id`, `employees.manager_to_be_hired` (CHECK: never true while manager_id is set).
> No cron; `wrangler.toml` untouched.

## Rules (Afshaan)
- **Title** = free text. **Level** = the L0–L10 ladder. **Team** = department (a tree: team > sub-team).
- Every team has a **founder owner** (Afshaan or Vinay; null = both, e.g. Founder's Office). A sub-team with no
  owner of its own inherits its parent's.
- **Vacant manager:** "leave it vacant, mark it to be hired, don't put placeholders; Vinay and I are skip-level
  managers for those positions." → `manager_id` null + `manager_to_be_hired` true. The **skip-level** for such a
  person = the founder owner of their team (walk up parents). It is derived, never stored per person.
- A team head may be empty = "To be hired".
- Job role is hidden in the UI (table kept for history).

## Worker (`podiumops-worker/src/`)
1. Levels: a read action `listLevels` (active, by rank) — or add `levels` to whatever lookup payload the People/
   openings forms already load (follow the existing pattern for departments). Any signed-in user can read.
2. Employees: `level_id` and `manager_to_be_hired` in the editable field lists (both the create and update lists near
   index.js:495 and :855) and in the read select (index.js:510: add `level:level_id(id,code,name,rank)`).
   Validation: `level_id` uuid of an existing level or null; setting a non-null `manager_id` forces
   `manager_to_be_hired=false`; `manager_to_be_hired=true` forces `manager_id=null` (do it in the patch, so the CHECK
   never fires). Same permission gate as manager_id today.
3. Departments: `founder_owner_employee_id` readable + editable wherever head/parent are (must be one of the two
   founders, EMP-001 / EMP-002 — reuse `FOUNDER_CODES` from googlesync.js, or null).
4. Openings: `level_id` editable on create/update like `department_id`; returned on read.
5. Approvers (leave.js): `resolveLeaveApprover(emp, founders)` and `wfhApprover(emp)` — when the person has no
   manager_id and is not a founder, return the **founder owner of their team** (walk up parent_department_id;
   null if none) instead of null. Callers pass the departments needed (one query, not per row). Keep founders'
   existing rule. Add unit tests for: manager present; vacant → team owner; vacant → parent's owner; no owner → null.
   `decideBlock`'s skip-level (`approverManagerId`) is unchanged.
6. Google department label (index.js ~6712, `desiredGoogleFields` caller): a sub-team pushes
   `"<Parent> - <Child>"` (e.g. "Sales - Ecommerce", "NPD - Build"); a top-level team pushes its own name.
   The select that loads `department` must include the parent's name. Update googlesync tests if they cover it.
7. Grep every other site that lists employee editable fields / builds an employee select (people list, org chart,
   team page, me page, exits) and add level where people are shown with title. Count sites in the report.

## App (`apps/podium/src/`)
1. `components/EmployeeForm.js`: Level select (from levels, "—" = none) next to Title; Job role field hidden;
   Manager field gets a "To be hired" checkbox — checked clears and disables the manager picker; when checked,
   show "Skip-level: <founder owner of the team>" (compute client-side from departments).
2. People list + person detail (`app/(auth)/people/...`): show Level code+name beside Title; manager shows
   "To be hired" when `manager_to_be_hired`. Org chart (`app/(auth)/org`): a person with a vacant manager hangs
   under a "To be hired" node under the team's founder owner if that is simple; otherwise under the founder owner
   with a "(manager to be hired)" note. Keep it simple; do not redesign.
3. `app/(auth)/departments/page.js`: show and edit Founder owner (Afshaan / Vinay / Both); empty head reads
   "To be hired".
4. Openings new/detail: Level select; designation unchanged.
5. Manual: the people/teams chapters mention Level, founder owner, "To be hired" manager and skip-level approvals;
   bump `manual.json` minor version; rebuild PDFs + in-app data per the system-manual skill (manual-builder agent or
   the lane).

## Done =
`node --test` green in podiumops-worker, `npx turbo build --filter=podium` zero errors, diffstat + list of every site
touched. The builder never commits, deploys or writes rows.
