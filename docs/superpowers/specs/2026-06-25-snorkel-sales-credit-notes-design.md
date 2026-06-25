# Snorkel Sales Credit Notes — Design Spec

> Date: 2026-06-25 · System: Snorkel (Offline Sales) · Status: approved, pre-implementation
> Worker: `snorkelops` · App: `apps/snorkel` · Schema: `store`

## 1. Purpose & context

LOT bills offline-channel partners (GT/MT) via the Offline Sales module (`store.sales_*`),
issuing a GST **tax invoice** per sales order (already built: `generateInvoice` +
`/sales/orders/invoice`). After invoicing — and often after GST returns are filed — the
billed value sometimes needs to be reduced. A **sales credit note** is the GST instrument
for that reduction: it lowers the partner's net receivable and reduces our output-GST
liability so the next GSTR-1 balances against the portal.

**Triggers (all in scope):**
1. **Under-supply** — invoiced more than physically supplied (₹2L invoiced, ₹1.5L supplied → ₹50k CN).
2. **Transit loss/damage** on us — goods lost/damaged in transit, our responsibility.
3. **Sales return** — unsold inventory returned from a channel.
4. **Price drop after supply** — new discount / market correction; quantity unchanged, credit the per-unit rate difference.

A credit note **mirrors the invoice, line-item based, with credit (magnitude) values**.
It references exactly one original invoice. It is a **financial / GST document only — it does
NOT move inventory** (physical handling of returned/short goods stays with dispatch/Depot).

**Out of scope / deferred:** feeding issued CNs into Odo as returns (reduces net revenue,
dated to cn_date per RULE-SALES-001) — bundled with the pending GT/MT `sales.sku_map` work.
The CN data model is structured so odoops can consume it later without rework.

## 2. Data model (migration `snorkel_sales_credit_notes_v1`)

All tables `store`, RLS **enabled**, `GRANT ALL … TO service_role`, no anon/authenticated grants
(RULE-RLS-001). PostgREST numeric columns read back as strings → `Number()` in worker;
`Math.round()` integer inserts.

### `store.sales_credit_notes` (header)
| col | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `cn_no` | text | `LOT/CN/<YY-YY>/NNNN`; **null until issued**; UNIQUE (partial, where not null) |
| `order_id` | uuid NOT NULL | → `sales_orders.id` |
| `partner_id` | uuid NOT NULL | → `sales_partners.id` (denormalized for list/query) |
| `invoice_no` | text NOT NULL | snapshot of the original invoice number |
| `invoice_date` | date | snapshot |
| `cn_date` | date NOT NULL | default `CURRENT_DATE`; the issue/document date |
| `reason` | text NOT NULL | CHECK in (`under_supply`,`transit_loss_damage`,`sales_return`,`price_drop`,`other`) |
| `reason_note` | text | free text |
| `status` | text NOT NULL | default `draft`; CHECK in (`draft`,`issued`,`cancelled`) |
| `place_of_supply` | text | snapshot from order |
| `subtotal` | numeric NOT NULL | default 0; Σ line taxable (positive magnitude) |
| `tax_total` | numeric NOT NULL | default 0 |
| `grand_total` | numeric NOT NULL | default 0; positive magnitude = credit value |
| `created_by` | uuid | |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `issued_by` | uuid | |
| `issued_at` | timestamptz | |
| `cancelled_by` | uuid | |
| `cancelled_at` | timestamptz | |
| `cancel_reason` | text | |
| `updated_at` | timestamptz NOT NULL | default `now()` |

Indexes: `(order_id)`, `(partner_id)`, `(status)`, unique `(cn_no)` where `cn_no is not null`.

**Sign convention:** values stored as **positive magnitudes** (the document *is* a credit; its
effect is subtractive). Cleaner for sums, caps, and GST-portal listing (which lists positive
credit-note values). The printable doc + AR math treat them as deductions.

### `store.sales_credit_note_lines`
Mirrors `sales_order_lines`:
| col | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `credit_note_id` | uuid NOT NULL | → `sales_credit_notes.id` ON DELETE CASCADE |
| `order_line_id` | uuid | nullable → `sales_order_lines.id` (link to original; null for free-form) |
| `product` / `model` / `color` / `sku` | text | |
| `hsn_code` | text | |
| `description` | text | |
| `qty` | integer NOT NULL | default 0 (credited qty; for price-drop = original qty) |
| `rate` | numeric NOT NULL | default 0 (returns = original rate; price-drop = per-unit drop) |
| `discount_pct` | numeric NOT NULL | default 0 (parity with order lines; normally 0) |
| `gst_pct` | numeric NOT NULL | default 0 |
| `taxable_value` | numeric NOT NULL | default 0 (= qty×rate magnitude) |
| `gst_amount` | numeric NOT NULL | default 0 |
| `line_total` | numeric NOT NULL | default 0 |
| `sort_order` | integer NOT NULL | default 0 |

### `store.sales_orders` — new column
`credit_total numeric NOT NULL default 0` — rollup of **issued** CN `grand_total` for the order.

### Sequence
Per-FY GST-continuous credit-note number via `store.sequences` key `sales_credit_note_<YY-YY>`,
lazily created (plain insert ON CONFLICT ignored, then `next_seq`) — **never merge-duplicates**
(would zero an existing counter). Indian FY Apr–Mar. Mirrors `nextInvoiceNo`.
Helper: `nextCreditNoteNo(date)` → `LOT/CN/<YY-YY>/NNNN`.

## 3. Worker actions (`snorkelops-worker/src/index.js`)

**Reads** (gate `canSalesView`):
- `getCreditNotes` — list with filters (partner_id, order_id, status, from/to date) + KPIs
  (count, total credited value, total GST credited). Joins partner name.
- `getCreditNote` — single CN: header + lines + order + partner + seller (registered-office
  `company_addresses`) + `intra` flag + per-line CGST/SGST/IGST split (computed exactly like
  `getSalesInvoiceData`). Drives detail + print.
- `getOrderForCreditNote` — given `order_id` (must be invoiced): returns order + its lines +
  per-line **already-credited qty** (Σ from issued/draft CN lines) + **remaining cap** per line
  and overall (invoice grand_total − Σ existing CN). Pre-fills the new-CN form and enforces caps.

**Writes:**
- `createCreditNote` (gate `canSalesCreditNote`) — validates order `invoice_generated=true`;
  inserts header (`status='draft'`) + lines; computes subtotal/tax/grand from lines (gst_amount
  = taxable×gst_pct/100; line_total = taxable+gst); cap check.
- `updateCreditNote` — **draft only** (422 otherwise); replaces lines atomically; re-validates caps.
- `issueCreditNote` — `draft→issued`; mint `cn_no`; stamp `issued_by/at`; re-validate caps at
  issue; `recomputeOrderCredit(order_id)`.
- `cancelCreditNote` — `issued→cancelled` (or `draft→cancelled`); `cancel_reason` required;
  `recomputeOrderCredit(order_id)`. (v1 does not track GST-filed state, so cancel is allowed with
  a reason; revisit if a filed-lock is needed.)
- `deleteCreditNote` — **draft only**, hard delete.

**AR recompute:**
- `recomputeOrderCredit(order_id)` — set `sales_orders.credit_total = Σ grand_total of issued CNs`,
  then recompute `payment_status` against **net = grand_total − credit_total**.
- `recomputeSalesPayment` (existing) — updated to use net (`grand_total − credit_total`) when
  deriving `payment_status` (unpaid/partial/paid) and never marking paid above net.

## 4. Guards / invariants
- Only `invoice_generated=true` orders are eligible (else 422).
- **Cap:** Σ(issued CN grand_total) + this CN ≤ order.grand_total (hard 422). Per **return/under-supply**
  line linked to an `order_line_id`: credited qty (cumulative across CNs) ≤ original line qty.
- **price_drop** lines: qty = original qty, rate = per-unit drop; taxable ≤ original line taxable.
- **transit_loss_damage / other:** free-form line allowed (`order_line_id` null) — description + qty + rate.
- GST split: `intra` when seller registered-office state == place_of_supply state → CGST+SGST,
  else IGST; rate from line `gst_pct`. Snapshot place_of_supply from the order.
- `cn_no` per-FY continuous, lazy seq, never merge-duplicates.
- All tables RLS-on, service_role-only.

## 5. Permissions (RULE-SNORKEL-002 layer)
New key **`sales_credit_note`** (bool) — create/edit/issue/cancel/delete. Reads gate on
`sales_view`. Seeded `true` on `sales_manager` + `admin`; `sales_rep` = read-only (sales_view).
Added to the `/admin/roles` permission matrix (PERM_DEFS) so it's a real, enforced key.

## 6. App (`apps/snorkel`)
New **Credit Notes** entry in the OFFLINE SALES nav group (`src/lib/nav.js`, gate `sales_view`).
- `/sales/credit-notes` — list (KPIs, table: cn_no/partner/invoice/cn_date/value/GST/status,
  filters, CSV export). Local components (PageHead/Kpi/Panel/Badge/`.dt`).
- `/sales/credit-notes/new?order=<id>` — form: searchable Combobox of **invoiced** SOs (skip if
  `?order=` passed); on select, load `getOrderForCreditNote` → render invoice lines with
  credit-qty + rate inputs (capped, default 0), reason dropdown + note, "+ add free-form line",
  live totals + CGST/SGST/IGST preview. Save = `createCreditNote` (draft) → detail.
- `/sales/credit-notes/detail?id=<id>` — header + lines; **draft**: inline edit + Issue + Delete;
  **issued**: Cancel + **Print Credit Note**; shows linked order/invoice + net-due impact.
- `/sales/credit-notes/print?id=<id>` — **CREDIT NOTE** document, clones the invoice template
  styling: title "CREDIT NOTE", header (CN No / CN Date / **Original Invoice No + Date** / Order No /
  Place of Supply / Reason), bill-to/ship-to, line table (qty/rate/taxable/CGST+SGST|IGST/amount),
  amount-in-words, note "Issued against Invoice <no> dated <date>", authorised-signatory. Print
  button + auto-print (when issued) → browser Save-as-PDF.
- **SO detail** (`/sales/orders/detail`): add Credit Notes panel — list CNs for the order, show
  **net due = grand_total − credit_total − amount_received**, "Raise credit note" button →
  `/sales/credit-notes/new?order=<id>` (gated on `sales_credit_note`).
- **Collections** (`/sales/collections`): reflect net due after credits.
- `src/lib/sales.js`: `CREDIT_NOTE_REASONS` + label/format helpers; reuse `inr`/`amountInWords`/`fmtDate`.

## 7. Docs
- **RULE-SNORKEL-004 add #9 (Credit notes)** in `systems/snorkel.md`: 1↔1 invoice, line-item
  magnitudes, cap ≤ invoice, draft→issued→cancelled, `LOT/CN/<FY>/NNNN` lazy seq, reduces net AR +
  output GST, financial-only (no stock), Odo-return feed deferred.
- Update `systems/snorkel.md` Offline Sales section + CORE.md schema map (`sales_credit_notes*` +
  `sales_orders.credit_total`).
- In-app manual chapter (in-system upkeep, same PR; `build.py` + `build-manual-web.py`).

## 8. Build sequence (for the plan)
1. Migration (tables + column + grants + RLS + indexes); verify advisor-clean.
2. Worker: helpers (`nextCreditNoteNo`, `recomputeOrderCredit`, split reuse) + reads + writes +
   `recomputeSalesPayment` net update + perm key; deploy.
3. App: nav + list + new + detail + print pages + SO-detail panel + collections net; build all
   monorepo apps clean.
4. Docs + manual; commit/push.
5. Verify data-path (create→issue→AR recompute→cancel) via SQL/worker; live browser smoke flagged
   (OAuth-gated, same as existing sales module).

## 9. Test / verification
- Unit-ish (SQL/worker): create draft against an invoiced SO; cap rejection (> invoice, > line qty);
  issue mints sequential `LOT/CN/<FY>/NNNN`; `credit_total` + `payment_status` recompute (₹2L inv,
  ₹50k CN, ₹1.5L received → paid); cancel reverses; price_drop line (qty kept, rate diff).
- GST split correct intra vs inter (use a KA partner and an out-of-state partner).
- Print page renders for an issued CN; auto-print fires.
