# Podium Leave R1 — apply, approve, balances, holidays — plan

> Spec: `docs/superpowers/specs/2026-11-13-podium-leave-scope.md` (L1–L10, all settled 2026-11-13).
> R1 = everything a person needs to apply and a manager to approve, with balances computed from a ledger.
> Moved INTO R1 from R2 (cheap, and it must exist before 1 Jan 2027): the lazy year-end carry-over / lapse.
> Still R2: maternity / paternity grants, LOP payroll report, X1 F&F fill, WFH, manual chapter.
> No cron, `wrangler.toml` untouched. Migration `0016_leave.sql` (`podium_leave_v1`).

## Decisions

- **D1 Coverage.** New `employees.leave_policy text` (null = not covered; check in (`fraternitas`)).
  Seed: `fraternitas` for every non-exited employee with a `razorpayx_employee_id` (56 today, interns
  included — L7). HR flips it on the person's edit form (EmployeeForm, HR-only field). A person who is not
  covered sees no Leave page; nothing else changes.
- **D2 Types (constants in `src/leave.js`, not a table in R1).**
  `PL` (accrues 1.5/month, borrowable, carry ≤ 5), `SL` (1/month, borrowable, lapses fully at year end —
  L8), `PERIOD` (gender = 'f' only, 1 per calendar month, not accrued, not borrowable, max 1 day per
  request, half day allowed), `OPTIONAL_HOLIDAY` (1 per calendar year, must be exactly one date that is a
  `kind='optional'` holiday, full day only). Maternity / paternity / LOP-as-a-type are R2.
- **D3 Ledger = the only balance.** `podium.leave_ledger` (id, employee_id, leave_type ∈ PL|SL, delta
  numeric(5,1) ≠ 0, kind ∈ opening|accrual|taken|cancelled|carry_over|lapse|adjustment, period text
  (YYYY-MM for accrual, YYYY for carry/lapse, null otherwise), effective_date date, request_id uuid null,
  note text, created_by uuid, created_at). Balance(type) = Σ delta over all rows. Unique (partial):
  (employee_id, leave_type, kind, period) where kind in (accrual, carry_over, lapse);
  (employee_id, leave_type) where kind = opening. PERIOD and OPTIONAL_HOLIDAY have no ledger: their
  availability = 1 − (pending + approved requests of that type in that month / year).
- **D4 Accrual (lazy, idempotent).** `leave_settings` row (singleton): `cutover_month` (default `2026-12`).
  Months that earn = from max(cutover_month, join month) through the current IST month; the join month earns
  only if the day of `date_joined` ≤ 15 (L3); none after the month of `date_exited`; none while
  `leave_policy` is null. Credited on the 1st (the current month's credit exists from the 1st). Writer:
  `ensureLeaveCurrent(env, employeeIds)` → computes missing accrual rows (pure `accrualPlan`) and inserts with
  `on_conflict … ignore-duplicates` (Prefer: resolution=ignore-duplicates). Called before any balance read
  (getMyLeave, getTeamLeave, applyLeave, decideLeave, HR ledger view). Batched: one select of existing
  accrual/carry rows for the ids, one insert.
- **D5 Year end (lazy, idempotent).** In `ensureLeaveCurrent`, for each completed calendar year Y ≥ cutover
  year that has no carry/lapse row yet: closing(type) = Σ delta with effective_date ≤ Y-12-31.
  PL: closing > 5 → `lapse` −(closing−5) dated Y-12-31. SL: closing > 0 → `lapse` −closing. A negative
  closing carries as is (no row). Write a zero-information marker? No — use the unique key with a
  `carry_over` row of delta… delta must be ≠ 0, so the marker is a row in `leave_year_closes`
  (employee_id, year, closed_at) PK (employee_id, year). Close once; late changes to a closed year are an HR
  adjustment.
- **D6 Day count (pure `countLeaveDays`).** Mon–Fri (L6) minus `kind='fixed'` holidays in the range; a
  weekend holiday changes nothing (L10). Half days: `start_half` ∈ full|second, `end_half` ∈ full|first
  (single day: full|first|second). Result in 0.5 steps; 0 → refuse `no_working_days`. A request may not cross
  31 Dec (`crosses_year` — apply twice). Max 60 working days per request (R1 sanity cap).
- **D7 Split: balance → borrow → LOP (pure `splitLeave`).** For PL/SL: available = Σ ledger − Σ days of the
  person's other **pending** requests of that type. cap = accruals still to come in the leave's calendar
  year after the current IST month (rate × months; for a next-year request: rate × 12) (L4 default).
  The request's days come first from max(available, 0), then are **borrowed** while the balance stays ≥ −cap,
  the rest is **lop_days** (unpaid; not debited from the balance). Stored on the request at submit
  (`borrowed_days`, `lop_days`) and **recomputed at decision**: the approver sends the split they saw
  (`expected_split`); a different split → 409 `balance_changed` (UI reloads).
- **D8 Requests.** `podium.leave_requests` (id, employee_id, leave_type, start_date, end_date, start_half,
  end_half, days numeric(5,1) > 0, borrowed_days ≥ 0, lop_days ≥ 0, status pending|approved|rejected|
  withdrawn|cancelled, reason text ≤ 500, approver_employee_id, decided_by uuid, decided_by_employee_id,
  decided_at, decision_note, cancelled_by, cancelled_at, created_at, updated_at). DB check:
  decided_by_employee_id is null or ≠ employee_id. No overlap: a person may not have two pending/approved
  requests on overlapping dates (any type) — checked in the RPC under a per-employee advisory lock.
  Notice: PL / PERIOD / OPTIONAL_HOLIDAY start ≥ today (IST); SL start ≥ today − 7. HR may record any past
  request for someone else (`applyLeave` with `employee_id` by isHr) — it still needs the approver.
- **D9 Approver.** At submit: the person's `manager_id`; no manager → the other founder (loadFounders) if the
  person is a founder, else null (HR decides). Who may decide: the snapshotted approver, that approver's own
  manager (cover), or isHr — never the person themself. Approve → in one RPC `podium.leave_decide`:
  status guard (pending), ledger `taken` row −(days − lop_days) for PL/SL dated start_date, request updated.
  Reject needs a note.
- **D10 Withdraw / cancel.** Pending → the person withdraws (`withdrawLeave`). Approved and start_date >
  today → the person cancels; approved and started → only the approver / their manager / HR cancels. Cancel
  writes a `cancelled` ledger row +(days − lop_days) in the same RPC `podium.leave_cancel`.
- **D11 Visibility.** Own: everything. Approver chain (descendantsOf the caller) + HR: requests, balances,
  reason. **Team calendar** ("Who's out", managers for their subtree + HR): name + dates + half-day marks;
  the type shows as "Leave" — never PERIOD / SL to anyone but the person, their approver chain and HR (it
  is the chain's own view, so types ARE shown there; the generic label is for any future wider view).
  Gender is read only to offer PERIOD to the person themself.
- **D12 Email (best effort, never fails the action).** Submit → approver; decision / cancel by someone else →
  the person. Sent with the existing `gmailSend` from the **caller's own work mailbox** (as O2's
  remindPanelist). Body: name, type label (PL → "Privilege leave", SL → "Sick leave", PERIOD → "Leave",
  OPTIONAL_HOLIDAY → "Optional holiday"), dates, day count, link `/leave`. **Never** the reason or a
  borrowed/LOP figure. Response carries `email: sent|failed|skipped`.
- **D13 Holidays.** `podium.holidays` (date PK, name, kind fixed|optional). Seed 2026: fixed 1 Jan, 26 Jan,
  20 Mar, 1 May, 15 Aug, 14 Sep, 2 Oct, 1 Nov, 7 Nov, 25 Dec; optional 14 Jan, 4 Mar, 31 Mar, 3 Apr, 28 May,
  26 Jun, 20 Oct, 9 Nov, 24 Dec. HR edits (add / rename / delete a future one; a holiday inside an approved
  request does not recount it — R1 limitation, shown as a warning to HR).
- **D14 HR tools.** `/admin/leave` (isHr): settings (cutover month), holidays, **opening balances** (per
  person, PL + SL, once each — L5; a second entry = an adjustment), adjustments ± with a required note, any
  covered person's ledger. Every HR write is logged in `application_events`? No — in a new
  `leave_events` (id, employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail jsonb,
  created_at) used for requests too.
- **D15 Nav + getMe.** getMe adds `podium_leave_access` (covered OR has direct reports OR isHr) and
  `podium_leave_pending` (count of pending requests the caller may decide). Nav: PEOPLE → "Leave"
  (`/leave`, CalendarDays icon, badge = pending count); ADMIN → "Leave Settings" (`/admin/leave`, podium_hr).
  Dashboard: tile "N leave requests waiting for you" when > 0.

## Worker API (podiumops, POST `{action, …}`; GET `?action=`)

| Action | Who | Does |
|---|---|---|
| GET `getMyLeave` | covered self | balances {PL,SL: {balance, available, cap}, PERIOD: {used_this_month}, OPTIONAL_HOLIDAY: {used_this_year}}, my requests (this year + future), holidays for this + next year, `can_period` |
| POST `previewLeave` {leave_type, start_date, end_date, start_half, end_half, employee_id?} | self / HR | days + split + refusal code, no write |
| POST `applyLeave` {…same, reason} | self / HR for others | RPC `podium.leave_apply` → request pending + event; email approver |
| GET `getTeamLeave` {from, to} | chain / HR | pending requests to decide (with split + balances), the team's approved / pending in range, team balances |
| POST `decideLeave` {id, decision, note, expected_split} | D9 | RPC `podium.leave_decide`; email the person |
| POST `withdrawLeave` {id} / `cancelLeave` {id, note} | D10 | RPC `podium.leave_cancel` |
| GET `getLeaveAdmin` | HR | settings, holidays, covered people with balances + whether opening set |
| POST `setLeaveSettings` / `saveHoliday` / `deleteHoliday` / `setOpeningBalance` / `adjustLeave` | HR | as D13/D14 |
| GET `getLeaveLedger` {employee_id} | self / chain / HR | rows newest first |

Errors use `errCode(code, message, status)` with codes: `not_covered`, `no_working_days`, `crosses_year`,
`overlap`, `notice`, `period_not_eligible`, `period_used`, `optional_used`, `not_optional_holiday`,
`too_long`, `balance_changed`, `not_pending`, `no_self_approval`, `forbidden`, `opening_exists`.

## Build

1. `migrations/0016_leave.sql` — tables above (RLS on, no policies, `grant all … to service_role`), checks,
   indexes, `employees.leave_policy` + seed, holidays seed, `leave_settings` singleton, RPCs
   `leave_apply` / `leave_decide` / `leave_cancel` (security definer, search_path podium, advisory lock per
   employee, status guards, ledger writes). Authorization stays in the worker.
2. `src/leave.js` (pure) + `test/leave.test.mjs`: `countLeaveDays`, `accrualPlan` (15th rule, cutover, exit,
   no policy), `yearClosePlan`, `splitLeave` (+ cap), `validateLeaveInput`, type labels. Edge tests: half days,
   weekend / holiday inside, single half day, Dec 31 crossing, join on 15th vs 16th, exit mid-month, negative
   carry, cap exhaustion → LOP, PERIOD twice in a month, optional holiday on a non-optional date.
3. `index.js` handlers + routing lists + getMe flags; `test/leave.sql` (transaction, rolled back): RPC guards
   (double approve, self-approval constraint, overlap under the lock, cancel restores).
4. App: `src/lib/leave.js` (fetchers + labels), `components/LeaveBits.js`, pages `(auth)/leave/page.js`
   (my balances + apply form with live preview + my requests; manager section: pending to decide + who's out
   calendar) and `(auth)/admin/leave/page.js`; nav items; dashboard tile; EmployeeForm HR field
   `leave_policy`.
5. Hostile review + Codex, apply migration, deploy, smoke (synthetic covered employee), manual chapter later (R2).
