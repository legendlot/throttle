# Pitstop Meta Comments — IG + FB Post Comments in the Inbox — Design

> **Status:** Design / not built. **Date:** 2026-06-27 (S181). **For:** a dedicated Pitstop session.
> **Origin:** Pruthvi #bugs 2026-06-27 — "a dedicated inbox section for managing Instagram + Facebook public post comments and responses from within Pitstop." The 6th and last of his 2026-06-27 batch (the other 5 shipped S181).
> **Builds on:** the LIVE Meta DM integration (S161) — webhook receiver, signature verification, per-channel Graph base/token, the cross-channel `/inbox`. This doc reuses that plumbing and adds **comments** as a distinct surface.

---

## 0. TL;DR

- Comments are **NOT** captured today. The Meta webhook (`handleMetaWebhook`) only iterates `entry.messaging`/`entry.standby` → `ev.message` (DMs). Comment events arrive under **`entry.changes[]`** (`field: 'comments'` for IG, `field: 'feed'` for FB Page) and are **silently dropped** — the loop never looks at `changes`.
- The **Graph plumbing partly exists**: `metaGraphBase(channel)` + `metaToken(channel, env)` give us the right host + token per channel (used for DMs). What's missing for comments: the **comment-reply / moderation Graph calls** (`POST /{comment-id}/replies`, hide/delete) and — critically — the **comment-management permissions** (DMs use `*_manage_messages`; comments need `*_manage_comments` / `pages_manage_engagement`, a **separate App Review**).
- The **webhook field subscription** ("comments"/"feed") is a Meta **App-Dashboard + page-`subscribed_apps`** setting, not visible in this repo. **Must be verified out-of-band** (§3). Even if it's already subscribed, the code change in §4 is required before a single comment is stored.
- **Data-model recommendation:** **new tables** (`cs_post_comments` + light `cs_social_posts`), NOT a reuse of `cs_wa_threads`/`cs_wa_messages`. Comments are public, post-anchored, tree-shaped, and carry moderation state (hidden/deleted) — they don't fit the 1:1 DM "thread" model the way email did. (Email reused the thread tables because email genuinely IS a 1:1 conversation; a comment stream is not.)

---

## 1. Scope

**In:** capture IG + FB **public post comments** (top-level + replies) into Pitstop; a dedicated **Comments** inbox surface to read, **reply**, **hide/unhide**, and **delete**; assignment + done/reopen so comments are accountable like threads; link a comment to a ticket (optional). Private-reply-to-comment (DM a commenter) is a **nice-to-have** (§7.3).

**Out (v1):** comment **sentiment/auto-moderation**, bulk actions, comment analytics, replying to ad comments, Stories/Reels-mention handling, comment translation. Threads/DMs are unchanged.

---

## 2. What exists today — verified (the "do we already have it" check)

Verified in `csops-worker/src/index.js` @ S181:

| Piece | State | Where |
|---|---|---|
| Webhook verify (`hub.verify_token`) | ✅ LIVE | `handleMetaVerify` (~L3693) — shared, no change needed |
| Signature check (FB + IG app secret) | ✅ LIVE | `handleMetaWebhook` (~L3710) — shared |
| **`entry.changes` (comment events) ingestion** | ❌ **MISSING — dropped** | loop @ ~L3728 only reads `entry.messaging \|\| entry.standby` |
| Per-channel Graph host | ✅ LIVE | `metaGraphBase(channel)` (~L3689) — `graph.instagram.com` (IG) / `graph.facebook.com` (FB) |
| Per-channel token | ✅ LIVE | `metaToken(channel, env)` (~L3683) — `META_IG_TOKEN` / `META_PAGE_TOKEN` |
| Handle resolution | ✅ LIVE (reusable) | `resolveMetaHandle` (~L3755) |
| **Comment-reply / hide / delete Graph calls** | ❌ MISSING | — |
| **Comment-management permissions** | ❓ **likely NOT granted** | DMs hold `instagram_business_manage_messages` / `pages_messaging` — comments need different scopes (§3.2) |
| Comment tables | ❌ none | `store` has no `%comment%` table |
| `cs_wa_threads.channel` | free-text (no CHECK) | distribution: whatsapp 5684 / instagram 332 / email 58 / messenger 2 |

**Bottom line for Afshaan:** the *transport shell* (verify + signature + Graph host/token) is shared and ready. The *comment-specific* work — ingesting `changes`, the reply/moderation endpoints, and the comment permissions/subscription — is all net-new. The subscription "field" you remember may well be toggled in the App Dashboard, but it's inert until §4 ships.

---

## 3. The two real gates (verify before building)

### 3.1 Webhook field subscription
Comment events only arrive if the app is subscribed to the **`comments`** field (IG object) and **`feed`** field (Page object), AND the page/IG account has the app subscribed with those fields. Verify (run with the live tokens — these are worker secrets, so run from a machine that has them, or add a one-off diagnostic GET):

```
# FB Page — which fields is the app subscribed to on the page?
GET https://graph.facebook.com/v21.0/{page-id}/subscribed_apps?access_token={META_PAGE_TOKEN}
#   → want subscribed_fields to include "feed"

# IG — app subscription on the IG user (IG-login path)
GET https://graph.instagram.com/v21.0/{ig-user-id}/subscribed_apps?access_token={META_IG_TOKEN}
#   → want "comments"
```
App Dashboard → Webhooks → object `instagram` (field `comments`) + object `page` (field `feed`) must also be checked. If absent, subscribe:
```
POST https://graph.facebook.com/v21.0/{page-id}/subscribed_apps   subscribed_fields=feed,messages
POST https://graph.instagram.com/v21.0/{ig-user-id}/subscribed_apps   subscribed_fields=comments,messages
```
*(Keep the existing `messages` field — don't replace it.)*

### 3.2 Permissions (App Review) — the long-pole
DMs already passed review for messaging scopes; **comments need separate scopes**:
- **Instagram:** `instagram_business_manage_comments` (read + reply + hide + delete IG comments).
- **Facebook Page:** `pages_read_engagement` + `pages_manage_engagement` (read comments + reply/hide/delete/like), and `pages_read_user_content` to read user-authored comments.

These must be added to the app's App Review submission. **Until granted, comment ingestion + replies work only for users with a role on the app/page (dev/test mode)** — same gotcha that held IG DMs in Development mode (S161). Plan the review submission early; it's the critical path, not the code.

---

## 4. Inbound ingestion — the webhook change

In `handleMetaWebhook`, after the existing `messaging`/`standby` loop, also walk `entry.changes`:

```js
for (const entry of (body.entry || [])) {
  for (const ev of (entry.messaging || entry.standby || [])) {
    if (ev.message) await metaHandleMessage(channel, ev, env);
  }
  for (const ch of (entry.changes || [])) {            // NEW
    if (ch.field === 'comments' || ch.field === 'feed') {
      await metaHandleComment(channel, entry, ch, env);
    }
  }
}
```

`metaHandleComment` parses the `value` payload (shapes differ by object):

- **IG (`field:'comments'`)** `value`: `{ id (comment-id), text, from:{id,username}, media:{id}, parent_id?, timestamp? }`.
- **FB (`field:'feed'`)** `value`: `{ item:'comment', verb:'add'|'edited'|'remove'|'hide', comment_id, post_id, parent_id?, message, from:{id,name}, created_time }` — note `feed` also fires for posts/reactions/shares, so **filter `item==='comment'`** and branch on `verb` (`add`/`edited` → upsert; `remove` → mark deleted; `hide`/`unhide` → mark hidden).

Behaviour:
- **Idempotent** on the platform comment-id (UNIQUE), like DMs on `provider_message_id`.
- **Skip our own replies' echoes** — a comment whose `from.id` is our own page/IG id is an outbound row (we posted it), not an inbound to action. (FB `feed` echoes our replies; IG may too.)
- Resolve + cache the commenter handle via `resolveMetaHandle` (reuse).
- Upsert the **post** (`cs_social_posts`) lazily on first comment so the inbox can group by post.
- For an **inbound** top-level comment or a reply to *our* comment, optionally run the round-robin assigner (reuse `cs_autoassign_thread` pattern but against the comment row — see §6 assignment) — **decide in §9**.
- Always `200 ok` to avoid Meta retry storms (existing pattern).

---

## 5. Data model (NEW — `store`, RLS-on, service_role-only)

### `store.cs_social_posts` (one row per IG/FB post we've seen a comment on)
| col | notes |
|---|---|
| `id` uuid PK | |
| `channel` | `instagram` \| `facebook` |
| `platform_post_id` text | IG media id / FB post id — **UNIQUE(channel, platform_post_id)** |
| `permalink` text | best-effort via Graph (`/{media-id}?fields=permalink`) |
| `caption` text, `media_url` text, `media_type` text | best-effort, for inbox context |
| `first_seen_at`, `last_comment_at` timestamptz | |

### `store.cs_post_comments` (the comment stream)
| col | notes |
|---|---|
| `id` uuid PK | |
| `post_id` uuid FK → cs_social_posts | |
| `channel` | mirror for cheap filtering |
| `platform_comment_id` text | **UNIQUE** — idempotency key |
| `parent_comment_id` text | null = top-level; else the platform id of the parent (one-level tree is enough for IG/FB) |
| `direction` | `inbound` (customer) \| `outbound` (our reply) |
| `from_external_id` text, `from_handle` text | commenter |
| `body` text | |
| `status` | `visible` \| `hidden` \| `deleted` (moderation state) |
| `comment_state` | `open` \| `closed` (work-queue, mirrors threads' `thread_state`) — top-level comments only |
| `assigned_agent_id` uuid, `assigned_agent_name` text, `assigned_at` | mirrors threads |
| `closed_at`, `closed_by_user_id` | |
| `ticket_id` bigint FK → cs_tickets (nullable) | optional link |
| `replied_at`, `replied_by_user_id` | set when we post a reply |
| `posted_at` timestamptz | platform comment time |
| `raw_meta` jsonb | the webhook `value` |

Reuse `store.cs_thread_tags`-style tagging only if wanted later — **not v1**.
Migration `pitstop_meta_comments_v1`; `GRANT ALL … TO service_role`; RLS on (RULE-RLS-001).

**Why new tables, not `cs_wa_threads`:** a comment isn't a 1:1 conversation — it's public, anchored to a post, has a (shallow) reply tree, and has moderation states (`hidden`/`deleted`) the DM model has no column for. Forcing it into `cs_wa_messages` would mean a synthetic "thread per post" or "thread per commenter" and overloading `kind`/`status`, polluting the DM inbox queries. Separate tables keep both clean. (Contrast email, which reused the thread tables because it genuinely is a 1:1 conversation.)

---

## 6. Worker actions (csops)

**Reads (GET, gate `cs_ticket_view`):**
- `getPostComments` — list comments; filters `channel`, `status` (open/closed/all), `post_id`, `assigned`/`unassigned`/mine, search; grouped by post; paginated (limit/offset, mirror queue). Enrich with the post row.
- `getCommentThread` — one top-level comment + its replies (for the detail/reply view).

**Writes (POST):**
- `replyToComment` (gate `cs_ticket_manage`) — `POST {graphBase}/{platform_comment_id}/replies` (IG) / `/{comment-id}/comments` (FB) with the agent's text + token; on success insert an `outbound` `cs_post_comments` row (dedup on the returned id, so the webhook echo is a no-op), stamp `replied_at`/`replied_by`, auto-claim the parent (mirror DM auto-claim), optional ticket link.
- `setCommentStatus` (gate `cs_ticket_manage`) — hide/unhide: `POST /{comment-id}?hide=true|false` (FB) / IG equivalent; delete: `DELETE /{comment-id}`. Update local `status`. **Delete is destructive on Meta's side — confirm in UI.**
- `setCommentState` (gate `cs_ticket_manage`) — open/closed work-queue flip (Done/Reopen).
- `assignComment` (self = `cs_ticket_manage`, other = `cs_ticket_reassign`) — mirror `assignThread`.
- `linkCommentToTicket` / `createTicketFromComment` (gate `cs_ticket_manage`) — optional, mirror the thread equivalents.

All Graph calls use `metaGraphBase(thread/comment.channel)` + `metaToken(channel, env)` (already exist).

---

## 7. UI surface (`apps/pitstop`)

### 7.1 New `/comments` page (nav after `/inbox`, gate `cs_ticket_view`)
- Left: comment list grouped by **post** (post thumbnail/caption + comment count + latest), with the same control row the inbox has: channel (IG/FB/all), Active/Closed/All, mine/unassigned/all, search, sort, pagination.
- Right: selected comment **detail** — the post context at top, the comment + its replies (tree), and an action bar: **Reply** (composer), **Hide/Unhide**, **Delete** (confirm), **Done/Reopen**, **Assign**, **Link/Create ticket**.
- Reuse the inbox's kit (`KpiCard`/`Tabs`/composer pieces, `TagChip`), the `csopsGet`/`csopsPost` helpers, and the dept/presence chrome.

### 7.2 Or a tab inside `/inbox`?
Decision in §9. Recommendation: **separate `/comments` page** — the grouping unit (post, not person) and the moderation actions差 enough that a tab would muddy the DM inbox. A small unread-comments count can surface on the inbox nav.

### 7.3 Private reply (nice-to-have, defer)
Meta allows ONE private DM reply to a comment within 7 days (`POST /{page}/messages` with `recipient:{comment_id}`). Useful for "DM'd you the details" — defer to v2; note it so we don't design it out.

---

## 8. Open decisions for the build session

1. **Surface:** dedicated `/comments` page (recommended) vs a tab in `/inbox`.
2. **Assignment/round-robin:** auto-assign inbound comments like DM threads, or leave comments **pull-only** (agents claim from a shared queue)? Comments are higher-volume + lower-SLA than DMs — pull-only may be calmer. (Recommend pull-only v1; reuse the config table pattern if auto is wanted.)
3. **Scope of moderation:** expose **Delete** to all `cs_ticket_manage`, or gate Delete to `cs_ticket_admin` (it's destructive + public)? (Recommend: Hide = manage; Delete = admin.)
4. **Which posts/accounts:** all comments on the @legendoftoys IG + the FB Page, or only organic (exclude **ad** comments)? Ad comments need `ads_management`-class handling — recommend **organic only** v1, filter out comments whose post is an ad.
5. **Ticket coupling:** is "create ticket from comment" wanted in v1, or just reply/moderate?
6. **Backfill:** pull existing recent comments on recent posts at launch (`GET /{ig-user-id}/media` → `/{media-id}/comments`), or start fresh from the webhook? (Recommend a shallow backfill of the last N posts so the inbox isn't empty.)

---

## 9. What NOT to do

- **Don't** shoehorn comments into `cs_wa_threads`/`cs_wa_messages` (see §5).
- **Don't** replace the existing `messages` webhook subscription when adding `comments`/`feed` — append.
- **Don't** ship before the comment-management App Review scopes are granted — without them it only works for app-role users (the S161 Development-mode trap). Submit review first.
- **Don't** treat FB `feed` events as all-comments — filter `item==='comment'` and branch on `verb`.
- **Don't** forget the outbound echo: our own posted replies come back on the webhook — dedup on the platform comment-id and skip our own `from.id`.

---

## 10. Suggested build sequence

1. **Verify §3** (subscription fields + start the App Review for the comment scopes). Gate everything else on the scopes.
2. Migration `pitstop_meta_comments_v1` (tables + grants + RLS).
3. Webhook: add the `changes` loop + `metaHandleComment` (IG + FB shapes, idempotent, echo-skip). Validate with a real test comment (app-role user works pre-review).
4. Worker reads: `getPostComments` + `getCommentThread`.
5. Worker writes: `replyToComment`, `setCommentStatus`, `setCommentState`, `assignComment` (+ optional ticket link).
6. `/comments` page (list-by-post + detail + action bar), reusing inbox kit.
7. Optional shallow backfill of recent posts' comments.
8. Manual chapter ("Comments") in the Pitstop in-app manual + PDF (CORE in-app-manual rule).

---

## 11. Appendix — exact files

- Webhook + Graph: `csops-worker/src/index.js` — `handleMetaWebhook` (~L3710), add `metaHandleComment` near `metaHandleMessage` (~L3765); reuse `metaGraphBase`/`metaToken`/`resolveMetaHandle`.
- Secrets already present: `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_IG_APP_SECRET`, `META_PAGE_TOKEN`, `META_IG_TOKEN`. **No new secret needed** — same tokens, broader scopes (after review).
- App: new `apps/pitstop/src/app/(auth)/comments/page.js` + nav entry; reuse `components/kit/` + `lib/csopsFetch.js`.
- Migration name: `pitstop_meta_comments_v1`.

> **One-line summary:** the Meta transport shell (verify + signature + per-channel Graph host/token) is shared and ready; comments are dropped today because the webhook ignores `entry.changes`. Build = new `cs_social_posts`/`cs_post_comments` tables + a `changes` ingestion branch + comment reply/hide/delete Graph calls + a `/comments` inbox page — gated on adding the **comment-management App Review scopes** (the critical path), which the DM integration does not already hold.
