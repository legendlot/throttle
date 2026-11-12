# Podium — Leave management — scope v1

> 2026-11-13 · Afshaan: "Podium owns it" — leave moves from RazorpayX into Podium. Policy source:
> Google Doc "LOT Leave Policy 2026" (`1yXpxGHA8SZpXUZzsdjMpngNZvtriWjjmSkoLy1DeKYU`) + sheet "LOT List of
> Holidays -2026" (`12vnYx9SYPdUDGXktNjBih-eGeWIy-Zuo0ja0lo_I8YI`). Size: R1 ≈ 1 build day, R2 ≈ 1–2.

## Goal

Every leave day of a covered employee is applied for, approved and counted in Podium; the balance anyone
sees is computed from one ledger, never typed; payroll gets the unpaid days it needs without anyone
re-deriving them.

## Decided by Afshaan (2026-11-13)

| # | Decision |
|---|---|
| L1 | **Podium owns leave.** RazorpayX stops being where people apply. Payroll still runs on RazorpayX. |
| L2 | **Who:** Fraternitas staff only (white-collar, on RazorpayX payroll). Silverton floor staff stay on Redline attendance's `day_status = leave`. |
| L3 | **Joiners:** joined on or before the 15th → that month's full 1.5 PL + 1 SL; after the 15th → nothing that month. |
| L4 | **Leave beyond the balance** (the policy's "email approval from your manager" case) is approved **in Podium** and is **borrowed ahead**: the balance goes negative and later monthly accruals pay it back first. |
| L5 | **Starting balances:** Afshaan gives them by hand once R1 is built; HR enters them as opening-balance rows. |

## The policy, as rules

- **PL** 18/yr = 1.5 credited per month · **SL** 12/yr = 1 per month · calendar year (Jan–Dec).
- **Year end:** up to 5 PL carry over; the rest lapses. **SL does not carry** (the policy names PL only) — confirm.
- **Period leave:** 1 per month, women only, does not accumulate (unused at month end is gone).
- **Maternity:** 26 weeks (policy text says 180 days; the Act says 26 weeks = 182) — granted by HR, not accrued.
  Eligibility per the Maternity Benefit Act (80 days worked in the 12 months before) is HR's check, recorded.
- **Paternity:** 15 days, granted by HR, not accrued.
- **Holidays:** the 10 fixed 2026 holidays + **one optional holiday per person per year** from the optional list.
- **WFH:** not leave and not counted; needs the **skip-level** manager's approval (today by email).

## Defaults I will build unless told otherwise (cheap to change before R1)

| Topic | Default |
|---|---|
| When accrual lands | On the **1st of each month** (so the month's leave is usable that month). |
| Half days | Allowed (first half / second half); balances move in 0.5s. |
| Sandwich rule | **None** — only working days in the range count; weekends and holidays inside it are free. |
| Work week | **Mon–Fri.** ⚠️ Confirm — if Saturday is a working day, every count changes. |
| Borrow cap (L4) | You may borrow up to what you will still earn by 31 Dec. Beyond the cap = **unpaid (LOP)**, still needs manager approval. A negative PL balance at year end carries into next year. A negative balance at exit = LOP in F&F. |
| Notice | PL: apply before the start date (HR can record a past PL). SL: may be applied up to 7 days after. |
| Approver | Reporting manager; the manager's manager can also decide (cover for an absent manager — no cron needed). A founder's own leave: the other founder. |
| Cancel | Before it starts: the employee withdraws. After approval: the employee asks, the approver confirms; days return to the balance. |
| SL reason | Optional free text, visible to the approver + HR only. **No medical documents in R1** (health data, DPDP). |
| Interns | **Covered?** ⚠️ Confirm — 5 interns are on RazorpayX. Default: same policy. |

## Data model (hard to change later)

- **`podium.leave_ledger`** — the only source of a balance. One row per credit or debit:
  `employee_id, leave_type, delta numeric(5,1), kind (opening | accrual | taken | cancelled | carry_over | lapse | adjustment | grant), period (YYYY-MM or YYYY), request_id, note, created_by`.
  Balance = Σ delta. Accrual rows are written **lazily and idempotently** (unique on employee × type × month)
  the first time anything reads that person's balance in a month → **no cron**. Year-end carry-over / lapse
  rows likewise on the first read in January.
- **`podium.leave_requests`** — `employee_id, leave_type, start_date, end_date, start_half, end_half, days
  (frozen at submit), borrowed_days, lop_days, status (pending | approved | rejected | withdrawn | cancelled),
  approver_employee_id, decided_by, decided_at, reason, decision_note`.
  `days` is counted once (work week + holidays at that moment) and frozen.
- **`podium.holidays`** — `date, name, kind (fixed | optional), year`. 2026 seeded from the sheet; **2027 must be
  given before January.**
- **`podium.leave_types`** — `PL, SL, PERIOD, MATERNITY, PATERNITY, OPTIONAL_HOLIDAY, LOP` with accrual / carry /
  eligibility config, so a policy change is a row change, not code.
- **Coverage:** `employees.leave_policy` (null = not covered). Seeded `fraternitas` for everyone with a
  `razorpayx_employee_id` (56 of 64 active today); HR flips the rest.

## Data gaps found today (2026-11-13)

- `employees.legal_entity` is **NULL for all 64** active people → coverage uses the RazorpayX link instead (above).
- `employees.gender` is **NULL for 41 of 64** → period / maternity / paternity eligibility is unknown for them.
  HR fills gender (J2 profile completion asks it) before R1 goes live, or those people simply don't see period leave.

## R1 — apply, approve, balances (≈ 1 build day)

- Leave page: my balances (PL / SL / period / optional holiday), apply (range + half days + type), live day
  count, shows "this borrows N days" / "N days unpaid" before submit; my requests; withdraw.
- Manager inbox: pending requests from the team, approve / reject with a note; team calendar "who's out" (week / month).
- HR: opening balances (L5), adjustments with a reason, holiday calendar edit, any person's ledger.
- Email: request → approver; decision → employee (the existing Gmail sender, like O1/O2).
- Dashboard tile: "N leave requests waiting for you".
- `employees.status` stays HR-set; leave does not flip anyone to `on_leave` automatically.

## R2 — year end, payroll, exits (≈ 1–2 build days)

- Year-end carry-over / lapse (lazy, no cron) + an HR preview of who carries what before 1 Jan.
- Maternity / paternity grants by HR (eligibility note, dates, auto-count).
- **Payroll:** monthly unpaid-days (LOP) report per person for HR to enter in RazorpayX. A direct push only if
  RazorpayX's API (Settings → API in its dashboard; the public docs give no schema) accepts leave/LOP.
- X1 exits: "Leave balance confirmed" fills from the ledger at the last working day (negative = LOP).
- WFH requests routed to the skip-level manager (not counted against leave).
- Manual chapter.

## Needs a cron (wrangler.toml go) — not in R1/R2

Reminders ("request waiting 2 days"), month-start balance emails, a 1 Dec "use or lose your PL" nudge.

## Open questions for Afshaan

1. Work week — Mon–Fri, or is Saturday a working day?
2. Interns covered by the same policy?
3. SL lapses at year end (the policy only carries PL) — confirm.
4. Maternity: 180 days as written, or 26 weeks (182) as the Act says?
5. Holiday sheet: Independence Day, Diwali and Kannada Rajyotsava fall on a weekend in 2026 — no substitute day?
   The sheet's weekday labels are wrong for 1 May (Fri), 15 Aug (Sat), 2 Oct (Fri). 2027 list needed by December.
