# Garage Dashboard — PCB & FBU/SKD Unit Sections

> Design spec · 2026-06-03 · Garage (`05_Throttle/apps/garage`) + lotopsproxy (`01_worker/worker.js`)

## Goal

Add two new at-a-glance sections to the top of the Garage Dashboard, directly
below the metric cards:

1. **PCBs** — per product, the live stock of the **Car PCB** and the **Remote PCB**.
2. **FBU & SKD Units** — per product, the live stock of the **car** unit and the
   **remote** unit for products that are received/held as FBU or SKD.

The existing **Reorder Flags** and **Producible Units by Product** grid moves down
to sit directly below these two new sections (content unchanged).

## Layout

Both sections render in the dashboard's existing responsive two-column grid
(`twoColStyle` — `repeat(auto-fit, minmax(560px, 1fr))`, so they sit side-by-side
on wide screens and stack on narrow ones), placed immediately after the KPI cards
and before the Reorder Flags / Producible grid.

### Section 1 — PCBs

- Header: `PCBs — Car & Remote`, with a product count on the right.
- One row per product (PCBs are `variant_model='Common'` — no colour split, no expand).
- Layout per row: **product name on the left**; on the right, two mono numbers,
  each with a small caption — **CAR** and **REMOTE**.
- A side with no PCB part shows `—`. Negative/zero stock renders in the error/red
  tone (consistent with the rest of the dashboard).
- Only products that have at least one PCB part appear (per decision; FBU-only
  products with no PCB part are skipped).

### Section 2 — FBU & SKD Units

- Header: `FBU & SKD Units`, with a product count on the right.
- One **collapsible** row per product. Collapsed shows: **product name on the left**
  (with a small `FBU` / `SKD` tag — or both if the product has both); on the right
  **CAR** and **REMOTE** totals (summed across variants/colours).
- Clicking a row expands a per-variant/colour breakdown table: one line per
  `variant + colour`, each showing its car and remote qty. Reuses the existing
  expand interaction pattern from the Producible panel (`expandedIndex` state,
  kept in a separate state var for this section).
- If a product is FBU/SKD on only one side (e.g. car is FBU, remote is CKD), the
  missing side shows `—` (the CKD remote board is already covered in the PCB
  section). Products are listed if they have **either** a car or remote FBU/SKD unit.

## Data source

A new **read-only** lotopsproxy GET action, `getDashboardUnits`, computes both
sections server-side and returns a clean shape. This keeps the part-identification
logic (which is finicky) in one place and avoids fragile client-side pattern
matching. The action is purely additive (a new `case` in the GET switch), so
blast radius on lotopsproxy is minimal.

### Response shape

```json
{
  "pcb": [
    { "product": "Apex", "car_stock": 0, "remote_stock": 0,
      "car_code": "AP-EL-02", "remote_code": "AP-EL-07" }
  ],
  "units": [
    { "product": "Flare", "formats": ["SKD"],
      "car_total": 500, "remote_total": 500,
      "variants": [
        { "label": "Burnout Grey", "car": 350, "remote": null },
        { "label": "Burnout Red",  "car": 150, "remote": null }
      ]
    },
    { "product": "Mac", "formats": ["FBU"],
      "car_total": 1000, "remote_total": null,
      "variants": [
        { "label": "Base · Black", "car": 500, "remote": null },
        { "label": "Base · Red",   "car": 500, "remote": null }
      ]
    }
  ]
}
```

`null` on a side means "no unit of this type exists for this product" → renders `—`.

### PCB identification

A part is a PCB iff:
- `part_code` matches `…-EL-…` (electronics-coded), **and**
- `part_name` contains `PCB` or `Controller` (case-insensitive). The `Controller`
  synonym catches Bumble's remote board (`BM-EL-13 "Controller"`). The `-EL-`
  code guard excludes `BM-PB-38 "PCB Cover"` (a plastic cover, code `-PB-`).

Car vs Remote split: `part_category = 'Remote'` → remote PCB; any other category
(`Car`, `Train`, …) → car PCB. Live stock = `stock_ledger.closing_stock` for the
part code. Only active `bom_register` rows are considered.

If a product somehow has more than one car-side (or remote-side) PCB part, sum
their stock for that side (defensive; not expected in current data).

### FBU identification

`store.fbu_stock`: group by `product`, split by `component_type` (`car` /
`remote`). Per variant/colour line uses `variant`+`color`; totals sum across them.
`qty_on_hand` is the stock. (Today only `car` rows exist; `remote` rows render
automatically when present.)

### SKD identification

Active `bom_register` rows with `bom_format = 'SKD'`, joined to
`stock_ledger.closing_stock`:
- **car** = the `Half Built Chassis` row's stock.
- **remote** = the `Built Up Remote` row's stock.
- All other SKD rows (Accessories Bag, tops, screws, USB cable, etc.) are **not**
  counted toward the car/remote unit totals (per decision — they're loose bundle
  components, not the car/remote unit).
- Per-variant breakdown: group the chassis / built-up-remote rows by
  `variant_model` (e.g. `Burnout Grey`, `Burnout Red` for the tops; chassis/remote
  are `Burnout`). The chassis colour split comes from the colour-specific Top rows
  where applicable; v1 keys the variant label off `variant_model` of the
  chassis/remote rows directly.

> Note: in current data the SKD chassis (`FL-SKD-01`) and built-up remote
> (`FL-SKD-11`) are single `variant_model='Burnout'` rows (500 each), while the
> colour split lives on the Top rows (`FL-SKD-09/10`). For v1 the SKD car/remote
> totals come from chassis + built-up-remote stock; the variant breakdown shows
> the chassis/remote rows by their `variant_model`. If per-colour chassis tracking
> is added later, the breakdown picks it up automatically.

### Identification matching: name-based, resilient

Names are matched case-insensitively and tolerant of word order (`Car PCB`,
`PCB Car`, `PCB`). The chassis/built-up-remote SKD rows are matched by
`part_name ILIKE '%half built chassis%'` (car) and `%built up remote%` (remote);
if those exact names change, the spec's matcher is the single place to update.

## Worker query plan (subrequest budget)

`getDashboardUnits` runs a small fixed set of parallel queries (well under the
50-subrequest limit):
1. `bom_register` active rows: `select=part_code,part_name,product,part_category,variant_model,bom_format` filtered to PCB-candidate `-EL-` codes **or** `bom_format=eq.SKD`.
2. `stock_ledger`: `select=part_code,closing_stock` for the part codes from (1) (single `IN` filter).
3. `fbu_stock`: `select=product,variant,color,component_type,qty_on_hand`.

All numeric values wrapped with `Number()` (PostgREST returns numerics as
strings). Server assembles the `pcb` and `units` arrays and returns them.

## Client (Garage dashboard)

- New loader `loadUnits(session, ...)` calls `garageFetch('getDashboardUnits', {}, session)`,
  with its own `units`/`unitsLoading` state, wired into `loadAll()` and the existing
  60s auto-refresh — exactly mirroring `loadProducible`.
- New `expandedUnitIndex` state for the FBU/SKD collapsible rows (separate from the
  Producible panel's `expandedIndex`).
- Render order in the page body: KPI cards → **PCBs + FBU/SKD grid** → Reorder
  Flags + Producible grid → (rest unchanged: Recent Shipments, GRNs, etc.).
- Reuse existing `panelStyle`, `panelHeaderStyle`, `twoColStyle`, mono fonts, and
  the red/green state tones already defined in the file. No new shared components.
- Loading: each section shows the existing `Spinner` while its data loads; empty
  state uses `EmptyState`.

## Visibility / permissions

Ungated — shown to anyone who can load the Garage dashboard, consistent with the
existing Reorder Flags and Producible panels.

## Out of scope

- No new tables or migrations.
- No changes to how PCB / FBU / SKD stock is *recorded* — read-only display.
- No per-colour chassis tracking for SKD (uses chassis/remote stock as-is).
- Reorder Flags and Producible panels are only *moved*, not changed.

## Files touched

- `01_worker/worker.js` — new `case 'getDashboardUnits'` in the GET switch
  (additive). Commit → push → `npx wrangler deploy`.
- `05_Throttle/apps/garage/src/app/(auth)/dashboard/page.js` — new loader, state,
  and two render sections; move the existing Reorder/Producible grid below them.
  Build with `npx turbo build --filter=garage`; auto-deploys on push.
