# Manifest — LOT ↔ Solve Factory China-Import Operating System

> Spec authored Session 140 (2026-06-16). Status: v1 build in progress.
> Plan of record: this file. Approved design decisions captured below.

## 1. Problem

LOT imports almost everything from China via **Solve Factory (SF)** — an external partner that is at
once importer, shipping agent, and product-development partner. The whole flow lives on WhatsApp +
a Google Sheet, causing:

1. **No shared source of truth** — which orders are placed vs pending is unclear; updates lost in chat.
2. **Brutal reconciliation** — LOT pays SF lumpsum draw-downs in INR at an *estimated* RMB→INR rate;
   SF pays vendors in RMB at the *actual* bank rate on transaction day; money is a **pool**, not
   order-allocated, and SF re-allocates LOT funds across orders on LOT's behalf. The running account
   ebbs and flows; spreadsheet recon is deferred until critical.
3. **Cost-per-unit surprises** — landed CPU depends on FX, shipping mode/rates, and customs duty that
   varies by HS classification. LOT has shipped products at unviable margins, discovered too late.
4. **No evidence trail** — PI/PO, bank receipts, loading/unloading photos, packing lists scattered.

**Goal:** a shared LOT↔SF system — **Manifest** — that captures every China order at the verbal/intent
stage, gives it PI/PO identity, tracks it end-to-end with evidence, runs the **pooled running account**
(real-time "who owes whom"), auto-applies stored FX, computes landed CPU, and **projects firmed orders
into Snorkel as `source='China'` POs** so a China PO is never created twice. This realises the earlier
"soft order approach": `store.purchase_orders` already has a China-only **`'Soft'`** status = the early
order before it hardens to `Draft → Accepted → Approved`.

## 2. Locked decisions (Afshaan, S140)

- **New sibling system** (not a Snorkel module): own app / worker / domain / `manifest` schema / permission layer.
- **SF login = email magic-link / OTP** (Supabase GoTrue), SF emails allowlisted; LOT keeps Google + `hd` lock.
- **SF visibility:** orders, shipping milestones, draw-downs, payments, running-account balance, and the
  cost inputs SF provides — **NOT** LOT landed CPU / selling price / margin / viability.
- **Shipments:** full consolidation, many orders ↔ many shipments (qty-level `shipment_lines` junction).
- **FX:** daily auto reference rate (estimates); **actual bank rate entered manually** per vendor payment
  (the true cost basis).
- **v1 = foundation + money engine.** Landed CPU + document generation = v2.

## 3. System identity

| Piece | Value |
|---|---|
| App | `05_Throttle/apps/manifest/` (`@throttle/manifest`) |
| Worker | `05_Throttle/manifestops-worker/` → `manifestops` |
| Domain | `manifest.legendoftoys.com` |
| Deploy repo | `legendlot/manifest` (gh-pages) via `.github/workflows/deploy-manifest.yml` |
| Schema | `manifest` (added to PostgREST exposed list in migration) |
| Bucket | private `manifest-docs` |

## 4. Architecture

- `manifestops` is `service_role` on `lot-production` (`jkxcnjabmrkteanzoofj`), same `sb_secret` apikey+Bearer
  pattern as snorkelops. Only DB client; the app talks only to the worker.
- All new tables in `manifest`, RLS-on, service_role-only (no anon/authenticated grants).
- Only cross-schema **write** is the Snorkel projection into `store.purchase_orders` + `store.po_lines`;
  cross-schema **reads** = `store.vendors` / `store.forwarders` / `store.company_addresses` masters and
  `store.next_seq` (called via the `store` PostgREST profile — `next_seq` lives in `store`).
- "Live" = always-current shared app + `manifest.activity` append-only feed + refresh-on-action/light
  polling. Supabase Realtime push is v2.

## 5. Data model (`manifest` schema) — see migration `manifest_schema_v1`

Numbers via `store.sequences` + `store.next_seq` (seeded rows; UPDATE-only). New keys: `mf_order` (`MF-NNNN`),
`mf_shipment` (`SHM-NNNN`), `mf_drawdown` (`DD-NNNN`), `mf_payment` (`PMT-NNNN`), `mf_vpay` (`VP-NNNN`),
`mf_charge` (`CHG-NNNN`). China PO numbers mint via the existing `po` seq (`CN-<TYPE>-NNNN`) at projection.

- **Permission layer:** `manifest_roles` (role_key, label, party `LOT|SF`, permissions jsonb, is_system),
  `manifest_user_roles` (user_id PK → role_key). verifyJWT loads perms + party; handlers strip cost/CPU/margin
  when `party='SF'`.
- **Orders:** `orders` (`MF-NNNN`, category, vendor, placed_via, currency `CNY`, 15-state pipeline,
  est_value_rmb, linked_po_number/linked_at, created_party). `order_lines` mirror `po_lines` columns +
  `weight_kg`, `cbm` (v2 allocation).
- **Shipments:** `shipments` (`SHM-NNNN`, mode, container, BL/AWB, forwarder, status, 9 milestone dates),
  `shipment_lines` (shipment_id, order_line_id, qty_in_shipment) qty-level junction (consolidation + split).
- **Charges (non-goods cost lines):** `charges` (`CHG-NNNN`, scope, order/shipment, category, amount,
  currency, is_estimate, fx_rate_used, amount_inr, source_party). Goods cost enters via `vendor_payments`,
  NOT charges, to avoid double-count.
- **Money:** `drawdowns` (`DD-NNNN`, phase, est_amount_inr, est_fx_rate — request/forecast layer);
  `payments` (`PMT-NNNN`, LOT→SF pool credit, amount_inr, fx_rate_used, soft nullable drawdown_id);
  `vendor_payments` (`VP-NNNN`, SF→vendor, amount_rmb, amount_inr_debited, actual_bank_rate — the actual-FX
  cost anchor / goods debit); `ledger_entries` (manual signed entries: opening balance, reallocations,
  settlements, adjustments); `sf_invoices` (SF's formal bills, reconcile against accrued charges — NOT a
  separate ledger debit).
- **`manifest.running_account` VIEW** (recon source of truth) = UNION ALL of:
  credit `+payments.amount_inr`; debit `−vendor_payments.amount_inr_debited` (goods);
  debit `−charges.amount_inr WHERE is_estimate=false AND category<>'goods'` (other actual costs);
  signed `ledger_entries.amount_inr`. Running balance via window `SUM`. **Net = SUM(signed)** → positive =
  SF holds LOT funds (advance); negative = LOT owes SF. Provisional/forecast money-due (open drawdowns +
  `is_estimate` charges) is computed in the worker, separate from this actual ledger.
- **FX:** `fx_rates` (base `CNY`, quote `INR`, rate, rate_date, source `auto|manual`); helper picks manual
  override else nearest auto ≤ date.
- **Evidence:** `documents` (scope + nullable FKs to every entity, doc_type, storage_path, uploaded_party);
  private bucket `manifest-docs`, signed-URL two-phase upload (reuse Snorkel asset pattern).
- **`activity`** append-only event feed.

## 6. External auth

Access = (valid Supabase JWT) ∧ (active `store.users_profile` row) ∧ (`manifest_user_roles` row). The worker
`verifyJWT` does NOT check email domain — only validates the JWT against `/auth/v1/user` + active profile.
So: enable email OTP in GoTrue (project-wide; harmless — every other app gates on its own profile+role).
App login offers Google (LOT, keeps `hd`) + email OTP (SF, no `hd`). SF onboarding is manual & controlled:
create auth user → `users_profile` (active) → assign `sf_owner` role. Everyone else's JWT → null → denied.

**Permission keys** — LOT: `manifest_view, order_manage, shipment_manage, charge_manage, payment_record,
drawdown_manage, fx_manage, cost_view, doc_manage, china_po_sync, manifest_admin`. SF: `manifest_view,
sf_order_update, sf_evidence_upload, sf_drawdown_raise, sf_vendor_payment_record, sf_running_account_view`.
Seeded roles: `admin` (all+manifest_admin, is_system), `lot_finance`, `lot_founder`, `sf_owner` (party SF).
Afshaan seeded `admin`.

## 7. Snorkel China-PO projection

`china_po_sync`-gated action `projectToSnorkel(order_id)` idempotently upserts (keyed on
`orders.linked_po_number`): `store.purchase_orders` (`source='China'`, `status='Soft'`, `currency='CNY'`,
`po_number` minted `CN-<TYPE>-NNNN` via `next_seq('po')`, vendor + shipping/timeline copied) and
`store.po_lines` mapped **column-for-column** from `order_lines` (product, variant, color, item_type,
part_code, qty_ordered, unit, unit_price, component_type, receive_format, remote_qty, hsn_code, gst_percent)
so `seedReceivingLinesFromPO` SKD/CKD/FBU explode keeps working. Stamps linked_po_number/linked_at back.
Garage GRN/receiving unchanged — Manifest only feeds the front of that pipe.

## 8. FX auto-fetch

`manifestops` daily cron (wrangler.toml `[triggers] crons`) fetches CNY→INR from a free no-key API
(`open.er-api.com` / `exchangerate.host`) → inserts `fx_rates (source='auto')`. Reference only; actual bank
rate is always manual (per `vendor_payment`). Manual override wins for its date.

## 9. App pages

Snorkel skeleton: `(auth)` group, `RequireAuth`+Sidebar/Topbar, `lib/nav.js` (`filterNavByPerms`),
`lib/manifestui.js`, `garageFetch`/`workerFetch`. SF gets reduced nav + server-stripped cost fields.
- Dashboard (running balance, money-due provisional vs actual, orders by stage, shipments in transit,
  pending draw-downs, activity feed) · Orders (+new, +detail, project-to-Snorkel) · Shipments (+detail,
  consolidation builder) · Money (drawdowns, payments, vendor-payments, running-account statement, fx) ·
  Documents vault · Admin (roles, users + SF onboarding).

## 10. Build sequence (v1)

1. Spec (this file). 2. Migration `manifest_schema_v1`. 3. Worker scaffold + wrangler + deploy.
4. Worker handlers (auth/getMe → masters → orders/shipments/charges → money → running-account → fx → docs
→ projectToSnorkel → admin); data-path smoke per cluster. 5. App scaffold (dual login). 6. App pages.
7. `deploy-manifest.yml` + DNS + gh-pages repo. 8. SF onboarding (GoTrue OTP + 2 profiles + roles).
9. Knowledge files (systems/manifest.md, CORE tables, RULE-MANIFEST-001/002/003, BACKLOG v2).

## 11. v2 (next)

Landed CPU: allocate shipment charges across `shipment_lines` (duty by line CIF value; freight by
weight→CBM→value; clearing/local by value) → provisional CPU (estimates) → final CPU (actuals), LOT-only;
feed back into `material_master`/`bom_register` standard cost. Document generation (PO/PI/Invoice + running
statement via HTML+window.print, reuse Snorkel invoice + `poTax.js`). Optional Realtime; SF-invoice ↔
accrued-charge reconciliation tooling.

## 12. Verification (v1)

- DB smoke: order+lines → projectToSnorkel → confirm `store.purchase_orders` Soft/China + `po_lines` +
  Garage `seedReceivingLinesFromPO` dry-read. Post payment+vendor_payment+charge → query `running_account`
  → balance + money-due reconcile by hand.
- FX cron once → fresh auto row; manual override wins.
- Auth/party (live): LOT Google sees full cost surface; `sf_owner` OTP sees orders/shipping/running-account
  /inputs but NO CPU/margin (server-stripped); non-allowlisted email denied.
- Evidence: signed upload + download of PI/receipt/photo.
- `get_advisors` clean (0 rls_disabled) after migration.
