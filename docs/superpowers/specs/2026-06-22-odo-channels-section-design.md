# Odo — Channels section (per-channel-family pages)

> Design spec · 2026-06-22 · Status: approved, building
> Scope: **frontend-only** in `apps/odo`. No worker, no DB, no migration.
> Sibling project (separate spec): the **Uniware (Unicommerce) connector** that will feed
> Flipkart + QC + long-tail. This spec is the *consumer* UI; it ships independently and
> auto-populates as connectors come online.

## Goal

A **Channels** sidebar group with one page per channel *family*. Each page shows the
family's **combined** headline metrics on top, then **splits into its constituent channels**
below (mirroring how `/marketing` shows combined KPIs then a per-platform split). Reuses the
existing `/performance` segregation ladder, scoped to a family.

## The 7 families

Single source of truth: `apps/odo/src/lib/families.js` — `FAMILY_ORDER`, `FAMILIES`
(`{key,label,color,emptyReason,match}`), and `familyOf(channelName)`.

| Family key | Label | Channels (`dispatch_channels.is_sale=true`) | Data today |
|---|---|---|---|
| `website` | Website | Website | full order-grain ladder |
| `amazon` | Amazon | Amazon-FBA, Amazon-Flex, Amazon-IXD | gross+units (FBA only; Flex/IXD fold into the FBA report) |
| `flipkart` | Flipkart | Flipkart Flex, Flipkart Managed | none → Uniware |
| `quickcom` | Quick-comm | Zepto, Blinkit, Instamart | gross+units |
| `gtmt` | GT / MT | GT, MT | none until a confirmed Snorkel sales order |
| `longtail` | Long-tail | Cred, Firstcry, Peeko | none → Uniware / upload |
| `other` | Other / Internal | Events, Export, Sold from WH | none → upload |

`familyOf` matches by name (regex), falling back to `other`. This taxonomy **replaces** the
cockpit's coarser `channelGroup()`/`GROUP_META`/`GROUP_ORDER` — the cockpit (`/`) migrates to
import from `lib/families.js`, so Amazon and Flipkart become **separate bands** in the
cockpit's stacked chart (Flipkart empty for now). One definition, used everywhere.

## Navigation

`apps/odo/src/app/(auth)/layout.js` — extend the flat `NAV` to support a **collapsible group**.
A `CHANNELS` group header (Store icon) expands to the 7 family sub-links, all gated on
`sales_view`. Group auto-expands when a child route is active; chevron indicates state.
`/channels` (no family) redirects to `/channels/website`.

## Page architecture

One shared component `apps/odo/src/components/ChannelFamilyPage.js`, rendered by 7 tiny static
routes (`app/(auth)/channels/<family>/page.js`, each `<ChannelFamilyPage familyKey="…" />`).
Static-export-safe (no dynamic params).

**Shared, extracted to avoid drift with `/performance`:**
- `lib/segregation.js` → `aggOrders(rows)` (the order-grain ladder math; `/performance` imports it too).
- `components/kit.js` → `Delta`, `Kpi` (presentational; `/performance` imports them too).

**Data path** (existing endpoints, scoped to the family's channel IDs — resolved client-side
from `getBootstrap.channels` via `familyOf`):
- `getSegregation {from,to,channel_id}` + prior period → order-grain ladder + deltas.
- `getSales {from,to,group:'variant',channel_id}` + prior period → gross/units (fallback header,
  trend, top sellers) + deltas.

`hasOrderGrain = segRows.length > 0`.

## Page content

1. **Range header** — presets + custom dates (as `/performance`), gross/units toggle for the trend.
2. **Combined header KPIs:**
   - `hasOrderGrain` → full ladder (Orders · Total Sales · Net · Net ex-GST · AOV · Cancellations ·
     Returns · Discounts) from `aggOrders(segRows)`, prior-period deltas.
   - else → Gross · Units · ASP tiles from `getSales`, with a one-line note that the full ladder
     fills in once order-grain segregation extends to this channel.
3. **Trend** — `StackedTrendChart` stacked by **sub-channel** (one band per channel in the family),
   gross/units. Days/dayVals built client-side from `getSales` rows by `(sale_date, channel_id)`.
4. **By channel (the split)** — table, one row per sub-channel with data: gross, units, and order
   metrics (orders/cancel/returns/discount/GST) where the channel has order-grain, else `—`.
5. **Top sellers** — variant rollup within the family (top 12, gross/units), compact bar list.
6. **Empty families** — clean shell + `FAMILIES[key].emptyReason` (e.g. "Awaiting Uniware
   connector"), so the page doubles as a coverage indicator.

**Mixed-family caveat (v1):** no family is currently mixed-grain (only Website is order-grain).
If a family ever has *some* order-grain and *some* gross-only channels, v1 shows the ladder from
the order-grain channels + gross/units totals across all — refine when that case actually arises.

## Permissions / build / deploy

All pages gated `sales_view` (same as Performance/Marketing). `npx turbo build --filter=odo`
must be green; commit + push (auto-deploys to odo.legendoftoys.com). Frontend-only — no worker
deploy, no migration.

## Out of scope (own specs / follow-ups)
- **Uniware (Unicommerce) connector** — feeds Flipkart + QC + long-tail; own research/auth/grain spec.
- **Order-grain ladder for non-Shopify channels** — the existing P1 "NET revenue everywhere"
  effort; these pages auto-upgrade gross-tiles → full-ladder when it lands.
