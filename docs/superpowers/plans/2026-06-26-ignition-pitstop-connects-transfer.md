# Ignition Connects (Pitstop→Ignition transfer) — Implementation Plan

> **For agentic workers:** execute task-by-task. LOT has no unit-test harness; "verify" = a live
> Supabase query, a worker `/health`+action curl, or an authenticated browser smoke. Sequence per
> task is always: edit → commit → push → `wrangler deploy` (workers) / commit+push (apps auto-deploy).

**Goal:** Let the Pitstop CS team transfer an IG/WhatsApp/email conversation to the Influencer team, giving Reann (+ Himani Nim) a single Ignition "Connects" inbox to reply on — while the channel stays owned by Pitstop and they get no general channel access.

**Architecture:** Approach 1 from the spec — Pitstop's `store.cs_wa_*` stays the single source of truth + channel owner; an `ignition_connect` flag gates a thread out of CS and into Ignition; `ignitionops` reads/replies via token-authed, scope-checked **bridge** endpoints on csops; `ignition.connects` holds only workflow overlay (status + influencer link), never messages.

**Tech Stack:** Supabase Postgres (migrations), Cloudflare Workers (csops, ignitionops — vanilla JS, PostgREST), Next.js static-export (apps/pitstop, apps/ignition), shared `@throttle/*` packages.

**Spec:** `docs/superpowers/specs/2026-06-26-ignition-pitstop-connects-transfer-design.md`

---

## File map

- **Migrations** (Supabase, via `apply_migration`): `pitstop_ignition_transfer_v1`, `ignition_connects_v1`, `ignition_connects_perm_v1`.
- **csops** `05_Throttle/csops-worker/src/index.js`: `transferThreadToIgnition` (JWT action), bridge router (token-authed, pre-JWT) with `getIgnitionConnects`/`getIgnitionThread`/`sendConnectReply`, CS-scope `ignition_connect IS NOT TRUE` guards, `scope=ignition` oversight param.
- **ignitionops** `05_Throttle/ignitionops-worker/src/index.js`: `getConnects`/`getConnect` (GET), `replyConnect`/`promoteConnect`/`setConnectStatus` (POST), bridge client helper.
- **apps/pitstop** `apps/pitstop/src/…/inbox`: Transfer-to-Influencer-team button + read-only oversight filter.
- **apps/ignition** `apps/ignition/src/app/(auth)/connects/{page.js,detail/page.js}`, `src/lib/connects.js`, `src/lib/nav.js`, `PERM_DEFS`.

---

## Task 1: Migrations (DB foundation)

**Files:** Supabase migrations (no repo file).

- [ ] **1a.** `pitstop_ignition_transfer_v1` — additive on `store.cs_wa_threads`:
  `ALTER TABLE store.cs_wa_threads ADD COLUMN ignition_connect boolean NOT NULL DEFAULT false,
   ADD COLUMN ignition_transferred_at timestamptz, ADD COLUMN ignition_transferred_by uuid;`
  + `CREATE INDEX idx_cs_wa_threads_ignition_connect ON store.cs_wa_threads (last_message_at DESC) WHERE ignition_connect;`
- [ ] **1b.** `ignition_connects_v1` — create `ignition.connects` exactly per spec (cols, `status` CHECK
  in (new,working,promoted,closed), `thread_id` UNIQUE, `influencer_id` FK→`ignition.influencers(id)`
  ON DELETE SET NULL), `ALTER TABLE … ENABLE ROW LEVEL SECURITY;`, `GRANT ALL ON ignition.connects TO service_role;`.
- [ ] **1c.** `ignition_connects_perm_v1` — add perm key to `store.roles` for the 4 roles:
  `UPDATE store.roles SET permissions = permissions || '{"ignition_connects":true}'::jsonb
   WHERE role_id IN ('ignition_manager','ignition_lead','admin','super_admin');`
- [ ] **1d. Verify:** `get_advisors(security)` clean; `SELECT` the new cols + the 4 role rows show
  `ignition_connects=true`; confirm Reann(admin)+Himani(ignition_manager) inherit it.

## Task 2: csops — transfer action + CS-scope guards

**Files:** Modify `05_Throttle/csops-worker/src/index.js`.

- [ ] **2a.** Read the existing `transferThread`, `getMessagingThreads`, `getMessagingStats`,
  `cs_autoassign_thread` usage, `metaHandleMessage`, and the BiteSpeed `message_created` path to match patterns.
- [ ] **2b.** Add JWT action `transferThreadToIgnition` (gate `cs_ticket_manage`; reuse `transferThread`'s
  own/unassigned-vs-reassign permission check): set `ignition_connect=true`, `ignition_transferred_at=now()`,
  `ignition_transferred_by=auth`, null out `assigned_agent_*`; insert a `kind='note'` internal message
  `↪ Transferred to Influencer team (Ignition): <note>`.
- [ ] **2c.** Add `ignition_connect IS NOT TRUE` (PostgREST `ignition_connect=not.is.true` / `eq.false`)
  to: `getMessagingThreads` (every tab) + `getMessagingStats`; the `cs_autoassign_thread` candidate query;
  the META + BiteSpeed inbound auto-assign/auto-reopen branches (append message + bump window, but skip
  assignment/reopen when `ignition_connect`).
- [ ] **2d.** Add optional `scope=ignition` to `getMessagingThreads` → include ONLY `ignition_connect=true`
  (default path unchanged = exclude). Read-only oversight.
- [ ] **2e.** Commit, push, `cd 05_Throttle/csops-worker && npx wrangler deploy`.
- [ ] **2f. Verify:** transfer a test thread via curl (JWT) → row flips, disappears from `getMessagingThreads`
  default, appears under `scope=ignition`; an inbound to it does not reassign to CS.

## Task 3: csops — bridge endpoints (token-authed, scope-checked)

**Files:** Modify `05_Throttle/csops-worker/src/index.js`.

- [ ] **3a.** Determine the existing ignitionops→csops auth (how `openPitstopTicket`→`createTicket`
  authenticates). Reuse it; else add a `IGNITION_BRIDGE_TOKEN` shared-secret check.
- [ ] **3b.** Add a bridge router **before** the JWT gate (sibling of `/webhooks/*`): all bridge calls
  require the bridge token; each handler hard-filters `ignition_connect=true`.
  - `getIgnitionConnects` → transferred threads + batched last-message preview + `awaiting_reply`.
  - `getIgnitionThread(thread_id)` → messages + window + channel; 403 if not `ignition_connect`.
  - `sendConnectReply(thread_id, body, [media], actor{id,name,email})` → route by `channel` to the
    existing `sendMetaMessage`/`sendWaReply`/`sendEmailReply` internals; stamp `sent_by_*`=actor;
    DO NOT auto-claim to a CS agent; 403 if not `ignition_connect`.
- [ ] **3c.** Commit, push, deploy.
- [ ] **3d. Verify:** curl each bridge endpoint with the token against the test thread; confirm a
  non-transferred thread_id returns 403 on `getIgnitionThread`/`sendConnectReply`.

## Task 4: ignitionops — Connects actions

**Files:** Modify `05_Throttle/ignitionops-worker/src/index.js`.

- [ ] **4a.** Add a bridge client helper (`callCsopsBridge(action, payload)` with the token + CSOPS base URL).
- [ ] **4b.** GET `getConnects` (gate `ignition_connects`): call `getIgnitionConnects`; upsert
  `ignition.connects` for new `thread_id`s (status `new`, snapshot channel/handoff); left-join overlay; return merged.
- [ ] **4c.** GET `getConnect(thread_id)` (gate `ignition_connects`): call `getIgnitionThread`; merge overlay.
- [ ] **4d.** POST `replyConnect(thread_id, body, [media])` (gate `ignition_connects`): forward to
  `sendConnectReply` with the caller's JWT identity as `actor`.
- [ ] **4e.** POST `promoteConnect(thread_id)` (gate `ignition_connects`): create/link `ignition.influencers`
  prefilled from the thread (channel_name/handle, contact_number, email; `next_influencer_seq()` when new);
  set `connects.influencer_id` + `status='promoted'`.
- [ ] **4f.** POST `setConnectStatus(thread_id, status)` (gate `ignition_connects`).
- [ ] **4g.** Set `IGNITION_BRIDGE_TOKEN` secret on ignitionops (+ confirm CSOPS base URL const). Commit, push, deploy.
- [ ] **4h. Verify:** curl `getConnects`/`getConnect`/`replyConnect` with Reann-like JWT; reply lands in
  `cs_wa_messages` with sent_by=actor; `promoteConnect` mints an influencer + flips status.

## Task 5: apps/pitstop — transfer button + oversight filter

**Files:** Modify `apps/pitstop/src/…/inbox` (conversation header + list filters), `csopsFetch` action wiring.

- [ ] **5a.** Add "Transfer to Influencer team" to the inbox conversation-header transfer popover (optional note)
  → `transferThreadToIgnition`; confirm dialog states it leaves the CS queue. Hide when already `ignition_connect`.
- [ ] **5b.** Add a read-only "Transferred to Ignition" filter (`scope=ignition`) gated to
  `cs_ticket_reassign`/admin; rows render without reply controls.
- [ ] **5c.** Commit + push (auto-deploys). Build must be green.
- [ ] **5d. Verify:** authenticated browser — transfer a thread; it vanishes from active tabs and shows under the oversight filter.

## Task 6: apps/ignition — Connects inbox

**Files:** Create `apps/ignition/src/app/(auth)/connects/page.js` + `connects/detail/page.js` +
`src/lib/connects.js`; modify `src/lib/nav.js` + `PERM_DEFS` + `ignitionopsFetch.js`.

- [ ] **6a.** `lib/connects.js`: channel labels/icons (instagram/messenger/whatsapp/email) + status labels/palette.
- [ ] **6b.** Nav: add a flat **Connects** item gated `ignition_connects`; add the key to `PERM_DEFS`.
- [ ] **6c.** `/connects` list: channel tabs + status filter + rows (handle, last-msg preview, awaiting-reply
  badge, transferred-by/when) from `getConnects`.
- [ ] **6d.** `/connects/detail?thread_id=`: conversation render mirroring Pitstop's inbox detail
  (text/media bubbles; email = subject header + sandboxed-iframe HTML body; window state); composer →
  `replyConnect` (disabled w/ reason when window closed or email unarmed); **Promote to influencer** +
  status controls; handoff-note banner.
- [ ] **6e.** Commit + push (auto-deploys). Build green.
- [ ] **6f. Verify:** authenticated browser as Reann/Himani — open Connects, see the transferred thread,
  reply (IG/WA), promote to influencer; confirm a non-ignition user has no Connects nav.

## Task 7: End-to-end + docs

- [ ] **7a.** Full path on a real transferred IG thread (existing `afshan1000`/`krishna_sharma__75` test threads);
  WA + email per channel availability (email reply expected inert → graceful message).
- [ ] **7b.** Update `systems/ignition.md` + `systems/pitstop.md` + `CORE.md` schema map + `BACKLOG.md`.
- [ ] **7c.** Knowledge-brain commit/push (root repo).

---

## Self-review

- **Spec coverage:** transfer model (T2/T6), full-handoff scope guards (T2c), bridge read/reply (T3/T4),
  promote (T4e/T6d), oversight (T2d/T5b), perms+access Reann/Himani (T1c), all-channel + email-inert (T3b/T6d),
  data model (T1). Covered.
- **No placeholders:** each task names exact files + the concrete change + a verify.
- **Naming consistency:** `ignition_connect` (thread flag) vs `ignition.connects` (table) vs `ignition_connects`
  (perm key + ignitionops action group) used consistently; bridge actions `getIgnitionConnects`/`getIgnitionThread`/
  `sendConnectReply` distinct from ignitionops `getConnects`/`getConnect`/`replyConnect`.
