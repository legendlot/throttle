# Pitstop — Support Analytics Dashboard (design)

> Status: **DESIGN — ready to build** · Date: 2026-07-16 · Owner: Claude (Pitstop/csops)
> Source ask: Pruthvi #bugs 2026-07-14 (ts `1783968397.105759`). Replaces the team's
> manual **"LEGEND OF TOYS — Complaints Dashboard"** Google Sheet
> ([ref sheet](https://docs.google.com/spreadsheets/d/1sOTCJA5xgmgiBSY2Ab2gUOLuBI1BIK7BZzHqXIsvDKY/edit)).
> Two design decisions locked by Afshaan 2026-07-16 (see §3): **purchase-date ageing** +
> **`product_master.product_line`**.

---

## 1. Context

The CS team maintains a manual Google-Sheet "Complaints Dashboard" fed from a separate
Complaints sheet. Every complaint Pitstop already captures as a `cs_tickets` row, so the
dashboard can be rebuilt **live, in-Pitstop, off `cs_tickets`** — no manual re-entry, always
internally consistent (the manual sheet's own totals don't reconcile: 1202 vs 1100 vs 1119
vs 1166 across its panels because of hand-entry drift).

**The reference sheet's panels (the target):**

| Panel | Cut | Source in `cs_tickets` |
|---|---|---|
| KPI band | Total · **Within 3 Days** · **After 3 Days** | count · `created_at − purchase_date` (see §3) |
| Complaints by Product | product × issue-category **matrix** + Total | `product` × `issue_category` |
| Complaints by Issue Category | category → count, % | `issue_category` |
| Complaints by Product Category (**LOT line**) | line-code/name → count, % | `product` → `product_master.product_line` (see §3) |
| Complaints by Channel | sale channel → count, % (Website/Amazon/CRED/Blinkit/Zepto/Swiggy/Instamart/Offline) | `platform` |
| Top Issue Sub-categories | subcategory → count | `issue_subcategory` (+ `issue_subcategory_custom`) |
| MTD Complaints by Product | same product × category matrix, current month | date-filtered |
| Monthly Product Issue Trend | month × product time series | `date_trunc('month', created_at)` × `product` |
| Monthly Category Trend | month × issue-category time series | month × `issue_category` |

**Additions beyond the sheet (per the backlog ask, cheap to include):**
- **By support channel** (WhatsApp / Email / IG / FB / Web / Calls) via `intake_channel` — the
  sheet only has sale-channel; the backlog explicitly wants both.
- **Drill-down** from any cell to the underlying complaint list + descriptions (§7).

Everything maps to columns `cs_tickets` already has **except** the two below.

---

## 2. Goals / non-goals

**Goals**
- One `/analytics` page in Pitstop reproducing every panel above, live off `cs_tickets`.
- A single date filter (**MTD default**; presets Today / MTD / Last month / This year / custom).
- Drill-down from any product/category/channel cut to the matching complaints (with descriptions).
- Internally consistent totals; respects the viewer's department + operator visibility scope.

**Non-goals (v1)**
- No new data capture beyond the two fields in §3. No changes to how complaints are logged.
- No CSV/PDF export in v1 (fast-follow — the page reuses the CSV helper pattern later).
- No SLA/agent-performance analytics here — that already lives in `/reports` + `/history`.
- No cross-system margin/returns-cost tie-in (that's Odo).

---

## 3. Data-model changes (the only two)

### 3a. `public.product_master.product_line` (LOT line taxonomy)
`ALTER TABLE public.product_master ADD COLUMN product_line text;` — the product's true home,
reusable by Odo/Redline later (read-only for them). Seed each active product to its LOT line:

| Line code | Line name | Products (seed — **confirm with team**) |
|---|---|---|
| `LOT-DX` | Drift Cars | Shadow, Flare, Ghost, Vortex, … (Drift-1 platform family) |
| `LOT-OR` | Off-Road Cars | Knox, Fang, Nitro, … |
| `LOT-RC` | Race Car | (race models) |
| `LOT-TR` | Transport | (transport models) |
| `LOT-CX` | Construction | (construction models) |
| `LOT-HS` | High-Speed | Wisp, Apex, … |

- Seed via one migration + a snapshot (`store.safety_product_line_seed_<date>`). Unmapped
  products fall into an **"Unclassified"** bucket on the panel (visible signal to map them).
- Migration is additive/nullable → zero risk to other readers.

### 3b. `store.cs_tickets.purchase_date` (ageing reference — DECIDED: purchase date)
`ALTER TABLE store.cs_tickets ADD COLUMN purchase_date date;` — the order/purchase date the
Within/After-3-days split measures from. **Ageing = `created_at::date − purchase_date`**;
`≤ 3` → "Within 3 Days", `> 3` → "After 3 Days", **NULL → "Ageing unknown"** (its own bucket,
never silently folded into either).

Population (three paths, in priority order):
1. **Auto at ticket creation (no extra Shopify call).** The `/new` order-lookup + `ShopifyPanel`
   already resolve the Shopify order for Website tickets — capture that order's `created_at`
   into `purchase_date` when the ticket is created with a resolved Shopify order. Add
   `purchase_date` to the `createTicket` / `createTicketFromThread` write when the order is in hand.
2. **Manual field.** `purchase_date` is editable on the ticket-detail Customer/Order rail (reuse
   the S215 `customer` edit section — add `purchase_date`), so agents fill it for Amazon / QC /
   offline where no Shopify order exists.
3. **One-time backfill (admin action).** `backfillPurchaseDates` — walk Website tickets with a
   non-null `external_order_id` and null `purchase_date`, resolve each order's `created_at` from
   Shopify in subrequest-bounded batches (≤~40/run, cron-drainable like the email backfill), set
   `purchase_date`. History fills over a few runs; non-Website history stays NULL ("unknown").

No per-render Shopify calls — the dashboard reads `purchase_date` straight off `cs_tickets`.

---

## 4. Architecture

Reuse the **`getReports` pattern** (JS aggregation over a scoped fetch), not RPCs — the volume is
small (all-time ≈ 1,200 complaints; MTD ≈ 250), one round-trip is ample, and it lets us reuse
`visibilityFilters` directly (RPCs would need the scope threaded in). One new read handler:

**`getSupportAnalytics(from, to)`** (GET, gated `cs_reports_view`):
1. `visibilityFilters(params, auth, env)` → dept + operator scope (same as `getKpis`).
2. One `cs_tickets` fetch in `[from, to]` on `created_at`, light columns:
   `created_at, purchase_date, product, issue_category, issue_subcategory, issue_subcategory_custom,
    platform, intake_channel, auto_created` (+ `limit=20000`, `count=exact`).
3. One tiny `product_master` fetch: `product, product_line` (for the LOT-line rollup + the
   product→line map) — cached shape, ~20 rows.
4. Aggregate in JS into every panel object and return one payload:
   ```
   { range, kpis:{ total, within_3d, after_3d, ageing_unknown },
     by_product_matrix:{ products:[{product,total,by_category:{...}}], categories:[…ordered] },
     by_issue_category:[{name,count,pct}],
     by_product_line:[{code,name,count,pct}],
     by_sale_channel:[{name,count,pct}],        // platform
     by_support_channel:[{name,count,pct}],     // intake_channel (+ calls)
     top_subcategories:[{name,count}],
     monthly_product_trend:[{month, total, <product>:n, …}],
     monthly_category_trend:[{month, total, <category>:n, …}] }
   ```
- **Matrix columns** = issue categories present in range, ordered by `cs_issue_catalog.sort_order`
  (data-driven — handles all 12 catalog categories, not the sheet's fixed 8).
- **Support channel** folds call-origin tickets (`auto_created` / `intake_channel='phone'`) into a
  "Calls" bucket; WA/Email/Instagram/Messenger/Web from `intake_channel`.
- Blank `product`/`issue_category`/`platform` → an explicit "—/Unknown" bucket (never dropped).
- The **MTD-by-product** panel is just `getSupportAnalytics` called with the MTD range — no separate
  endpoint; the page requests the selected range and (for the "MTD" sub-panel when a wider range is
  chosen) can issue a second call scoped to the current month, or we surface it purely via the date
  filter (recommend: the date filter drives the whole page; drop the separate always-MTD panel since
  it's redundant once the filter defaults to MTD — confirm in review).

---

## 5. Permissions & scope
- Page + endpoint gated **`cs_reports_view`** (same as `/reports` + `/history`).
- Department + operator visibility via `visibilityFilters` (admins see all / can switch dept; a
  plain agent sees their scoped slice — consistent with the rest of Pitstop). Nav entry under the
  **Analyze** group, beside Reports + History.

---

## 6. Frontend — `/analytics` page
`apps/pitstop/src/app/(auth)/analytics/page.js`, on the Volt kit (mirrors `/reports`):
- **Header:** title + date-filter control (Today / MTD [default] / Last month / This year / Custom).
- **KPI band:** Total · Within 3 Days · After 3 Days · Ageing unknown (4 stat tiles; the last only
  shown when > 0, with a subtle "fill purchase dates" hint linking to the backfill for admins).
- **Complaints by Product** — matrix table (rows = products, cols = issue categories + Total; subtle
  heatmap on cell intensity; TOTAL row). Row/cell click → drill (§7).
- **By Issue Category** + **Top Sub-categories** — ranked lists with count + %.
- **By Product Line (LOT line)** — code · name · count · % share.
- **By Sale Channel** + **By Support Channel** — two ranked lists side by side.
- **Monthly Product Trend** + **Monthly Category Trend** — Recharts stacked/line (reuse the
  `TrendChart` kit already added for `/reports`+`/calls`), plus the underlying month × dimension table.
- Empty/loading/error states per the kit; 60s auto-refresh optional (report data isn't real-time-critical).

## 7. Drill-down
Any product row, category, channel, or matrix cell → navigate to `/queue` pre-filtered so the agent
sees the actual complaints + can open each for its description. Requires small `getTickets` filter
additions (both cheap, reusable): **`product`** and **`from`/`to`** (created_at range) params + the
matching controls on the queue (or applied silently via the URL from the analytics link). Category
(`category`) + platform (`platform`) filters already exist. Descriptions are on the ticket detail
(`issue_description`) — no new read needed.

## 8. Phasing
- **P1 (core):** migrations (3a + 3b) + seed product_line + `getSupportAnalytics` + `/analytics` page
  with every panel EXCEPT auto/backfilled ageing (ageing shows "unknown" until dates land). Ship.
- **P2 (ageing fill):** auto-set `purchase_date` at ticket creation from the resolved Shopify order +
  manual field on the Customer rail + `backfillPurchaseDates` admin action → the Within/After band
  populates.
- **P3 (polish):** CSV export; drill-down queue filters; per-line/per-channel trend toggles.

## 9. Open decisions / data-quality caveats (for review)
1. **product_line seed** — the product→line map above is a first guess; **Piyush/CS to confirm** the
   full mapping (esp. which products are Race / Transport / Construction / High-Speed).
2. **`platform` coverage** — the sheet shows Swiggy/Instamart/Zepto/Blinkit/CRED as sale channels;
   confirm the `cs_tickets.platform` CHECK enum covers them (else widen it, or they group as "Other").
   Same for how consistently agents tag `platform` on non-Website tickets.
3. **Redundant MTD panel** — recommend dropping the sheet's separate always-MTD-by-product block once
   the page date-filter defaults to MTD (it becomes the same view). Keep both only if the team wants a
   fixed MTD block alongside a custom range.
4. **Ageing basis** — locked to **purchase date** per the ask; note delivery-date would be more
   faithful to "arrived broken" but is harder to source — revisit if the team prefers it later.
5. **Blank-field buckets** — products/categories/platforms left blank on a ticket surface as an
   explicit "Unknown" bucket (a nudge to tighten intake tagging), not hidden.

## 10. Acceptance
- Every reference-sheet panel renders live off `cs_tickets` for the selected range; MTD by default.
- Totals reconcile across panels (single source, no hand-entry drift).
- LOT-line rollup resolves via `product_master.product_line`; unmapped → "Unclassified".
- Within/After-3-days populates for tickets with a `purchase_date`; the rest sit in "Ageing unknown".
- Drill-down from a cut lands on the matching complaint list.
- Gated `cs_reports_view`; respects dept + operator scope.
