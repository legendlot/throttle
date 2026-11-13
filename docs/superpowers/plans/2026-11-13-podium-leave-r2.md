# Podium Leave R2 — LOP report, exit leave fill, maternity / paternity, WFH, year-end preview — plan

> Spec: `docs/superpowers/specs/2026-11-13-podium-leave-scope.md` (L1–L10). R1 plan: `2026-11-13-podium-leave-r1.md`
> (D1–D15 stand; this plan only adds). Afshaan 2026-11-13: "Yes, start R2", LOP report first.
> No cron, `wrangler.toml` untouched. Migration `0020_leave_r2.sql` (`podium_leave_r2_v1`).
> RazorpayX: its API has NO write for leave/LOP (reference/integrations.md: the only working call is view-payroll),
> so payroll gets a report + CSV that HR enters by hand. No push.

## Decisions

- **E1 LOP report (payroll, HR).** GET `getLeaveLopReport {month: YYYY-MM}` (isHr). One row per employee with any
  unpaid day in that month: employee code, name, `razorpayx_employee_id`, LOP days (0.5 steps), and the dates.
  LOP comes only from **approved PL/SL requests' `lop_days`** (D7: beyond balance + borrow cap). Exit-time negative
  balances are NOT here (they are E2's F&F figure).
  - **Which dates are unpaid (pure `lopAllocation`):** a request uses balance first, then borrow, then LOP — in date
    order. So the LOP days are the **last** working halves of the request: list the request's working halves
    (Mon–Fri minus fixed holidays, honouring start/end halves, `countLeaveDays` rules), take the last `lop_days × 2`
    halves, group by month. If today's holiday list gives fewer halves than the frozen `days` (a holiday added after
    submit), allocate over the halves that exist and flag the row `recount_mismatch` for HR.
  - The report also lists **pending requests touching the month** (count + who) as a warning: "decide these before
    running payroll".
  - **Exports (late-change tracking):** POST `markLopExported {month}` (isHr) stores the current rows as a snapshot in
    `podium.leave_lop_exports` (month, rows jsonb, exported_by, exported_at; a new row each time). The report shows
    the last export's time and **what changed since** (per person: was X, now Y), so a cancel or a late approval after
    payroll is carried into next month by HR, not lost. CSV download is client-side (code, RazorpayX id, name, LOP
    days, dates).
  - UI: `/admin/leave` gets a "Payroll — unpaid days" section: month picker (default: this month; per memory, range
    pickers default to today's period), table, Download CSV, Mark exported.
- **E2 Exit leave fill (X1).** The exit checklist line `leave_balance` gets `auto_source = 'leave_ledger'` (new
  AUTO_SOURCES value; template line + any OPEN exit's open item updated in 0020). Live figure on the exit page
  (HR + the exit's viewers who already see the checklist): PL and SL balance **as at the last working day** =
  ledger balance + the accruals still to land up to and including the LWD month (earningMonths rules: the exit
  month earns, nothing after) − nothing else (approved leave is already a `taken` row).
  - Negative PL / SL = **LOP days for the F&F** (`leave_lop_days` = −min(PL,0) + −min(SL,0)). SL is shown but marked
    "not paid out" (lapses). PL positive is shown as "PL balance at exit" (encashment is Finance's call, not computed).
  - Ticking the line **done** (HR) is refused `leave_after_lwd` while the person has a pending or approved request
    ending after the LWD (cancel it first), and `leave_pending` while any request is pending. On done, the worker writes
    the snapshot to `employee_exits`: `leave_pl_balance`, `leave_sl_balance`, `leave_lop_days`, `leave_confirmed_at`,
    `leave_confirmed_by` (new nullable columns). Re-opening the line clears them.
- **E3 Maternity / paternity (HR grants).** New types `MATERNITY`, `PATERNITY` in `leave_requests` — no ledger, not
  accrued, not borrowable, never LOP. POST `grantLeave {employee_id, leave_type, start_date, note}` (isHr, never for
  yourself — `no_self_approval`). Inserted **approved** in one RPC `podium.leave_grant` (lock, covered, overlap,
  decided_* = the HR caller, event `granted`), email the person (best effort, D12 rules).
  - MATERNITY: **182 calendar days** (26 weeks, L9) from start; `days` = 182; gender must be `f`. A note is required
    (the eligibility check — 80 days worked in the prior 12 months — is HR's, recorded in the note).
  - PATERNITY: **15 working days** (Mon–Fri minus fixed holidays) from start; gender must be `m`. ⚠️ Default chosen
    here (the policy says "15 days"); calendar days would be a one-line change.
  - Gender null → `gender_unknown` ("Fill the person's gender first"). Both may cross 31 Dec (the crosses-year check
    is relaxed for these two types only); `days` cap 182 for MATERNITY, 60 for the rest.
  - Ending early / correcting: HR cancels (existing `leave_cancel`, no ledger) and grants again.
- **E4 Work from home.** Type `WFH` in `leave_requests`: applied by the person like leave (`applyLeave`), counted in
  working days (same day count, half days allowed), **no ledger, no balance, no LOP**, never on the LOP report or in
  F&F. Approver snapshot at submit = the **skip-level** manager (manager's manager); no skip-level → the manager; no
  manager → HR (null). ⚠️ Default per the spec ("needs the skip-level manager's approval"). Who may decide: as D9
  (approver, approver's manager, HR, never self). Notice: start ≥ today − 7 (as SL). Overlap with any open leave/WFH is
  refused (existing check). Calendar shows it as "WFH", not "out". Label "Work from home".
- **E5 Year-end preview (HR).** `/admin/leave` section "Year end" (shown from 1 Nov to 31 Jan): per covered person,
  projected 31 Dec PL / SL = ledger balance + the year's remaining accruals − pending PL/SL days in this year →
  PL carries min(PL, 5) (negative carries as is), PL lapse, SL lapse. Pure `yearEndPreview`, read only; the real
  close stays the lazy R1 one.
- **E6 Manual.** One Podium manual chapter "Leave" covering R1 + R2 (apply, approve, balances, borrow/LOP, holidays,
  HR tools, payroll report, exits, maternity/paternity, WFH), by `manual-builder` after the build.

## Build

1. `migrations/0020_leave_r2.sql`: leave_requests type CHECK + MATERNITY/PATERNITY/WFH; days cap (182 for
   MATERNITY); crosses-year relaxed for MATERNITY/PATERNITY; ledger-free types keep borrowed/lop = 0 (existing check
   already covers non-PL/SL); `leave_grant` RPC; `leave_lop_exports` (RLS on, service_role only); `employee_exits`
   leave_* columns; exit auto_source CHECK + `leave_ledger`; template line + open items updated. Verify that
   `leave_decide` / `leave_cancel` (0016/0017 live versions) write ledger rows only for PL/SL — WFH approve/cancel must
   not touch the ledger.
2. `src/leave.js` (pure) + tests: `lopAllocation`, `lopReport` rows/diff, `exitLeaveFigures`, `grantPlan`
   (end date / days per type), `wfhApprover`, `yearEndPreview`, labels, validateLeaveInput for WFH.
3. `src/index.js`: handlers + routing (`getLeaveLopReport`, `markLopExported`, `grantLeave`, exit live source +
   done-guard + snapshot, WFH in applyLeave/previewLeave, approver for WFH, getAdmin year-end); `src/exits.js`
   AUTO_SOURCES + autoStatus for `leave_ledger`.
4. App: `/admin/leave` payroll + year-end + grant sections; `/leave` apply form gets WFH (with "approved by <skip-level>")
   and shows MATERNITY/PATERNITY rows; team calendar label WFH; exit page live leave figures.
5. Tests green, hostile review + Codex, apply migration, deploy, smoke on a synthetic covered employee, manual.
