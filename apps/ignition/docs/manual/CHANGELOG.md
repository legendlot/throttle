# Changelog - Ignition Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.14.0] - 2026-09-11
### Added
- Engagement detail: documented the COMPLETE-deal lock (Deal Terms, Costs, Post-live,
  Products and Compliance go read-only once a deal is Complete; Performance, payments,
  notes, stage, POC, logistics, codes and Ads stay open), the Unlock for edit / Lock again
  controls (24h window, approval-rights only, logged), and the 11 Sep 2026 backfill that
  marked Followers gained "Internal gap" on every historic Live deal.
- Engagement detail: added an Ads card section (approval, gated 10 days after the take
  posts IST; run status, which needs approval to hand-set Running; Meta refresh; ad
  payments to the creator with required paid screenshots) and noted ad money (ad payments
  and Meta spend) is outside the influencer budget and no longer includes a Costs card
  "Ad spend" field.
### Changed
- Performance card: Views now splits into Paid views (typed, or filled by a synced Meta
  ad) and a derived Organic views line; CPM and the performance ratios now compute off
  organic views, not the platform total.

## [1.13.0] - 2026-09-10
### Changed
- Engagements list + engagement detail: documented that a declared gap reason (Internal
  gap / Gated data / System timing) recorded on the per-video Performance card now
  satisfies the Views, Likes or Followers gained completeness check, so a deal can be
  Complete with a metric explained rather than captured. Cost has no gap reason and must
  still be a real total greater than zero. Updated the green tick hover text and the
  "Not complete" filter description accordingly.

## [1.12.0] - 2026-09-10
### Added
- Engagement detail: the Logistics card now shows live courier status alongside the
  hand-entered Shipping order / Tracking / Shipping date / Delivered fields: a Courier
  lifecycle badge (Pending, Manifested, In transit, Out for delivery, Delivered, RTO,
  Cancelled) plus courier name, an AWB row (linked to Delhivery's public tracking page for
  Delhivery parcels, plain text otherwise), and Dispatched / Delivered (courier) timestamps
  in IST. Documented "matched by order prefix", "Awaiting courier sync" and "Sent via
  <courier> - no tracking" as normal, non-error states, and added a callout that stage and
  courier lifecycle are different things that will often disagree, and a deal's stage
  should never be changed just to match the courier.
- Schedule: the "overdue to post" clock now counts from the courier's actual delivery date
  where known, not from a stage-click date. Added two new panels above the chasing list:
  parcels that came back (RTO/cancelled, do not chase the creator) and parcels stuck in
  transit 14+ days (chase the courier, not the creator).

## [1.11.1] - 2026-09-04
### Fixed
- Engagement detail: corrected the Video #1/Post-live callout. Only the posted date is a
  shared field between the Video #1 tab and the Post-live card; the video link is edited on
  the Video #1 tab and the Post-live card only displays it. The Post-live card's Tracking
  link is a separate thing (the deal's UTM link, minted from Relay), not the video link.
- Engagement detail: corrected the Followers at post date rule. It is required once ANY
  number is entered on a take (views, likes, comments, shares, reposts, saves, impressions,
  followers gained, organic or paid views), not unconditionally; a take with only a link and
  posted date can be saved.

## [1.11.0] - 2026-09-04
### Changed
- Engagement detail: the Performance card now holds one video per tab (Video #1, Video #2,
  up to six per deal), each with its own link, posted date and metrics. + Add video adds a
  take; Remove video #N deletes any take but the primary Video #1. Deal totals, below the
  tabs, is now a rollup of the takes (views, likes, comments, shares, reposts, saves,
  followers gained, impressions), no longer typed directly; Sessions, Orders and
  Conversions ₹ stay deal-level and editable there. Video #1's link and posted date are the
  same field as the Post-live card's.
- Targets: documented the month drill-down for the first time (Spend, Views, Conversions),
  and the new behaviour where a deal's videos each count in the month they posted; a take
  after the first shows a small "#2" and its own posted date in the Views drill-down.

## [1.10.0] - 2026-09-04
### Changed
- Engagement detail: documented "Complete" as a derived flag, not a stage. A Live deal reads
  Complete once Views, Likes, Followers gained and Cost are all entered; the header shows a
  green Complete pill or a muted Incomplete pill naming exactly which numbers are missing.
  Live remains the final stage; nothing moves when a deal becomes Complete.
- Engagements: documented the green checkmark after the engagement number for Complete deals,
  and the new Completion filter (All / Complete / Not complete) beside the date filter.

## [1.8.0] - 2026-09-04
### Changed
- New Deal / Product Lines: the product field is pick-only now (catalogue only, no free
  typing); a product that does not exist yet has to be created first. Older deals with a
  typed-in product still open and save unchanged unless that field itself is edited.
- Engagement detail: Followers at post date is now a required Performance field (no
  "why blank?" reason accepted for it) since the number cannot be recovered later.
- Engagement detail: a warning banner appears on a live deal missing Cost or Views (warns,
  does not block).
- Engagement detail: the tracking-link mismatch warning is now automatic, showing where the
  link points versus where the deal now points, with a link to Relay -> Links to fix it.
- Engagements: added deal type, multi-select product, and campaign filters, all of which
  combine with the existing tabs/stage/date filters.

## [1.1.0] - 2026-06-06
### Added
- Payments, Schedule and Targets chapters. Payments and Schedule join the Work
  part; Targets joins the Analyze part ahead of Reports. Covers the per-deal
  payment log and spend tiles, the monthly go-live calendar/list, and the
  monthly views-and-budget targets with their progress tracking. Same house
  style and depth as the existing chapters.

## [1.0.0] - 2026-05-29
### Added
- Complete self-serve manual for Ignition: 5 parts, 16 chapters (Getting Started,
  Work, Lists, Analyze, Admin) covering the dashboard, influencers, the engagement
  pipeline, codes, campaigns, reports and admin. Role-segmented (Marketer / Lead /
  Admin). Themed to Ignition's orange identity. Built with the shared pipeline and
  impeccable theme; copy in house style (no em dashes). Phase-B placeholder screens
  (Reports, Campaigns, parts of Codes) are documented honestly as view-only today.
