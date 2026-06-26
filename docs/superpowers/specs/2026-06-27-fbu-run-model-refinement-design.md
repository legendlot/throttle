# FBU Run-Model Refinement — Design

> **Status:** Design (S178/S179, 2026-06-27). Refines the shipped FBU unification (Plans 1–3) to match the clarified team structure + run model. Design only — not yet built.
> **Builds on / supersedes parts of:** `2026-06-26-fbu-outsourced-unification-design.md` (the data model stands; this changes the *production-intent*, *store-discretion*, *FBU granularity*, and *outsourced* layers).
> **Author:** Claude Code (with Afshaan).

---

## 1. Why this refinement

The data model shipped in Plans 1–3 is sound (built car/remote = first-class parts; `bom_format` CKD/SKD/FBU + shared `ANY` kit; receipt-side format; unified FBU stock with source tags). But it was built with the **format decision on the store side** (a flip toggle) and **FBU car codes at the wrong granularity**. The clarified team structure forces four changes:

**Team structure (the operating reality):**
- **Store team** (Garage) — inwards all material, stores it, issues to production **on request**. *Acts on requests; never decides runs or formats.*
- **Production team** — **decides and requests** runs; builds; dispatches. Two sub-teams:
  - **In-house** (Redline) — leads Fresh/Repair runs; also does the **finishing run** for vendor-built cars.
  - **Outsourced** — coordinates vendors; issues build materials → vendor → brings built cars back to the store. Never finishes (in-house does).

**Guiding principles (Afshaan):** production's job is finished goods; **FBU (readily-finishable) always gets priority**; the **run captures production's intent**; the store **pick list is a 1:1 projection of the run's format** (no store judgement); format applies **only to the car/remote**, the finishing kit is always issued with a build run; **an FBU unit is an FBU unit** regardless of source.

---

## 2. The run model

Two independent dimensions on a run:

| Dimension | Values | Set by |
|---|---|---|
| **Type** (existing tabs) | Fresh · Outsourced · Repair · Repack · Ad-hoc | Production, at run-create |
| **Format** (new) | **CKD · SKD · FBU** | Production, at run-create |

- **Format is MANDATORY on Fresh and Repair runs.** (Repair format = repair-by-built-unit-swap (FBU) vs repair-from-parts (CKD).)
- **No format on:** Ad-hoc (parts only), Repack (channel change, no store issue), Outsourced (§6 — its own flow, always CKD-out → FBU-in).
- The format is the run's **clear, visible classification** on Redline and at the scanner — production is never unsure what it's doing. A "finishing run" for vendor cars is simply **a Fresh run, format = FBU** — no new object.

**Format → pick list, 1:1.** The store-side pick list (Garage Issue Queue + `calcKit`) is generated directly from the run's format: FBU → built car/remote (+ ANY kit); SKD → SKD bundles (+ kit); CKD → granular car (+ kit). The store issues exactly that.

This **reverses the S121 decision** that moved the "Issue As" choice off Redline to the store. **RULE-FBU-001 is rewritten** to "production declares the format at run-create; store projects it 1:1."

---

## 3. Store has no format discretion — accept or reject only

- **Remove `setRunIssueMode`** (the store-side FBU flip) entirely. The store never changes a run's format.
- If a requested format **can't be fulfilled** from stock, the store **rejects the run** (existing reject mechanism) and asks production to re-raise it to match what's actually available. Accept/reject is the store's only lever.
- Rationale (Afshaan): a store flip "gives them a choice and confuses people." Keep floor ops simple — production owns the intent, store executes or bounces it.

---

## 4. FBU priority — surfaced + defaulted at run-create

When production picks a product on a Fresh run:
- Show **available built-unit (FBU) stock** for that product/variant/colour inline (e.g. "**166 built units in stock**"), tied into the existing **Coverage Check** panel.
- **Default the format to FBU** when built stock exists (production can change it). This nudges "finish these first" without forcing it — production still picks (your call: *show availability and let them pick*, with FBU as the smart default).

---

## 5. FBU part-code granularity (correction)

**FBU units carry variant AND colour.** So:
- **FBU car = one part code per (product, variant, colour).** E.g. Flare 2 models × 2 colours = 4 car codes. Encoded with `variant_model = "<variant> <colour>"`, `bom_format='FBU'` — the existing picklist matcher (which filters `variant_model`) then picks the right one automatically.
- **FBU remote = one Common code per product** (`<PROD>-RM-01`, `variant_model='Common'`, `bom_format='FBU'`) — remotes don't vary by car variant/colour.

**⚠ Migration correction (required before team reliance — not live-harmful yet):** Plan 2 wrongly **collapsed colours into one Common `<PROD>-CAR-01`** (e.g. `NT-CAR-01` = 428, merging Nitro's 5 colours). Redo:
1. Mint per-(variant,colour) FBU car codes for every multi-combo product (Dash, Mac, Nitro, Shadow; Rift/Rumble are single-combo and already fine).
2. Re-split the merged balances from the **`store.safety_fbu_stock_2026_06_26`** snapshot (which preserved the per-colour quantities: Nitro Race Blue 6, Tarmac Grey 71, …).
3. Fix the **receiving resolver** (`builtPartCodeResolver`) and `receiveExtBuiltUnits`/the receive flow to resolve the **variant+colour** car code, not Common.
4. Retire the wrongly-merged Common car codes (keep the single-combo ones).

**Scalability:** every product can be FBU — mint its car codes (per its variant/colour combos) + one remote code, consistently. "A couple of new entries per product."

---

## 6. Outsourced = a vendor-build run that yields FBU stock

Keep it as a distinct **run** (gives the single `EXT-NNN` object ITC-04 + the challan + return-reconciliation need). Conceptually it's **"a build-materials issue to a vendor that returns built cars into FBU stock"** — not a production run, no format attribute, never finishes/dispatches.

**Lifecycle:**
1. Outsourced team creates the run (Outsourced type, vendor) and requests **build materials** = the CKD car/remote parts **including the colour top** (everything to build the *coloured* car) but **NOT** the finishing kit (battery/packaging/para).
2. Store issues the build materials (Issue Queue). → `Issued`.
3. Outsourced team **sends to vendor** (`markRunSentOut`, delivery challan). → `In Progress`.
4. Vendor returns built cars → handled in the **receiving flow** (§7), linked to this run.
5. **Auto-close:** when the run's total received FBU (linked GRNs) **≥ planned qty**, the run flips to `Completed` automatically.
6. **Finishing** is a **separate Fresh run, format = FBU** by the in-house team — drawing the now-stocked FBU car (vendor or purchased — an FBU unit is an FBU unit) + the kit.

**Removes** Plan 3's separate Issue-Queue "Receive built cars" button (`receiveExtBuiltUnits` as a standalone action) — the receive now lives in the receiving flow (§7).

---

## 7. Receiving — one flow for all FBU (purchase + job-work), with run-linking

When the store declares **FBU** at receipt (the format toggle, Plan 1):
- Show an **optional "Link outsourced run"** picker, listing open outsourced (`In Progress`) runs for that product/vendor.
- **Linked →** the GRN carries `source='jobwork'`, `ext_run_no=<EXT-NNN>`; on GRN, if the run's received-FBU ≥ planned, **auto-close** it (§6.5). The worksheet counts against the run's planned variants/colours.
- **Unlinked →** `source='fbu_purchase'` (a bought-built shipment, normal PO path).
- Either way, built cars land as **variant+colour FBU car stock** (§5). Store stays the source of truth (counts what's physically in the box); the PO/run states intent, receipt can override (Plan 1 mismatch warning stands).

This consolidates everything: one receiving surface handles purchased FBU and vendor returns; the run-link is just a tag on the receipt.

---

## 8. Business-rule changes

- **RULE-FBU-001 — rewrite:** production declares the format (CKD/SKD/FBU) at run-create (mandatory on Fresh/Repair); store projects it 1:1 and has no flip (accept/reject only); FBU car = per variant+colour, remote = Common; FBU defaulted/surfaced when built stock exists. (Reverses the S121 store-side-choice amendment.)
- **RULE-EXT-001 — amend:** outsourced run = vendor build-materials issue → FBU-stock return; receive via the receiving flow with run-link; auto-close on received ≥ planned; finishing is a separate Fresh+FBU run.
- **RULE-SKD-001 — unchanged** for now (SKD deferred, §9).

---

## 9. Deferred (logged in BACKLOG)

- **SKD-for-any-product [BIG]:** no clean run-format→1:1 pick list because the vendor's built-% varies per shipment; needs a store-defines-SKD-contents-at-receipt mechanism (TBD). Stays Flare-only meanwhile.
- **Per-format output monitoring:** units finished from FBU vs SKD vs CKD, for differentiated targets/allocation. Data is largely present (run format + qty); it's a reporting/dashboard build. Fast-follow.
- **Plan 4 cleanup (carried):** freeze vestigial `fbu_stock`/`ext_return_pool`, remove dormant old EXT handlers + `EXT_INW` SCANNER_ACTION + `fbu_includes_remote`/`fbu_products` dead-code.

---

## 10. What this builds on (already shipped, stands)

- `bom_format` (CKD/SKD/FBU) + shared `ANY` kit; format-aware matcher; format-aware `calcKit`/producibility. ✅
- Built car/remote = first-class `stock_ledger` parts; per-form part codes. ✅ (granularity corrected in §5)
- Receipt-side declared format + PO-intent + mismatch warning; store = source of truth. ✅
- Unified FBU stock (purchase + job-work) with `source` tag; outsourced issues build-materials-only; finishing = normal FBU run. ✅

**Net:** no rebuild — the spine holds. This refinement moves the **format choice to production**, removes **store discretion**, corrects **FBU granularity to variant+colour**, and consolidates the **outsourced receive into the receiving flow with auto-close**.

---

## Open items before implementation plan

None blocking — all decisions made (S178/S179). The implementation will sequence: (1) FBU granularity correction + re-migration (from snapshot); (2) run-format attribute on Fresh/Repair + remove `setRunIssueMode` + RULE rewrite; (3) FBU surfacing/default at run-create; (4) receiving FBU run-link + outsourced auto-close (replacing the Issue-Queue receive button); (5) SKD + monitoring as logged fast-follows.
