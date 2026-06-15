# Redline — Production History & Totals

**Date:** 2026-06-15 (Session 137) · **System:** Redline (production floor)

## Goal
One place to see **what was produced, by day, at a product level**, plus the **running
total** for a chosen period — without exporting first. Today there's no such view:
`/hourly` is single-day-by-hour; `/reporting` (Pit Wall) is plan-vs-actual / QC / cycle-time
over a range. Neither answers "which day, what did I make, and how much in total."

## Definition of "produced"
A unit is **produced when it's packed out at PKG OUT** (packed & ready-to-dispatch). PKG OUT
is fed by **both fresh production and returns**, so the page **segregates Fresh / Returns / Total**.

In `public.scans` (`station='PKG_OUT'`, one row per car `upc`, `timestamp`):
- **Fresh** = `activity IN ('RTE','RTR')` (ecom-ready / retail-ready — the fresh pack-out path).
- **Returns** = `activity = 'RTD_RETURN'` (a store-issued UDR returned unit re-packed out).
- **Total** = Fresh + Returns.

Cars only (one per box): join `public.units` on `upc` with `component_type='car'` — this excludes
the paired-remote PKG_OUT scans automatically. Exclude `voided = true`. Day = IST calendar day
(`timestamp AT TIME ZONE 'Asia/Kolkata'`). Counted as `COUNT(DISTINCT upc)` per bucket so a rare
same-day re-scan can't double-count.

## Data — Postgres RPC (server-side aggregation; mirrors `get_hourly_production`)
`public.get_production_history(p_from date, p_to date)` → rows `{ day, product, fresh_qty,
return_qty, total_qty }`, grouped by IST day × product, ordered day desc. `STABLE SECURITY
DEFINER`, `search_path=public`, `GRANT EXECUTE … TO service_role`. Bound the scan filter on
`timestamp` (index-friendly) using IST midnight of `p_from` .. `p_to+1`. Single RPC = no
50-subrequest concern. Non-destructive migration (CREATE OR REPLACE FUNCTION).

## Worker — lotopsproxy GET action (Garage/Redline/Scanner blast radius)
`getProductionHistory` (`?from=&to=`) → `rpcPublic('get_production_history', { p_from, p_to })`,
returns the rows. Read-only, JWT-gated at the routing layer like `getHourlyProduction` (no extra
perm guard, matching the sibling reporting reads).

## Page — `apps/redline/src/app/(auth)/production-history/page.js` (+ nav entry)
- **Period filter** (presets, like other tabs): **Today · This Week (Mon-start) · This Month ·
  This FY (Apr 1)** + a custom from/to. Resolve to `from`/`to` ISO dates, refetch.
- **Three total tiles** for the selected period: **Fresh · Returns · Total** (the running totals).
- **Daily breakdown, newest day first.** Each day is a group: a day header (date + day totals
  Fresh/Returns/Total) and product rows beneath (product · fresh · return · total). So you see
  which day, what product, how many.
- **Download CSV** → `date, product, fresh, returns, total` rows for the selected period.
- Reuse Redline reporting patterns: `garageFetch`, the `downloadCsv` helper + date/preset helpers
  from `/reporting`, shared UI (`Panel`/`Chip`/tiles), CSS tokens. Match the existing page chrome.

## Out of scope (v1)
- No line/variant/colour split (product-level only; can add later).
- No targets/plan-vs-actual (that's `/reporting`).
- Superseded-but-not-voided scans counted as-is (refine only if it proves noisy).

## Files
- Migration: `get_production_history` RPC (Supabase, `public`).
- `01_worker/worker.js`: `getProductionHistory` action.
- `apps/redline/src/app/(auth)/production-history/page.js` + Redline nav config entry.
