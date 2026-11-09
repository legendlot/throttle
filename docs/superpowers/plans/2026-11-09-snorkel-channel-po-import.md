# Snorkel: channel PO file → draft sales order (plan)

Harsh `#bugs` `1793871854.409349`. Samples received 2026-11-09 (`1794224462.796779`). Plan written S443; not built.

## What the samples are

| File | Channel | Format | Line identifier on the PO | Matches today |
|---|---|---|---|---|
| `P6150806.pdf` | Zepto | PDF (Qt 4) | Material code `96747869`, SKU code (UUID, wraps over 2–3 lines), **EAN** | EAN → `product_master` ✅; SKU UUID → `sales.sku_map` (Zepto, 26 rows) ✅ |
| `CMFPO…476.pdf`, `KOCPO…078.pdf` | Swiggy Instamart (billed as Scootsy Logistics, per-FC GSTIN) | PDF (Qt 5), same layout both | Item code `140019`, `646970` — no EAN | `sku_map` Instamart (15 rows) ✅ both codes present |
| `PO_2026_10_1421.pdf` | Peeko (Zippycubs) | PDF (OpenPDF), table cells wrap badly | VSKU `04_108309`, **EAN split across 2 lines** | EAN → `product_master` ✅ after reassembly |
| `purchase_order_FLSHM4VFE4XN.xlsx` | Flipkart Minutes (hyperlocal, Anekal, intra-state KA) | xlsx, fixed columns from row 16–17 | FSN `RCTHK8ATQPC2MQPA`, EAN often blank, title | `sku_map` Flipkart Managed FSN rows ✅ |
| `purchase_order_FLSJD88U0HRZ.xlsx` | Flipkart National (Alpha, inter-state MH) | same xlsx | same | ✅ 3 of 3 checked |

Every channel code spot-checked (8 codes, 4 EANs) already resolves to a `product_code` — the hard part (code → product) exists.
**No Blinkit sample** although Harsh's ask named Blinkit — ask for one.

## How Snorkel makes an SO today

- `store.sales_orders` (partner_id, channel_key, order_date, `partner_po_ref`, status) + `store.sales_order_lines`
  (product, model, color, sku, hsn, qty, rate, gst%).
- `createSalesOrder` — `05_Throttle/snorkelops-worker/src/index.js:6650`. Rate and qty are user-typed; HSN/GST filled
  from `product_master`; **no product-exists check, no price lookup**.
- Picker — `apps/snorkel/src/app/(auth)/sales/orders/OrderForm.js:84`, keyed on product family + model + colour.
- Partners: `store.sales_partners` has `gstin`, `channel_key`; ZEPTO 5, INSTAMART 21, FLIPKART_MGD 20, PEEKO 1.
- No PDF/xlsx parsing anywhere in Snorkel today.

## Design

1. **Sales → Orders → "Import PO"**: drop one file.
2. **Parse in the browser** (pdf.js text with positions; SheetJS for xlsx). One small parser per layout, chosen by
   detecting the buyer (Zepto / Scootsy / Zippycubs / Flipkart text + GSTIN). Output a neutral shape:
   `{channel, po_no, po_date, expiry, delivery_date, bill_to_gstin, ship_to_gstin, ship_to_address,
   lines:[{channel_code, ean, title, qty, unit_cost_ex_gst, mrp, gst_pct}], po_total_taxable, po_grand_total}`.
3. **New worker route `previewSalesOrderImport`** (snorkelops, `sales_order_manage`):
   - partner = `sales_partners` by ship-to GSTIN within the channel (Instamart has many FCs per GSTIN → also city /
     address match; ambiguous → user picks);
   - each line → `sku_map(channel, channel_code)` → else EAN in `product_master` → else **unmatched** (flagged red);
   - duplicate guard: refuse if a non-cancelled SO already has this `partner_po_ref`;
   - checksum: sum(qty × unit cost) must equal the PO's taxable total within ₹1, else a visible warning.
4. **Review screen = the existing OrderForm, pre-filled.** Unmatched lines need a product picked before Save. Save goes
   through the existing `createSalesOrder` — no second write path. Rate = the PO's unit base cost ex-GST.
5. Keep the uploaded file on the SO (storage bucket) for audit.

## Phases

- **P1 (one session):** Flipkart xlsx (both), Instamart PDF, Zepto PDF + the preview route + review screen. Tests: parser
  unit tests on text fixtures extracted from the samples (not the raw PDFs — they carry buyer addresses/contacts),
  route tests for match / unmatched / duplicate / checksum. `builder` (opus) + `/hostile-review`.
- **P2:** Peeko (wrapped-cell reassembly), Blinkit once a sample arrives, any other channel Harsh sends.

## Decisions for Afshaan before building

1. ✅ **DECIDED 2026-11-09 (Afshaan): fixed parsers.** No Claude API. Was: **Parsers vs AI extraction.** Plan above uses fixed parsers: free, predictable, but each new channel or layout change
   needs code. Alternative: send the file to the Claude API and validate the result with the same checksum + matching —
   handles any layout, but needs an Anthropic API key as a worker secret (none of our workers calls it today) and a few
   paise per PO.
2. **Learn new codes into `sales.sku_map`?** When someone picks a product for an unmatched code, saving that mapping
   makes the next PO match automatically — but `sku_map` is Odo's sell-out map, so the write is shared with Odo's
   numbers. Alternative: a separate SO-import map.
3. **P1 scope** — confirm the four layouts above, and get a Blinkit sample.
