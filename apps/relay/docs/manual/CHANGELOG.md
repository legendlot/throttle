# Relay Operations Manual — Changelog

## 1.9.0 — 2026-09-11
- **New chapter: Forms** (`33-forms.html`, Audience part, right after Contacts). Covers the
  `/f/*` capture forms and the back-in-stock widget on sold-out PDPs, the Forms list and what
  Active means (accepting sign-ups, not a sending switch), one form's sign-ups screen (tiles,
  the 30-day per-day chart, top products, the table, search and paging), the 5,000-row sampling
  note, and the back-in-stock alert statuses (Waiting/Queued/Retrying/Stuck/Alerted) tied to the
  five-attempt retry cap. Callout: sign-ups record even while the journey is draft, and no
  customer is emailed until it is activated; each sign-up is alerted at most once. Notes there is
  no CSV export yet.

## 1.8.2 — 2026-09-11
- **Bot Builder:** Publish now saves the canvas first (S372) — the 1.8.1 "Save draft, then Publish" warning is replaced by a note.

## 1.8.1 — 2026-09-11
- **Bot Builder corrections** (hostile review): Publish ships the last SAVED draft (new "Save draft,
  then Publish" callout); Shared flows run their current live version on entry, so a shared-flow
  publish or pause reaches chats already under way; Publish also un-pauses; WhatsApp pause can leave
  a thread out of Pitstop *Awaiting*; keywords on the opening message are WhatsApp-only;
  `dangling_target` is usually an unwired outcome; a duplicated Menu gets new option ids.

## 1.8.0 — 2026-09-11
- **New chapter: Bot Builder** (`26-bot-builder.html`, Send part, right after Journeys). Covers the
  bot list and its 7-day stats, building the flow (Chat start, Duplicate step, Delete step, Expand),
  every step type (Message, Menu, Ask for input, Order status, Hand to agent, End chat, Shared
  flow), the WhatsApp button/list limits and that the canvas lint is advisory while Publish enforces
  them per channel, Settings (channel, keywords, WhatsApp rollout), the side-effect-free Test panel,
  the publish-error table, and Pause/Resume.

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
