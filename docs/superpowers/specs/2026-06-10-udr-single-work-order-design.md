# UDR Request → Single Work Order (parent + lines) — Design

> Status: DESIGN (not built). Author: S117 (2026-06-10), prompted by Mrudula 06-10 13:28
> ("while requesting UDRs, each variant is being created as different work orders —
> can we get one issue as one work order?"). Afshaan: build for long-term stability +
> scalability, not a quick fix.

## 1. The ask

A UDR re-dispatch request raised in Redline for, say, Ghost UG Black ×13 + Ghost Burnout
Yellow ×17 + Shadow Tarmac ×11 currently lands in the Garage Issue Queue as **three
separate work orders** (WO-779/780/781…). The team wants **one request = one work order**,
with the variants as lines inside it.

## 2. Today's process (full trace)

```
Redline /returns ──createUdrRequest({lines:[{product,model,color,qty}], notes})──▶ worker
   worker createUdrRequest (worker.js ~9756):
     FOR EACH line: nextSeq('wo','WO-') → INSERT store.work_orders
       { wo_no, wo_type:'UDR', status:'Open', product, variant, colour, qty }
     ⇒ N work_orders rows (one per variant)              ← the complaint

Garage /issue-queue ──getWorkOrders──▶ worker
   getWorkOrders (worker.js ~1672): SELECT work_orders
     WHERE status NOT IN (Complete,Cancelled,Rejected) AND wo_type<>'planned'
   ⇒ renders ONE ROW PER work_order ⇒ N UDR rows in the queue

Scanner "Issue UDR" station ──postUdrIssueScan({scan, device, operator})──▶ worker
   postUdrIssueScan (worker.js ~7841):
     1. find open return_unit (disposition UDR, issued_at null, released_at null) by car_upc
     2. MATCH one open work_orders row: wo_type=UDR, status=Open, product (+colour),
        FIFO created_at.asc, limit 1
     3. stamp return_units.udr_wo_no = wo.wo_no, issued_at, issue_type='udr'
     4. fulfilled = COUNT(return_units WHERE udr_wo_no = wo.wo_no);
        if fulfilled >= wo.qty → work_orders.status='Complete' (over = soft scan_violation)

Garage UDR pool (read-only) ──getReturnsPickList?kind=udr──▶ worker
   buckets return_units by product|model|color. PURELY return_units-driven —
   does NOT read work_orders. ⇒ UNAFFECTED by this change.

Redline pool counts ──getReturnPilesV2──▶ worker
   counts return_units by disposition (S116: active = !released && !issued_at).
   ⇒ UNAFFECTED by this change.
```

### Why it's "one WO per variant" today
`store.work_orders` is a **flat single-variant row** (product / variant / colour / qty).
There is no child-line concept, and `postUdrIssueScan` matches + closes a WO by
`product (+colour)`. So a multi-variant request cannot be one WO without a line model.

### Schema facts
- `store.work_orders`: id, wo_no, date, product, variant, qty, line_no, status, wo_type,
  colour, created_at, completed_at, notes, run_id, repack_run_id, repair_run_id, phase,
  receipt_id, issue_mode. **Flat. No lines.**
- `store.return_units` carries `udr_wo_no` (text) — the link a scan stamps.
- **Precedent that already exists:** `public.repair_runs` (parent: run_no/status/
  target_units/completed_units) + `public.repair_run_lines` (child: repair_run_id FK,
  product/model/color/target_car_qty). UDR should mirror this parent/child shape.

## 3. Two model options

### Option A — dedicated `store.udr_requests` + `store.udr_request_lines`
Mirror repair_runs/repair_run_lines exactly, UDR-specific. Lowest blast radius (work_orders
untouched for every other type). **But** it adds a *third* parallel "request" concept
(work_orders vs repair_runs vs udr_requests) and the Issue Queue (which is work_orders-centric)
would need a separate fetch+merge for UDR. Less unified long-term.

### Option B — generic parent `work_orders` + new `store.work_order_lines`  ★ RECOMMENDED
One `work_orders` row stays the **parent** (the queue's unit, wo_type='UDR'); a new generic
`store.work_order_lines` child table holds the per-variant lines with their own fulfilment.
This is the scalable choice Afshaan asked for because:
- The Issue Queue already centres on `work_orders` — one parent row per request keeps the
  queue model intact; we just nest lines.
- It **generalises**: the same `work_order_lines` mechanism can later absorb the parked
  "Repair (CXR/BRV) Issue-Queue consolidation" and multi-line repack pulls — ONE consolidation
  primitive for the whole Issue Queue instead of per-type tables.
- Fulfilment moves to line-level; the parent status is derived.

The rest of this spec details **Option B**.

## 4. Data model (Option B)

New table — additive migration `udr_work_order_lines_v1`:

```sql
CREATE TABLE store.work_order_lines (
  id            bigserial PRIMARY KEY,
  work_order_id bigint NOT NULL REFERENCES store.work_orders(id) ON DELETE CASCADE,
  product       text   NOT NULL,
  variant       text,                 -- model
  colour        text,
  qty           integer NOT NULL,      -- target for this variant
  fulfilled_qty integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'Open',   -- Open | Complete
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wol_wo_idx       ON store.work_order_lines(work_order_id);
CREATE INDEX wol_match_idx    ON store.work_order_lines(work_order_id, product, colour) WHERE status='Open';
GRANT ALL ON store.work_order_lines TO service_role;        -- RULE (every new store table)
GRANT USAGE, SELECT ON SEQUENCE store.work_order_lines_id_seq TO service_role;
ALTER TABLE store.work_order_lines ENABLE ROW LEVEL SECURITY; -- RULE-RLS-001, no anon policy

-- precise per-line fulfilment link (count units by the line they fulfilled)
ALTER TABLE store.return_units ADD COLUMN udr_wo_line_id bigint;  -- FK-ish to work_order_lines.id
```

Parent `work_orders` row for a UDR request:
- `wo_type='UDR'`, `status='Open'`, `qty = SUM(line qty)` (at-a-glance total),
  `product` = single product if the whole request is one product else NULL, `variant`/`colour`
  NULL (detail lives in lines), `notes`.

**Fulfilment is derived, never a stored running total that can drift:** a line's
`fulfilled_qty` is maintained as `COUNT(return_units WHERE udr_wo_line_id = line.id)` (recomputed
on each scan), mirroring how `postUdrIssueScan` already recomputes from `udr_wo_no` today.

## 5. Worker changes (lotopsproxy `01_worker/worker.js`)

1. **`createUdrRequest`** (~9756) — rewrite:
   - Mint ONE `WO-NNN` parent (wo_type='UDR', status='Open', qty=Σ, product=single-or-null).
   - Insert N `work_order_lines` in **one array insert** (2 subrequests total vs N today —
     also better against the 50-subrequest limit).
   - Return `{ wo_no, lines: N }`.
2. **`postUdrIssueScan`** (~7841) — change matching from work_orders→work_order_lines:
   - After finding the open `return_unit`, MATCH an open **work_order_lines** row by
     `product (+colour)` where `fulfilled_qty < qty`, joined to an Open UDR parent,
     FIFO by parent `created_at` (then line id). One extra query; same shape as today.
   - Stamp `return_units.udr_wo_no = parent.wo_no` **and** `udr_wo_line_id = line.id`.
   - Recompute that line's `fulfilled_qty = COUNT(units with udr_wo_line_id)`; set line
     `status='Complete'` when met (over = soft `scan_violations`, unchanged policy).
   - When **all** lines of the parent are Complete → parent `status='Complete', completed_at`.
   - Reject text unchanged ("No open UDR request for <product> <colour> — production must
     request it first") — now driven by "no open line".
3. **`getWorkOrders`** (~1672) — for UDR parents, attach their lines:
   - Either PostgREST embed `select=*,work_order_lines(*)` (needs the FK relationship exposed
     to PostgREST) or a second `work_order_lines?work_order_id=in.(…)` fetch keyed back.
   - Return UDR rows with a `lines:[{product,variant,colour,qty,fulfilled_qty,status}]` array
     + derived `fulfilled_total`/`qty_total`. Non-UDR rows unchanged.
4. **Parent close/cancel** — `updateWorkOrder` cancelling a UDR parent cascades lines
   (ON DELETE CASCADE handles delete; for Cancel, set parent + all lines status).
5. **getReturnsPickList / getReturnPilesV2** — NO CHANGE (return_units-driven).

## 6. Frontend changes

1. **Garage `apps/garage/src/app/(auth)/issue-queue/page.js`** — the visible win:
   render a UDR work order as **one card** showing the request (WO-NNN, total fulfilled/target,
   raised-by/date) with its **variant lines listed inside** (per-line product · model · colour ·
   fulfilled/target + a Complete tick). Replaces N rows with 1 grouped card. Keep the existing
   "scan at Issue UDR" hint + read-only (no desk-issue button, per RULE-RET-002 #3).
2. **Redline `apps/redline/src/app/(auth)/returns/page.js`** — Request UDR already submits a
   `lines[]` batch; only the success toast changes ("1 work order created with N lines").
   No structural change.

## 7. Business-rule change

Amend **RULE-RET-002 #2**: a UDR request is modelled as **ONE store work order
(`wo_type='UDR'`) carrying N `work_order_lines` (one per variant), NOT one work order per line.**
Fulfilment is tracked per line (`fulfilled_qty`, derived from `return_units.udr_wo_line_id`);
the parent closes when every line is met. Over-count stays soft. Document
`store.work_order_lines` in CORE.md as the generic multi-line work-order primitive (UDR first;
repair/repack consolidation can adopt it later).

## 8. Migration / rollout sequence

1. Migration `udr_work_order_lines_v1` (additive): create `work_order_lines` (+ grants + RLS +
   indexes) + `return_units.udr_wo_line_id`.
2. **Backfill (uniformity, no dual-path):** for every existing OPEN UDR `work_orders` row,
   insert one `work_order_lines` row mirroring it (qty/product/colour), set
   `fulfilled_qty = COUNT(return_units WHERE udr_wo_no = that wo_no)`, and stamp those units'
   `udr_wo_line_id`. Now every UDR WO — old and new — is uniformly parent+lines (old ones just
   have one line), so the new scan path handles them with no legacy branch.
3. Deploy worker (createUdrRequest + postUdrIssueScan + getWorkOrders) — edit→commit→push→deploy.
4. Push frontend (Garage issue-queue card + Redline toast).
5. Live floor smoke (below).

## 9. Edge cases & guards

- **50-subrequest limit:** createUdrRequest = 2 subrequests (parent + array-insert lines);
  postUdrIssueScan = ~5 (find unit, find line, update unit, recount line, maybe close parent).
- **FIFO across requests:** multiple open lines for the same product+colour → match the oldest
  open parent's line first (preserves today's behaviour).
- **Partial fulfilment:** parent stays Open until all lines Complete; UI shows total + per-line
  progress. (Optional `Partially Issued` status if a distinct queue state is wanted — derive,
  don't store, to avoid drift.)
- **Over-issue:** soft scan_violation at line level (unchanged policy).
- **Manual cancel:** cancelling a parent cancels all its lines; a single line can be zeroed by
  editing qty (future, if needed).
- **No double-count in queue:** `getWorkOrders` returns parents only; lines are nested, never
  separate rows.
- **RLS:** new table is service_role-only; scanner reaches it only via the worker (never the
  anon key) — RULE-RLS-001.

## 10. Live floor smoke (after build)

Redline: raise a UDR request with 3 variants → confirm Garage Issue Queue shows **one** card
(WO-NNN) with 3 lines + 0/target each. Scan a unit of variant A at Issue UDR → that line
increments, others untouched; pool drops the unit. Fulfil all 3 lines → the single card flips
Complete (not 3 separate completions). Confirm a scan with no open line hard-rejects; an
over-scan soft-flags. Confirm the Garage UDR pool + Redline pool counts still read correctly
(unchanged). Confirm non-UDR work orders render exactly as before.
```
