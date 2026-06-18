# Manifest — Document Generation (China PO + SF Invoice) — design

> Date: 2026-06-18 · System: Manifest · Worker: `manifestops` · App: `apps/manifest`
> Backlog: the v2 "Document generation" item, scoped down to **China PO + SF Invoice** (running-account statement + PI deselected).

## 1. Goal & decision

Let a user generate a clean, printable **China PO** and **SF Invoice** for a Manifest order, save it
as a PDF (via the browser print dialog), and re-download it any time.

**Chosen approach — browser-print route pages (the proven Snorkel pattern).** Each document is a
dedicated `'use client'` route page that fetches assembled data from a worker GET, renders formal
white-background HTML with inline print `<style>`, and auto-fires `window.print()`. The user picks
"Save as PDF". Generated on demand from live data → infinitely re-downloadable, always current.

Explicitly rejected (per Afshaan's latitude — "whichever is easier, no need to store"):
- **jsPDF / client PDF lib** — more build effort, new dependency; not needed.
- **Vault storage of the PDF** — nothing persisted; the order/invoice data is the source of truth and
  the doc regenerates on demand. (A later enhancement could snapshot issued invoices to `manifest-docs`
  if immutable copies are ever required — clean to add; out of scope now.)
- **Running-account statement, Proforma Invoice** — deselected.

## 2. Documents

### China PO (`/print/china-po?id=<order_id>`)
A purchase order from LOT to the order's Chinese vendor.
- **Header:** title "PURCHASE ORDER", PO number (`orders.po_number`, `CN-…`), order date.
- **Buyer (LOT):** name "Legend of Toys", GSTIN `29AAFCF7834H1ZA`, address from `store.company_addresses`
  (default billing) if available; else a hardcoded LOT block.
- **Supplier:** the vendor (`store.vendors` via the order's vendor code) — name, country, vendor code.
- **Lines:** from `order_lines` — vendor item code, description/product, qty, unit (pcs), unit price (RMB),
  line total (RMB). Columns currency = **RMB / CNY**.
- **Totals:** subtotal + grand total in **RMB**. **No GST** (non-INR is GST-exempt per `poTax.js`).
- **Footer:** simple terms line (mode/incoterm if present; else blank), "System-generated, no signature required."

### SF Invoice (`/print/sf-invoice?id=<order_id>`)
A formal GST tax invoice for an **invoiced** order (mirrors the Snorkel sales-invoice layout).
- **Header:** "TAX INVOICE", invoice no (`orders.invoice_no`, `VWINV-…`), invoice date (`orders.invoice_date`).
- **Seller:** the SF sub-entity (`manifest.sf_subentities` via `orders.billing_subentity`) — name + GSTIN/address
  if the row carries them; else name only.
- **Buyer (LOT):** name + GSTIN `29AAFCF7834H1ZA` + address (as China PO).
- **Lines:** the invoiced `order_lines` (those with `invoice_no` set) — description, HSN (if present), qty,
  taxable value (INR), GST % , and CGST/SGST **or** IGST per `poTax.js` (intra vs inter-state on the seller's GSTIN
  state vs LOT's `29`). Falls back to a single header line if the order was billed lump-sum (no per-unit ¥).
- **Totals:** taxable subtotal, CGST+SGST or IGST, **2.5% commission line** (`orders`/`sf_invoices` commission_inr,
  shown as a separate charge), grand total (INR), **amount in words**.
- **Footer:** "System-generated tax invoice."

GST math: reuse the rule in `apps/snorkel/src/lib/poTax.js` — INR only; intra-state (seller state == `29`) →
CGST+SGST 50/50; inter-state → IGST. Port the small helper into `apps/manifest/src/lib/docTax.js` (don't import
across apps).

## 3. Worker (manifestops) — two new GET reads

Both gated on `canManageDocs` (`doc_manage`) and run through the normal party/cost rules. They assemble
exactly what the print page needs so the page stays presentational.

- **`getPoDoc` (`?id=<order_id>`)** → `{ company, vendor, order:{po_number,order_date,currency,…},
  lines:[{vendor_item_code,description,qty,unit_price,line_total}], totals:{subtotal,grand} }`.
- **`getInvoiceDoc` (`?id=<order_id>`)** → `{ seller, buyer, invoice:{invoice_no,invoice_date},
  lines:[{description,hsn,qty,taxable,gst_percent}], tax:{cgst,sgst,igst,isCgstSgst}, commission_inr,
  grand_total, amount_in_words }`. Returns `null`/422 if the order isn't invoiced.

Schema-verify the actual columns of `orders`, `order_lines`, `vendors`, `company_addresses`,
`sf_subentities` before binding (the standing rule). No new write actions, no new tables, no migration.

## 4. App (`apps/manifest`)

- **`src/lib/docTax.js`** — ported GST helper (`computeTax`, `COMPANY_GSTIN`).
- **`src/lib/numberToWords.js`** — INR amount-in-words (reuse Snorkel's `amountInWords` logic; port locally).
- **`src/app/print/china-po/page.js`** + **`src/app/print/sf-invoice/page.js`** — `'use client'` pages,
  `useSearchParams()` for `id` (wrapped in `<Suspense>` for static export), `useAuth().session` to call the
  GET, render formal HTML with inline `<style>` (white bg, `@media print` clean margins), auto `window.print()`
  once data loads. Error/loading states like Snorkel's invoice page.
- **Buttons in `mf/screens.js` (OrderDetail):** a "China PO" button (order status `placed`+) and, on the
  **Invoiced** card, an "SF Invoice" button — each `window.open('/print/<doc>?id=' + order.id, '_blank')`.
  (These open a normal browser tab outside the SPA shell, so print CSS is isolated.)

No change to the Documents screen for v1 (these aren't stored). The Generate buttons are the entry points.

## 5. Static-export note

`apps/manifest` is `output: export`. The `/print/china-po` and `/print/sf-invoice` pages are statically
generated; the `id` is read client-side via `useSearchParams` (works under export, as Snorkel's invoice page
proves). No dynamic route segments.

## 6. Verification

- Build all apps green.
- Worker: `getPoDoc`/`getInvoiceDoc` return assembled data for a known order (anon → 401; deployed routes clean).
- Authenticated browser smoke (standing caveat): open an order → China PO prints with vendor + RMB lines + no GST;
  open an invoiced order → SF Invoice prints with correct CGST/SGST-vs-IGST split, commission line, amount-in-words.

## 7. Rollout
edit → build all → commit → push (app auto-deploys) → `cd manifestops-worker && npx wrangler deploy`.

## 8. Out of scope / later
PDF-lib generation; vault storage of issued docs; running-account statement; Proforma Invoice; packing list / BL.
