# Changelog - Ignition Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

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
