# The moulder → painter job-work leg

> **Status:** design approved 2026-09-01 (S328, with Afshaan). Not built.
> **Closes:** BACKLOG `[lotops] [build] [MED]` "the moulder→painter leg is missing from the system"
> (open since 2026-07-28, ts `1785232713.592129`), and as a side effect `[lotops] [build] [LOW]`
> "Gate-pass send-out on outsourced".
> **Amends:** RULE-DSP-001 (Direct Issuance gains a return leg — see §9).

---

## 1. The problem

LOT's real tops flow is:

```
PO on the MOULDER for unpainted tops
  → moulder delivers unpainted
  → inspected, deliberately NOT inwarded
  → sent to the PAINTER
  → store only ever GRNs the PAINTED top
```

The painter leg is modelled nowhere. Consequences, all measured 2026-09-01:

- **Unpainted tops do not exist in the system.** `SH-PB-51`, `FL-PB-97`, `FL-PB-98` are all
  `is_active=true` with **0 received / 0 issued, ever**, while the painted codes carry real volume
  (`SH-PB-60` 16,389 received, `SH-PB-52` 10,628).
- **There is no view of stock sitting at the painter**, and **no paint scrap/loss figure anywhere.**
- **The mould→part mapping is unfixable in isolation.** A mould shot physically yields an *unpainted*
  top, so Flare's `26017→FL-PB-97` is correct and Shadow's `25307→SH-PB-60` (painted) is not — but
  fixing Shadow alone would explode into unpainted receiving lines that, by process, nobody inwards.
  Neither mapping works end-to-end until this leg exists.
- **The purchasing end papers over it too.** Moulder POs (Monash, `IN-VND-001`) are raised against
  *painted* codes. The single unpainted PO line ever raised (`SH-PB-51`, 255) is on VITBOJ — the
  *painter* — which is backwards.

### ⭐ The finding that shaped this design

**LOT has built "send material out and get it back" three times. All three are at zero.**

| Mechanism | Built | Returns ever completed |
|---|---|---|
| `direct_issuances.returned_at` / `return_grn_ref` | S92 | **0 of 8** |
| `gate_passes.is_returnable` | S97 | **0 of 4** |
| EXT run `shipments.ext_run_no` receive link | S180 | **0 rows, ever** |

The common shape: the return was a step a person had to remember, and **nothing broke when they
forgot**. So the gap is not a missing object — the object exists three times over. Any design whose
return leg is a discrete action someone must perform will read exactly like these in six months.

⛔ **Do not "fix" this by building a fourth returnable object.** That was considered and rejected
(§3, approach C).

---

## 2. Decisions taken (all with Afshaan, 2026-09-01)

| # | Decision | Why it matters |
|---|---|---|
| 1 | **The painter relationship is JOB-WORK**, not purchase | LOT owns the material throughout; it moves on a delivery challan, not a sale, and reconciles in Form ITC-04. Today it is modelled as a purchase (48 VITBOJ POs on painted codes), which is what makes unpainted stock invisible. |
| 2 | **Stock is the forcing function** | "At the painter" is a *balance*, not a checkbox. Nobody can skip the return step because there is no step to skip — the numbers simply read wrong until the goods come back. |
| 3 | **Full loop: the store inwards the unpainted delivery** | The balance is only real if unpainted stock exists. This is the one genuinely new habit in the design. |
| 4 | **Vehicle = Direct Issuance** (approach A) | The return side needs no new object and no new habit: the store already GRNs painted tops today. |
| 5 | **Vendor is mandatory and structured — never free text** | Combobox with server search + inline create. `destination` free text is retired from this path. |
| 6 | **Office becomes a vendor**, `IN-VND-135` | So that every DI has a real vendor, office requests included. |
| 7 | **Rejects use `grn_register.damaged_qty`** — the field the floor ALREADY fills in | ⚠️ **CORRECTED 2026-09-01, after the decision was taken and before any code.** The decision as approved was `qty_rejected`. Measured against the source: `qty_rejected` is **hardcoded `0`** in the receiving GRN insert (`worker.js:20452`) and is `>0` on **0 of 7,025 rows**, while `damaged_qty` is a live per-line input on the Garage receiving screen and carries **13 GRNs / 582 units**, last used 2026-08-04. Activating the dead column would have been this design's own anti-pattern — building on a mechanism nobody uses. **No new field, no new habit: the floor already types this number.** |
| 8 | **A rejected top is credited back to the UNPAINTED code** | Makes rework an ordinary second challan rather than a special path. |
| 9 | **The challan raiser gets vendor-create rights** | An unknown painter must never block a challan. |

---

## 3. Approaches considered

**A — DSP becomes the challan; the return is the GRN the store already does. ← CHOSEN**
Send is a Direct Issuance with a `jobwork` purpose; return is the existing painted-top GRN,
unchanged. The balance is arithmetic over movements that already happen.

**B — Extend the EXT job-work run (RULE-EXT-001).** Most legally coherent: EXT already *is* the
job-work object, vendor required, ITC-04 as its stated basis. Rejected because EXT is a **production
run** — it opens work orders, expects UPC-stickered units and auto-completes on unit counts. Painting
returns *parts*, not units. Bending it is large, and its receive link has fired zero times since S180.

**C — A dedicated `jobwork_challans` object.** Cleanest data model, rejected as the fourth
returnable object in a codebase where three sit unused, and it adds a screen to the store's flow.

---

## 4. Data model

### 4.1 `store.part_finish_pairs` (NEW)

The unpainted→painted transformation, which nothing in the schema currently expresses.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` PK | |
| `unpainted_part_code` | `text NOT NULL` | |
| `painted_part_code` | `text NOT NULL` | |
| `process` | `text NOT NULL DEFAULT 'paint'` | room for future finishes |
| `is_active` | `bool NOT NULL DEFAULT true` | |
| `notes` | `text` | |

`UNIQUE (unpainted_part_code, painted_part_code)`.

A table rather than two columns on `material_master`: the pair is a *relationship*, and putting it on
the master needs two mutually-pointing nullable columns. Join on `part_code` alone (RULE-003).

⏳ **Seed needs Piyush.** `SH-PB-51 → SH-PB-52` is inferable from the names ("Unpainted Asphalt top"
→ "Painted Black Asphalt Top"). The Flare targets are **not** — `FL-PB-97` "Race Unpainted Top" and
`FL-PB-98` "Burnout Unpainted Top" have never been used and their painted counterparts are not named
in the data. ⛔ **Do not guess the mapping from names** — that is the exact failure mode the S83
screw cohort records.

### 4.2 `store.direct_issuances` (ALTER — additive only)

- `purpose` gains `'jobwork'`, validated server-side (mirror `gpPurposeValid`'s shape)
- `+ vendor_code text` — **required for every new DI**, backfilled for the 8 existing rows
- `+ challan_no text` — the GST delivery challan
- `expected_return_at` already exists and finally carries meaning

`destination_contact` already exists and takes the person's name, so "issued to Kirti at the office"
survives the move to a structured vendor.

### 4.3 `store.direct_issuance_returns` (NEW)

`issuance_id` · `part_code` (the painted code) · `qty` · `scrap_qty` · `grn_no` · `received_at` ·
`note`.

This closes an individual challan **for ITC-04**. ⚠️ It is deliberately **not** required for the
balance — gating the GRN on paperwork is precisely how the EXT link died at zero.

### 4.4 `store.jobwork_balance` (VIEW)

Grain: `(vendor_code, unpainted_part_code, painted_part_code)`.

- `sent` = Σ `direct_issuance_items.qty` on DIs with `purpose='jobwork'`, `status='issued'`,
  `issued_at >= cutover`
- `returned` = Σ `grn_register.qty_received` where `part_code` = the painted code,
  `supplier` = the vendor, `grn_date >= cutover`
- `rejected` = Σ `grn_register.damaged_qty`, same filter (⛔ **not** `qty_rejected` — see §5)
- `outstanding` = `sent − returned − rejected` — material still physically at the painter

⚠️ **`outstanding` and `paint_loss` are the SAME arithmetic read in two different states, and
conflating them is the easy mistake.** While a challan is open the remainder is *goods still at the
vendor*; once it is closed the same remainder is *material that never came back* — i.e. paint loss.
The view must therefore expose the raw remainder plus the challan's state, and let the caller name
it. **Do not ship two columns computing the same expression** — that invites one of them being read
as a second, independent measurement.

⚠️ **The cutover anchor is load-bearing.** There are already 18,129 painted tops GRN'd from VITBOJ
against zero unpainted ever sent. Without the anchor the view reads catastrophically negative on day
one and nobody trusts it again.

⚠️ **`Line Flush` is not a vendor.** It is the internal repack line-flush mechanism and accounts for
703 units across `SH-PB-52`/`SH-PB-60`. It must be excluded from "returned from painter" or it
inflates the balance. Exclude by supplier, and re-derive the exclusion list rather than trusting this
line — `supplier` is free text.

### 4.5 New-table housekeeping (both new tables)

RLS on at creation, `GRANT ALL … TO service_role`, and **`NOTIFY pgrst, 'reload schema';` in the same
migration** — a new table in an already-exposed schema is invisible to PostgREST until the cache
reloads, and it fails *silently* (PATTERN-207).

---

## 5. The flow

**① Moulder delivers unpainted tops** — *the one new habit.* Monash's PO is raised on the unpainted
code; the store inwards the delivery instead of inspecting and setting it aside. GRN credits
unpainted stock.

**② Send to painter** — *new object, existing mechanics.* Garage → Direct Issuance,
`purpose='jobwork'`, vendor from the Combobox, lines = unpainted part + qty, expected return date.
Approve prints the DI-NNN sticker **and the delivery challan**, and raises the outward gate pass
(`is_returnable=true`). The `DSP_ISSUE` scan then debits unpainted stock.

⭐ **`postDspIssueScan` issues the WHOLE DI on one sticker scan**, so a 2,000-top consignment is one
scan, not two thousand. A `DSP_ISSUE` device exists and is active. `forceIssueDI` remains the
audited exception for a lorry that leaves without passing the station — do not remove it.

**③ Painter returns painted tops** — *nothing changes for the store.* Normal shipment → receiving →
GRN on the painted code, exactly as they do today across 55 GRNs on these two codes. Receiving now
also captures **rejected qty** on job-work returns. The DI stamp is best-effort.

**④ Balance** — derived, never entered.

### Rejects and rework

**The reject quantity is `grn_register.damaged_qty`** — already a per-line input on the Garage
receiving screen, already used by the floor (13 GRNs / 582 units). ⛔ **NOT `qty_rejected`**, which
is hardcoded `0` in the receiving insert and is `>0` on **0 of 7,025 rows**; activating it would mean
asking the floor to start using a field they never have, which is this design's own anti-pattern.

⭐ **The interpretation is what differs, and it keys off a column that already exists.** On a normal
purchase, damaged goods are a supplier claim and credit nothing. On a **job-work return
(`grn_register.source='jobwork'`, already set by the receiving path)** the damaged material is still
**LOT's own**, so it must come back to the ledger — credited to the **unpainted** code. Same field,
same floor habit, different handling selected by `source`.

⚠️ **Damaged/rejected quantities are counted BESIDE `qty_received`, never inside it.** The worker
already documents this (`worker.js:16900`): rows exist with `qty_received=0` alongside
`damaged_qty=30` (GRN-092), and an earlier reading that subtracted them rendered that receipt as a
−30 stock delta for a movement of nothing. **Do not subtract `damaged_qty` from `qty_received`.**

So 1,000 sent → 950 good + 30 damaged + 20 unaccounted reads as: unpainted −1,000, painted +950,
unpainted +30. Net 970 consumed, 950 converted, **20 paint loss**, outstanding zero. Rework is then
an ordinary second challan on the unpainted code — no special path, no third state.

⛔ **This is NOT a free-standing ledger movement, and it is the single easiest thing to build wrong.**
The GRN line names the *painted* code, and `bulk_update_stock_received` credits the part on the line.
Crediting the rejected quantity back to the **unpainted** code means the job-work receive path must
resolve the pair and write a *second, different* part's ledger row — it is not a variation of the
normal receive, and a naive implementation will silently credit rejects to the painted code, which
inverts the whole balance. Write it as an explicit two-part movement with its own test
(§7, "a rework cycle").

✅ **This half now needs NO behaviour change from the floor** — `damaged_qty` is an existing input
they already use. What changes is only what the worker does with it when `source='jobwork'`.

---

## 6. Vendor handling

- The picker is a **`<Combobox>`** with `onQueryChange` server search. **`portal` is required** — the
  DI form renders inside a card, and without it the dropdown is clipped.
- No match → **"+ Add vendor"** inline, opening a minimal modal (name, category, contact) that
  creates and selects in one step.
- **Office = `IN-VND-135`**, `vendor_name='LOT Office'`, `category='Internal'`. The numeric
  convention is followed deliberately: `postVendor` mints by partitioning on the `<ISO>-VND-` prefix
  and taking max+1 from live data, so a new `IN-INT-` prefix would silently start its own sequence.
  ⚠️ Cost: Office appears in procurement's vendor list. `category='Internal'` is the filter hook —
  **raise that with the Snorkel lane; do not change their app from here.**
- **Migration of the 8 existing DIs:** `vendor_code='IN-VND-135'`; current destinations (Kirti,
  Kaushik, Mohit, Joseph, Kiriti, Joseph Mathew, LOT HQ) move to `destination_contact`. No row
  deleted, nothing lost.
- ⭐ **Vendor creation goes through snorkelops' existing `postVendor`, not a reimplementation.** Two
  code paths minting vendor codes is the duplicate-path class that keeps biting this codebase, and
  the existing one derives from live data *specifically because* bulk imports bypass the counter.
- **Permission:** the challan raiser holds a **lotops** role (`direct_issuance_request` via
  `store.roles`) while `postVendor` checks a **Snorkel** layer (`canManageVendors`). Cross-layer. Route
  it as Garage → lotopsproxy (checks the DI permission) → snorkelops with an **internal bridge token**,
  scope-limited to vendor create — the same shape as the existing `IGNITION_BRIDGE_TOKEN`. Mint the
  token; it is not a blocker.
- ⛔ **BUT THE WORKER-TO-WORKER HOP HAS A HARD BLOCKER, and it is not the token.** A Worker
  **cannot `fetch()` another Worker on the same `workers.dev` zone** — Cloudflare error 1042, which
  surfaces confusingly as a **404**. Cross-worker calls require a **`[[services]]` binding** (the
  precedent is `csops-worker/wrangler.toml`). That means editing `01_worker/wrangler.toml`, and the
  repo rule is **never modify `wrangler.toml` without explicit permission** — so this needs Afshaan's
  go-ahead as a discrete step, not a silent one.
  ⭐ **Therefore the vendor-create hop is split out as its own task and is NOT on the critical path.**
  Until the binding exists, the inline "+ Add vendor" affordance is hidden and an unknown painter is
  added in Snorkel first — degraded, not blocked. **Do not let this hold the rest of the build.**

---

## 7. Testing

- **`part_finish_pairs` resolution** — a painted code with no configured pair still GRNs normally and
  simply does not reconcile. **Degrade, never block.**
- **Balance arithmetic** — sent/returned/rejected/outstanding across: a clean round trip; a partial
  return split over several GRNs; a challan carrying two pairs; a rework cycle (reject → re-send →
  return).
- **Cutover anchor** — a GRN dated before cutover must not count as a return. Assert the view reads
  zero outstanding on day one with no job-work DIs raised.
- **`Line Flush` exclusion** — assert an internal flush GRN does not move any vendor's balance.
- **Multi-vendor** — VITBOJ, Mudra and SG Ventures balances stay independent; nothing assumes one painter.
- **Permission** — a challan raiser without Snorkel rights can still create a vendor through the
  bridge; a user with neither cannot.
- **`postDspIssueScan`** — one scan issues every line on the DI; re-scanning a burned DI is refused.
- ⛔ **Blast-radius sweep before shipping** (RULE-009's lesson): grep every reader of
  `direct_issuances.destination` and `purpose` before changing either. A `purpose` value added
  without checking its readers is the RULE-TAXONOMY-001 `classifyTitles` failure in another file.

---

## 8. Cutover and rollout

Order matters; each step is safe on its own.

1. **Migrations** — the two new tables + the three `direct_issuances` columns. RLS, grants, `NOTIFY`.
2. **Seed** `part_finish_pairs` (Shadow now; Flare when Piyush confirms) and create `IN-VND-135`.
3. **Backfill** the 8 existing DIs to the Office vendor. Snapshot first:
   `CREATE TABLE store.safety_direct_issuances_2026_09_01 AS SELECT * FROM store.direct_issuances;`
4. **Worker + Garage**: the `jobwork` purpose, the vendor Combobox, the challan print, the gate-pass
   raise, the receiving reject capture. **Deploy Garage BEFORE the worker** if the worker starts
   refusing a DI without `vendor_code` — rejecting a cached client for a field it cannot yet send
   would block the desk. (Same ordering trap as the S327 `fbu_kind` deploy.)
5. **Set the cutover date** and announce it.
6. **Repoint `mould_parts`** at the unpainted codes. ⚠️ Do this **deliberately and last** — it feeds
   `seedReceivingLinesFromPO`, so it changes what a mould PO explodes into.
7. **Procurement change**: moulder POs move to unpainted codes; painter POs become **service** POs for
   the painting charge, not goods POs on painted codes.

### Pass conditions

- ✅ A real consignment goes out on a job-work DI and `stock_ledger` shows the unpainted code debited.
- ✅ Its painted return GRNs normally, credits the painted code, and `jobwork_balance` returns to zero.
- ✅ `paint_loss` is non-zero and plausible on at least one closed challan — **a number that does not
  exist anywhere today.**
- ⚠️ **A job-work GRN with `damaged_qty > 0` credits the UNPAINTED code, verified in `stock_ledger`.**
  This is the assertion that the two-part movement was built correctly rather than silently crediting
  the painted code — which would invert the balance while looking fine on screen.

### Deliberately out of scope

- **Recoding the 48 existing VITBOJ POs.** They are miscoded under decision 1 (LOT is buying back
  goods it already owns), but that is a procurement/finance correction, not this build.
- **The moulder→painter leg for products other than Shadow and Flare.** Only these have unpainted
  codes today.
- **Anything about `SH-PB-52`'s pre-existing drift** (12,954 issued vs 10,628 received). Real, not
  caused here, and the balance view must not be read as explaining it.

---

## 9. Rule changes this requires

**RULE-DSP-001 must be amended, not worked around.** It currently records Direct Issuance as
deliberately one-way, and the BACKLOG item carried an explicit *"do NOT build it as a Direct
Issuance"* — written after Piyush confirmed he wanted "a proper send-and-return against the vendor".

Afshaan's call (2026-09-01) reverses that: *"fold it into the direct issuance feature we already have,
we just need to enable it and ensure that we have a way to reconcile/close the loop on the round trip
to the painter."*

This is coherent — he is **adding** the return leg, not misusing the one-way flow — but it overrides
both a recorded rule and a recorded floor answer, so it must be written into `BUSINESS_RULES.md` as a
deliberate amendment. **What RULE-DSP-001 still protects and this design preserves: authorize ≠
execute. Stock moves on the `DSP_ISSUE` scan, never on a click.** That invariant is untouched.

**RULE-EXT-001 is NOT superseded.** EXT remains the vehicle for job-work that returns *units*
(outsourced assembly). This design covers job-work that returns *the same part transformed*. Two
different shapes, deliberately kept apart — do not merge them later without re-reading both.

---

## 10. Open questions

| # | Question | Owner |
|---|---|---|
| 1 | Painted counterparts for `FL-PB-97` and `FL-PB-98` | ⏳ Piyush |
| 2 | ~~Will receiving record rejected qty?~~ **CLOSED** — `damaged_qty` is already a live floor input (13 GRNs / 582 units); no behaviour change needed | — |
| 3 | Are Mudra Innovation and SG Ventures painters on job-work, or genuine suppliers of painted tops? | ⏳ Procurement — decides whether they get pairs and challans or stay purchase |
| 4 | Filtering `category='Internal'` out of procurement vendor pickers | ⏳ Snorkel lane |
| 5 | The cutover date | ⏳ Afshaan |
