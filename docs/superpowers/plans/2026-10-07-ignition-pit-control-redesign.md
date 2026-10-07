# Ignition UI refresh ("Pit Control") — implementation plan

> S411 prep session, 2026-10-07. Design source: `design_handoff_ignition_redesign/` (workspace root —
> `README.md` = spec, `design/*.dc.html` = prototypes; the HTML wins over the README).
> Baseline at plan time: `npm test` 19/19 pass · `turbo build --filter=@throttle/ignition` green.
> **Rule for the whole build: presentation changes only, unless an item below is explicitly marked
> WORKER or DECISION. Every page keeps its current worker calls, state, gates and keyboard nav.**

## 0. What the gap map found (7 read-only passes, 2 judgements spot-checked each)

The README says "data model, routes, permissions, worker calls don't change". **That holds for
about 80% of the design.** The other 20% draws data that does not exist, or drops inputs the worker
requires. Those items are listed in §4 and §5, and none of them ships as fake data.

### Hard constraints (breaking these breaks live functionality)
1. **Advance modal must keep its per-stage inputs.** The worker returns 422 without them:
   `video_link` + `post_date` + `rating` for Live, `shipping_order_id`/`tracking_url` for Shipped,
   and the On-track/Delayed fork for Scheduled (which reroutes to `delayed` and sends
   `expected_post_date`). It must also keep the skip warning, the note, the UGC stage list and the
   422 error mapping (`components/AdvanceModal.js`; worker `index.js:2765–2815`). Build the design's
   stage grid as **step 1** and today's input panel as **step 2**.
2. **Connects composer stays Cmd/Ctrl+Enter.** The design's single-line Enter-to-send fires real
   customer messages. Keep the 24h-window lock (non-email), `sendErr`, the email subject bar,
   `sandbox=""` on the email iframe, the `confirm()` on Send back to Pitstop, and `sent_by_name` on
   outgoing bubbles.
3. **Shared `@throttle/ui` is untouched** (12 apps). Shared `Modal`, `Spinner` and `Toast`
   **hard-code their colours** (`#111/#222/#333`, scrim `rgba(0,0,0,.75)`), so the README's
   "aliases make them pick up the palette" is false for them. Fix: an Ignition-local `Modal` with
   the **same props API** (10 call sites swap only the import). Toast and Spinner are acceptable as-is.
4. **Keep every gate:** `ignition_manage`, `ignition_approve`, `ignition_admin`,
   `ignition_reports_view`, `ignition_connects`. The new UI has two places that **look clickable for
   read-only users**: the rating segmented control and B-List "Move to master". Gate both on
   `canManage`.
5. **Keep:** `useListNav` on Engagements, Influencers, Connects and Campaigns (the Campaigns card
   grid needs it rebuilt); `data-search-primary` on every page search (`useSearchShortcut` only
   focuses that, it is not a command palette); the Engagements sessionStorage filter key
   `ignition.engagements.filters.v2`; the 200 × 25 paging loop and its short-page stop; the
   Influencers `loadMore`; and the BrokenLinksPanel "suggestion only on click" rule.
6. **Mobile CSS selects on inline style strings** (`[style*="columns: 1fr 1fr"]` in
   `globals.css` ≤767px). A restyle that changes those strings silently un-stacks mobile layouts, so
   re-check at 375px on every page.

### Pre-existing bugs found (fix FIRST, own commits, so the restyle can't mask or inherit them)
- **B1 `setRating` wipes `rating_notes` on every click.** The worker writes
  `rating_notes: body.rating_notes || null` (`index.js:2892`) and the UI sends no notes
  (`influencers/detail/page.js:63`). The new rating segmented control would make this one tap.
- **B2 Schedule "chasing" links are dead.** They go to `/engagements/?search=<no>`
  (`schedule/page.js:236,262,285`), and `/engagements` never reads `?search=`.
- **B3 UTC month on Dashboard + Targets.** Both use `new Date().toISOString().slice(0,7)`
  (`dashboard/page.js:31`, `targets/page.js:11`), so 00:00–05:29 IST on the 1st shows last month.
  The worker's Payments `summary` today/week/month buckets are UTC too.
- **B4 New Deal page vs NewDealModal disagree.** The page shows payment fields for every deal type
  and defaults terms to `on_release`. The modal hides them unless the deal is paid and defaults to
  `advance`. → DECISION D7.

## 1. Release strategy

The Ignition Pages deploy fires on every push touching `apps/ignition/**`
(`.github/workflows/deploy-ignition.yml`), and Reann's team uses the app all day. Plan: **incremental
to main, one page per commit, each smoked live** (`tools/wait-deploy.sh ignition <sha>` → in-app
browser). Phase 1 swaps the palette for the whole app at once, so un-restyled pages already render in
the new colours and the mixed state between commits stays coherent. No feature flag: a flag doubles
every page and is the larger risk.

**Regression gate per commit:** `npm test` green → full build with no "Attempted import error"
(a runtime crash at exit 0) → the route's checklist in §6 smoked at desktop width and 375px →
`/hostile-review` on the diff.

## 2. Phase 0 — refactors with zero visual change (de-risk the big files)

| # | Item | Why |
|---|---|---|
| P0.1 | Fix B1–B3 (+ B4 after D7) | Separate commits, worker deploy for B1 (pass existing notes through, or have `setRating` leave notes alone when absent). |
| P0.2 | **Split `engagements/detail/page.js` (110 KB, 1,868 lines)** into `engagements/detail/components/*`: DetailHeader, PipelineCard + 4 banners (approval/lock/unlocked/data-warning), Products, DealTerms, Costs, PostLive + TrackingLinkRow, Performance + DealTotals, Codes + CodeRow, Compliance, Payments, Influencer, Logistics (+ shipment helpers 1698–1837), Notes, History, BriefPreviewButton, CompletenessPill | A pure move, so the build output is visually identical. Restyling one card at a time is reviewable afterwards; restyling 110 KB in place is not. |
| P0.3 | Extract a shared `useDealForm` used by `engagements/new/page.js` **and** `NewDealModal.js` (keeps `presetInfluencer`, `onCreated`, payload field-dropping, `productsValid && linesAreValid`) | Both get the new look from one source and can't drift. |
| P0.4 | Add the missing CSS variables the shared components already read and Ignition never defined: `--t4`, `--border-3`, `--r-full`, `--font-ui` | Chip's radius and border are broken today and the restyle depends on them. |

## 3. Phase 1 — foundation + shell (one coherent visual switch)

1. **Tokens** in `globals.css :root` per the README table. Keep every legacy alias (`--t1..3`,
   `--surface2/3`, `--border2`, `--yellow/2`, `--red`, `--green`, `--orange`, `--blue`, `--mono`,
   `--cond`), remapped onto the new values. Keep `--yellow` = brand yellow (Combobox and Chip focus
   use it). Port every keyframe (`igUp igSlide igGrowX igGrowY igFuse igPulse igRing igPop igFade
   igDash`) using `animation-fill-mode: backwards`, and keep the reduced-motion block.
2. **Fonts:** they load twice today (`globals.css:1` `@import` + `layout.js:16-19` `<link>`). Keep
   one `<link>` and add Hanken Grotesk 400–700. `themeColor` `#1f1f1f` → `#0e1015`.
3. **Primitives** in `src/components/ui/`: Card, SectionTitle, Segmented, StagePill, DealPill,
   RatingDot, Tile, FilterSelect, SearchField (`data-search-primary`), TableCard + Row, Avatar,
   Modal (same API as `@throttle/ui` Modal), Stepper, ProgressBar, Spark, Banner, Menu.
   `lib/stages.js` STAGE_PALETTE and `lib/ugcStages.js` take the new hexes, with **labels and stage
   lists unchanged** (PATTERN-076 three-layer stage encoding).
4. **Shell:** `components/shell/IgRail.js` + `IgTopbar.js` replace `<Sidebar>`/`<Topbar>` in
   `(auth)/layout.js`.
   - The rail is collapsible, defaults to collapsed, and persists in `localStorage['ig.rail.expanded']`
     (hydrated in an effect; static export). `[` toggles it.
   - New icons go into `nav.js`. "New Deal" leaves the rail, but **keep its route** and the mobile
     tab bar/sheet.
   - The Connects badge has **no data today** (no unread count anywhere), so it ships hidden →
     Phase 4 W6.
   - IgTopbar: the search field focuses `data-search-primary`. LIVE · synced Ns comes from
     `useRefreshState()`. Keep `<AppLauncher current="ignition" />`. The `+ New deal` CTA routes to
     `/engagements/new`.
   - `.sb-wrap` hiding ≤767px moves to the rail's own class.

## 4. Phase 2–3 — pages (presentation only, low risk → high)

Each line is one commit, and fixes that ride along are named.

**Phase 2 (list pages, S–M):** Login (the fuse stripe and official Google G; keep the redirect and
`hd` hint) · B-List (restyle; the Move-to-master action → W5) · Payments (kind pills
advance→Advance, final→Balance, other→Other; tiles from the existing `summary`) · Influencers (type
cards + Total reach already returned by `getInfluencerCounts`) · Connects list (status pill mapping
→ D5) · Campaigns list (card grid; **keep the per-campaign Spend-vs-budget table below the grid**,
since no Reports source exists for it) · UGC list (all 5 tiles + per-row ROAS/days/owed already in
`getUgcPipeline`; keep the stray-stage warning) · Schedule (client-side overdue state; keep
ChasingList with B2 fixed) · Engagements list (**fold in the open backlog item: scroll + filter
restore on Back**; tab counts → W4) · Users (role counts client-side from `users[].role_key`) ·
Import (restyle the instruction stub → D3) · Manual (→ D4) · Targets (keep the click-month-to-edit
path and the Views breakdown) · Reports (presets map onto the existing from/to; **keep CSV export
and YTD default** → D6; histogram buckets map onto the worker's 5 bands).

**Phase 3 (detail pages, L, after P0.2/P0.3):** Influencer detail (the reach chart comes from
`getInfluencerMetrics`; **keep the reach table + form + delete in a disclosure**; keep Shopify
line items, Business-driven card, do-not-ship reason) · Campaign detail (the brief stays a file
card → D2; "Spent vs Committed" → W8) · UGC detail (keep Creator / Deal / Hook / Product / Payment
/ brief-version cards; Daily ROAS → D1) · Connect detail (constraint 2) · New Deal (both surfaces
via `useDealForm`; keep inline create-campaign, Directed to, goodies/shipping/list-price hint) ·
**Engagement detail last** (one card per commit on the P0.2 components; constraint 1; keep the
Performance editor (takes, gap reasons, DealTotals), Codes actions, TrackingLinkRow,
gifted-no-post, the delete-confirm modal and the unlock-reason prompt).

## 5. Phase 4 — worker-backed additions (each its own item + `ignitionops` deploy)

| # | Design element | Today | Change |
|---|---|---|---|
| W1 | Dashboard pipeline per-stage counts + ₹ committed + Video/UGC/All | `getKpis` returns `{active, live, ghosted, overdue, engagement_totals, ugc_summary}` only (`index.js:1395`) | add `type` param + `stage_counts` + `committed` |
| W2 | Organic-views delta vs previous period + 7-bar sparkline; Live "+n this week" | all-time totals only | weekly series in `getKpis` |
| W3 | "Approved {date} · by {name}"; note author; history actor | `approved_by`, `actor` are uuids | resolve names (precedent: `unlocked_by_name`, `index.js:827`) |
| W4 | Engagements tab counts | tabs filter server-side | per-stage counts (reuse W1) |
| W5 | B-List **Move to master** (new action) | none; `updateInfluencer{list_status}` exists, gated `ignition_manage` | front-end only + gate |
| W6 | Connects rail unread badge, "{n} new" | none | count `status='new'` (decisions §3485: build "awaiting reply" on the `ignition_connect_reply_flags` RPC, not on a column) |
| W7 | Roster rating counts, Videos, CPM, verdict strip; `getRoster` "shipped+" filter runs after `limit` (a paging bug) | not returned | extend `getRoster` (+ define "Videos") |
| W8 | Campaign Spent (paid) vs Committed | `rollup.spend` = committed | aggregate `payments` per campaign |
| W9 | New Deal "last deal Nd ago"; Dashboard **Re-book** preset | not returned; `/new` reads no params | `last_deal_at` on `getInfluencers`; `/engagements/new?influencer=` |
| W10 | Influencer detail "team avg CPM" hint | only `getReports.avg_cpm` (gated, range-scoped, mean-of-CPMs) | ungated blended figure, or drop the hint |

Until each W ships, its element is **omitted**, never faked.

## 6. Regression checklist (smoke per route; from the gap-map inventories)

- **Shell:** every nav item honours its `requires`; `/` focuses search; the rail state survives a
  reload; ≤767px tab bar + More sheet work; sign-out; AppLauncher.
- **Dashboard:** Flag overdue red (`canManage` only) → toast + reload; overdue/re-engage links;
  empty-target "Set one →".
- **Engagements:** all filters + persistence across reload; stage chips only on All; paging past 200;
  keyboard ↑↓/Enter; tiles exclude cancelled; New Deal.
- **Engagement detail:** approve; unlock (reason prompt) / re-lock; advance through every input
  branch (live, shipped video+UGC, scheduled delayed); every card's edit+save; products editor
  validity; payments + proof; codes issue/retire/sync; video takes add/remove; compliance +
  gifted-no-post; notes; delete (incl. has_payments refusal); Brief; Open Pitstop.
- **New deal (page + modal):** influencer search; each deal type's field rules; inline campaign;
  product lines; create → routes to detail.
- **Influencers / detail:** every filter + sort + loadMore + type cards; broken-link Use/Save;
  rating (notes preserved after B1); edit Identity+Contact incl. `+ add` options; reach log
  add/delete; Shopify lookup; archive-vs-delete.
- **Roster, B-List, UGC (+detail: stepper moves, prompts, refresh metrics, brief), Campaigns
  (+detail: create, edit, delete 409, attach/detach, brief upload/open), Connects (+detail: reply,
  24h lock, status, promote, send back), Payments (record with proof, view proof, delete), Schedule
  (month nav, list view, chasing links), Reports (range, CSV), Targets (save, expand, unallocated),
  Users (grant, revoke, restore), Manual (TOC, PDF), Login.**

## 7. Close-out
- System manual: `manual-builder` refreshes screenshots and copy (the `data/manual.json` + PDF version
  bump), last.
- Tell the floor: a `#system-updates` note to Reann's team before Phase 1 lands (the whole app
  changes colour and the sidebar becomes a rail).
- `systems/ignition.md`: the mobile-shell paragraph (`.sb-wrap`) and the shell description move to
  IgRail; `apps/ignition/DESIGN.md` tokens are replaced.

## Decisions for Afshaan (D1–D7)
- **D1** UGC detail "Daily ROAS · last 14 days" has no data source (no daily table; Meta pulls
  lifetime totals only). Options: drop the chart (rec.) / build a daily Meta table.
- **D2** Campaign "brief text + tag pills" has no fields; the brief is an uploaded file. Options:
  show the file card (rec.) / add schema.
- **D3** Import is a stub that tells you to run a Python script. Options: restyle the instructions
  (rec.) / build a real importer (L).
- **D4** Manual: re-skin the shared `Manual` renderer via tokens; it already reads `--accent`
  (rec.) / write a local renderer to match the prototype exactly.
- **D5** Connects statuses are new/working/promoted/closed, while the design shows
  New/Replied/Linked/Returned (a returned thread leaves the list). Map working→Replied,
  promoted→Linked, keep Closed; no Returned (rec.).
- **D6** Reports default range: keep YTD (rec., no behaviour change) / the design's implied 90d.
- **D7** New Deal payment fields: the modal's rule (hide unless paid, default `advance`) on both
  surfaces (rec.) / the page's rule.
- Also: the design drops the per-deal **Verdict** (influencer detail + roster strip), and there is
  **no per-deal rating storage** (`quality_rating` is one overwritten value per influencer). It is
  omitted unless we add a column, which is a separate build.
