# Relay Links — a first-party URL shortener on the Phase-B redirect

**Status:** scoped 2026-08-04 (S261), building.
**Builds on:** `2026-07-30-relay-link-tracking-phase-b-redirect.md` (the `/r/<code>` redirect, shipped
2026-08-04) — this adds the *product* on top of the engine that already runs.

## Why

The Phase-B redirect exists to make WhatsApp URL-button clicks attributable. But the mechanism it
created — *a link we own, whose destination is decided at tap time* — is worth far more than the case
that motivated it. Afshaan's ask: one place to mint a link, **change where it points after the fact**,
and see what got clicked. The driving use case is **printed QR codes** (packaging inserts, box labels,
catalogue codes, print ads), where the destination must stay changeable long after the artwork is
committed to paper and cannot be recalled.

Nothing like this exists in LOT — verified 2026-08-04, no shortener anywhere in the monorepo or the
workers. QR *rendering* does exist (`qrcode`, used by Redline operator badges + UPC pages and Snorkel
asset labels), so that is reused, not rebuilt.

## The load-bearing decision: two KINDS on one table, with opposite rules

A campaign link and a per-recipient link look identical and must behave in opposite ways. Collapsing
them is a security bug, so `comms.links.kind` is explicit and the rules deliberately diverge.

| | `kind='recipient'` (shipped) | `kind='campaign'` (this spec) |
|---|---|---|
| Code | random 22-char base62 | a **slug the author chooses** (`diwali26`) |
| Why | maps to **ONE customer's cart/order** — an enumerable code leaks that customer's context to anyone who guesses | carries **no personal data**; deliberately shared with thousands of strangers |
| Expiry | 30 days, always set | **NULL — never expires** |
| Destination | fixed at mint | **editable forever**, audited |
| Created by | the send path, automatically | a person, in the UI |
| Volume | one per message | dozens, hand-made |

⚠️ **Do NOT later "unify" these into one behaviour.** Making all links slug-able and permanent would
expose customer cart contexts to slug-guessing; making all links expire would kill a printed QR code
mid-campaign. If a future reader sees the two branches as duplication, this table is why they exist.

⚠️ **A printed QR must never 404.** Retiring a campaign link sets `active=false`, which 302s to
`legendoftoys.com` exactly like an unknown code. The row is never deleted — the artwork is already in
customers' hands and will keep being scanned for years.

## Scope

**Data** (migration `0040`):
- `comms.links` gains `kind` (CHECK `recipient|campaign`, default `recipient` so every existing row is
  correct without a backfill), `title`, `active` (default true), `created_by`, `updated_by`,
  `updated_at`, `last_clicked_at`.
- `comms.link_changes` — append-only audit of destination edits (`code`, `old_target_url`,
  `new_target_url`, `changed_by`, `changed_at`, `reason`). An editable redirect is a thing someone could
  repoint at anywhere; the audit is what makes that recoverable and attributable.
- `comms.link_click_daily` (`code`, `day`, `clicks`, PK both) — a bounded daily rollup, upserted per
  counted click. `click_count` alone cannot draw a chart, and a row-per-click table on a printed QR is
  unbounded. Campaign links have no profile, so they emit **no** `link_clicked` event (that event is
  profile-scoped by design) — this rollup is their entire analytics story.

**Slug rules.** `[a-z0-9][a-z0-9-]{1,30}`, lower-cased on write. Uniqueness is the existing PK on
`code`, so a slug and a minted code can never collide. Slugs live under `/r/`, so they cannot shadow a
worker route (`/health`, `/ingest`, …) no matter what is chosen.

**Worker** — actions on commsops, JWT + the existing `relayops` layer (no new permission key; a link is
a campaign asset):
- `getLinks` / `getLink` — `relay_view`
- `createLink` / `updateLink` — `campaign_build`
- `updateLink` may change target, title, utm and active. Changing the **target** writes a
  `link_changes` row. It may never change `kind` or `code` — a printed code is immutable by definition.

**Resolver.** `resolveLink` additionally treats `active=false` as unresolvable. Everything else about
the redirect path is unchanged, including the prefetch filter, which matters more here: a QR code on
packaging gets scanned by crawlers and preview bots too.

**UI.** New Relay page `/links`, in the "Build & measure" group beside Library (it is the same class of
thing: an asset campaigns draw from). List with clicks; create; edit destination; **QR download**
(reusing the monorepo's `qrcode`); a small daily-clicks chart on the detail.

## Explicitly out of scope

- Per-click detail rows for campaign links (device, geo, referrer). The rollup answers "is this
  working"; anything more is an analytics product, and the data has privacy weight we have no use for.
- Rewriting body-text links through the redirect — Phase A already tags those correctly, and a redirect
  would add a failure point while hiding the destination from the customer.
- A/B or geo-conditional destinations. Tempting on a per-tap resolver, but nothing has asked for it and
  each one multiplies what "where does this link go" means.

## Sequencing note

Buildable and testable on `workers.dev` today. Customer-facing use waits on `lottoys.in` being live on
Cloudflare — and a **campaign link must never be printed before the domain is final**, because unlike a
message link, a printed one cannot be re-issued.
