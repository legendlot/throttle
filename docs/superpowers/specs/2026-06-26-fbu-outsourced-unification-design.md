# FBU + Outsourced-Run Unification — Design

> **Status:** Design approved in shape (S178, 2026-06-26). Awaiting spec review → implementation plan.
> **Scope:** LOT Ops cluster (Garage + Redline + Scanner) on `lotopsproxy` + `store`/`public` schemas.
> **Author:** Claude Code (with Afshaan).
> **Blast radius:** HIGH — `lotopsproxy` serves Garage + Redline + Scanner; the picklist matcher change touches *every* production run. Phased rollout + snapshots mandatory.

---

## 1. Problem

Built-up units ("FBU" — Fully Built Units) are tracked by a **parallel, incompatible mechanism** that doesn't reconcile with the rest of the parts system, and the **outsourced (job-work) run flow** layered on top of it is too complex for the floor to follow. Two symptoms, one root cause.

### 1.1 The FBU split-brain (live evidence, 2026-06-26)

Two accounting systems hold the same physical built car and never share receipts:

- **Native `fbu_stock` path** — FBU GRN → `fbu_grn_register` + `fbu_stock` (a count pool keyed `product|variant|color|component_type`); production via `issue_mode='fbu'` runs that *skip* the `Car`/`Sticker` BOM categories and deduct `fbu_stock`. Live balances: **Rift 1,710 · Dash 2,000 · Rumble 1,131 · Mac 600 · Nitro ~428** cars.
- **S122 part-code workaround** — a built car/remote minted as a first-class part (`RI-CAR-01`, `RU-CAR-01`, `RI-RM-01`, …) so it bags + scans like any CKD part. But these live in `stock_ledger`, which **never receives the FBU GRN**, so they run **negative**: `RI-CAR-01 −280 · RI-RM-01 −310 · RU-CAR-01 −288 · RU-RM-01 −237`.

So Rift/Rumble are simultaneously **+1,710 in `fbu_stock`** and **−280 in `stock_ledger`** for the same cars. Every new FBU shipment needs a manual recode to keep limping. The disconnect is **entirely on the receiving side** — production already consumes part codes.

### 1.2 Outsourced runs (live evidence)

The two-phase model (one `EXT-NNN` run carrying *build* → send-to-vendor → in-house *finish*, parts split by `outsource_bom_split`) + the `ext_return_pool` count pool + the `EXT_INW` scanner station is **created but not progressed**: EXT-004…EXT-016 (11 Shadow/Ghost runs) are **all stuck at `Issued`** — none sent in-system, none with a return line, none requesting finish. Floor feedback: the **store-level pooling causes simple mistakes**, the **two-phase split confuses**, **reconciliation/visibility is poor**, and it's **tangled with FBU** (the EXT-003 ↔ FBU GRN-203 Shadow/Mudra collision). There is also **no clear, linked way to issue *more* materials to a vendor** when the first issue was short.

### 1.3 The unifying realization

The PO layer already proves the right model. Every "unit" PO line is identical — `part_code=null`, carries `product/variant/color/remote_qty`, and a `receive_format` that decides how it lands:

| `item_type` / `receive_format` | Lands in stock as… | Run consumes… |
|---|---|---|
| **CKD Unit** (Ghost, Wisp…) | granular parts → `stock_ledger` | granular CKD BOM |
| **SKD Unit** (Flare) | SKD bundle parts → `stock_ledger` | `bom_format='SKD'` rows |
| **FBU Unit** (Rift, Dash…) | *today:* `fbu_stock` ❌ + skip-category hack ❌ | — |

CKD and SKD already do what we want. **FBU is the only format that breaks the pattern.** The fix: make FBU behave exactly like SKD — its "bundle" is simply the whole built car (+ remote). RULE-SKD-001 already establishes every piece of machinery required. *(The table above is the **current** PO-marker-driven discriminator; §4 moves the **binding** format decision to receipt-side declaration — the PO marker becomes advisory.)*

---

## 2. Goals / Non-goals

**Goals**
1. Every FBU SKU's built car/remote is a **first-class part** (`<PROD>-CAR-01` / `-RM-01`) in `stock_ledger` — in line with all other parts. One stock number per built component.
2. **Retire** the parallel apparatus: `fbu_stock`, `fbu_grn_register`, `fbu_issue_register`, `issue_mode='fbu'` skip-categories, `fbu_includes_remote`, `ext_return_pool`, `EXT_INW`, the `fbu_products` heuristic.
3. **Source accountability** preserved: every built-part receipt is tagged `fbu_purchase` vs `jobwork`+`EXT-NNN`. One stock number; the receipt ledger carries provenance.
4. **ITC-04 compliance** preserved: the outsourced loop keeps a single tracked object (`EXT-NNN`) linking materials-out (challan) ↔ built-cars-in (source-tagged GRN).
5. Outsourced flow simplified to remove the pooling/two-phase confusion; add a first-class **"issue more to vendor"** path.
6. Robustness: the **PO → receiving → stock → kit/producibility/coverage → run** chain references the built-car part uniformly, with `po_lines.qty_received` written back.

**Non-goals**
- No change to dispatch / scanner downstream of PKG (already format-agnostic, keys on `product_code`).
- No change to how POs are *raised* (the `receive_format` + `remote_qty` differentiator stays).
- No per-finished-unit source attribution (built cars are physically fungible once stocked; source lives on the receipt).
- Marketplace/cost accounting unchanged.

---

## 3. Data model

### 3.1 `bom_format` becomes a real 3-value dimension + a shared tag

`store.bom_register.bom_format` today carries only `CKD` + `SKD`. Extend to:

- **`CKD`** — granular sub-components (assembled in-house).
- **`SKD`** — pre-assembled bundles (`<PROD>-SKD-NN`).
- **`FBU`** — the whole built car/remote as a part (`<PROD>-CAR-01` / `-RM-01`).
- **`ANY`** — *format-agnostic* shared rows (the outward kit: Packaging, Para, Primary Packaging, Battery/AA, Accessories, Charger Cable, and Stickers that are not format-specific).

**The car/remote *representation* is format-specific; the *outward kit* is `ANY`.**

### 3.2 Per-product capability = which format rows exist

- **Pure-FBU** (Rift, Rumble, Dash, Mac, Nitro): only `FBU` (built car + built remote where delivered built) + `ANY` rows. No granular alternative; cannot be outsourced (nothing to send).
- **Dual-format** (Shadow; Ghost where it has both): keeps its full granular `CKD` car/remote rows **and** gains `FBU` rows (`SH-CAR-01` [+ `SH-RM-01`]) + `ANY` kit. Can be assembled in-house (CKD) *or* finished from a built car (FBU, via purchase or job-work).
- **Pure-CKD** (most products): unchanged.

### 3.3 Built-part minting

For every FBU SKU, ensure `<PROD>-CAR-01` (always) and `<PROD>-RM-01` (when the remote is delivered built — e.g. Rift/Rumble carry `remote_qty=car_qty` on their FBU POs) exist in `bom_register` (format `FBU`, category `Car`/`Remote`, `qty_per_unit=1`, `variant_model='Common'`), `material_master`, and `stock_ledger`. Today present: Rift/Rumble (car+remote), Dash/Mac/Nitro (car only — confirm remote-built status with Piyush). **Missing: `SH-CAR-01` for Shadow** (and any dual-format Ghost variant). Built parts carry product-scoped codes; they never reuse CKD codes (mirrors RULE-SKD-001 §3).

### 3.4 Receipt source attribution

Add to `store.grn_register` (and the FBU branch of receiving): **`source`** ∈ `{fbu_purchase, jobwork}` and **`ext_run_no`** (nullable, set when `jobwork`). This is the accountability + ITC-04 key. (Reporting reads receipts grouped by `source`/`ext_run_no`; stock stays one number.)

### 3.5 Retirements (frozen, not dropped, until cutover verified)

`fbu_stock`, `fbu_grn_register`, `fbu_issue_register`, `ext_return_pool` are frozen and archived. `product_master.fbu_includes_remote` becomes unused (the FBU BOM expresses what's delivered built). `outsource_bom_split`'s build/finish two-phase use is retired (finish is decoupled — see §6).

---

## 4. POs & receiving — receipt-side format (captured truth)

**The format is declared at receipt, from physical inspection, and is binding.** The PO is raised at the product level ("buy N of product X"); it carries an *advisory* intended-format only for (a) price/GST basis and (b) a mismatch warning — it **never** decides how stock lands. Rationale: the format is a physical fact the receiver is looking at; this removes PO-vs-actual drift (the EXT-003 ↔ GRN-203 class of bug) and the malformed-line failure mode, and the part-level forecasting it would have fed doesn't exist today (coverage keys on `part_code`, which unit-PO lines lack — §9 case 11).

- **Flow:** shipment created against a PO → receiver opens it, inspects, and **declares CKD / SKD / FBU** → the worksheet explodes from the **declared** format's BOM → count → GRN. `seedReceivingLinesFromPO` becomes `seedReceivingLines(shipment, declaredFormat)` — explode from the *declared* format, not a PO marker; the `line_type='fbu' → fbu_stock` path is removed.
  - **CKD declared** → explode granular CKD BOM (part-level lines; receiver counts parts).
  - **SKD declared** → explode `bom_format='SKD'` bundle parts.
  - **FBU declared** → land the built unit **1:1**: `<PROD>-CAR-01 × car_qty` (+ `<PROD>-RM-01 × remote_qty` when the product's FBU built-part list includes a built remote). No heavy "explosion" — a direct mapping.
  - **part-level line** (a genuine components PO with a real `part_code`) → received 1:1; no format question.
- **Soft mismatch warning (non-blocking).** If declared format ≠ the PO's intended-format, surface *"Purchased format (X) ≠ received format (Y) — escalate."* and proceed. **Received is always the truth**; the warning is a signal for procurement, never a gate.
- **GRN writes `source`** (context-derived, **not** receiver-declared): `fbu_purchase` for a purchase PO, `jobwork` + `ext_run_no` for a vendor return (§6). Source and format are independent axes — the receiver can see the *form* but not the *origin*.
- **`po_lines.qty_received` write-back** (robustness, fixes the 0/657 gap): every GRN increments it so coverage / pending-PO / kit see the true outstanding qty. All formats.
- **`stock_ledger` rows must pre-exist** for built-part codes before GRN (`bulk_update_stock_received` is UPDATE-only — RULE-SKD-001 §5); §3.3 mint covers this.

---

## 5. Production & issue

### 5.1 Format-aware matcher (the core change)

The picklist matcher is currently strict-equality (`(b.bom_format||'CKD') === runFmt`), which would strand `ANY` kit (and already strands SKD's kit — a latent gap). Change to:

```
woBom = allBom.filter(b => variantModels.has(b.variant_model)
                        && ['CKD','SKD','FBU'].includes(runFmt)
                        && [(runFmt), 'ANY'].includes(b.bom_format || 'CKD'));
```

Applied to **every BOM reader**: `getProductionRun`, `calcKit`, `getProducibility`, `getPartCoverage`, `checkRunBomStock`, `getBOM`. This is required so a dual-format product doesn't double-count (need granular parts *and* built-car). For pure-FBU products `calcKit`/producibility *just work* once the built-car part has real `stock_ledger` balance. **Remove** the FBU skip-category block, `fbu_lines`, `fbu_available`, and `fbuIncludesRemote` from `getProductionRun`; **remove** the `fbu_stock` deduct from `issueAgainstRun` (the built car deducts `stock_ledger` like any part).

### 5.2 Trigger vs fulfillment (resolves "store acts only on requests")

- **Production triggers** — creates the run (the request). Store never self-initiates.
- **Format is a fulfillment decision** (which inventory to draw down) = store's call, *in response to* the request. Store keeps a clean **"Fulfill as: CKD parts (N) │ FBU built unit (M in stock)"** toggle at issue time (`setRunIssueMode`, reframed). Forced FBU for pure-FBU SKUs; forced CKD for pure-CKD; the choice appears only for dual-format products (detected by the presence of `bom_format='FBU'` rows — replacing the `fbu_products`/`fbu_stock` heuristic).
- Run-creation default `issue_mode` continues to resolve from `product_master.receive_format` (planner + manual paths).

### 5.3 Unit birth unchanged

The serial `units` row is born at the normal `INW` station (worker.js:5537) from a UPC sticker, with the existing product/line guard for cars **and** remotes. An FBU finishing run flows through the standard `fresh` category (`INW→QC_PASS→QC_FAIL→WKS→PKG→PKG_OUT`) — no FBU-specific unit lifecycle. The built-car part is consumed at *issue* (deduct `stock_ledger`); the unit is serialized at `INW`. Dispatch is untouched.

### 5.4 Short supply

A short built-car balance at issue uses the **existing** short-issue WO flow (RULE-SHORT-001 / RULE-001) unchanged — it's now an ordinary part.

---

## 6. Outsourced runs (collapse into the part flow)

**Outsourced = a dual-format-product activity** (you can only send raw materials for a product with a granular CKD car BOM — Shadow, Ghost; pure-FBU SKUs are bought-built only). The two-phase-on-one-run + `ext_return_pool` + `EXT_INW` collapses to:

1. **Create `EXT-NNN`** (`run_type='outsourced'`, `vendor_id`) — the job-work order and single ITC-04 object.
2. **Issue raw materials** against EXT-NNN = the product's granular **CKD build components** (Car + Remote sub-parts; the `ANY` finish kit and the FBU built-part are NOT sent). Deduct `stock_ledger`, ride a **delivery challan out**. *[materials OUT]*
3. **Short-supply-to-vendor** = a first-class **"Issue more to EXT-NNN"** action → linked supplementary issue on a fresh challan. (Closes the "no clear linked path" gap.)
4. Vendor builds, returns built cars → **GRN as `<PROD>-CAR-01`** into `stock_ledger`, `source=jobwork`, `ext_run_no=EXT-NNN`. *[units IN — ITC-04 reconciles materials-out ↔ built-cars-in on EXT-NNN]*
5. **`ext_summary {planned, returned, pending}`** recomputed from the built-car GRN qty tagged to the run (replaces the per-unit EXT_INW count + pool drain).
6. **Finishing = an ordinary FBU run** (§5) consuming the now-stocked built-car part + `ANY` kit → `INW→QC→PKG`. Decoupled; run whenever; may blend FBU-purchased + vendor-built cars.

**Removed:** `markRunSentOut`→`requestExtFinish`→`assignOutsourcedLine`→`receiveExtUnits`→`postExtInw` two-phase chain (replaced by: issue-materials + GRN-as-part), `EXT_INW` scanner station + its `OPERATOR_GATE_STATIONS` entry + the scanner `outsourced` category, the RULE-EXT-001 FBU/EXT dedup warning (no split remains).

**Preserved:** one EXT object end-to-end for ITC-04 (challan-out + source-tagged GRN-in); per-source counts via the GRN `source`/`ext_run_no` tag.

---

## 7. Affected touchpoints (inventory)

**Worker (`01_worker/worker.js`)**
- `seedReceivingLinesFromPO` (~778) — FBU explode-from-FBU-BOM → stock_ledger; drop `line_type='fbu'`.
- `raiseGRNFromReceiving` (~16028) — FBU lines post to `grn_register`/`stock_ledger` + `source`/`ext_run_no`; drop `fbu_grn_register`/`fbu_stock`; write `po_lines.qty_received` back.
- `getProductionRun` (~3240) — format matcher; remove skip-categories/`fbu_lines`/`fbu_available`/`fbuIncludesRemote`.
- `calcKit` (~2258), `getProducibility` (~2647), `getPartCoverage` (~4756), `checkRunBomStock`, `getBOM` (~1942) — format-aware.
- `createProductionRun`/`resolveIssueMode` (~16799, ~17002), `issueAgainstRun` (~17450) — drop fbu deduct; built-car = ordinary part.
- `setRunIssueMode` (~17415) — reframe as the store fulfillment toggle; dual-format detection via `bom_format='FBU'`.
- `getProductCatalogue` (~2594) — replace `fbu_products` with "has FBU-format BOM".
- Outsourced: replace `markRunSentOut`/`requestExtFinish`/`assignOutsourcedLine`/`receiveExtUnits`/`postExtInw` with issue-materials + supplementary-issue + GRN-as-part; recompute `ext_summary`.

**Scanner (`02_scanner/index.html`)** — remove `outsourced` category + `EXT_INW` station.

**Apps** — `apps/garage/receiving/page.js` (FBU lines render as parts), `apps/garage/issue-queue/page.js` (EXT flow: issue / issue-more / receive-as-GRN; FBU fulfillment toggle), `hooks/useProducts.js` (`FBU_PRODUCTS`), `apps/redline/.../FreshRunForm.js` + `RunDetailPanel.js` (format default, `ext_summary`).

**DB** — `bom_register.bom_format` (+`FBU`/`ANY`); mint `<PROD>-CAR-01/-RM-01` (esp. `SH-CAR-01`); retag kit → `ANY`, built-car/remote → `FBU`; `grn_register.source`/`ext_run_no`; freeze `fbu_*`/`ext_return_pool`; `bom_current` view (already exposes `bom_format`).

---

## 8. Migration / cutover (phased; snapshots mandatory)

- **Phase 0 — model (no behavior change):** add `FBU`/`ANY` to `bom_format`; mint built parts incl. `SH-CAR-01`; retag each FBU/dual product's rows (car/remote→`FBU`, kit→`ANY`); add `grn_register.source`/`ext_run_no`. Snapshot `bom_register` first.
- **Phase 1 — receiving:** FBU explode → `stock_ledger` + source; `qty_received` write-back.
- **Phase 2 — production:** format-aware matcher across all readers; store fulfillment toggle. *Verify a CKD run and an FBU run for a dual-format product produce correct picklists before floor exposure.*
- **Phase 3 — outsourced collapse:** new EXT flow + supplementary issue; remove `EXT_INW`/pool; scanner deploy.
- **Phase 4 — stock reconciliation + retirement:** for each `fbu_stock` row, bring `<PROD>-CAR-01/-RM-01` `stock_ledger` to its **true physical count** via a snapshotted `opening_stock` correction (resolves the negative balances), then freeze `fbu_stock`. **Requires Piyush's physical count per SKU before flipping.** Snapshot `stock_ledger` first.
- **In-flight EXT runs:** the 11 `Issued` runs (no materials sent in-system) → cancel-and-recreate or re-flow under the new model; EXT-001 (legacy v1, In Progress) handled as a documented one-off (ties to the existing EXT-003 ↔ GRN-203 cleanup item).

---

## 9. Edge cases / breakage analysis

1. **Dual-format double-count** — Shadow run must pick one format's car parts, not granular *and* built. Solved by §5.1 matcher.
2. **SKD kit gap (pre-existing)** — Flare SKD runs currently miss CKD-tagged packaging/para. Fixed as a side effect of `ANY`.
3. **Built-remote vs in-house remote** — driven by whether the product has an `FBU` `<PROD>-RM-01` row (delivered built) vs CKD remote sub-parts (assembled in-house). Receiving explodes `remote_qty` into `-RM-01` only when that FBU row exists. Confirm Dash/Mac/Nitro remote-built status with Piyush.
4. **Reorder flags** — built-car parts now have `stock_ledger` reorder points (desirable: "order more built units"). Ensure pure-FBU products have no stale active granular car parts firing false reorders (Rift/Rumble already clean).
5. **Negative `*-CAR-01` at cutover** — reconciled in Phase 4 to true physical count; never silently zeroed.
6. **Outsourced of a pure-FBU SKU** — disallowed (nothing to send); the run form offers outsourced only for products with a granular CKD car BOM.
7. **Vendor pre-stickering** — if vendors pre-apply LOT UPC stickers, those units still scan-to-create at the finishing `INW` (the sticker is consumed there, not at receipt). Operational confirm with Piyush; does not change the data model.
8. **Coverage panel** (`getPartCoverage`) for a dual-format product — must check the *intended* format's parts; defaults to registered format, honors the run's chosen format.
9. **Platform interaction (Drift 1)** — Shadow/Flare are platform-mapped (RULE-PLATFORM-001). The `ANY`/`FBU` tags coexist with `platformCommonRows`; the union must apply the format filter to platform rows too (they default `CKD`). Verify `platformCommonRows` rows carry/inherit a sane `bom_format` (treat platform bottom as `CKD`, and built-car FBU rows as product-level).
10. **Reporting** that read `fbu_grn_register`/`fbu_issue_register` — re-point to `grn_register`/`issue_register` filtered by built-part code + `source`.
11. **Open unit-POs are invisible to part-level coverage today** (`getPartCoverage` keys on `part_code`; unit lines are null) — so receipt-side format costs no working forecast. A future enhancement could explode open POs into projected inbound *if* an advisory PO format is present.
12. **Purchase-vs-receipt format mismatch** — soft, non-blocking warning at receipt (declared ≠ PO intended-format); received format wins and lands stock; the warning is escalated to procurement, never gates the GRN.

---

## 10. Business-rule changes (to land in BUSINESS_RULES.md on implementation)

- **RULE-SKD-001** — generalize: `bom_format ∈ {CKD,SKD,FBU,ANY}`; the matcher is `IN(run_format,'ANY')`; the format BOM is the single source of truth for both receiving and issuance, **FBU included**. **Receiving format is receiver-declared at receipt (binding truth)**; the PO carries only an advisory intended-format (cost/GST + a soft mismatch warning).
- **RULE-FBU-001** — supersede: there is no `issue_mode='fbu'` skip-category path and no `fbu_stock`. A built car/remote is a first-class `FBU`-format part; an FBU run consumes it like any part. Format is a store **fulfillment** choice on a production-triggered run; dual-format detected by the existence of `FBU` rows.
- **RULE-EXT-001** — amend: the EXT run still spans the full loop for ITC-04, but units-in is a **source-tagged GRN of the built-car part** (not `EXT_INW`/`ext_return_pool`); finishing is decoupled into an ordinary FBU run; built-part receipts carry `source` (`fbu_purchase` vs `jobwork`+`EXT-NNN`).
- **New RULE-FBU-002** — built-unit source accountability: one stock number per built component; provenance lives on the GRN `source`/`ext_run_no`, queried for FBU-purchase vs job-work counts and the ITC-04 seed.

---

## 11. Decided questions (S178)

1. **Shared kit** → `bom_format='ANY'` tag + `IN(format,'ANY')` matcher (not per-format duplication).
2. **Format choice** → production triggers the run; store picks the fulfillment source (CKD parts vs FBU built unit) at issue; forced for pure formats, choice only for dual-format.
3. **Outsourced returns** → collapse fully; kill `EXT_INW` + `ext_return_pool`; GRN built cars as a source-tagged part; finishing is a normal FBU run.
4. **Receiving format** → receipt-side, receiver-declared = captured truth (binding). PO carries an advisory intended-format only; a **soft non-blocking mismatch warning** fires when declared ≠ intended (escalate to procurement), but received always wins. Source (`fbu_purchase` vs `jobwork`) stays context-derived, not receiver-declared.

## 12. Open operational items (confirm before/at implementation)

- Piyush: physical count per FBU SKU (Phase 4 reconciliation).
- Piyush: Dash/Mac/Nitro — is the remote delivered built (`-RM-01`) or assembled in-house?
- Piyush: exact CKD category set sent to a vendor on an outsourced run (default: Car + Remote sub-components).
- Piyush: do vendors pre-sticker returned units, or do we sticker at finishing `INW`?
