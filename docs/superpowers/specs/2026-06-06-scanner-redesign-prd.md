# PRD — Scanner Redesign (Department Gating + Touch-First Modernization)

> **Date:** 2026-06-06 · **Owner:** Afshaan · **Status:** Approved design — implementation deferred to a later session (floor is LIVE; nothing built from the design session).
> **Target:** existing single-file PWA `02_scanner/index.html` (+ scanner-repo assets); additive worker/DB/Garage changes where noted.

---

## Context / Why

Today the scanner lets any device switch to any station from the setup screen with **no role gating**. Line workers press the wrong station, causing mis-scans — most visibly the **06-Jun RTO mix-up** (fresh-production cars scanned under `RTO_IN` at a packaging device, hard-deleting box labels). This redesign walls stations into department buckets so the wrong-station error class becomes structurally impossible, and at the same time modernizes the scanner to a touch-first, app-like UI matching Garage/Redline.

## Platform decision (locked)

Build the **full redesign on the EXISTING single-file PWA** — gating, guided flow, branding, and the full touch-first visual pass. Chosen for lowest risk and fast ship; no rewrite of the proven camera/scan engine. **A React/Next migration into the monorepo (`apps/scanner`, reusing `packages/ui`) is a separate, deliberate future project** — this PRD is framework-agnostic and becomes its spec too, so nothing here is wasted if migrated later.

## Hard constraints

- **Additive-only backend changes; never break a working flow.** Most work is in `02_scanner/index.html`. Worker (`01_worker/worker.js`) / Supabase / Garage changes are allowed ONLY when purely additive (new action, *widened* allow-list, new table/column) and verified non-breaking. A bad worker deploy hits Garage + Redline + Scanner at once, so additive + tested only; deploy worker first (backward-compatible) then ship the new scanner.

## ⛔ Open questions — resolve immediately before implementation (do NOT build blind)

1. **PIN values** — the three 6-digit department PINs are seeded by Afshaan via the Garage card at build time (kept out of this doc).
2. **Dispatch double-shift window** + the precise **OT vs Double-OT boundary** — pending floor confirmation. Implement Regular/OT now; wire Double-OT when confirmed.

---

## Buckets (locked)

Four buckets: **Production, Store, Dispatch** are PIN-gated departments; **Attendance** is a standalone, PIN-free bucket.

| Bucket | Stations |
|---|---|
| 🟩 **Production** | INW · QC_PASS · QC_FAIL · WKS · PKG · PKG_OUT · REPAIR · REPACK_IN · REPACK_OUT · EXT_INW |
| 🟦 **Store** | STORE_ISSUE · RET_IN · DSP_ISSUE *(relabelled "Direct Issue")* — *RTO_IN retired/hidden* |
| 🟧 **Dispatch** | ALLOC · PACK · DTK · DOUT · RESTOCK |
| ⬜ **Attendance** | ATTENDANCE (standalone, no PIN) |
| Replicated in all 3 departments | LOOKUP everywhere; LEGACY_REG in Store + Dispatch (excluded from Production) |

Why this kills the RTO mix-up: `RTO_IN` (a returns station) moves behind the **Store** wall while `PKG_OUT` stays in **Production** — a Production device can no longer switch to `RTO_IN`, so the wrong-station press that caused the incident cannot happen.

---

## Screen flow (all departments)

**Screen 1 — Department Select (landing).** Four tiles, visible to anyone. Production/Store/Dispatch each prompt for **their own distinct 6-digit PIN**; Attendance opens directly (no PIN). Unlocking one department grants no access to the others.

**Screen 2 — PIN entry.** Custom **on-screen numeric keypad** (0–9, backspace, masked) — **NOT** the phone's native keyboard (so the OS keyboard never remembers/autofills the PIN). Verified server-side (see PIN mechanism). Wrong PIN → "incorrect, try again" (no lockout). A correct PIN unlocks the department and persists (survives relaunch) until the daily **1 AM IST** expiry, then drops back to Screen 1. Department is switchable anytime via Logout.

**Screen 3 — Category select (guided).** Per department, a small set of large category tiles (below). **Single-station categories skip the picker** and go straight to setup. Multi-station categories show stations in **physical floor-flow order** (a downstream station never precedes an upstream one).

**Screen 4 — Setup ("Launch Scanner").** One screen, top→bottom: **Line** (where applicable) → **Station** → **Camera** (back/front) → **Flashlight-on-scan** toggle → **Beep volume** (default 100%) → big **▶ Launch Scanner**. Aspiration: fits without scroll on a phone.

**Screen 5 — Scanner.** Top bar: **Line + Station large** on the left (operator name smaller, where applicable), **Logout** on the right, and a station-aware region that injects the station-specific control (e.g. Repair run dropdown, packaging channel toggle, RET_IN shipment binding, PKG_OUT tally). Middle = camera/scanner (largest). Bottom = scan-history feed. **No settings button and no in-app station switch** — the only way to change station/line is **Logout → exit fully to Screen 1** → re-enter via the guided flow. Friction is intentional.

---

## Department specifics

### Production
- **No operator login.** One scanner per station, 4–5 operators tagged to it; output is measured per-station, so per-operator attribution isn't needed from the scanner (it's a Redline calc). Production scans carry device attribution, `operator_id` omitted.
- **Lines = L1–L5**, unchanged from today (feeds the existing `lineProductGuard`).
- **Categories (floor order):**
  - **Fresh Production** — Assembly → QC Pass → QC Fail → Workshop → Packaging → Package Out
  - **Repair Run** — Repair → QC Pass → QC Fail → Workshop → Packaging → Package Out
  - **Outsourced Run** — Ext Inwarding → QC Pass → QC Fail → Workshop → Packaging → Package Out
  - **Repack Run** — Repack In → Repack Out
  - **Utilities** — Lookup *(no Legacy Reg in Production)*
- **Menu-only duplication:** the QC→Package-Out chain appears under Fresh/Repair/Outsourced but is the **same station codes + worker handlers** (a repaired/outsourced unit already flows through the normal QC_PASS/PKG/PKG_OUT — not forked). One source of truth, multiple navigation groups.

### Store
- **Operator login = YES** — operator QR card, same gate as Dispatch (see shared gate).
- **No lines** — stations bind to a **run / shipment / DI** via a dropdown on the scanner screen (Store Issue→run, Returns Intake→open RS-NNN shipment, Direct Issue→DI sticker). Store's Screen 4 omits the line picker.
- **Categories:** Store Issue · Returns (RET_IN only — RTO retired) · Direct Issue · Utilities (Lookup + Legacy Reg). Three are single-station → skip straight to setup.

### Dispatch
- **Operator login = YES** — canonical gate (existing `loginDispatchOperator`, per-shift QR, 1 AM IST expiry).
- **Lines = D1/D2** (dispatch lines). Screen 4 is line-first with D1/D2.
- **Categories:** Dispatch Flow (Dispatch In → Allocate → Pack → Dispatch Out, floor order) · Restock (single → straight to setup) · Utilities (Lookup + Legacy Reg).
- **Open-shipment dropdown shows ALL open shipments** (advance packing): `getActiveShipments` drops its same-date filter and returns all `draft` + `packing` shipments regardless of `scheduled_date` (keep `order=scheduled_date.asc`). It's a SCANNER_ACTION used only by PACK, so this is additive and contained.

### Attendance (standalone)
- Tapping Attendance opens **directly** into clock-in/out — no PIN, no category, no line, no operator gate. Scan/type employee QR → clock in/out. Back returns to Screen 1.

---

## Shared operator gate (Store + Dispatch)

ONE shared operator-gate component (no code variation). Implementation: keep `loginDispatchOperator` and **additively widen** its allowed-station check to also accept Store stations (RET_IN, STORE_ISSUE, DSP_ISSUE). Dispatch is untouched; Store rides the same action. Operator + 1 AM IST expiry cached in `cfg` exactly like today's dispatch gate.

## PIN setup mechanism (server-side, super-admin-managed)

- **New table `store.scanner_department_pins`:** `department` PK (`production`/`store`/`dispatch`), `pin_hash` (hashed, never plaintext), `updated_at`, `updated_by`. RLS enabled + `GRANT ALL … TO service_role`. Additive.
- **Setter UI:** a **super-admin-only "Scanner Department PINs" card** on Garage `apps/garage/.../users/page.js`, rendered only when `role === 'super_admin'`. Three fields; **write-only** (shows "set · last updated by · when", never the number).
- **Worker actions (additive):** `setDepartmentPin` (JWT, super_admin-gated — hashes + upserts + audit) and `verifyDepartmentPin` (SCANNER_ACTION, device_code auth — hashes input, compares; must live in the SCANNER_ACTIONS if-chain per RULE-007).
- **Scanner:** keypad → `verifyDepartmentPin` → on ok cache the unlocked department + 1 AM IST expiry; on fail "try again."

## Global changes

- **Remove ALL shift buttons** (Regular/OT/Double OT). Shift is **auto-derived in JS** from the device clock and sent as before (worker already accepts a `shift` value — no backend change).
  - **Windows (IST, by station):** Packaging = 10:00–19:00; all others = 09:00–18:00. Within window → `Regular`; outside → `OT`. Dispatch double-shift / Double-OT boundary TBD (assume 09:00–18:00 for now). The shift helper must know the station to pick the window.

---

## Visual / touch-first redesign

Mobile-first (phone is the only device); match Garage/Redline.

- **App-like, not a website:** PWA standalone (full-screen, no browser chrome), fixed app header, card/tile screens, snappy push/slide transitions between guided-flow steps, app-style buttons, retain scan haptics/beeps.
- **Icons:** replace all ~40 emoji with **inline SVG** using the same **lucide** vocabulary as Garage/Redline (single-file → copy SVG paths, no `lucide-react`).
- **Color (adopt Garage/Redline tokens):** lift background `#080808` → **`#1f1f1f`** + full 4-step surface ramp (`#2a2a2a`/`#333`/`#3c3c3c`) for visible card elevation; 4-step text ramp fixing sub-AA greys (`#555`→`#888`, `#999`→`#b0b0b0`); semantic state colors (success/warning/error/info). Brand colors already shared.
- **Typography:** keep **JetBrains Mono** (body/codes) + **Tomorrow** (big titles); raise the scale for the phone (base ~16px, functional text ≥14px, large line/station titles).
- **Touch targets:** ≥48px on department/category/station tiles, keypad keys, camera/torch/volume controls, and Launch.

## Branding

New app identity: a **yellow rounded-square icon (brand `#F2CD1A`) with a dark charcoal scan-frame glyph** (corner brackets + scan line). Assets supplied (`scanner.svg` + PNG set 16/32/48/180/192/512 + maskable).
- Copy assets into `02_scanner/`, replacing `icon-192x192.png` / `icon-512x512.png` and adding the other sizes.
- **`manifest.json`** — point `icons[]` at the new set (include `purpose:"maskable"`), set name/short_name (LOT Scanner), `background_color`/`theme_color` to the new design.
- **`index.html` `<head>`** — favicon (16/32), apple-touch-icon (180), update `theme-color`.
- **`sw.js`** — update the cached-asset list.
- **Screen 1 / sign-in** — show the new logo as the app brand (replaces the plain "Legend of Toys" wordmark).

---

## Files to modify (all additive / non-breaking)

- **`02_scanner/index.html`** (the bulk) — Screen 1 dept-select, PIN keypad, per-department guided flows, redesigned scanner screen (top bar, logout top-right, no settings), remove shift bar, app-like + touch-first visual overhaul (tokens, inline SVG, type scale), shift auto-derive helper, shared operator-gate, `verifyDepartmentPin` call, new branding in head.
- **`02_scanner/` assets** — add the `scanner-logo` set (replace `icon-192x192.png`/`icon-512x512.png`); update `manifest.json` + `sw.js`. Scanner repo only.
- **`01_worker/worker.js`** (additive) — `getActiveShipments` drop same-date filter; widen `loginDispatchOperator` allowed-station set; new `setDepartmentPin` (JWT/super_admin) + `verifyDepartmentPin` (SCANNER_ACTION). No existing path altered.
- **`05_Throttle/apps/garage/.../users/page.js`** (additive) — super-admin-only "Scanner Department PINs" card.
- **Supabase (additive)** — new table `store.scanner_department_pins` (RLS + service_role grant). No DROP/ALTER.

## Rollout (floor LIVE — non-disruptive)

DB migration (additive) → worker edit → commit → push → `wrangler deploy` → Garage card → scanner. Deploy worker first (backward-compatible, old scanner keeps working), then ship the new scanner. Seed the 3 PINs via the Garage card and confirm the Dispatch shift window first. Keep the old scanner reachable until the new one is smoke-tested on a real floor device.

## Verification (end-to-end)

- Each department: tile → correct PIN unlocks; wrong PIN rejects (no lockout); Attendance opens with no PIN.
- Production: category → station (floor order) → line L1–L5 → launch → scan; no operator prompt; shift auto-shows Regular/OT by clock + station.
- Store: operator QR gate appears; run/shipment/DI dropdown on scanner; RTO_IN absent.
- Dispatch: D1/D2 line; operator gate; PACK shipment dropdown shows advance/future open shipments.
- Logout exits fully to Screen 1; no in-app station switch; no settings button anywhere.
- Regression: existing dispatch operator login still works; Garage/Redline unaffected by the worker deploy.
- Visual: readable at arm's length, no-scroll setup screens, app-like transitions, zero emoji left.
