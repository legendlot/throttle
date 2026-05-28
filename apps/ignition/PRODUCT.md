# Ignition — PRD
> Influencer Marketing CRM for Legend of Toys.
> Last updated: 2026-05-28 (Session 85 — initial)

## Register

ignition

## Users

Ignition is operated by a small marketing team led by Reann. Three roles:

**Influencer Marketing Lead** (Reann, primary persona) — Owns the entire pipeline from sourcing to post-live tracking. Lives in this system. Needs to see the active queue (who is being talked to, who has been shipped to, what's about to go live), historic spend per influencer, and a clean roster filter to re-engage proven creators. Desk and laptop use, no mobile.

**Marketing Manager** — Reviews performance reports, approves higher-value paid deals, audits monthly spend. Lower-frequency use.

**Admin** (Afshaan + super-admins) — Manages users, departments, schema, sheet imports. Read access to everything; configuration access scoped to admin permission key.

CS team (Pitstop) is a downstream consumer, not a direct Ignition user: damaged-shipment events open Pitstop tickets via a manual button in Ignition.

## Product Purpose

Ignition replaces the "Omnipresent — Influencer" Google Sheet — a 6-sheet, ~7,000-row file that is the entire marketing pipeline today. It is unauditable, can't track historic spend per influencer, has no audit trail, and degrades the team's ability to make rating-driven re-engagement decisions.

Ignition gives the marketing team:

- A **CRM pipeline** for every influencer from identification through closed engagement
- **One row per video deal** with full deal terms (paid / barter / affiliate / mixed), payment timing, all costs, and post-live performance metrics
- A **roster view** of every influencer who has done at least one video, with a green/yellow/red quality rating per past engagement
- A **B-list** for parked influencers (low engagement rate, not yet a fit)
- A **UGC pipeline** for the commission-driven creator program that operates beside the paid-video pipeline
- A **discount code pool** that tracks which code went to which engagement and whether it was used
- A **damage handoff** to Pitstop — one click opens a real `cs_ticket` with influencer + product context prefilled

Success looks like: Reann opens `/influencers`, searches a creator by handle, sees every past engagement with cost, ROAS, and the verdict (green/red); decides in five seconds whether to re-engage; clicks through, mints a fresh engagement, and that engagement carries forward into the same audited pipeline.

## Brand Personality

**Energetic · Performance-driven · Direct.** Same Legend of Toys motorsport DNA — bold, terse, technical — applied to a creator-economy use case. Ignition orange (`~#FF6B00`) is the accent colour, layered on the existing yellow/dark base; it functions as a "lit fuse" cue and differentiates Ignition routes from Pitstop's blue chrome.

Voice: action verbs, no marketing fluff. "Ship", "Live", "Closed", "Ghosted" — never "Pending review of next steps." The team already talks like this; the UI should match.

Emotional goals: the user trusts what they see (live, audited spend; honest ratings). They feel a system that respects their time — the queue tells them what to do next without ceremony.

## Anti-references

Explicit list of what Ignition must NOT look like:

- **Influencer-platform SaaS dashboards** (AspireIQ, GRIN, Tribe) — packed with stock-photo influencers, gradient hero cards, AI-suggested matches. Too marketing-y for a working CRM.
- **HubSpot / Salesforce CRMs** — over-templated pipeline stages, drag-drop kanbans, enterprise feel. Wrong tempo.
- **Notion / Airtable databases** — generic table-first views, configurable everything, no opinion. Ignition is opinionated.
- **Crypto creator-economy neon-on-black** — gradient cards, glowing CTAs. Too try-hard.

## Phase A scope (this session)

Per approved plan (`/Users/afshaansiddiqui/.claude/plans/elegant-splashing-bonbon.md`):

- Core CRM pipeline: identify → invite → engage → negotiate → agree → ship → deliver → script → live → track → close
- Full lifecycle state machine (16 stages, 3-layer encoding)
- UGC engagement type alongside Video Tracking
- B-list parking
- Roster view (derived from completed engagements)
- Quality rating (green / yellow / red / unrated) + reason notes
- Discount-code pool with assignment + utilization
- Manual "Open Pitstop Ticket" damage handoff
- Sheet importer for all 6 Omnipresent sheets (~7,000 rows)
- Permissions: 5 keys on `store.roles`, 2 new role rows
- Reports placeholder (recharts wiring — fuller buildout in Phase B)
- Private GH-Pages target repo at `legendlot/ignition`; domain `ignition.legendoftoys.com`

## Phase B (next)

- Multi-video campaign grouping UI
- GA4 connector (auto-pull conversion data via UTM)
- Shopify customer linking (full order history per influencer)
- Auto-rating signals (e.g. ghost → auto red after N days without post)
- Full reports build (spend by month/product, ROAS distribution, CPM histogram, top performers)

## Success metrics

- **Cutover**: 100% of pipeline activity moves off the sheet within 2 weeks of go-live
- **Re-engagement velocity**: time from "thinking about creator X" to "engagement created" drops below 1 minute (vs 5+ min sheet-scrolling today)
- **Audit completeness**: every engagement has a complete cost row + post-live metric row before close (sheet has ~30% incomplete rows today)
- **Damage handoff**: every damaged shipment opens a Pitstop ticket within 30 seconds of being flagged (vs current ad-hoc Slack handoff)
