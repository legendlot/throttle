# FBU Unification · Plan 2 — Production Cutover + Migration

> **For agentic workers:** execute task-by-task. No unit-test harness — "verify" = live Supabase SQL / worker curl / authenticated browser smoke. Sequence per task: migration → worker (edit→commit→push→`cd 01_worker && npx wrangler deploy`) → app → verify. **Snapshot before every data touch.** Builds on Plan 1 (receipt-side receiving, lotopsproxy `ccd9cf43`).

**Goal:** Flip production so a built car/remote is consumed from normal `stock_ledger` as a first-class part — FBU becomes a real `bom_format` (`CKD`/`SKD`/`FBU`) with a shared `ANY` kit tag — then migrate the built-unit balances out of `fbu_stock` and retire it.

**Architecture:** The picklist matcher gains `bom_format IN (run_format,'ANY')` (byte-neutral until rows are tagged). Built-car/remote rows are retagged `FBU`; the outward kit `ANY`. FBU runs then consume the built-part from `stock_ledger` via the matcher (no more skip-categories / `fbu_lines` / `fbu_stock` deduct). The `fbu_stock`→`stock_ledger` balance migration + stopping Plan 1's dual-write + freezing `fbu_stock` are one **gated** cutover step needing a physical-count truth source.

**Tech Stack:** Supabase Postgres (`store`), Cloudflare Worker `lotopsproxy`, Next.js Garage + Redline.

**Spec:** `docs/superpowers/specs/2026-06-26-fbu-outsourced-unification-design.md` (§3, §5).

**Deploy ordering (safety):** Task 1 (matcher supports `ANY`) is byte-neutral and deploys first. Task 2 (mint + retag) is neutral for production *because FBU runs still read `fbu_stock` until Task 3*. **Task 3 is the gated big-bang flip** (code + balance migration + retire, together) — needs the physical-count decision + Afshaan's go-ahead + ideally Plan 1 floor-proven. Tasks 4–6 are independent polish.

---

## Task 1: Matcher supports the shared `ANY` tag (byte-neutral)

**File:** `01_worker/worker.js` — every BOM reader that filters `bom_format`.

**Change:** replace strict `(b.bom_format||'CKD') === runFmt` with membership `['ANY', runFmt].includes(b.bom_format||'CKD')`. Neutral today (no row is tagged `ANY` yet); once Task 2 tags the kit `ANY`, SKD/FBU runs correctly pick it (fixes the latent SKD-misses-kit gap).

- [ ] 1a. `getProductionRun` (~3408, the `woBom` filter): change the bom_format equality to `['ANY', runFmt].includes(b.bom_format || 'CKD')`. (`runFmt` stays `wo.issue_mode==='skd' ? 'SKD' : 'CKD'` for now — FBU runs unchanged in Task 1.)
- [ ] 1b. `checkRunBomStock`, `startRunPick`, `issueAgainstRun`'s expected-pick matcher, `getBOM` (~1942), `getProducibility` (~2647), `calcKit` (~2258): apply the same `ANY`-union. For readers that fetch `bom_current` with **no** format filter (`calcKit`, `getProducibility`, `getBOM`), add a `formatFilter(rows, fmt)` helper = keep rows where `(bom_format||'CKD') ∈ {fmt,'ANY'}`, defaulting `fmt` to the product's registered format (`product_master.receive_format`, 'FBU'→'FBU' else 'CKD'); accept an optional `?format=` override. This prevents a dual-format product (Shadow) double-counting granular CKD car **and** FBU built-car once Task 2 adds the FBU rows.
- [ ] 1c. Add the helper near `isLumpSum` (~278):
```javascript
// FBU unification (Plan 2): keep only rows for the chosen format + the shared 'ANY' kit.
const formatFilter = (rows, fmt) => rows.filter(b => ['ANY', (fmt || 'CKD')].includes(b.bom_format || 'CKD'));
```
- [ ] 1d. `node --check`; commit; push; `cd 01_worker && npx wrangler deploy`; record version.
- [ ] 1e. Verify byte-neutral: pick a live CKD product run via `getProductionRun` curl/browser before+after — identical pick list (nothing is `ANY`/`FBU` yet). SQL sanity: `SELECT DISTINCT bom_format FROM store.bom_register` still only `CKD`/`SKD`.

---

## Task 2: Mint `SH-CAR-01` + retag built-parts `FBU` / kit `ANY` (neutral for production)

**Files:** Supabase migration `fbu_format_model_v1`; snapshot first.

- [ ] 2a. Snapshot: `CREATE TABLE store.safety_bom_register_fbu_2026_06_26 AS SELECT * FROM store.bom_register;`
- [ ] 2b. Mint Shadow's built car (Shadow = `fbu_includes_remote=true` → the built unit is car+remote together → one built-part `SH-CAR-01`, no separate built remote):
```sql
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active)
VALUES ('Shadow','SH-CAR-01','Car (Shadow)','Car','Common',1,'FBU',true)
ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU';
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active)
VALUES ('SH-CAR-01','Car (Shadow)','Shadow','Car',true) ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, opening_stock)
VALUES ('SH-CAR-01','Shadow',0) ON CONFLICT (part_code) DO NOTHING;
```
(Verify exact `material_master`/`stock_ledger` required columns with `information_schema.columns` first; match SKD-mint precedent.)
- [ ] 2c. Retag **built-car/remote rows → `FBU`** for every product that has one:
```sql
UPDATE store.bom_register SET bom_format='FBU'
WHERE is_active AND (part_code ~ '-CAR-' OR part_code ~ '-RM-');
```
- [ ] 2d. Retag the **outward kit → `ANY`** for FBU + dual-format products (Rift/Rumble/Dash/Mac/Nitro/Shadow). The kit = every active row for those products that is NOT the built-car/remote (`-CAR-`/`-RM-`) and NOT a granular CKD car/remote part (keep Shadow's granular `SH-*` car parts as `CKD`). Concretely, tag the non-car/remote *categories* as ANY:
```sql
UPDATE store.bom_register SET bom_format='ANY'
WHERE is_active AND product IN ('Rift','Rumble','Dash','Mac','Nitro','Shadow')
  AND part_code !~ '-CAR-' AND part_code !~ '-RM-'
  AND part_category NOT IN ('Car','Remote');   -- kit only: Packaging/Para/Primary Packaging/Battery/Accessories/Sticker(non-car)/Charger
```
**Caution:** Shadow's granular car parts are `part_category='Car'` and its granular remote parts `part_category='Remote'` → excluded by the `NOT IN ('Car','Remote')` guard, so they stay `CKD` (correct — Shadow CKD runs still pick them). Pure-FBU products have no granular car/remote category rows, so only their kit is touched. **Verify per-product after** (2f) before trusting.
- [ ] 2e. Verify neutrality for production: `SELECT product, bom_format, part_category, count(*) FROM store.bom_register WHERE is_active AND product IN ('Rift','Shadow') GROUP BY 1,2,3 ORDER BY 1,2,3;` — Rift: `FBU` car+remote, `ANY` kit, no `CKD`. Shadow: `CKD` granular car/remote, `FBU` SH-CAR-01, `ANY` kit.
- [ ] 2f. Browser/curl: a Shadow **CKD** run picklist (matcher `IN('CKD','ANY')`) must still list the granular `SH-*` car parts + kit, and must NOT list `SH-CAR-01`. A Rift **FBU** run is still on the `fbu_stock` path (Task 3 not done) — confirm it's unchanged. If anything regressed, restore from `safety_bom_register_fbu_2026_06_26`.

---

## Task 3 — ⚠️ GATED CUTOVER: flip FBU production to `stock_ledger` + migrate balances + retire `fbu_stock`

**Gate:** (1) physical-count truth source decided — Piyush's per-SKU built-unit counts, OR Afshaan's authorization to trust `fbu_stock`; (2) Afshaan go-ahead; (3) ideally Plan 1 + Tasks 1–2 floor-proven. **Deploy the worker flip and run the balance migration in the same window** (they're interdependent).

**Files:** `01_worker/worker.js` (`getProductionRun`, `issueAgainstRun`, `raiseGRNFromReceiving`); migration `fbu_stock_to_ledger_cutover_v1`.

- [ ] 3a. `getProductionRun`: for `issue_mode==='fbu'` WOs, set `runFmt='FBU'` so the matcher (`IN('FBU','ANY')`) picks the built-car/remote part + kit. **Remove** the `fbuStockMap`/`fbuAvailable`-from-stock lookup, the `FBU_SKIP_*`/`fbuSkipCategories` block, the `fbuMap`/`fbu_lines` accumulation, and `fbu_includes_remote` (the FBU BOM now expresses car-only vs car+remote by which built-part rows exist). Keep returning `fbu_available` = "product has `bom_format='FBU'` rows" (drives the store toggle — Task 4).
- [ ] 3b. `issueAgainstRun`: **remove** the `fbu_lines`/`fbu_issue_register`/`update_fbu_stock_issued` block — the built-car part now deducts `stock_ledger` through the normal parts-issue path like any component.
- [ ] 3c. `raiseGRNFromReceiving`: **remove** the Plan 1 `fbu_stock` dual-write bridge (the `if (isFbuShip) { …update_fbu_stock_received… }` loop) — receipts now land in `stock_ledger` only. Keep `source='fbu_purchase'`. (The legacy `fbuLines→fbu_grn_register` path can also go once no product lacks a built code — Shadow now has `SH-CAR-01`, so all FBU products have one; remove it.)
- [ ] 3d. **Balance migration** (`fbu_stock_to_ledger_cutover_v1`) — snapshot `stock_ledger` first (`CREATE TABLE store.safety_stock_ledger_fbu_cutover_2026_06_26 AS SELECT * FROM store.stock_ledger;`). **TRUTH SOURCE DECIDED (Afshaan S178): take the POSITIVE balance; discard the negative part-code values (they're artifacts of consumption recorded while receipts went to the pool — "the negative obviously doesn't exist").** So per built-CAR code, `target_closing` = the current `fbu_stock` car balance summed onto the Common code (e.g. RI-CAR-01 → 1,710, discard the −280). **Built REMOTES have no positive in either ledger** (the pool only tracked cars; RI-RM-01/RU-RM-01 are negative) → default `target_closing` = the **paired car count** (Rift/Rumble received + consumed car+remote 1:1), flag for a floor spot-check. Because `closing = opening + received − issued + returned` is generated, compute `new_opening = target_closing − (received − issued + returned)` per code; write via a single `UPDATE … FROM (VALUES …)` batch. **Show the before/after per SKU for sign-off before committing.**
- [ ] 3e. Freeze `fbu_stock`: rename to `fbu_stock_retired_2026_06_26` (keep data, break readers) **after** confirming no live reader remains (grep worker for `fbu_stock`/`fbu_grn_register`/`fbu_issue_register`; all removed in 3a–3c). Same for `fbu_grn_register`/`fbu_issue_register` if fully unreferenced.
- [ ] 3f. `node --check`; commit; push; deploy. Run the migration. Verify end-to-end (browser): a Rift FBU run picklist now shows `RI-CAR-01`+`RI-RM-01`+kit from `stock_ledger`; issue deducts `stock_ledger` (not `fbu_stock`); the run completes; dispatch unaffected. SQL: `stock_ledger` built-part `closing_stock` = agreed truth; no new `fbu_stock` writes.

---

## Task 4: Store fulfilment toggle + dual-format detection (off `fbu_stock`)

**Files:** `01_worker/worker.js` (`setRunIssueMode`, `getProductCatalogue`); Garage Issue Queue already renders the toggle.

- [ ] 4a. `setRunIssueMode`: replace the "FBU stock must exist" guard (queries `fbu_stock`) with "the product has `bom_format='FBU'` rows" (i.e. an FBU BOM exists). Keep the Submitted/Picking + not-outsourced guards.
- [ ] 4b. `getProductCatalogue`: replace the `fbu_products` heuristic (distinct `fbu_stock.product`) with products that have `bom_format='FBU'` active rows. (`useProducts.FBU_PRODUCTS` consumes it unchanged.)
- [ ] 4c. `node --check`; deploy. Browser: a fresh Shadow run shows the CKD-parts ↔ FBU-built toggle; flipping to FBU re-fetches a picklist with `SH-CAR-01`+kit; pure-CKD products show no toggle.

---

## Task 5: `qty_received` write-back for unit lines (deferred from Plan 1) via batched RPC

**Files:** migration `po_qty_received_writeback_v1` (RPC); `01_worker/worker.js` (`raiseGRNFromReceiving`).

- [ ] 5a. Create RPC `store.bump_po_qty_received(p_po text, p_updates jsonb)` that, for each `{part_code, qty}`, does `UPDATE store.po_lines SET qty_received = COALESCE(qty_received,0) + qty WHERE po_number=p_po AND part_code=<code>` — one round-trip, no per-line subrequests. `GRANT EXECUTE … TO service_role`.
- [ ] 5b. `raiseGRNFromReceiving`: after the stock post, call `bump_po_qty_received(ship.po_reference, [{part_code, qty:delta}…])` once for all parts lines (covers part-level **and** exploded unit lines now that explosion is part-coded). Replace the Plan-1-deferred per-line loop.
- [ ] 5c. Deploy. Verify: GRN a multi-line shipment → `po_lines.qty_received` increments per line; coverage/pending-PO reflect true outstanding; no subrequest-limit error.

---

## Task 6: Knowledge

- [ ] 6a. `BUSINESS_RULES.md`: rewrite RULE-FBU-001 (FBU is a `bom_format`; built car/remote = first-class parts; `fbu_stock`/skip-categories/`fbu_includes_remote` retired) + generalize RULE-SKD-001 to `{CKD,SKD,FBU,ANY}` + `IN(fmt,'ANY')` matcher.
- [ ] 6b. `systems/lotops.md`: production now format-aware; the cutover + migration record. `CORE.md` schema map: `fbu_stock`/`fbu_grn_register`/`fbu_issue_register` retired.
- [ ] 6c. `BACKLOG.md`: mark Plan 2 done; Plan 3 (outsourced collapse) next. Commit (brain-sync auto-pushes).

---

## Execution log (S178)

**Production cutover LIVE.** Worker versions: Task 1 `bd858c34`, Task 3 flip `0b762378`, formatFilter `f8f58ce5`.
- **Task 1 ✅** — matcher `IN('ANY',runFmt)` (byte-neutral; verified no ANY/FBU rows existed).
- **Task 2 ✅ (migration, folded with Task 3)** — retagged built car/remote → `FBU`, kit → `ANY` for Rift/Rumble/Dash/Mac/Nitro/Shadow; minted `SH-CAR-01`. Verified: Rift = FBU car+remote + ANY kit (no CKD); Shadow = CKD granular(25) + FBU `SH-CAR-01` + ANY kit; **zero** collateral on other products. Final: CKD 1,362 · ANY 109 · FBU 8 · SKD 13.
- **Task 3 ✅** — `getProductionRun`: `runFmt='FBU'` for fbu runs + removed skip-category + removed `fbuMap`/`fbu_lines` accumulation. **Balance migration (positive-truth, Afshaan):** DS 2,000 · MA 600 · NT 428 · RI car/remote 1,710 · RU car/remote 1,131 · SH 0 — verified exact (negatives wiped). Backups: `safety_{fbu_stock,fbu_grn_register,fbu_issue_register,stock_ledger,bom_register}_*_2026_06_26`.
- **formatFilter ✅** — `calcKit` + `getProducibility` filter to registered-format + ANY (Shadow no longer reads 0-producible).
- **Deferred (work as-is on vestigial `fbu_stock`):** Task 4 (`setRunIssueMode`/`getProductCatalogue` still read `fbu_stock` — functional, conceptually stale); Task 5 (`qty_received` batched RPC); **`fbu_stock` freeze** (entangles `postFbuGRN` + GRN list/detail + the FBU-stock report — a dedicated retirement pass, Plan 4). `issueAgainstRun` fbu-deduct block left dormant (fed empty `fbu_lines`).
- **Pending:** authenticated browser smoke (Afshaan + team) — issue a pure-FBU run, confirm the built-car pick lines + `stock_ledger` deduction. Known edge: flipping a *pure-FBU* product's run to CKD yields an empty car pick (no granular rows) — gate the toggle to dual-format products in Plan 4.

## Self-review (spec coverage)

- **Spec §3.1 (`bom_format` CKD/SKD/FBU/ANY)** → Task 1 (matcher) + Task 2 (tagging).
- **Spec §3.3 (built parts incl. `SH-CAR-01`)** → Task 2b/2c.
- **Spec §5.1 (format-aware matcher across all readers)** → Task 1.
- **Spec §5.2 (store fulfilment toggle; dual-format detection)** → Task 4.
- **Spec §3.5 / §8 (retire `fbu_stock`/`fbu_grn_register`/`fbu_issue_register`; migrate balances)** → Task 3.
- **Spec §4 (`qty_received` write-back)** → Task 5.
- **Deferred to Plan 3:** outsourced collapse (EXT flow, `EXT_INW`/`ext_return_pool` removal, source=`jobwork`).
