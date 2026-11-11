# Podium X1 — Exits + no-dues (the only path to `exited`)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` → "X1" + decisions L4–L8 (v4.1). Builds on J1
(`google_admin_access`, `googleWriteToken`, `google_admin_log`, `work_accounts`).

## Deliberate deviations from the spec (record in the spec when shipped)

1. **No `notice` status.** During notice the employee stays `status = 'active'`; "on notice" = an open
   `employee_exits` row. Why: `sales.f_podium_salary_run`, `_coverage`, `f_podium_sga_excluded`, `f_analytics_*`,
   `f_okr_cycle`, both auth-link triggers and 10 worker queries all key on `'active'` — a `notice` status would drop
   people serving notice from payroll/SG&A. (`notice` stays allowed by the CHECK, unused.)
2. **Relieving / experience letters** are a manual line (HR uploads the letter) in X1; the generator on the
   offer-letter engine is X1b.
3. **F&F** = nullable columns only (L7), no UI beyond "F&F — later phase".

## Data (migration `podiumops-worker/migrations/0010_exits.sql`, applied as `podium_exits_v1`)

- `podium.settings.exit_notice_days int not null default 30` (the default LWD = notice date + this).
- `podium.exit_checklist_lines` — admin-editable TEMPLATE rows: `key text pk`, `title`, `owner text check in
  ('hr','manager','it','admin','finance','store')`, `required bool`, `allow_na bool`, `applies_to text[]` (employment
  types; empty = all), `auto_source text check in ('snorkel_assets','open_work','payment_requests','lot_access',
  null)`, `sort int`, `active bool`, timestamps. Seed the L8 draft (spec table), in this order:
  notice_served (hr, req) · assets_returned (store, req, auto snorkel_assets, allow_na false) · id_card_keys (admin, req)
  · company_sim (it, req, allow_na) · lot_access (hr, req, auto lot_access — completed BY the close itself) ·
  open_work_handed_over (manager, req, auto open_work) · advances_reimbursements (finance, req, auto payment_requests)
  · leave_balance (hr, req) · fnf (finance, NOT required, "Full & final — later phase") · relieving_letters (hr, req)
  · exit_interview (hr, not required).
- `podium.exit_tools` — `id`, `name unique`, `active`, `sort` (L4 list; seed the spec's starter list). At exit start
  each active tool becomes a checklist line `tool:<id>` (owner it, required, allow_na — HR marks n/a for tools the
  person never had).
- `podium.employee_exits` — one per employment exit: `id`, `employee_id` FK, `status check in
  ('open','closed','cancelled')`, `initiated_by check in ('employee','manager','hr','backfill')`, `started_by uuid`,
  `reason_code check in ('resignation','termination','absconding','end_of_internship','end_of_contract','other')`,
  `reason_note text`, `notice_date date`, `lwd date not null`, `lwd_override_reason text` (required when lwd ≠
  notice_date + exit_notice_days), `rehire_eligible bool` (HR-only visibility), `exit_interview text`,
  `fnf_amount numeric`, `fnf_paid_on date`, `fnf_document_id uuid` (all nullable, later phase), `closed_at`,
  `closed_by`, `cancelled_at`, `cancelled_by`, `cancel_reason`, timestamps. Partial unique index: one `open` per
  employee.
- `podium.exit_checklist_items` — the SNAPSHOT taken at start: `id`, `exit_id`, `line_key`, `title`, `owner`,
  `required`, `allow_na`, `auto_source`, `sort`, `status check in ('open','done','na')`, `note`, `document_id uuid`,
  `done_by`, `done_at`. Unique (exit_id, line_key). Editing the template never changes a started exit.
- `podium.google_exit_items` — the post-exit HR prompt (L5/L6): `id`, `employee_id`, `exit_id`, `work_email`,
  `google_user_id`, `status check in ('open','transferred_suspended','suspended','kept')`, `keep_until date`,
  `keep_reason text`, `transfer_id text`, `transfer_to_employee_id uuid`, `acted_by`, `acted_at`, timestamps. One open
  per employee. A `kept` item whose keep_until has passed counts as open again (computed, no cron).
- `google_admin_log.action` CHECK widened: + `'suspend_exited'`, `'drive_transfer'`.
- RLS on, service_role only, grants as 0009.
- RPC `podium.exit_close(p jsonb)` SECURITY DEFINER (pattern 0009): lock exit + employee; require exit `open`,
  `p.today >= lwd`; every `required` item `done` or (`na` and allow_na); **live check**: zero `store.assets` with
  `custodian_user_id = employee.auth_user_id and status not in ('retired','disposed')` (check the real status values)
  → else `podium_assets_outstanding`; zero open `docket.tasks` (assignee or owner = employee, status not in the done/
  abandoned set, archived_at null) → else `podium_open_work`. Then: employee `status='exited'`, `date_exited = lwd`,
  `exit_reason = reason_code`; exit `closed`; the `lot_access` item `done` (by the close); `store.users_profile.active
  = false` for the auth user; delete their `store.podium_user_roles`, `podium.comp_access`, `podium.google_admin_access`
  rows; insert the `google_exit_items` row (`open`) when the employee has a work_email. Return what changed.
  (Reports are reassigned by the worker right after with the existing `reassignReportsOnExit`, RULE-PODIUM-010.)
- RPC `podium.exit_backfill(p jsonb)`: for an already-`exited` employee with no `employee_exits` row — insert a
  `closed` exit (`initiated_by 'backfill'`, reason_code, reason_note = the old free-text `exit_reason` preserved, lwd =
  the HR-confirmed date) and set `employees.exit_reason = reason_code`, `date_exited = lwd`. No checklist items.

## Worker (`podiumops-worker/src/index.js`; pure rules in new `src/exits.js` + `test/exits.test.mjs`)

Gates: HR = `isHr`; manager = in the manager chain (`inManagerChain`); self = caller's employee; Google admin =
`isGoogleAdmin` (J1).
- GET `getExit?employee_id=` (self, chain, HR): the open exit (or latest) + items + live lists: assets (code, name,
  category) · open Docket tasks (task_no, title, status) · open payment requests (request_no, purpose, status, amount
  only for HR) · `rehire_eligible` stripped unless HR.
- GET `getExits` (HR): open exits board (person, reason, LWD, days left, items done/required, blockers) + open/overdue
  `google_exit_items` + backfill queue (exited employees with no `employee_exits` row, with the old free text).
- POST `startExit {employee_id, reason_code, reason_note, notice_date, lwd?, lwd_override_reason?, rehire_eligible?}`:
  self → `initiated_by 'employee'`, reason forced `resignation`, lwd = default, no override, no rehire flag; manager
  chain → 'manager'; HR → 'hr' (only HR may override lwd or set rehire). Refuse if an open exit exists or the employee
  is exited. Snapshot template lines (filtered by `applies_to`) + one line per active tool. Self-serve (add to
  SELF_SERVE_POST, self-scoped).
- POST `updateExitItem {item_id, status: done|na|open, note, document_id?}`: HR any line; manager-chain only `owner =
  'manager'` lines. `na` needs allow_na + a note. `assets_returned` cannot be `done` while assets remain;
  `open_work_handed_over` likewise for open Docket tasks; `lot_access` can't be set by hand.
- POST `updateExit {exit_id, lwd?, lwd_override_reason?, rehire_eligible?, exit_interview?, reason_code?}` (HR).
- POST `cancelExit {exit_id, reason}` (HR) — resignation withdrawn.
- POST `closeExit {exit_id}` (HR): `exit_close` RPC, then `reassignReportsOnExit`; return blockers verbatim on refusal.
- POST `backfillExit {employee_id, reason_code, lwd}` (HR): `exit_backfill`.
- POST `actGoogleExitItem {item_id, action: transfer_and_suspend|suspend|keep, keep_until?, keep_reason?}` (Google
  admin): verify `users.get(google_user_id).primaryEmail == work_email` first (never act on a mismatched id).
  transfer_and_suspend: Data Transfer `POST /admin/datatransfer/v1/transfers` {oldOwnerUserId, newOwnerUserId = the
  manager's google_user_id, applicationDataTransfers: [{applicationId: the "Drive and Docs" id from
  applications.list, applicationTransferParams: [{key:'PRIVACY_LEVEL', value:['PRIVATE','SHARED']}]}]}, store
  transfer_id, then `users.update {suspended:true}`. Manager without a google_user_id → refuse
  `manager_has_no_google_account`. Each Google call logged. keep needs a future date + reason.
- **Remove the other exit paths:** `createEmployee`/`updateEmployee` refuse `status='exited'` and any `date_exited`
  change (`use_exit_flow`); Directory-sync import refuses the `exit` list (`exits_are_recorded_in_podium`); its
  preview's "suspended in Google / not in Google but active in Podium" items become `exit_started_outside_podium`
  alerts (never auto-exit).
- Register actions; none self-serve except getExit (self-scoped) and startExit (self-scoped).

## App (`apps/podium`)

- `/people/detail` (employee page): an **Exit** panel — "Start exit" (HR/manager chain) or "Resign" (self) modal
  (reason, notice date, LWD prefilled = notice + default, HR override + reason, HR-only rehire toggle); when open:
  header (reason, LWD, days left), checklist grouped by owner with Done / N/A (+ note) per line, live asset / Docket /
  payment-request lists under their lines, HR buttons Close exit (disabled with the blocker list until clear) and
  Cancel exit. Status badge "On notice" wherever the employee shows (StatusBadge) when an open exit exists.
- New `/exits` page (HR; nav under People): Open exits board · Google accounts to action (overdue first, with the
  three actions for Google admins) · Backfill review (old note shown, pick reason code, confirm LWD).
- `/admin/exit-checklist` (HR/admin): edit template lines (title, owner, required, allow_na, active, sort) and the
  tools list. No code change needed to change the checklist.
- Remove the manual "exited" option from the employee edit form (status select) — point to the Exit panel.

## Tests / done

`test/exits.test.mjs`: default LWD + override rule · who may start / tick / close / cancel · item resolution
(required/na/allow_na) · snapshot filtering by applies_to + tools · blocker computation · Google item due logic
(kept past keep_until = open) · SQL-text checks on 0010 (service_role only, partial unique, RPC raises). Existing
tests green; `node --check`; `npx turbo build --filter=podium` zero errors. No real names/salaries in fixtures.
