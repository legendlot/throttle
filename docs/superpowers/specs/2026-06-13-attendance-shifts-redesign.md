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

## 11. Done this session (2026-06-13, data cleanup only — no code yet)
- Reopened the 2 double-scan rows (AMIR LOT-FACT-1148, Vijay LOT-FACT-1118) — cleared the instant clock-out.
- Relabeled all 42 of today's false-OVERTIME rows (early arrivals) → `standard`.
