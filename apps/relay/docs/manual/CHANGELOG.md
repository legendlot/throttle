# Relay Operations Manual — Changelog

## 1.3.1 — 2026-08-26
- **Journeys**: new "Saving: what gets checked" section. Relay validates the whole graph on every
  save and refuses one that could not run; the section names the four checks an author actually
  meets, including the new `send_no_template_or_body` (a send step needs either a saved template or
  message text typed on the step). Adds the note that free-text steps are legitimate and are how the
  COD confirmation replies work, so nobody "fixes" them by forcing a template on.

> ⚠️ **Gap in this file, recorded rather than invented: versions 1.2.0 and 1.3.0 shipped with no
> changelog entry.** `manual.json` was on 1.3.0 before this edit while the newest entry below was
> 1.1.0. CORE.md records that **1.3.0 added the SMS & RCS chapter (24 chapters total)**; what 1.2.0
> changed is not recorded anywhere found. Left blank rather than guessed.

## 1.1.0 — 2026-08-13
- **Segments**: new "Grouping conditions" section for nested condition groups, including the
  one-level limit and what the read-only banner on an over-nested rule means.

## 1.0.0 — 2026-08-13
First complete edition. 22 chapters across 6 parts, covering every screen in Relay.

- **Getting Started** — what Relay is, signing in, the six roles, and a dedicated chapter
  on the send gate (the single most common source of "why did fewer people get this?").
- **Overview** — the control tower and its status strip.
- **Send** — Campaigns, Audience Exclusions, A/B Testing, Experiment Log, Journeys.
- **Audience** — Activity, Segments, Contacts.
- **Build & Measure** — Templates, Library, Links, Analytics.
- **Admin** — Users, Roles, Approval & Caps, Sender Identities, Connectors.

Written against the app as it stood on 2026-08-13, which includes campaign audience
exclusions and the segment event count operators (= and ≤) shipped the same day.
