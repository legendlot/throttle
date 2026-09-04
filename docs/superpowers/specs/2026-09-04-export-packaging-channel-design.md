# Export as a third packaging channel — design (Phase 2)

> Written 2026-09-04 (S349) from Afshaan's decisions of 2026-09-03 (S337) and 2026-09-04 (S349).
> Phase 1 (S338, lotopsproxy `8c335e0`) replaced the two-way `ecom ? … : retail` ternaries with one
> `CHANNEL_SPEC` registry in `01_worker/lib/channel.js`. This phase adds the third entry and everything
> that must exist for an export unit to be planned, picked, packed, labelled, packed-out and allocated.

## Decisions (verbatim, Afshaan)

- **Export is a channel TYPE, not a channel** — *"This will be an additional channel for dispatch also,
  but right now we are only doing exports to Amazon… in the future export to Walmart, Dubai, Amazon Dubai.
  Build it future-safe."* (S337). `dispatch_channels.type='export'` covers every export destination the
  way `type='ecom'` covers 14 named ecom channels today.
- **One export row for now, and it is the existing dormant one** — *"make other to export, reuse it…
  only one export for now, and that too Amz US or something, so that there's no confusion. Leave the room
  for other export channels in the future."* (S349). Row `public.dispatch_channels` id
  `66276f97-b058-47f8-8b16-87cdb00cc806` (name `Export`, `type='other'`, `fulfillment_model='bulk'`,
  `is_sale=true`, 0 allocations ever) is retyped to `export` and renamed **`Amazon US (Export)`**.
  Walmart / Dubai are future INSERTs with `type='export'`.
- **Export boxes are real parts already**: `SH-PP-20` and `FL-PP-27` "Export Box", `Primary Packaging`,
  active, on **0** BOM rows (measured 2026-09-04). They hang on the Shadow/Flare BOMs as `qty_export=1`.

## Shape of the change

| Layer | Today (2 channels) | After (3, registry-driven) |
|---|---|---|
| `store.bom_register` / `store.bom_current` | `qty_ecomm`, `qty_retail` numeric | + `qty_export` numeric (NULL = "not on this channel", same as siblings); view lists it explicitly |
| `store.work_orders` | `qty_ecomm`, `qty_retail` int default 0 | + `qty_export` int default 0 |
| `public.get_line_view` / `get_open_runs` / `get_plan_vs_actual` | `target_ecom`, `target_retail`; `rte_count`/`rtr_count` | + `target_export`, `rtx_count` / `actual_rtx`; export units count as dispatched |
| CHECKs | `pkg_scans.channel ∈ (ecom,retail)` · `dispatch_channels.type ∈ (ecom,retail,other)` · `store.dispatch_plan_lines.mapping ∈ (Ecom,Retail)` | each widened by one value in the SAME migration as the column (enum-CHECK rule) |
| `lib/channel.js` `CHANNEL_SPEC` | ecom `E`/RTE, retail `R`/RTR | + `export: { code:'X', qtyCol:'qty_export', label:'EXPORT', pkgOutActivity:'RTX' }` |
| Batch label | `…-E` / `…-R` | `…-X` for export. Five worker regex sites read the suffix; they move onto one `channelFromLabel()` helper |
| Alloc gate (`worker.js` ~9362) | ecom box → ecom channel; retail box → retail or other | + export box → export channel only; ecom/retail boxes never go to an export channel (common-packaging bypass unchanged) |
| Picklist / issue math | `bom.qty_ecomm×wo.qty_ecomm + bom.qty_retail×wo.qty_retail` at 4 sites | one `splitPackagingQty(bom, wo)` helper summing over `CHANNEL_TYPES` |
| Redline new-run / planner / run detail, Garage issue queue | two inputs / `E:n R:n` | third input / `E:n R:n X:n` |
| Depot type badges (4) | ecom blue · retail yellow · else grey | + export green |
| Scanner PKG channel toggle + 3 display ternaries | ECOM / RETAIL | + EXPORT button; label/badge/tag from a `{ecom,retail,export}` map; activity `RTX` |
| RULE-012 | written for two channels | amended: N channels, `CHANNEL_SPEC` is the registry, `common_packaging` semantics unchanged |

## Deliberately out of scope (Phase 3, only if Depot asks)

- **Depot's demand planner** (`store.dispatch_plan_lines.mapping`, worker ~6250/6347/21989/22072,
  `rtd_ecomm`/`rtd_retail` stock buckets). The CHECK is widened now so a future `Export` mapping is
  not a migration, but the planner keeps its two buckets.
- `postFbuGRN`, repack `from_channel`/`to_channel` beyond what `CHANNEL_SPEC` already gives them.
- Reports that name RTE/RTR explicitly (Redline reporting tiles) — they keep working; export shows in
  the run targets and `total_dispatched`, not as its own tile.

## Invariants

1. **`ecom` and `retail` behaviour is byte-identical before and after** — the Phase 1 acceptance test
   (`test/channel.test.js`) stays green untouched.
2. **An unknown channel still fails loudly** — `channelSpec()` throws, the alloc gate refuses.
3. **Sequencing:** migration (additive) → worker → apps → scanner → THEN the data flip (row retype +
   BOM rows). Until the flip, no export row exists, so every new code path is inert.
4. **`common_packaging` is untouched** — it is a dispatch-gate concession (RULE-012 §S183), not a
   production split, and export does not change that.
5. **Never `qty_retail` as a stand-in** — the whole reason for Phase 1.

## Pass conditions

- Unit: `npm test` in `01_worker` — the new `export` cases plus the untouched Phase 1 file.
- Live, after the flip: create a Shadow run with `qty_export=2` in Redline; Garage picklist shows
  `SH-PP-20 ×2`; PKG scan with channel EXPORT prints a `…-X` label reading EXPORT; PKG_OUT writes
  activity `RTX`; ALLOC accepts the `-X` box on `Amazon US (Export)` and refuses it on any ecom/retail
  channel; `get_open_runs` shows `target_export=2`.
