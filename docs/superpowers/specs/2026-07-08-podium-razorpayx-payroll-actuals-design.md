# Podium ← RazorpayX Payroll — actuals feed (design)

> **REVISION (S200, post-probe — this supersedes §3/§5/§6 below where they conflict).**
> The live probe disproved the assumptions this spec was written on. Actual API reality:
> (1) **No bulk/list/profile endpoint** — the only working read is per-employee `view-payroll`.
> (2) The payslip has **no email, no payroll-id, no disbursal date** — only `employee-id`,
> `employee-name`, `salary`, `additions`, `arrears`, `deductions`, `deductible_benefits.PF`.
> (3) **Gross = `salary` + Σ`additions` + `arrears`** (there is no single gross field).
> (4) Employee-ids are **sequential**; the API is **rate-limited** (429 under load).
> So the shipped design is: enumeration = a **cursored sequential id-scan**
> (`getRazorpayxPayrollScan`, ≤40 ids/call, client follows `next_start` until a trailing-miss
> stop / id cap / rate-limit backoff); matching = **RazorpayX `employee-name` → Podium
> `full_name`** (persisted-id first, else unique normalized-name; unmatched → manual dropdown;
> id persisted on confirm) — NOT email. Everything else (comp gate, audit, one gross `fixed`
> row/employee-month superseding via the unique index, Fraternitas-only, `/admin/payouts` modal)
> is as written. Current truth: [[systems/podium]] + reference/integrations.md.



> Status: design, awaiting review → writing-plans
> Date: 2026-07-08 (Session 200)
> System: Podium (People & Performance OS) · worker `podiumops` · schema `podium`
> Related: [[project_podium_salary_vault]] · RULE-PODIUM-002 (comp allow-list) · RULE-PODIUM-007 (Google Directory sync — the pattern this mirrors) · `2026-07-06-podium-payouts-ledger-design.md` (the `payouts` actuals ledger this feeds)

## 1. Goal & scope

Wire the **RazorpayX Payroll (Opfin)** API into Podium so that each month's **actual salary
disbursements** flow into the `podium.payouts` actuals ledger (`source='razorpayx'`), matched
per-employee. This is the "real-salary / actuals feed" that has been the pending Phase-5
follow-on since the salary vault shipped (S195). It makes the S196 Analytics **plan-vs-actual**
payroll trend real instead of empty, and gives Odo an accurate SG&A people-cost source.

**In scope (v1):**
- Read-only pull of finalized monthly payroll (gross earnings per employee) → `podium.payouts`.
- On-demand, human-gated, review-and-confirm ingestion (no silent writer, no cron).
- Employee matching (RazorpayX ↔ Podium) with an unmatched review surface.

**Out of scope (future — the API scopes exist but are deliberately deferred):**
- Reimbursement-request view.
- Live payroll/CTC detail rendered on employee profiles.
- Any **write-back** to RazorpayX (no write scopes are enabled; integration only pulls).
- Component/bonus line-splitting (v1 stores one gross row per employee-month).

## 2. Entity model — Fraternitas only

LOT's two `employees.legal_entity` values are **not** two payroll orgs:

- **Fraternitas** — the only internal-payroll entity; all white-collar LOT staff. This is the
  **single RazorpayX Payroll account** (one API ID/key). This feed = Fraternitas.
- **Silverton** — a third-party holding/vendor for **blue-collar contract labour**. Paid as a
  **bulk vendor payout** (`payouts` Option-A: `payee_type=vendor`, `payout_type=contract_labour`)
  and/or `podium.factory_pay` COGS. **Not** on RazorpayX; **excluded** from this feed.

Consequence: RazorpayX's employee roster will match only the white-collar Podium set. Blue-collar/
contract people won't appear in RazorpayX and are not expected to. See
[[reference_legal_entities_silverton_fraternitas]].

Cost separation preserved: white-collar (Fraternitas) → per-person `payouts` → **SG&A**;
blue-collar contract (Silverton) → bulk vendor rows / `factory_pay` → **COGS**.

## 3. API facts (verified against live docs, 2026-07-08)

- **Base URL:** `https://payroll.razorpay.com/api/payroll` (production).
- **Auth is in the JSON body, not a header.** Every request is a POST of:
  ```json
  { "auth": { "id": "<API_ID>", "key": "<API_KEY>" },
    "request": { "type": "<type>", "sub-type": "<sub-type>" },
    "data": { ... } }
  ```
- **`view-payroll`** is **per-employee-per-month**: `request:{type:"payroll", sub-type:"view-payroll"}`,
  `data:{ "employee-id": <int>, "payroll-month": "YYYY-MM" }`. **No bulk payroll endpoint — you loop
  per employee.**
- **Employee list** (bulk) provides RazorpayX employee id + email + name for the mapping.
- Sandbox base (testing only): `https://opfin.np.razorpay.in`.

**Probe-first field resolution.** The exact per-field names in the `view-payroll` response are
confirmed by ONE live probe call during implementation (creds available), before wiring the parser.
`amount` = **gross monthly earnings**; if the response cleanly exposes only net + a deductions
breakdown, reconstruct `gross = net + employee-side deductions`. This is the one field-mapping
decision deferred to the probe; everything else is fixed here.

## 4. Secrets & client helper (podiumops)

- New secrets on `podiumops`: `RAZORPAYX_PAYROLL_ID`, `RAZORPAYX_PAYROLL_KEY`
  (`cd 05_Throttle/podiumops-worker && npx wrangler secret put <NAME>`).
- Helper `razorpayxCall(env, type, subType, data)` — POSTs the `{auth,request,data}` envelope,
  parses JSON, surfaces the API error message on non-2xx. **Graceful-when-unconfigured:** if either
  secret is absent, the sync actions return `razorpayx_not_configured` and nothing breaks (same
  posture as the Google SA — RULE-PODIUM-007).

## 5. Employee matching (the mapping backbone)

- **New column** `podium.employees.razorpayx_employee_id text` (nullable) + partial-unique index
  `WHERE razorpayx_employee_id IS NOT NULL`. Migration `podium_employee_razorpayx_id_v1`.
- **Match key = `work_email`** (case-insensitive). On first successful match the RazorpayX id is
  persisted onto the Podium row, so later syncs resolve directly (no re-matching by email).
- **Unmatched, both directions, surfaced not guessed** (review-and-confirm):
  - RazorpayX employee with no Podium `work_email` match → shown as **unmatched (RazorpayX side)**,
    excluded from the write. (Consistent with "never auto-create a Podium employee" —
    [[feedback_podium_employee_via_email_only]].)
  - Podium (Fraternitas, active) employee with no RazorpayX match for the month → shown as
    **no payroll data**, informational.

## 6. The 50-subrequest constraint → cursored preview

`view-payroll` is 1 subrequest/employee; ~52 white-collar > the Worker's 50-subrequest ceiling. So
the preview is **chunked across calls**:

- `getRazorpayxPayrollPreview(month, cursor)` — resolves the matched-employee list once (cached via
  the persisted ids + one employee-list call), then fetches `view-payroll` for **≤40 employees per
  call**, returning `{ rows:[...], next_cursor|null, unmatched:{...} }`. Reads to Postgres are
  batched (`in.()`), never per-row awaits (50-subrequest RULE).
- The frontend calls it repeatedly, accumulating `rows` client-side into one preview table, until
  `next_cursor` is null.
- `applyRazorpayxPayouts(month, rows)` — a single write action that upserts the confirmed rows.

## 7. What gets written

For each matched employee-month, **upsert one `podium.payouts` row**:

| field | value |
|---|---|
| `employee_id` | matched Podium employee |
| `payout_type` | `fixed` |
| `period_type` | `monthly` |
| `period_key` | `YYYY-MM` |
| `amount` | **gross monthly earnings** |
| `source` | `razorpayx` |
| `paid_on` | payroll disbursal date for the month |
| `source_ref` | **NEW nullable col** = RazorpayX payroll/payslip id (idempotency + audit) |

- Existing `UNIQUE(employee_id, payout_type, period_key)` → a RazorpayX sync **supersedes** any
  autogen'd (`generateFixedPayouts`) or manual row for that month. Once synced, RazorpayX is the
  truth for that person-month.
- Re-running a month is a safe re-upsert (same key). `source_ref` lets us detect/refresh.
- Migration `podium_payouts_source_ref_v1` adds `source_ref text` (nullable) to `payouts`.
- v1 = one gross row per person-month (gross already includes that month's additions/bonus
  processed by RazorpayX). Component/bonus splitting is deferred (§1 out-of-scope).

## 8. Permissions — comp-gated + audited

This reads everyone's pay, so it sits behind the salary vault gate, not general HR:

- Both `getRazorpayxPayrollPreview` and `applyRazorpayxPayouts` require **`canComp`** (the
  `podium.comp_access` allow-list — RULE-PODIUM-002; not admin/hr).
- Every preview call writes an append-only **`podium.comp_access_log`** row (cross-person comp
  read), consistent with `getCompensation`/`getFactoryWorkforce`/`getAnalyticsComp`.
- The trigger UI renders only for allow-list members (`brandUser.tier.comp`).

## 9. Frontend

Extend the existing **`/admin/payouts`** page (the actuals-ledger entry screen) with a **"Sync from
RazorpayX"** action:

- Month picker (defaults to last completed payroll month).
- Progress-through-chunks preview modal: a matched-rows table (employee · gross · will-supersede
  flag) + an unmatched/no-data section. Modeled on `components/DirectorySyncModal.js`.
- **Confirm** → `applyRazorpayxPayouts` → success summary (n written, n superseded, n unmatched).
- Comp-gated visibility; graceful `razorpayx_not_configured` empty state until secrets are set.

## 10. Worker actions (podiumops) — summary

- GET `getRazorpayxPayrollPreview` (comp; `{month, cursor}`; chunked; audited) — read-only, writes
  nothing to `payouts`.
- POST `applyRazorpayxPayouts` (comp; `{month, rows}`) — the only writer; upserts `payouts` +
  persists any newly-resolved `razorpayx_employee_id`.
- Helper `razorpayxCall`; graceful-until-creds.

## 11. Migrations

1. `podium_employee_razorpayx_id_v1` — `employees.razorpayx_employee_id text` + partial-unique index.
2. `podium_payouts_source_ref_v1` — `payouts.source_ref text` (nullable).

Both additive, RLS unchanged (tables already service_role-only).

## 12. Rollout / safety

- Set the two secrets → probe call to confirm `view-payroll` field names → wire the parser.
- First real run: pick a recent completed month, review the preview, confirm; verify the
  Analytics plan-vs-actual trend fills for that month.
- No cron, no auto-write. Idempotent re-sync. `source_ref` + the UNIQUE key make re-runs safe.

## 13. Open (resolved-at-implementation, not blocking)

- Exact `view-payroll` gross field name / gross-reconstruction — resolved on the probe call (§3).
- Whether the employee-list endpoint returns enough (id+email) in one call or needs pagination —
  confirmed on the probe; if paginated, the list fetch also respects the subrequest budget.
