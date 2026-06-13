# Attendance & Shifts Redesign — Design Spec

> Status: **DESIGN LOCKED 2026-06-13** (Afshaan). Not yet built. Execute in two phases (see end).
> Systems touched: lotopsproxy (`01_worker/worker.js`), Scanner (`02_scanner/index.html`),
> Redline + Garage (`05_Throttle/apps/{redline,garage}`), Supabase `public` schema.
> Supersedes/extends RULE-ATT-001.

## 1. Why

The current attendance mechanism produces wrong data. Two live bugs (2026-06-13):

1. **Instant double-scan clock-out.** One open "Attendance" station; each scan calls `clockIn`,
   and if a row is already open the scanner immediately retries as `clockOut`. So scan #1 = in,
   scan #2 = out — decided purely by open-row state, with **no debounce and no minimum dwell**. A
   QR double-read clocks a person out seconds after clocking in (AMIR in 10:36:32 / out 10:36:41;
   Vijay 08:16:07 / 08:16:13). They look like they left after 0 minutes while still working.
2. **False OVERTIME on early arrival.** `detectShiftType()` tags a shift `overtime` for **any**
   clock-in outside a hardcoded per-department window — including *before* the start. Packaging
   starts 10:00, so a 09:57 arrival is flagged OVERTIME; Assembly before 09:00 likewise. Overtime
   is also decided at clock-in, before any work happens, so it can never reflect real overtime.

Root cause: intent is inferred from scan-count, "overtime" is guessed at the door, and shift
timings are hardcoded (`SHIFT_WINDOWS`). The system also can't represent multiple shifts per
department (dispatch runs two; production may go two-shift), and can't let teams own their timings.

## 2. Principles

- **Floor stays trivial:** operators only ever *scan on arrival, scan on exit*. They choose nothing.
- **Smarts live in the worker + back office**, not the scanner.
- **Time-of-day + the operator's own open-row state decide in vs out — never scan-count.**
- **Shifts are first-class, team-owned, free-text-named, effective-dated/versioned, and audited.**
- **Attendance is the canonical input to a future salary/OT engine** — every field it needs is
  captured now and frozen per-day so historical pay can't drift.

## 3. Data model

### 3.1 `shifts` — identity of a shift (stable)
`id · department · name (FREE TEXT — team-chosen, NO presets like Day/Morning) · sort_order · is_active · created_by · created_at`
- Attaches to a **department/area** (assembly/qc/packaging/admin/store/dispatch), because end times
  differ per area and dispatch runs >1.

### 3.2 `shift_versions` — effective-dated timing (the version control + audit)
`id · shift_id · effective_from (date) · start_time · end_time · ends_next_day(bool) ·
in_open_lead_min · out_open_lead_min · grace_min · min_dwell_min ·
created_by_user_id · created_at · note`
- Timing on date D = the version with the greatest `effective_from <= D`.
- A change = a **new row** (never overwrite). The version rows ARE the audit trail: who
  (`created_by`), when (`created_at`), why (`note`), and "how many times moved" = version count.

### 3.3 `operators` — add team routing
- **+`team`** `production | store | dispatch` (NEW). Routes which system/tab shows the operator.
  Backfill: `assembly/qc/packaging/admin → production`, `store → store`, `dispatch → dispatch`.
- Existing `department` is the **area** and drives shift lookup. (`admin` is a Production area per
  Afshaan 2026-06-13.)
- One team per operator; occasional borrowed workers are NOT modelled.

### 3.4 `operator_attendance` — additions
- **`shift_id`** + **`scheduled_start`** + **`scheduled_end`** — snapshot of the resolved shift &
  its version-in-effect, stamped at clock-in. Freezes history against later definition changes.
- **`late_minutes`** — `clock_in − scheduled_start` (>=0; early arrival = 0), set at clock-in.
- **`overtime_minutes`** — set at clock-out / auto-close.
- **`day_status`** `full_day | half_day | absent | leave | holiday` (NULL = normal/worked) — **manual**,
  set by the team for sick / sent-home-mid-shift, etc. Plus `day_status_by · day_status_at · day_status_note`.
- `shift_type` (existing) kept but now derived correctly (standard/overtime at clock-out).

## 4. Scan-resolution engine (worker)

Replace the scanner's two-call toggle with ONE worker action `recordAttendance(employee_id, device, client_ts)`
that owns the decision and returns the resolved action for the scanner to display. For a scan by
operator O at time T:

1. **Find the shift.** Load O's `department` active shifts + each one's version-in-effect for date(T).
   Each shift owns clock windows derived from its timing:
   - in-window: `[start − in_open_lead, …)` — opens before start so arriving early to get ready is on-time.
   - out-window: `[end − out_open_lead, end + stay) → nightly auto-close`.
   - neutral (mid-shift): between them.
2. **Decide in vs out by O's own open-row state:**
   - **No open row** + T in an in-window → **CLOCK IN** (record actual T; `late_minutes`).
   - **Open row** + T in that shift's out-window + dwell satisfied → **CLOCK OUT**.
   - **Open row** + T mid-shift → **ignored** ("already in") — lunch/wander/accidental can't clock out.
3. **Guards (always on):**
   - **Debounce** (~10 s): same operator scanned twice = one event. (Directly kills the AMIR/Vijay bug.)
   - **Min-dwell** (~30–60 min, per-shift configurable): a clock-out is only honored after this long.

### Multi-shift / future two-shift production
Shifts are just data; the engine resolves by department + time + open-row state, so no code change is
needed to add shifts. Back-to-back shifts (dispatch ~07:00 + ~14:00) disambiguate by open-row state:
at the handover, a scan by someone with an open earlier-shift row = clock-out; by someone with no open
row = clock-in to the later shift. Adding a 2nd production shift = add one `shifts` row.

## 5. Late & overtime
- **Late** = clock_in − scheduled_start (stored, shown as a badge). Early = on-time, never overtime.
- **Overtime** computed at clock-out/auto-close: `clock_out > scheduled_end + grace` → `overtime_minutes`.
  Surfaced as a flag + minutes in Manpower for supervisor **review** (no scan-time friction).

## 6. Edge cases & overrides
| Case | Handling |
|---|---|
| Double-scan at clock-in | debounce + min-dwell ignore it |
| Re-scan at lunch / mid-shift | ignored ("already in") |
| Sent home / sick mid-shift (= half day) | supervisor sets `day_status='half_day'` (manual; feeds payroll) |
| Wipe / fix a bad record | supervisor **Close / Reopen / Void** in Manpower |
| Forgot to clock out | nightly auto-close stamps the shift's **scheduled end** (amends RULE-ATT-001's next-day-1AM stamp), flagged, adjustable |
| Forgot to clock in (only scans at exit) | "No clock-in today — see supervisor"; supervisor adds the shift |
| Genuine early departure | before out-window → supervisor Close Shift |

## 7. Three teams → three Manpower homes
Same engine underneath; each surface filters by `operators.team` and scopes its own shift admin.

| Team | `department` (area) | Manpower home | Shift admin |
|---|---|---|---|
| **Production** | assembly · qc · packaging · admin | Redline → Production → Manpower (existing, now filtered) | Production managers |
| **Store** | store | Garage → Manpower (**new view**) | Store managers |
| **Dispatch** | dispatch | Redline → Dispatch → Manpower (**new tab**) | Dispatch managers |

- Each team **self-manages its own shifts from day one** (Afshaan 2026-06-13), with super-admin override.
- Consequence: Redline Manpower narrows to Production; Dispatch leaves to its own tab; Store leaves to Garage.
- New permission `shift_manage`, team-scoped.

## 8. Seed defaults (at Phase-2 go-live)
- Production: assembly 09:00–18:00 · qc 09:00–18:30 · packaging 10:00–19:00 · admin 09:00–18:00.
- Dispatch: two shifts (≈07:00 + ≈14:00) — dispatch enters real times.
- Store: one shift — store enters real time.
- Each seeded as `shift_versions` v1 effective go-live; in_open_lead ≈60m, out_open_lead ≈60m,
  grace ≈30m, min_dwell ≈30–60m (all team-editable thereafter).

## 9. Future (explicitly out of v1)
- **Per-worker rostering** (who is *expected* on which shift) → per-shift absence. The model supports
  adding a worker→shift assignment table later without touching the core.
- **Salary / OT engine** — consumes this attendance data (worked minutes, late, OT, day_status, shift
  snapshot). Separate build.
- Analytics "late" can switch from self-calibrated to objective (vs scheduled_start) once shifts exist.

## 10. Phasing
- **Phase 1 (kills both live bugs, low risk, no schema upheaval):** scan debounce + min-dwell +
  OT-computed-at-clock-out + auto-close stamps scheduled end.
- **Phase 2:** `shifts` + `shift_versions` + `operators.team` + multi-shift resolver (`recordAttendance`) +
  the three Manpower homes + back-office shift admin (versioned + audited) + `day_status` + payroll-ready fields.

## 11. BUILD STATUS & HANDOVER — end of Session 131 (2026-06-13)

> **Read this first when resuming.** Phase 1 + the entire Phase-2 BACKEND are shipped & deployed.
> The Phase-2 resolver is deployed but **INERT** (scanner still on the Phase-1 path). What remains
> is the Phase-2 **frontend** (Garage Store Manpower, Dispatch tab, day_status UI) + the **flip**.

### ✅ LIVE / deployed
- **Phase 1 (both bugs fixed)** — lotopsproxy `023709ea`: `clockIn` writes `shift_type='standard'`;
  `clockOut` has the **min-dwell guard** (clock-out <30 min ⇒ `action:'noop'`) + **OT-at-clock-out**
  (`SHIFT_END_MIN` hardcode: assembly 18:00/qc 18:30/pkg 19:00 + 30m grace). Scanner pushed: a `noop`
  clock-out shows **"Already Clocked In"** (`02_scanner/index.html` `confirmAttendance`).
- **Phase 2a** — migration `attendance_shifts_phase2a`: `store.shifts` + `store.shift_versions`
  (RLS-on, service_role-only), `operators.team` (backfilled production 119 / store 22 / dispatch 9),
  `operator_attendance` +`shift_id`/`scheduled_start`/`scheduled_end`/`late_minutes`/`overtime_minutes`/
  `day_status`(+`_by`/`_at`/`_note`). Seeded v1 shifts.
- **Phase 2b** — lotopsproxy `0e9b49b4` → `1dc9f986` (latest): `recordAttendance` resolver
  (SCANNER_ACTION, **INERT** — not called by scanner yet) + helpers `activeShiftsForDept`/`shiftZone`/
  `istClockToUTC`/`hhmmToMin`; JWT actions `getShifts`/`getShiftHistory`/`createShift`/`renameShift`/
  `setShiftActive`/`addShiftVersion` + `setDayStatus` + `setOperatorShift`; `getOperatorAttendance`
  gained optional `team` filter; `getOperators` returns `team`+`shift_id`. Migration `operators_home_shift`
  added `operators.shift_id` (per-worker home shift; resolver prefers it at clock-in, null⇒time-of-day).
- **Redline Manpower → "Shifts" tab** (`apps/redline/.../manpower/page.js` `ShiftsTab` + `EditTimingModal`/
  `AddShiftModal`/`ShiftHistoryModal`): production+dispatch list/add/edit-as-new-version/history/enable-disable
  shifts; **Dispatch operator→home-shift assignment** panel. LIVE (auto-deployed).

### 📊 Current shift data (store.shifts / shift_versions, all effective 2026-06-13)
- assembly **09:00–18:00**, qc **09:00–18:30**, packaging **10:00–19:00**, admin **09:00–18:00** (production, CONFIRMED correct).
- dispatch **Shift 1 08:00–17:00**, **Shift 2 10:00–19:00** (CONFIRMED by Afshaan S131; they OVERLAP → need per-worker assignment).
- store **09:00–18:00** (PLACEHOLDER — store must confirm via the Garage admin, not yet built).
- Window defaults per version: in_open_lead 60, out_open_lead 60, grace 30, min_dwell 30.

### 🔧 REMAINING WORK (Phase 2 frontend + flip) — priority order

> **Update — Session 132 (2026-06-13):** items 1–3 SHIPPED (the Phase-2 frontend). Items 4 + 5 remain
> (both coupled to the flip / people-confirmations). Worker `getOperatorAttendance` now also returns
> `day_status`/`day_status_note`/`late_minutes`/`overtime_minutes`/`scheduled_start`/`scheduled_end`/`shift_id`
> (lotopsproxy `160f475a`).

1. ✅ **DONE S132 — Garage Store Manpower (Attendance + Shifts).** Garage already HAD a `/manpower` page
   (single Store Activities tab) — added two tabs to it rather than a new route: **Attendance** (`getOperatorAttendance`
   `team:'store'` + `getAttendanceStats` + close-shift + day_status + late/OT badges) and **Shifts** admin
   (`getShifts` filtered to dept `store` + create/addVersion/setActive/history; reuses the Redline ShiftsTab pattern
   in Garage's local-style kit). **Store can now confirm its real shift time here** (prereq for the store flip).
   `apps/garage/.../manpower/page.js`.
2. ✅ **DONE S132 — Redline Dispatch tab + production scoping.** New **Dispatch** tab renders the same
   `AttendanceTab` with `team:'dispatch'`; the existing **Attendance** tab + **Analytics** now scope to
   `team:'production'` (AttendanceTab gained a `team` prop → `getOperatorAttendance`; Analytics filters its RPC
   rows via an operator→team map). **Live view left as the full cross-line floor map** (it's a line map, not a
   per-team list — filtering its presence dots while it still shows Dispatch/Store/Others roster buckets would
   be inconsistent; flagged as a deliberate deviation from the original "filter Live too" wording).
3. ✅ **DONE S132 — `day_status` control** in the attendance rows (both apps) → `setDayStatus` (optimistic,
   tone-coloured select Normal/Full day/Half day/Absent/Leave/Holiday). Feeds future payroll.
4. **Auto-close → stamp scheduled end** — `public.auto_close_open_attendance()` (pg_cron 1 AM IST) currently
   stamps next-day 1 AM + no OT. With shifts: stamp `scheduled_end`, leave `standard`. Amend RULE-ATT-001.
   **NOTE (S132): coupled to the flip** — pre-flip the live `clockIn` path does NOT populate `scheduled_end`
   (only `recordAttendance` does), so there's nothing to stamp until the flip lands. Do this WITH item 5.
5. **2c — THE FLIP (behavioral go-live):** switch `02_scanner/index.html` `confirmAttendance` from
   `clockIn`/`clockOut` → `recordAttendance` (read `res.data.action` = `in`/`out`/`noop`). **Deploy ONLY after
   Store + Dispatch confirm their times** (Store can now do this via the new Garage Shifts tab; Dispatch via the
   Redline Shifts tab) + dispatch assigns its 9 operators. Then live-test one in + one out.
   After flip, `clockIn`/`clockOut` + `SHIFT_END_MIN` become legacy.

### ⚠️ Resume gotchas
- `SHIFT_END_MIN`/`shiftTypeAtClockOut` (Phase-1 hardcode) is still used by the **LIVE** `clockOut` path —
  do NOT remove until the flip. `recordAttendance` uses the shifts table; both coexist intentionally.
- Worker DB helpers: `query`/`insert`/`update` = **store** schema; `queryPublic`/`insertPublic`/`updatePublic` = public. `authResult.userId` = caller id.
- Redline UI: `workerFetch(action,{data},session)` → `res.data`. Kit: `Panel({title,icon,action,pad})`,
  `Modal({open,onClose,title,confirmLabel,onConfirm,loading})`, `ToneBadge tone=ok|mute|bad`, existing `Field({label,full})`,
  `istToday()`, `capitalize()`, `selectStyle`, `smallGhost`, `btnPrimary/btnGhost`. Build: `npx turbo build --filter=redline`.
- Shift CRUD gated `canManageFloor` (team-scoped `shift_manage` perm = later refinement).
- Dispatch shifts OVERLAP → resolver uses `operators.shift_id`; production/store single-shift use time-of-day.

### ⏳ Pending on PEOPLE (not code)
- **Piyush:** (a) physical recount of `HW-TM-CMB` (−2,525) — blocks producibility dashboard org-wide (BACKLOG DQ);
  (b) confirm the 2 held screw codes `HW-CSC-59-24-4` + `GH-SC-03` (#system-updates thread).
- **Dispatch team:** assign the 9 dispatch operators to Shift 1 / Shift 2 in the Redline Shifts tab.
- **Store team:** confirm real store shift time (needs the Garage admin from item 1 first).

### Migrations applied S131
`attendance_shifts_phase2a`, `operators_home_shift`.

### Data cleanups done S131 (no code)
Reopened the 2 instant-double-scan rows (AMIR LOT-FACT-1148, Vijay LOT-FACT-1118); relabeled 42 false-OVERTIME
rows → `standard`; set dispatch times (8-17/10-19); seeded Wisp ledger rows `WI-PB-37` 1036 + `WI-TM-01` 1029.
