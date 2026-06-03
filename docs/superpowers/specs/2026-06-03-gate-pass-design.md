# Gate Pass — V1 Design

> System: **Garage** (LOT Ops cluster) · Worker: **lotopsproxy** · Schema: **store**
> Date: 2026-06-03 · Status: approved design, pre-implementation
> Origin: Piyush, #bugs 06-03 — "create a gate pass system to authorize the entry or exit of vehicles or materials to/from a secured facility."

## 1. Purpose & scope

A security-level log of **every material/vehicle entry and exit at the store/factory gate**,
with documentation (invoices in, docs out) and a printable pass.

- **In scope:** inbound material arrivals (with vendor invoices) and **non-dispatch** outbound
  movements — vendor returns, job-work / repair-out, samples out, scrap, inter-unit transfer.
- **Explicitly NOT in scope:** finished-goods dispatch to customers — that already has its own
  **Delivery Challan** system in Redline. Gate Pass must not duplicate or replace it.

A gate pass is a **point-in-time security log entry**, not an approval workflow. The store team
operates it today (a dedicated security-guard login role is a V2 possibility).

## 2. Record model

**One gate pass = one directional movement.** Each pass is either `inbound` or `outbound`, has
its own number `GP-NNNN`, and records a single gate event. A vehicle arriving with materials = one
inbound pass; goods leaving = one outbound pass. No open/closed vehicle-visit lifecycle in V1.

**No in-system approval.** The pass is valid the moment it is created. Authorization is captured
on the **printed** pass via hand-signed lines (Security · Authorised By · Driver).

Lifecycle: `active → void` (void keeps the row, never hard-deleted — a printed pass must not
silently vanish). Returnable outbound passes additionally track `expected_return_date` and a
`returned_at` set by a **Mark Returned** action.

## 3. Data model (`store` schema)

Both tables: **RLS enabled, service_role-only** (RULE-RLS-001). lotopsproxy is service_role
(BYPASSRLS) and the only DB client. `GRANT ALL ON store.<table> TO service_role`.

### `store.gate_passes`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | identity |
| `gate_pass_no` | text UNIQUE | `GP-NNNN`, atomic from `store.sequences` key `gate_pass`, no year reset (mirrors `AST-NNNN`) |
| `direction` | text | CHECK `inbound` \| `outbound` |
| `gate_datetime` | timestamptz | defaults `now()`, editable (actual gate time) |
| `vehicle_no` | text | |
| `person_name` | text | driver / person at the gate |
| `person_phone` | text | |
| `transporter_name` | text NULL | courier / logistics partner (Delhivery, BlueDart, vendor's own vehicle, walk-in) — distinct from driver |
| `box_count` | integer | number of boxes / packages |
| `purpose` | text | validated in worker against a direction-specific list (see §4) |
| `party_name` | text NULL | vendor/company goods are **from** (inbound) or **to** (outbound) |
| `reference_no` | text NULL | free-text — PO no / invoice no / RMA / challan no (NOT an FK; keeps Garage decoupled from Snorkel's PO system) |
| `material_description` | text NULL | what's in the boxes ("10 cartons BLDC motors") |
| `is_returnable` | boolean | default false |
| `expected_return_date` | date NULL | only meaningful when `is_returnable` |
| `returned_at` | timestamptz NULL | set by Mark Returned |
| `remarks` | text NULL | |
| `status` | text | CHECK `active` \| `void`, default `active` |
| `void_reason` | text NULL | required when voiding |
| `created_by` | uuid | auth user |
| `created_at` | timestamptz | default `now()` |
| `updated_by` | uuid NULL | |
| `updated_at` | timestamptz NULL | |
| `voided_by` | uuid NULL | |
| `voided_at` | timestamptz NULL | |

Indexes: `gate_pass_no` (unique), `(direction, gate_datetime desc)`, `status`,
partial on `is_returnable = true AND returned_at IS NULL` (overdue-returnables filter).

### `store.gate_pass_documents`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | |
| `gate_pass_id` | bigint FK → gate_passes(id) | |
| `file_name` | text | original name |
| `mime_type` | text | |
| `storage_path` | text | path within the private bucket |
| `uploaded_by` | uuid | |
| `uploaded_at` | timestamptz | default `now()` |

Private storage bucket **`gate-pass-docs`** (not public). Upload via signed upload URL; download
via short-lived signed URL — ports the Snorkel asset-register doc pattern
(`snorkelops` `createAssetDocumentUploadUrl` / `recordAssetDocument` /
`getAssetDocumentDownloadUrl`) into lotopsproxy.

### Sequence

`store.sequences` gets a `gate_pass` row (seed 0). Mint via the existing
`store.next_seq*` mechanism used for other counters. `GP-` + zero-unpadded integer
(uniqueness, not padding, is what matters — same convention as DI / AST).

## 4. Purpose lists (worker-validated)

- **Inbound:** `material_receipt`, `returnable_in`, `sample_in`, `other`
- **Outbound:** `vendor_return`, `jobwork_out`, `sample_out`, `scrap`, `inter_unit_transfer`, `other`

The form shows the list matching the chosen direction. Worker rejects a purpose not in the
direction's set (HTTP 422). Stored as the snake_case key; UI renders a friendly label.

## 5. Permissions

One new permission key **`gate_pass`** (covers view + create + edit + void + mark-returned).
Granted in `store.roles` to: `store_head`, `production_manager`, `admin`, `super_admin`.

- New `PERM_DEFS` entry in Garage `/users` for `gate_pass` (label "Gate Pass").
- Every worker handler calls its guard first (RULE-011): reads `canRead('gate_pass')`,
  mutations `canEdit('gate_pass')`.
- **Do not** reuse `production_view` as the sole gate (the recurring permission-incident class —
  it's null on most roles). Verify the 4 intended roles pass `gate_pass` against live
  `store.roles` before deploy.

V2: a narrow `security_guard` role (only the Gate Pass nav, create + own-day view) once guards
get logins.

## 6. Worker API (lotopsproxy, `01_worker/worker.js`)

All JWT-authenticated POST switch handlers unless noted; guard first.

| Action | Type | Guard | Notes |
|---|---|---|---|
| `getGatePasses` | GET | canRead | list + filters: `direction`, `date_from`/`date_to`, `purpose`, `status`, `overdue_returnable`, `q` (GP no / vehicle / party). Capped, ordered `gate_datetime desc`. |
| `getGatePass` | GET | canRead | single pass + its documents (metadata only) |
| `createGatePass` | POST | canEdit | mints `GP-NNNN`, validates direction+purpose, stamps `created_by` |
| `updateGatePass` | POST | canEdit | edits an `active` pass; PROTECTED fields stripped (gate_pass_no, status, created_by, audit) ; stamps `updated_by/at` |
| `voidGatePass` | POST | canEdit | `active → void`, requires `void_reason`, stamps `voided_by/at` |
| `markGatePassReturned` | POST | canEdit | sets `returned_at = now()` on a returnable outbound pass |
| `createGatePassDocUploadUrl` | POST | canEdit | returns signed upload URL + storage_path |
| `recordGatePassDocument` | POST | canEdit | inserts the `gate_pass_documents` row after upload |
| `deleteGatePassDocument` | POST | canEdit | removes doc row + object |
| `getGatePassDocumentDownloadUrl` | GET | canRead | short-lived signed download URL |

Print uses `getGatePass` + the existing `getCompanyAddresses` (no new print endpoint).
Batch any multi-row work (50-subrequest limit). Wrap numeric reads in `Number()`,
integer inserts in `Math.round()`.

## 7. Garage UI

New nav item **"Gate Pass"** (under a STORE/PRODUCTION group), gated by `gate_pass`.

- **`/gate-pass`** — list table (GP no, direction badge, date, vehicle, party, purpose, boxes,
  returnable/overdue indicator, status). Filters: direction, date range, purpose, status,
  "overdue returnables". Search box. CSV export (consistent with other Garage reports).
  Row → detail.
- **`/gate-pass/new`** — create form. Direction toggle drives the purpose dropdown. Fields per §3.
  Document upload (multiple). On save → option to **Print** immediately.
- **`/gate-pass/detail`** — view all fields + document list (view/download/add/delete);
  actions: Edit, Void (reason modal), Mark Returned (returnable + not yet returned), **Print**.

Toast: use `const { showToast } = useToast()` and `showToast(msg, 'success'|'error')` —
NOT the `toast(msg,'ok')` shape (the latent bug fixed across 15 pages in S91).

## 8. Print layout

Browser print-window, same pattern as Delivery Challan / PO print.

- **Header:** LOT logo (reuse the asset used by challan/PO prints) + title **"GATE PASS"** +
  GP no + direction. Company block: **Fraternitas Ventures Private Limited** + the **Factory /
  Delivery** address pulled **live** from `store.company_addresses` (id=2 / `is_default_delivery`)
  — nothing hardcoded (RULE precedent: PO/challan address is data-driven).
- **Body:** date-time, vehicle no, person + phone, transporter, box count, party, purpose,
  reference, material description, returnable + expected return date, remarks; a list of attached
  document names.
- **Footer:** three signature lines — **Security · Authorised By · Driver** — plus printed-on
  timestamp.
- Printable from `/new` right after creation **and** from `/detail` any time, unlimited reprints.
- A `void` pass prints with a diagonal **"VOID"** watermark.

## 9. Out of scope (V2+)

- Live PO / receiving-shipment FK links (V1 uses free-text `reference_no`).
- Separate time-in / time-out (vehicle-visit lifecycle) and an on-site board.
- Total weight, structured driver ID-proof (upload a photo instead).
- Dedicated `gate_pass_history` audit table (V1 keeps audit columns on the row).
- A `security_guard` login role.
- Notifications (Slack/email) on create / overdue returnable.

## 10. Build sequence

1. Migration: `gate_passes` + `gate_pass_documents` (RLS-on, service_role grants), `gate-pass-docs`
   private bucket, `store.sequences` `gate_pass` seed. Verify advisors clean (0 rls_disabled).
2. lotopsproxy handlers (§6) + `PERM_DEFS` `gate_pass` + grant the 4 roles in `store.roles`.
   edit → commit → push → `cd 01_worker && npx wrangler deploy`. (Blast radius: Garage+Redline+Scanner.)
3. Garage pages (§7) + nav + print (§8). `npx turbo build --filter=garage`, commit, push (auto-deploy).
4. Smoke: create inbound + outbound, upload a doc, print both, void one, mark a returnable returned,
   verify overdue filter + CSV.
