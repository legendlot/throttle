# Outpost end-to-end harness (O11)

Plays vendor benches, a print agent and a supervisor against the LIVE `outpostops` worker with real signed
requests. First run: S423, 2026-10-16, on two throwaway test vendors (all PASS; results in `systems/outpost.md` §O11).

**Owner side is done by hand in Depot** (it needs a LOT login): add the test vendor(s), set the product to packed,
issue enrolment codes, add operators, raise a work order; later Receiving / Audit QC / dispositions / kill switch.

1. Put the codes and PINs Depot shows into `creds.json` here (git-ignored, never commit it):
   `{"A":{"vendor_id":N,"enrol":{"b1":"…","b2":"…","b3":"…","b4":"…","agent":"…"},"ops":{"001":{"pin":"…"},…}},"B":{…}}`
   A = the vendor under test (supervisor 001, operators 002/003, lockout operator 004); B = a second vendor for the
   cross-vendor checks (one bench, supervisor 001).
2. `node step1_auth.mjs` → `step2_mint_pack.mjs` → `step3_unpack_print_csg.mjs` (+ `step3b.mjs`) → receive CSG1 in
   Depot (one unit short, one extra) → `step4_csg2.mjs` → receive + adverse audit CSG2 in Depot → `step5_return_repack.mjs`
   → `node killpoll.mjs kill` while flipping the vendor kill switch in Depot. Run-specific values to edit for a new run:
   vendor ids 198/199 (step 1 `/v/me` checks), work-order ids 25/26 (steps 1–3b, 5) and the UPCs in step 5. Device keys + sessions persist in `state.json` (git-ignored).
3. **Clean up**: an accepted test unit becomes dispatchable stock — move it out at once, then delete the test vendor's
   rows (S423's FK-ordered delete: `store.safety_o11_testrun_2026_10_16` is the snapshot; order = outpost children →
   public pkg_scans / unit_pairs / scans / upc_pool / units / upc_batches / GRN rows → work orders / products / config
   → store.vendors → **store.payment_payees** (`trg_sync_vendor_to_payee` creates one per vendor and a vendor delete
   leaves it behind); snapshot EVERY table you delete from (S423 missed the carton/receipt child tables); `pack_events` needs its append-only trigger disabled for the delete and re-enabled after).
