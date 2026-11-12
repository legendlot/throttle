# Podium J1b — one-way Podium → Google Directory field sync — plan

> Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §J1b (~line 503). Afshaan 2026-11-12:
> "Do this task here". Answers 2026-11-12: push the **personal** phone (`employees.phone`); Google's name comes
> from **full_name only**; **any HR save** pushes; **founders and super-admins are excluded entirely**.
> Investigation (file:line findings) summarised in the session; key facts are restated in the decisions.

## Facts the design rests on

- The existing Google → Podium Directory import (index.js ~1622–2049, `DirectorySyncModal`) writes
  `department_id`, `manager_id`, `google_org_unit` on `update[]`, and baselines on `dismiss[]` / `baseline[]`.
  Once Podium pushes OU/manager to Google, its `moved` / `differs` rows would propose undoing Podium's change.
- Podium has no OU of its own: `google_org_unit` is what Google last said; departments do not map 1:1 to OUs.
- Employee → Google user: `work_email` (41 of 63 active have no `google_user_id`); `users.get` also matches aliases,
  so `primaryEmail` must equal `work_email`.
- Directory `users.update` replaces whole array fields (organizations / relations / phones / externalIds); J1's
  `externalIds[{type:'podium_work_account'}]` stamp (workaccount.js:77) must survive.
- `fetch(request, env)` has no `ctx`; handlers are `handler(body, auth, env)`. No cron (wrangler.toml untouched).
- `googleWriteToken(env, 'directory')` (index.js:304) = the write SA; `googleAdminLog` (index.js:6273) = the audit
  log (action CHECK must widen); `requireGoogleAdmin` (index.js:6263) = the 3 Google admins.

## Decisions

- **D1 One way.** Podium → Google only. Google values are displayed in a diff, never written into Podium fields.
- **D2 Fields + mapping.** `full_name` → `name.givenName` (all tokens but the last) / `name.familyName` (last token;
  a one-word name → both = that word); `job_title` → `organizations[primary].title`; department name →
  `organizations[primary].department`; manager → `relations[{type:'manager', value: manager.work_email}]`;
  `phone` (the person's own phone, Afshaan's call) → `phones[{type:'mobile'}]`; `employee_code` →
  `externalIds[{type:'organization'}]`; `org_unit_path` → `orgUnitPath`. Never `primaryEmail`, password,
  suspension, deletion, groups.
- **D3 Merge, never clobber.** Every push = `GET ?projection=full` → merge → `PUT`. Keep extra organization keys,
  non-manager relations, other phone types, every externalId that is not type `organization` (incl. the J1
  stamp). A blank Podium value leaves Google's value alone — **except the manager**: Podium with no manager
  removes Google's manager relation (Podium is the source of truth for reporting lines). Nothing changed → no PUT.
- **D4 Scope.** In: status `active` / `on_leave` / `notice`, `work_email` @legendoftoys.com, Google user exists, not
  suspended, `primaryEmail` == `work_email`. Out (skipped with a reason, never written): exited; founders and
  super-admins (users_profile.role = super_admin, the hard deny-list EMP-001 / EMP-002, any Google `isAdmin` user,
  and the impersonated admin) —
  **entirely** (Afshaan); `directory_ignored` emails; users in an excluded OU; a push that would move someone
  into an excluded OU or an OU not in Google's live OU list.
- **D5 Podium owns the OU.** New `employees.org_unit_path`, starting NULL (review 2026-11-12: the `google_org_unit`
  baseline was last refreshed 2026-10-07, so no seed). NULL = leave Google's OU alone. It is backfilled from LIVE
  Google whenever the worker reads a user (drain, preview / push, the diff) via `google_sync_backfill_ou`, which
  dirties nobody (transaction GUC `podium.gsync_backfill`). EmployeeForm gets an Org unit picker (live OUs minus
  excluded; an excluded OU is refused, `ou_excluded`), pre-suggested from `defaultOu` (over `org_unit_path`, falling
  back to `google_org_unit`, never `/`) when the department changes and the OU is blank or the old department's.
- **D6 Dirty-marking in the database — push only what changed.** A trigger on `employees` (insert, or update of
  full_name, job_title, department_id, manager_id, phone, employee_code, org_unit_path, work_email, status, values
  IS DISTINCT FROM) upserts `google_sync_state` = pending and UNIONS into `dirty_fields` only the fields whose
  columns changed (full_name→name, job_title→title, department_id→department, manager_id→manager, phone→phone,
  employee_code→employee_code, org_unit_path→org_unit; insert / work_email / status → every field). A manager's
  `work_email` change adds `manager` to their direct reports; a department rename adds `department` to its active
  members. `dirtied_by` = the `X-Podium-Actor` header the worker sends (PostgREST `request.headers`). This covers
  every path (updateEmployee, saveMyProfile RPC, joining RPC, exits reassign, raw SQL) without per-handler code.
- **D7 Push timing, no cron.** The handler that saved one person pushes that person inline after the commit
  (8 s budget) and returns `google_sync: {status, error?}`; a failure never fails the Podium save. Fan-out and
  leftovers drain via `ctx.waitUntil(drainGoogleSync)` (≤ 8 people per drain, claimed with a 2-min lease like J1's
  attempt claim). Opening the People list or a person's page also triggers a drain. **A drain pushes only
  `dirty_fields`** (only triggers add to it); a field leaves `dirty_fields` when pushed or found equal, and the row
  is `ok` only when none is left and `rev` is unchanged. **An admin push (`pushGoogleFields`, D11) is one-shot and
  preview-bound:** `google_sync_claim` stores the picked fields + the preview's body hash on the claim, the worker
  recomputes the body and PUTs only if it hashes the same (else `stale_preview`), and any outcome but `ok` just
  releases the claim: it is never queued and never retried. Per person: ownership check → GET → merge → re-read of
  status / work_email / google_user_id + ownership (changed → `identity_changed`, no PUT) → PUT (If-Match: the
  user's etag), each Google call (body included) aborted after 20 s. A bad target OU skips the org_unit field
  only. Failed drain rows retry with backoff (1 / 5 / 30 min) on later drains; Retry button for Google admins
  (`google_sync_queue`, retry-only). A status / work_email change bumps `rev` and revives a skipped row that still
  has dirty fields. `ctx` is threaded through as an
  optional 4th handler argument.
- **D8 Who.** Push-on-save runs for any save that HR (or the self-profile) makes; logged in `google_admin_log`
  (`sync_fields` / `sync_fields_failed`) with actor = `dirtied_by` (the saver) else the drain's caller, and
  `request = {trigger: save|drain|push|retry, caller, body}`. The diff is visible to HR; bulk push and Retry
  need `requireGoogleAdmin`.
- **D9 After a successful push** write `google_org_unit`, `google_manager_email`, `google_user_id` (backfill) and
  `google_sync_state.last_pushed` (the values sent).
- **D10 Import reconciled.** The Google → Podium import keeps: new-joiner detection + `create[]` (copying name +
  title from Google for accounts made outside Podium), departure alerts, ignore list, excluded OUs. It stops:
  `update[]`, `dismiss[]`, `baseline[]` (refused server-side) and the `moved` / `differs` tiers (removed from the
  preview and the modal).
- **D11 Reconciliation on demand.** No nightly job (needs a cron = Afshaan's go on wrangler.toml). The Directory
  screen's **Google vs Podium** tab is the reconciliation: per person × field, state `equal` / `differs` /
  `podium_blank` / `changed_in_google` (Google differs from what we last pushed), with checkboxes, **Preview**
  (dry run showing the exact request body + a hash of it) and **Push** in chunks of 8, which sends the hashes back
  and is refused per person (`stale_preview`, 409) where the recomputed body differs.

## Build

1. Migration `0015_google_field_sync.sql`: `employees.org_unit_path` (+ seed), `podium.google_sync_state`
   (employee_id PK, status pending/ok/failed/skipped, dirty_at, attempts, last_attempt_at, next_attempt_at,
   last_error, last_pushed_at, last_pushed jsonb, skip_reason, attempt_id, attempt_started_at; RLS on,
   service_role only), the triggers in D6, `google_admin_log.action` CHECK widened.
2. Pure `src/googlesync.js` + `test/googlesync.test.mjs`: `splitForGoogle`, `desiredGoogleFields`,
   `mergeGoogleUser(current, desired)` → body | null, `scopeOf(emp, gUser, ctx)`, `classifyDiff`, backoff.
3. Worker: `drainGoogleSync`, actions `getGoogleSyncStatus`, `retryGoogleSync`, `getGoogleDiff`,
   `pushGoogleFields {employee_ids ≤ 8, fields?, dry_run}`; `google_sync` in the save responses; import
   reconciliation (D10); `ctx` threading.
4. App: DirectorySyncModal (drop moved/differs, add the Google vs Podium tab), person page banner
   ("Google not updated — retry") + pending chip, EmployeeForm Org unit field.
5. Live: dry-run on one real person first (preview only), then a synthetic test Google account only for real
   writes; manual chapter; backlog; spec row.
