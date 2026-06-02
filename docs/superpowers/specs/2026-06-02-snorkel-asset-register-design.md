# Snorkel Asset Register V1 — Design Spec

> Date: 2026-06-02 (Session 94)
> System: Snorkel (Procurement) · Worker: `snorkelops` · App: `apps/snorkel`
> Status: approved (data model + scope) → building

## Purpose

A living inventory of physical assets LOT owns or rents — **"track what we own"**:
what it is, where it is, who has it, what it cost, and how we got it (linked PO).
NOT an accounting/depreciation register (full IND-AS fixed-asset register is a
deferred Phase 2+ item). The register lets the team answer "we bought this — where
is it now, who has it, is it still working" and separate true owned assets from
rental expenses.

## Scope (V1)

In:
- Asset records with auto-minted printable code `AST-NNNN`.
- Managed **categories** and **locations** (admin-editable lists).
- **Custodian** = a LOT user (picker) OR free-text name (login-less floor/contract staff).
- **Status** lifecycle: `in_use` · `in_storage` · `damaged` · `in_repair` · `retired` (terminal).
- **Acquisition type** tag (separate axis): `purchased` vs `rented` (expense-vs-asset split).
- **Cost + PO link** (purchased) and **rental fields** (rented), form adapts to the tag.
- **Change-history** log (status / custody / location / edits / retire / doc-added).
- **Document attachments** (photo / invoice / warranty) in a private bucket, signed-URL access.
- **Warranty / AMC** date fields (dates only — no maintenance log in V1).
- Snorkel-layer permissions: new keys `asset_view` (read) + `asset_manage` (write/admin).

Out (deferred):
- Depreciation, book value, capitalization, IND-AS.
- Full maintenance/service log, AMC contract documents lifecycle.
- Check-in/check-out custody workflow with overdue alerts.
- Cross-link to Podium employees (custodian is users_profile or free text only).

## Architecture fit

- **Data lives in `store`** (Snorkel's locked decision — service_role on the same
  Supabase project; `store` is already in the exposed-schemas list). New tables only;
  no migration of existing data.
- **Worker = snorkelops** (self-contained; no cross-worker calls). Reuses existing
  helpers: `nextSeq`/`next_seq` RPC (code mint), `getSnorkelUsers` (custodian picker),
  `getVendors` (vendor picker), `verifyJWT` → `perms`.
- **Storage** = new private bucket `snorkel-asset-docs`, signed-URL upload/download,
  ported from the podiumops `podium-documents` pattern (`storageFetch` + `/object/sign`
  + `/object/upload/sign`).
- **App** = new `/assets` module in `apps/snorkel`, styled with `src/lib/snorkelui.js`,
  nav gated on `asset_view`.

## Data model (`store` schema)

All tables: **RLS enabled, `GRANT ALL … TO service_role`, no anon grant** (RULE-RLS-001).

### `store.asset_categories`
| col | type | notes |
|---|---|---|
| id | serial PK | |
| name | text UNIQUE NOT NULL | |
| is_active | bool default true | |
| sort_order | int default 0 | |
| created_at | timestamptz default now() | |

Seed: Machinery, Tools, Moulds & Dies, IT / Computers, Office Equipment, Furniture, Vehicles, Electrical, Other.

### `store.asset_locations`
Same shape as categories. Seed: Factory, Office, Warehouse, Other.

### `store.assets`
| col | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| asset_code | text UNIQUE NOT NULL | `AST-NNNN`, minted via `store.sequences` key `asset`, padStart(4) |
| name | text NOT NULL | |
| description | text | |
| category_id | int → asset_categories(id) | nullable |
| status | text NOT NULL default 'in_use' | CHECK in (in_use,in_storage,damaged,in_repair,retired) |
| acquisition_type | text NOT NULL default 'purchased' | CHECK in (purchased,rented) |
| location_id | int → asset_locations(id) | nullable |
| custodian_user_id | uuid | nullable (users_profile.id) |
| custodian_name | text | denormalized / free-text fallback |
| serial_no | text | OEM serial |
| model_no | text | model / vendor part no |
| secondary_ref | text | alt identifier / old tag |
| vendor_code | text | picker from store.vendors |
| vendor_name | text | denormalized / free-text fallback |
| source_po_number | text | loose ref to purchase_orders.po_number (no FK, like source_request_no) |
| purchase_cost | numeric(14,2) | |
| currency | text default 'INR' | |
| acquired_date | date | |
| rental_cost | numeric(14,2) | |
| rental_period | text | CHECK in (monthly,quarterly,annual) when set |
| rental_start_date | date | |
| rental_end_date | date | |
| warranty_expiry | date | |
| amc_renewal | date | |
| retired_at | timestamptz | |
| retired_reason | text | |
| created_by | uuid | |
| created_by_name | text | |
| created_at | timestamptz default now() | |
| updated_at | timestamptz default now() | |

### `store.asset_history` (append-only)
| col | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| asset_id | uuid → assets(id) ON DELETE CASCADE | |
| event_type | text | created · status_change · custody_transfer · location_change · updated · retired · document_added · document_removed |
| from_value | text | |
| to_value | text | |
| note | text | |
| changed_by | uuid | |
| changed_by_name | text | |
| created_at | timestamptz default now() | |

### `store.asset_documents`
| col | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| asset_id | uuid → assets(id) ON DELETE CASCADE | |
| doc_type | text | photo · invoice · warranty · other |
| file_name | text | |
| storage_path | text | object key in snorkel-asset-docs |
| mime_type | text | |
| uploaded_by | uuid | |
| uploaded_by_name | text | |
| created_at | timestamptz default now() | |

Storage bucket `snorkel-asset-docs`: **private** (never public). Read only via worker-minted
short-TTL signed URL; upload via worker-minted signed upload URL → browser PUT → recordDocument.

### `store.sequences`
Add row `('asset', 0)` (ON CONFLICT DO NOTHING) so `next_seq('asset')` mints AST codes.

## Permission layer (RULE-SNORKEL-002)

Add two keys to the Snorkel perm set: `asset_view`, `asset_manage`.

Seed updates to `store.snorkel_roles.permissions`:
- `admin` (is_system) — already all keys (true map); ensure asset_view + asset_manage present.
- `procurement_manager` — += `asset_view`, `asset_manage`.
- `approver` — += `asset_view`.
- `requester` — unchanged (`{}`; no asset access).

All editable in `/admin/roles`. Worker gates:
- Reads (`getAssets`, `getAsset`, `getAssetCategories`, `getAssetLocations`,
  `getAssetDocumentDownloadUrl`) → require `asset_view` OR `asset_manage`.
- Writes (`createAsset`, `updateAsset`, `retireAsset`, doc upload/record/delete,
  category/location create/update/deactivate) → require `asset_manage`.

## Worker actions (snorkelops `src/index.js`)

Reads:
- `getAssets` — filters: `status`, `category_id`, `location_id`, `acquisition_type`, `search`.
  Returns rows joined with category_name, location_name, custodian display, doc_count.
- `getAsset` — `{ id }` → full row + category/location names + history (desc) + documents (metadata).
- `getAssetCategories` / `getAssetLocations` — active (and `?all=1` for admin including inactive).
- `getAssetDocumentDownloadUrl` — `{ document_id }` → 120s signed URL.

Writes (asset_manage):
- `createAsset` — validates name; mints `AST-NNNN`; inserts; writes `created` history row.
- `updateAsset` — diff-aware: logs `status_change` / `custody_transfer` / `location_change`
  when those change, else `updated`. Strips `asset_code` (immutable). Re-stamps `updated_at`.
- `retireAsset` — `{ id, reason }` → status=retired, retired_at=now(), retired_reason; history.
- `createAssetDocumentUploadUrl` — `{ asset_id, file_name }` → signed upload URL + storage_path.
- `recordAssetDocument` — `{ asset_id, doc_type, file_name, storage_path, mime_type }` → row + `document_added` history.
- `deleteAssetDocument` — `{ document_id }` → delete object + row + `document_removed` history.
- `createAssetCategory` / `updateAssetCategory` (name/is_active/sort) ; same for locations.

Helper to add: `storageFetch(path, env, opts)` (ported from podiumops) using the service key.
Bucket const `ASSET_BUCKET = 'snorkel-asset-docs'`.

## App (`apps/snorkel/src/app/(auth)/assets/`)

- `assets/page.js` — list. Filter bar (status / category / location / acquisition_type) +
  `/`-search; table: Code · Name · Category · Status badge · Acq tag · Location · Custodian ·
  Cost; "+ New Asset" (asset_manage); row → detail. Settings cog (asset_manage) → `/assets/settings`.
- `assets/new/page.js` — create form. Adaptive section: Purchased (cost/currency/acquired/vendor/
  source PO) vs Rental (rental cost/period/start/end/vendor). Common: name, category, status,
  location, custodian (user picker + free-text), serial/model/secondary, warranty/AMC, notes.
- `assets/detail/page.js` — `?id=`. Read view + inline edit (asset_manage); status/custody/location
  change; Retire (with reason); History timeline; Documents (upload via signed URL, list, view
  signed-URL in new tab, delete). China-style cost restriction NOT applied.
- `assets/settings/page.js` — manage categories + locations (add / rename / activate-deactivate),
  gated asset_manage.

Shared: status badge tones in `snorkelui.js` style; vendor picker reuses `getVendors`;
custodian picker reuses `getSnorkelUsers`.

Nav (`apps/snorkel/src/lib/nav.js`): add `ASSETS` group/item → `/assets`, icon Boxes/Package,
gate `asset_view`.

## Build / deploy sequence

1. Migration (DDL) — apply to `lot-production` (requires confirmation per ops rules).
   Verify with `information_schema.columns` after.
2. Create private storage bucket `snorkel-asset-docs`.
3. snorkelops: add helpers + actions + perm keys; commit → push → `cd snorkelops-worker && npx wrangler deploy`.
4. app: build `npx turbo build --filter=snorkel` (zero errors) → commit → push (auto-deploy).
5. Knowledge files: systems/snorkel.md (asset module), BUSINESS_RULES (RULE-SNORKEL-003),
   CORE.md (store table list), BACKLOG (mark Phase 1b done), archive/SESSIONS + LEARNINGS.

## Testing / verification

- Schema: `information_schema.columns` for all four tables post-migration.
- Worker actions return 401 without JWT (gate present), 200 with.
- Live smoke (floor / user JWT): create asset → appears in list → open detail → change status
  (history row) → transfer custodian (history row) → upload a photo (signed URL round-trip) →
  retire. Categories/locations CRUD in settings.
- RLS advisor clean (no new `rls_disabled_in_public`); anon cannot reach asset tables.
