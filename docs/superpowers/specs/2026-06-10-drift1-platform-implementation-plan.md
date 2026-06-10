# Drift 1 Platform — Implementation Plan (Session Handover)

> Status: READY TO EXECUTE. Design approved by Afshaan 2026-06-10 (S117). DB tools were
> down mid-design (Supabase token expiry) and are now back. **This plan is written so a
> FRESH session can execute it end-to-end without missing anything.** Pairs with the design
> spec: `05_Throttle/docs/superpowers/specs/2026-06-10-drift1-platform-design.md` — read that first.

---

## 0. How the new session starts (do this first)

1. Run the **session-start sequence** (root CLAUDE.md): `git pull && git -C 01_worker pull && git -C 05_Throttle pull && git -C 02_scanner pull`; load `CORE.md` + `BUSINESS_RULES.md` + `BACKLOG.md` + `systems/lotops.md`.
2. **Read the two Drift 1 docs:** the design spec (above) + this plan.
3. **Verify Supabase is connected** — call `execute_sql` with `SELECT now();`. NOTE: the Supabase MCP server ID changes on every reconnect (it was `plugin_supabase_supabase`, then `0798d867-…`). Don't hardcode the prefix — `ToolSearch "select:…execute_sql"` for whatever is currently registered.
4. **Do NOT start writing data yet.** Phase 0 is a *read + ask-Afshaan* gate (Section 6). The bottom↔delta classification and Flare's variant decision MUST be confirmed with Afshaan before any mutation. Guessing here corrupts both products.

## 1. Environment / access facts

- **Supabase project_id:** `jkxcnjabmrkteanzoofj` (project `lot-production`, db `postgres`).
- **Worker (the one code change):** `lotopsproxy` = `01_worker/worker.js`. Deploy: `cd 01_worker && npx wrangler deploy` (edit→commit→push→deploy). Blast radius = Garage + Redline + Scanner — test carefully.
- **Monorepo:** `05_Throttle` (garage/redline auto-deploy on push to main). No app UI change is required for the MVP (picklist resolves server-side), but verify the run/issue-queue screens render the resolved picklist correctly.
- **Rules that bite here:**
  - **RULE-005:** `stock_ledger.closing_stock` is GENERATED. To move stock, update `opening_stock` only — never `closing_stock`.
  - **RULE-SKD #5 / bulk_update_stock_received is UPDATE-only:** a GRN/receive against a part_code with **no pre-existing `stock_ledger` row silently moves zero**. So mint D1 `stock_ledger` rows (at 0) BEFORE any inwarding.
  - **RULE-003:** truly-universal parts use `product=''` in `stock_ledger` + `product='Universal'` in `material_master`; join on `part_code` alone. Drift 1 parts are platform-scoped, NOT universal → they use `product='Drift 1'`. Do NOT recode `UNV-*`/`HW-*`.
  - **50-subrequest limit** in the worker — batch inserts/updates (IN filters / array inserts), never loop awaits.
  - **Schema-verify before any SQL** (information_schema.columns) — table shapes drift.
  - **Supabase MCP gotcha:** a multi-statement `execute_sql` returns ONLY the last statement's rows — run diagnostics one statement per call.
  - **DDL:** use `apply_migration` (it prompts/records). Destructive SQL (DELETE/DROP/TRUNCATE) prompts via the sql-gate hook. Per memory, confirm DB writes with Afshaan per-operation.

## 2. The decision (FINAL — do not re-litigate)

A **platform** owns the shared **bottom** BOM once; **products** (Shadow, Flare) keep only their **delta** and point at the platform; the picklist resolves `platform ∪ delta`. Specifics Afshaan locked:

- **Keep Shadow & Flare as the same products** — same `product_master` rows, same SKUs, **same EANs**. **NO new product_master rows, NO EAN change/duplication.** We only **re-point their BOMs.** Old-vs-new is a temporal/run-level distinction, NOT a product-level one (a unit's build run + date is the implicit identifier). Afshaan accepted that old/new finished units are indistinguishable by barcode.
- **Platform name: `Drift 1`** (internal only, never customer-facing, never sold). Covers the two top-selling drift cars (Shadow + Flare).
- **Part prefixes:** platform/bottom = NEW **`D1-*`** codes; Shadow delta stays `SH-*`; Flare delta stays `FL-*`; universal parts stay `UNV-*`/`HW-*` (referenced, never recoded).
- **Shadow:** transfer its existing shared-bottom stock `SH-* → D1-*` (Afshaan OK).
- **Flare:** new India tops (Burnout, Race) get **new `FL-*` top codes**; old `FL-*` bottom + old tops drop out of the active Flare BOM (stock stranded → physically quarantined by store; deprecate the codes whenever — no functional difference, since BOM membership, not `is_active`, controls picking). Leftover China-Flare stragglers handled later, manually, with a fresh EAN on EAN-tolerant channels (OUT OF SCOPE).
- **Scope/scale:** 2-3 platforms × 4-5 products eventually; this builds the first platform + moves Shadow + Flare onto it.

## 3. Current state (data gathered this session — so you don't re-derive)

**product_master (leave Flare 3.0 and Flare LE ALONE — separate products):**
- **Shadow** — `car` CKD, 6 variants: Asphalt {Black, Grey, Silver}, Tarmac {Black, Grey, Red}; + 1 `remote` CKD. (Shadow is also dual-format FBU — outsourced/Mudra built, `fbu_includes_remote=true`, RULE-FBU-001 — consumed via `fbu_stock`, not bom_register.)
- **Flare** — `car` CKD, 11 variants: Burnout {Green, Grey, Red}, Race {Black, Grey}, Street {Red, White}, Track {Pink, White}, Underground {Blue, Silver}; + 1 `remote` CKD. (Flare also has an SKD format.)

**bom_current composition (active rows):**
- **Shadow** (≈111 active rows total). CKD Common: Accessories 4, Battery(AA) 1, **Car 47**, Charger Cable 1, Fastener 4, Packaging 4, Para 2, Primary Packaging 4, RC Battery 1, **Remote 12**, Sticker 1. CKD Variant: Car 22, Fastener 1, Para 4, Sticker 3 (across the 6 variants — these are the tops + per-variant bits).
- **Flare** CKD Common: Accessories 4, Battery 1, **Car 28**, Charger 1, Fastener 5, Packaging 5, Para 2, Primary Packaging 4, RC Battery 1, **Remote 16**, Sticker 1. CKD Variant: Car 29, Fastener 3, Para 11. Plus SKD format (SKD 12, Remote 1).

**The bottom (→ Drift 1) is essentially Shadow's CKD `Common` set** — the shared chassis/internals (`Car` Common), `Remote` Common, `RC Battery`, and internal `Fastener`s. **The delta (stays on the product) = the outward kit** (`Packaging`, `Primary Packaging`, `Para`, `Sticker`, `Charger Cable`, AA `Battery`) **+ the tops + any connector/spoiler `Car` parts that are product-specific.** Tops already live in `common_variant='Variant'` rows. The judgment call (Phase 0) is which of Shadow's 47 Common `Car` parts are truly shared bottom vs Shadow-specific delta — confirm with Afshaan.

## 4. The resolver change (the only code change) — `01_worker/worker.js`

- **`getProductionRun`** (~line 2705): currently `allBomR = query('bom_current', '?product=eq.<run.product>')` (~2723), then `variantModels` set is built (includes `'Common'`), then `woBom = allBom.filter(b => variantModels.has(b.variant_model) && (b.bom_format||'CKD')===runFmt)` (~2799).
  - **Change:** after fetching the product's bom, look up the product's platform via `store.product_platforms`; if mapped, ALSO `query('bom_current', '?product=eq.<platform>&common_variant=eq.Common')` and **append** those rows to `allBom`. The existing `variantModels` filter already contains `'Common'`, so platform Common rows flow through unchanged. Keep `bom_format` filtering (platform bottom rows are CKD).
  - Net effect: for a mapped product, picklist = platform Common ∪ product (Common delta + matching Variant). For an unmapped product → byte-identical to today (NO-OP).
- **`getProducibility`** (~line 2143): reads all `bom_current` grouped by product to compute producible qty vs stock. Make it platform-aware too (fold platform Common into each mapped product's requirement) so producibility numbers are correct. Secondary to the picklist but do it in the same pass.
- **Other `bom_current` readers to AUDIT** (likely fine for MVP, but check each isn't relied on for a platform product's full BOM): lines ~1502 (getBom view), ~1770 (calcKit), ~3960 (repair-run picklist), ~8495 (UPC→variant lookup), ~9431 (another picklist), ~13011/13049 (repack). For the MVP only `getProductionRun` (+ `getProducibility`) must change; note the rest for follow-up if a platform product hits them.
- **Receiving (`seedReceivingLinesFromPO`, ~line 505) needs NO change** — procurement is per-part PO line items (each vendor's parts), which reference `part_code` directly; the CKD-unit explode path isn't used for the bottom. D1 parts inward against their own codes.

## 5. Schema addition

```sql
CREATE TABLE IF NOT EXISTS store.product_platforms (
  product   text PRIMARY KEY,   -- e.g. 'Shadow', 'Flare'
  platform  text NOT NULL,      -- e.g. 'Drift 1'
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON store.product_platforms TO service_role;
ALTER TABLE store.product_platforms ENABLE ROW LEVEL SECURITY;  -- service_role-only, no anon policy (RULE-RLS-001)
```
(Rows inserted in Phases 4-5, not at creation — so the resolver stays a no-op until you deliberately map a product.)

## 6. Phase 0 — questions to confirm with Afshaan BEFORE any mutation

Ask these (do not guess), then proceed:
1. **Bottom↔delta split:** Generate Shadow's full `Common` BOM (all ~83 Common rows: `SELECT part_code, part_name, part_category, qty_per_unit, qty_ecomm, qty_retail FROM store.bom_current WHERE product='Shadow' AND common_variant='Common' ORDER BY part_category, part_code`). Propose **bottom (→Drift 1):** Car internals + Remote + RC Battery + internal Fasteners; **delta (stays Shadow):** Packaging, Primary Packaging, Para, Sticker, Charger Cable, AA Battery, + any Shadow-specific connector/spoiler Car parts. Have Afshaan confirm/adjust line-by-line (especially: which `Car` Common parts, if any, are Shadow-specific and must NOT go to the shared bottom).
2. **Is the new Flare bottom physically identical to Shadow's bottom** (same parts → the SAME D1 codes serve both)? Design assumes yes (mold reuse). Confirm.
3. **Flare's new variant structure:** do "Flare Burnout / Flare Race" **replace the existing 11 variants** (collapse to a smaller set?), or map onto existing `variant_model`s by swapping the top part inside each? Get the exact list of new Flare variants + which colours. This dictates how many new `FL-*` top codes to mint and the Variant rows to write.
4. **Remote:** confirm the remote is part of the shared bottom (→ Drift 1) for BOTH products (Afshaan said yes — same mold). Flare's old remote (`FL-*` remote) then deprecates.
5. **Stock transfer scope:** confirm zero Shadow's `SH-*` bottom stock and move to `D1-*` now (vs leave Shadow legacy stock + fund D1 only by new inwarding). Afshaan said transfer is fine.

## 7. Execution phases (each: snapshot → mutate → verify; all reversible)

**Phase 1 — Resolver + mapping table (code; no behavior change).**
- `apply_migration` for `store.product_platforms` (Section 5).
- Edit `getProductionRun` (+ `getProducibility`) to be platform-aware (Section 4). Commit→push→`wrangler deploy`.
- **Verify NO-OP:** `product_platforms` is empty, so every product's picklist is unchanged. Spot-check a Shadow run + an unrelated product's picklist == pre-deploy. This MUST be confirmed before Phase 4.

**Phase 2 — Stand up Drift 1 bottom.**
- For each confirmed bottom part: mint a `D1-*` code → insert into `material_master` (product='Drift 1'... or keep cross-product convention; mirror an existing Shadow bottom row's columns), `bom_register` (`product='Drift 1'`, `common_variant='Common'`, qty_per_unit/qty_ecomm/qty_retail copied from the Shadow row, `bom_format='CKD'`, is_active=true), and `stock_ledger` (`product='Drift 1'`, opening 0). Universal parts: add `bom_register` rows under `product='Drift 1'` referencing the existing `UNV-*`/`HW-*` codes as-is (do NOT mint D1 codes for them, do NOT touch their stock).
- Keep a **map of `SH-* → D1-*`** (the old→new code pairing) — needed for the stock transfer + so you can verify the split is complete.
- Verify: `bom_current WHERE product='Drift 1'` == the agreed bottom set, qtys match Shadow's originals.

**Phase 3 — Transfer Shadow bottom stock `SH-* → D1-*`.**
- Snapshot first: `CREATE TABLE store.safety_drift1_stock_<date> AS SELECT * FROM store.stock_ledger WHERE part_code IN (<SH bottom codes> , <D1 codes>);`
- For each pair: set the `D1-*` row's `opening_stock` = the `SH-*` row's current `closing_stock`; then draw the `SH-*` row down to 0 by adjusting its `opening_stock` (RULE-005 — never write `closing_stock`). Do it as batched UPDATEs. Verify total units conserved (sum closing before == sum closing after across the pair set).
- Universal parts: untouched (still shared globally).

**Phase 4 — Re-point Shadow.**
- `INSERT INTO store.product_platforms (product, platform) VALUES ('Shadow','Drift 1');`
- Remove the migrated bottom rows from **Shadow's** `bom_register` (the ones now living under Drift 1) — deactivate (`is_active=false`, deprecated_at, change_note) rather than hard-delete (RULE-004 soft-deprecation; keeps history). Keep Shadow's delta rows (Variant tops + Common Packaging/Para/Sticker/Charger/AA + any Shadow-specific connectors).
- **VERIFY THE INVARIANT:** Shadow's resolved picklist now (`Drift 1 Common ∪ Shadow delta`) must equal its pre-migration picklist part-for-part + qty-for-qty. Compute a sample run's picklist via `getProductionRun` and diff against a snapshot taken before Phase 4. Any difference = a misclassified part; fix before continuing.

**Phase 5 — Stand up new Flare on the platform.**
- `INSERT INTO store.product_platforms VALUES ('Flare','Drift 1');`
- Mint new `FL-*` India top codes for the confirmed new variants (Burnout/Race per Phase 0 #3): `material_master` + `stock_ledger` (opening 0) + `bom_register` Variant rows (`product='Flare'`, `common_variant='Variant'`, `variant_model='<Model Colour>'` per RULE-NAME-002).
- Deactivate Flare's **old bottom** rows (the `FL-*` Common car/remote that the platform now provides) + **old top** rows being replaced (soft-deprecate). Keep Flare's packaging/license/para delta (unchanged, still used).
- Verify Flare's resolved picklist = `Drift 1` bottom + new tops + Flare packaging/license. No leftover old-bottom parts in the active picklist.

**Phase 6 — Inwarding readiness.**
- D1 `stock_ledger` rows exist (Phase 2) → per-part POs for `D1-*` inward normally. New Flare top codes have ledger rows → inward normally. (Shadow bottom already funded via Phase 3 transfer; new POs top up the shared pool.)

**Phase 7 — Smoke + sign-off.**
- A Shadow CKD run resolves the same parts as before (invariant).
- A Flare CKD run resolves `Drift 1` bottom + new India tops + Flare kit.
- Receiving a `D1-*` part via a per-part PO moves stock into the pool.
- A Flare unit and a Shadow unit each get their own product UPC (unchanged); scanning/dispatch unaffected.
- Every OTHER product's picklist unchanged (resolver no-op without mapping).
- `grn_summary` product-count behaves on a mixed GRN that includes `product='Drift 1'` parts (RULE-003 sanity).

**Cutover timing:** Do the Phase 4-5 flips when Flare/Shadow have **no open production runs** (an open mid-pick run referencing soon-deactivated parts would break). Build out or quarantine remaining China-Flare WIP first — there is no "back" to the old BOM once a product's bottom is re-pointed.

## 8. Failure modes & guardrails (must-not-break order)

1. Re-point a product BEFORE the resolver is live → picklist loses the bottom. → **Resolver (Phase 1) first; it's a no-op until a product is mapped.**
2. Inward/GRN a `D1-*` code with no `stock_ledger` row → silent zero move. → **Phase 2 mints ledger rows first.**
3. Stock transfer corruption → **`opening_stock` only (RULE-005), batched, snapshotted.**
4. Recoding a universal `UNV-*`/`HW-*` part into `D1-*` corrupts every other product → **only `SH-*`/`FL-*`-specific bottom parts move; universals are referenced, never recoded.**
5. Flip during an open run → **flip when quiescent; finish/quarantine WIP first.**
6. Misclassified bottom/delta part → caught by the Phase 4 **invariant diff** (resolved picklist must match pre-migration). Don't skip it.
7. Hard-deleting old rows loses history → **soft-deprecate (RULE-004), never DELETE bom rows.**

## 9. Reversibility

- Phase 1: drop the `product_platforms` rows → resolver reverts to no-op; revert the worker commit + redeploy.
- Phase 2: deactivate/delete the new `D1-*` rows (no stock yet).
- Phase 3: restore `stock_ledger` from `store.safety_drift1_stock_<date>`.
- Phases 4-5: reactivate the deprecated Shadow/Flare bottom rows + delete the `product_platforms` mapping → products resolve their own full BOM again.

## 10. Done criteria
Shadow + Flare both build from the `Drift 1` shared bottom + their own deltas; Shadow's picklist is unchanged from before (invariant holds); new Flare picks the India tops; the bottom is a single source of truth (edit a `D1-*` part once → both products see it); stock is pooled under `Drift 1`; EANs/UPCs/scanning/dispatch untouched; all other products unaffected.
