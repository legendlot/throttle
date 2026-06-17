# Depot go-live checklist (Session 152)

Run signed-in on **https://depot.legendoftoys.com/** with a `@legendoftoys.com` Google account.
Goal: prove Depot signed-in before we tear out Redline's dispatch fallback (P4 cutover).
Tick each box; note anything that errors / shows wrong or empty data.

## A. Auth + chrome
- [ ] Google OAuth sign-in succeeds (hd:legendoftoys.com); lands on `/dashboard`.
- [ ] Sidebar groups render: Overview · Outbound · Returns · Floor · Setup + System Manual footer link.
- [ ] ⌘K palette opens and lists the floor views (Live Floor / Lines).
- [ ] Topbar refresh control works; brand (DEPOT shutter) + favicon correct.

## B. Outbound
- [ ] **Pipeline** `/dispatch-pipeline` — on-hand finished goods load (real counts, not empty).
- [ ] **Shipments** `/dispatch-shipments` — open shipments list; channels populate.
- [ ] **Challans** `/dispatch-challans` — list loads; open one `…/detail`; **Print** view print-isolates the doc (only the challan prints, not the app shell).
- [ ] **New challan** `/dispatch-challans/new` — form loads, channel/shipment pickers populate.
- [ ] **Dispatch Counts** `/dispatch-counts` — scan-to-list scratchpad works.

## C. Returns
- [ ] **Unit Restock** `/restock` — loads; a restock action posts (if safe to test).
- [ ] **Repack** `/repack-runs` (+ `/reports`) — loads. *(Repack stays in BOTH apps for now — parked.)*

## D. Floor
- [ ] **Live Floor** `/dispatch` — D1/D2 line cards, channels, last scan.
- [ ] **Lines** `/dispatch/lines` — per-line view.
- [ ] **Scan Feed** `/scans` — dispatch scan stream + summary tiles; date presets; UPC search.
- [ ] **Dispatch Roster** `/dispatch-roster` — assign a D1/D2 operator activity.
- [ ] **Manpower** `/manpower` — Attendance (dispatch) · Daily roster (D1/D2 buckets) · Analytics · Shifts (dispatch only). Non-floor viewers degrade to "—" gracefully.

## E. Overview cockpit `/dashboard`
- [ ] Hero: units-in-dispatch-area + operators-on-floor show real numbers.
- [ ] 5 pipeline stat cards populate (With Production / With Dispatch / Allocated / Dispatched today / Shipments today).
- [ ] Today-on-the-Floor per-line cards show rostered manpower.
- [ ] Allocated-Awaiting-Ship / On-Hand FG / Sent-Out-by-Channel sections load (date presets work).

## F. Setup
- [ ] **Channels** `/dispatch-channels` — list loads; edit/create a channel.

## G. System Manual
- [ ] `/manual` — Depot Operations Manual renders; search + role filter work; Download-PDF returns the 52-page PDF.

## H. Stock Audit lifecycle (RULE-AUDIT-001) — the critical governed flow
- [ ] **Open** `/dispatch-audits` as a `cycle_count_record` user → create a new audit (only one open at a time enforced).
- [ ] At the scanner **Stock Audit** station: device `STOCK_AUDIT-SHARED` resolves under **Dispatch**; operator sign-in works.
- [ ] Scan several held car box labels → they register; **re-scanning the same label dedups** (no double count).
- [ ] Audit page shows live **variance per product** (system-held vs scanned) + the exact **missing batch labels** + extras.
- [ ] **Submit for review** → variance freezes.
- [ ] A **different** supervisor (`cycle_count_approve_l1`) approves. **Confirm the original counter/submitter CANNOT approve their own audit** (server should reject).
- [ ] On approve: a **missing** unit flips to `lost`, an **extra** flips to `handed_over` (per-line skip honored).
- [ ] The audit register lists the audit with its variance + who/when.

## I. Redline-untouched sanity (fallback still intact)
- [ ] redline.legendoftoys.com → Dispatch group still works (pipeline/shipments/challans/etc.) — confirm we have NOT yet removed it.

---
**When A–I pass:** report back and we execute the P4 cutover (remove dispatch from Redline, leave repack, rebuild both manuals).
**If anything fails:** note the screen + symptom; we fix on Depot before any Redline removal.
