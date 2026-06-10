# Drift 1 — Shared-Bottom Platform Model (Shadow + Flare)

> Status: DESIGN (approved in conversation 2026-06-10, Afshaan). Build pending Supabase
> reconnect. Author: S117.

## Problem

LOT is moving to a **platform** model: one shared **bottom** (chassis + all internals +
remote — most of the BOM) reused across multiple **branded products** whose only real
difference is the **top** (new mould) plus a few connector/cosmetic parts and the
outward kit (box/manual/license/packaging).

First instance: a new top mould lets us build **Flare** on **Shadow's bottom**. Both
Shadow and (new, India-made) Flare share the same bottom; only tops differ. They remain
**distinct customer products** with their own EANs/UPCs.

Today the word "product" is overloaded: `bom_register.product` (BOM grouping) +
`SH-*/FL-*` part prefixes (identity/stock) + `product_master.product` (brand/SKU/EAN) are
forced to be the same string. Sharing a bottom across brands by **copying** it into each
product's BOM would create N drifting copies. We need the bottom defined **once**.

## Key constraints (from Afshaan)

- **EANs cannot change** and are not duplicated. So **no new product_master rows** for the
  new Flare — Flare and Shadow stay the *same* products (same SKU/EAN); only their **BOM is
  re-pointed**. Old vs new is a temporal/parts-level distinction, not a product-level one.
- The platform is **internal-only**, never customer-facing, never sold bare.
- Bottom-part change must **propagate to every product on the platform** (single source of truth).
- Stock of bottom parts is **pooled**; production runs are **per product** (pick bottom from
  pool + add the product's top); each finished unit gets its **own product's UPC**.
- Procurement/receiving is **per-part PO line items** (plastics PO, metals PO, para PO…),
  not a CKD-unit explode.
- Scale: ~2-3 platforms × ~4-5 products each.

## Model (Approach 1 — platform as a BOM layer)

Three layers resolved at run time:
1. **Platform `Drift 1`** owns the shared **bottom BOM once** — `bom_register` rows with
   `product='Drift 1'`, `common_variant='Common'`, covering the shared chassis + internals +
   remote. Platform-specific parts get **new `D1-*` codes** with **one pooled `stock_ledger`
   row each**. Universal parts (`UNV-*`/`HW-*`) are referenced as-is (NOT recoded).
2. **Product delta** — each product (Shadow, Flare) keeps only its own rows: tops (per
   variant, `common_variant='Variant'`), connector/spoiler/mount parts, and its outward kit
   (box/manual/license/stickers/packaging). Product-prefixed codes (`SH-*`, `FL-*`).
3. **Mapping** — `store.product_platforms (product text PK, platform text NOT NULL)`:
   `Shadow → Drift 1`, `Flare → Drift 1`.

**Resolution:** a run whose product is mapped to a platform resolves its picklist to
`platform Common bottom ∪ product delta`. For a product with **no** mapping, behaviour is
**identical to today** (no-op) — so every other product is untouched.

### Identity / old-vs-new
No product-level flag. Flare/Shadow are continuous products (same SKU/EAN). The implicit
identifier separating China (old) from Drift 1 (new) units is the **production run** that
built each unit (+ its date): pre-cutover runs resolve the old BOM, post-cutover the
platform. Units key on `product_code` (unchanged), so unit/scan/dispatch history is
continuous. Trade-off accepted: old vs new finished units cannot be told apart by barcode,
only by their run. Leftover China-Flare stragglers, if ever processed, get a fresh EAN
manually on EAN-tolerant channels (out of scope here).

## What changes per surface

- **Picklist resolver** (`getProductionRun`, `getProducibility`) — the one code change: union
  the platform bottom when mapped. lotopsproxy (3-system blast radius) → careful testing.
- **Receiving** — unchanged; per-part POs reference `D1-*` for the bottom, `FL-*/SH-*` for delta.
- **Stock** — bottom pooled under `Drift 1`; delta per product.
- **UPC / scanning / dispatch** — unchanged (units key on `product_code`; EANs unchanged).
- **Other products** — untouched (resolver no-op without a platform mapping).

## Execution sequence (each step snapshotted/reversible)

0. **Classify (DB read):** generate Shadow's bottom↔delta split; flag universal parts
   (stay universal, never `D1-*`); read Flare's variant structure to map the new
   Burnout/Race tops. Refine with Afshaan.
1. **Resolver + mapping (code, no behavior change):** add `store.product_platforms`; make
   the resolver union platform `Common` when mapped. No-op today (nothing mapped). Deploy +
   confirm nothing moves. **MUST precede any BOM re-point.**
2. **Stand up Drift 1:** mint `D1-*` bottom — `material_master` + `bom_register`
   (`product='Drift 1'`, Common) + `stock_ledger` rows at 0; reference universal parts as-is.
   (Ledger rows must exist before any GRN — `bulk_update_stock_received` is UPDATE-only.)
3. **Transfer Shadow bottom stock `SH→D1`:** snapshot; set each D1 `opening_stock` to the SH
   balance, draw SH to 0 (via `opening_stock` — `closing_stock` is generated, RULE-005);
   verify totals conserved.
4. **Re-point Shadow:** map Shadow→Drift 1; drop migrated bottom rows from Shadow's
   `bom_register` (keep tops/packaging delta). **Verify invariant:** Shadow resolved picklist
   (`D1 ∪ Shadow delta`) == old picklist, part-for-part, on a sample run.
5. **Stand up new Flare on platform:** map Flare→Drift 1; mint new `FL-*` India top codes
   (Burnout/Race) + ledger rows + Variant BOM rows; drop Flare's old bottom rows from its
   BOM; keep packaging/license. Old FL bottom + old tops fall out of the active BOM
   (system-side quarantine); their stock strands (physical quarantine + later write-off).
6. **Inward:** per-part POs against `D1-*` + new FL tops flow normally into pooled stock.
7. **Smoke:** Shadow run + Flare run resolve correct picklists; receiving against D1 works;
   UPC/scan/dispatch unchanged; other products unchanged.

**Cutover timing:** run Phase 4-5 flips when Flare/Shadow have **no open runs**; build-out or
quarantine remaining China WIP first (no "back" to the old BOM once swapped).

## Failure modes & mitigations (the "what breaks")

1. **Re-point before resolver → picklist loses the bottom.** Mitigate: Phase 1 first; resolver
   no-op until mapped.
2. **Receiving/issuing a `D1-*` code with no ledger row → silent zero move** (UPDATE-only).
   Mitigate: Phase 2 mints ledger rows first.
3. **Stock transfer corruption.** Mitigate: `opening_stock` only (RULE-005), atomic, snapshot.
4. **Renaming a universal part into `D1-*` corrupts every other product.** Mitigate: only
   `SH-*/FL-*`-specific bottom parts move; universals stay universal, referenced as-is.
5. **Open Flare/Shadow run mid-flip breaks.** Mitigate: flip when quiescent; finish/quarantine WIP.
6. **Stranded old Flare stock** — accounting/quarantine only, not a system break (parts simply
   out of the active BOM; keep active or deprecate later — no functional difference).
7. **`grn_summary` product count** (RULE-003): `D1-*` parts carry `product='Drift 1'`
   (platform-scoped, distinct from universal `''`). Verify a mixed GRN's product count is sane.

## Open items (resolve when DB reconnects)

- Shadow bottom↔delta split (live, line-by-line) — refine with Afshaan.
- Flare variant structure: do "Flare Burnout / Flare Race" replace the existing Burnout/Race
  colour variants (swap the top part inside each `variant_model`) or form a new variant set?
- Confirm `grn_summary`/stock views handle `product='Drift 1'` gracefully.
