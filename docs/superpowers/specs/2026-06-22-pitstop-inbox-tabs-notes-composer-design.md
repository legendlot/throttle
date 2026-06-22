# Pitstop Agent Inbox — Conversation Tabs, Private Notes & Richer Composer (design)

> Status: **DESIGN — awaiting Afshaan sign-off before build**
> Date: 2026-06-22 (Session 162)
> Requested by: Pruthvi (#bugs, 2026-06-22 — two messages, both acked "logged, passing to Afshaan to confirm scope")
> Surface: Pitstop Agent Inbox `/inbox` (shipped S161) — `apps/pitstop/src/app/(auth)/inbox/page.js` + csops messaging handlers
> Decision locked with Afshaan (S162): build **both** requests from **one** spec; thread ownership = **thread-level assignment** (new field), not inherited from the linked ticket.

---

## 1. Context

The `/inbox` console (S161) is a cross-channel DM reader over `store.cs_wa_threads` / `cs_wa_messages`:
Instagram + Facebook Messenger are two-way (reply via `sendMetaMessage`); WhatsApp is a read-only BiteSpeed
mirror. The list is **channel-scoped** (All / Instagram / Messenger / WhatsApp tabs already exist, driven by
`getMessagingStats` tiles). A thread can be **linked to a ticket** (`cs_wa_messages.ticket_id`) but has **no
agent owner** today.

Pruthvi's two asks:
- **(A)** Conversation list filters — **Mine / Unassigned / All** — for workload tracking, claiming unassigned chats, SLA triage.
- **(B)** **Private (internal) notes** in the conversation for agent-transfer hand-off + composer upgrades: media/file attach, emoji, bold, italic, quick replies / canned responses / templates.

These are **net-new inbox capability**, NOT a reskin. No change to capture/webhooks or to the ticket lifecycle.

### Current data model (verified S162 via information_schema)

`cs_wa_threads`: `id`(uuid), `channel`, `customer_phone`, `customer_handle`, `external_user_id`,
`waba_phone_number_id`, `provider_thread_ref`, `provider_account_id`, `last_message_at`,
`customer_window_until`, `created_at`, `updated_at`. **No assignment, no dept, no internal-note concept.**

`cs_wa_messages`: `id`(uuid), `thread_id`, `ticket_id`(bigint), `direction`(CHECK inbound|outbound),
`kind`(CHECK text|image|video|audio|document|template), `body`, `template_name`,
`media_url`/`media_filename`/`media_mime_type`/`media_size_bytes`, `provider_message_id`,
`status`(CHECK queued|sent|delivered|read|failed), `status_error`, `sent_by_user_id`, `sent_by_name`,
`received_at`, `sent_at`, `created_at`, `channel`, `raw_meta`(jsonb).

**Media columns already exist** — attachments are partly modelled; what's missing is an upload path + the Graph attachment send.

### Channel reality (drives scope)

- IG DM + FB Messenger send **plain text only** — Graph has no rich-text. **Bold/italic markup will NOT render
  for the customer** on IG/FB. Only WhatsApp renders `*bold*`/`_italic_`, and WA is read-only here.
  → bold/italic is only meaningful on **internal notes** (rendered by us). Recommend scoping it there, or dropping it.
- Quick replies / "templates": the `cs_wa_templates` catalog is WhatsApp-utility-template oriented, but for an
  IG/FB **canned response** we just need the template **body text inserted into the composer** as plain text.
- Attachments to IG/FB use Graph `message.attachment` with a **publicly reachable URL** → needs a hosting bucket.

---

## 2. Feature A — Conversation tabs (Mine / Unassigned / All) + thread assignment

### 2.1 Data
Add to `cs_wa_threads` (additive, nullable — WA byte-unaffected):
- `assigned_agent_id uuid` (FK → `auth.users`, nullable)
- `assigned_agent_name text`
- `assigned_at timestamptz`

Index: `CREATE INDEX ON store.cs_wa_threads (assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;`

### 2.2 Worker
- **`getMessagingThreads`** gains a `tab` param: `mine` → `assigned_agent_id=eq.<me>`; `unassigned` →
  `assigned_agent_id=is.null`; `all` / absent → no assignment filter. Composable with the existing `channel`
  filter (e.g. Instagram + Unassigned). Add `assigned_agent_id`/`assigned_agent_name` to the row output
  (already `select=*`).
- **NEW `assignThread`** (POST) — mirrors the ticket `assignAgent` gate exactly (RULE-PITSTOP role rules):
  - self-claim (`agent_id === auth.userId`, or null=unassign-self) requires **`cs_ticket_manage`**;
  - assigning to **another** agent requires **`cs_ticket_reassign`** or `cs_ticket_admin` → else 403
    "missing cs_ticket_reassign".
  - Writes `assigned_agent_id` + `assigned_agent_name` (resolved from `getAgents`/users_profile) + `assigned_at`.
- **`getMessagingStats`** gains per-channel `mine` + `unassigned` counts (cheap — the IG/FB thread set is already
  fetched; add `assigned_agent_id` to its select and tally). WhatsApp `mine`/`unassigned` left `null` (read-only mirror).

**Scope note (decision D1 below):** threads have no department column, so inbox tabs are **assignment-based, not
dept-scoped**, unlike the ticket queue. Simplest v1: every `cs_ticket_view` user sees all threads in a channel and
the three tabs operate purely on assignment. (Optional later: operator self-scope mirroring `isOperatorScope`.)

### 2.3 Frontend (`inbox/page.js`)
- Add a **Mine / Unassigned / All** segmented control above the thread list (separate axis from the channel
  tabs/tiles, which stay). Pass `tab` to `getMessagingThreads`; default `all`.
- Thread header: show an **Assign / Claim** control next to "Link ticket":
  - unassigned → "Claim" (self) for `cs_ticket_manage`; TL+ also gets an "Assign to…" agent dropdown (reuse `getAgents`).
  - assigned-to-me → green "Mine" pill + "Release"/"Reassign" (TL+).
  - assigned-to-other → name (read-only for operators; "Reassign" for TL+).
- ThreadRow: small assignee chip (initials/name) so the list shows ownership at a glance.

---

## 3. Feature B — Private (internal) notes

Agent-only notes inside the conversation, never sent to the customer; the transfer hand-off use-case.

### 3.1 Data (reuse `cs_wa_messages`)
- Add `is_internal boolean NOT NULL DEFAULT false`.
- Widen `cs_wa_messages_kind_check` to add `'note'`.
- A note row = `{ kind:'note', is_internal:true, direction:'outbound', body, sent_by_user_id/name, channel }`,
  `provider_message_id NULL`, `status NULL`. (direction kept 'outbound' = our side; the `is_internal` flag is the
  real discriminator, so no need to touch the direction CHECK.)

### 3.2 Worker
- **NEW `addThreadNote`** (POST, gate `cs_ticket_manage`): inserts the internal-note row, stamps thread `updated_at`
  (NOT `last_message_at` — a note must not reorder a thread above customers awaiting reply, and must not flip
  "awaiting reply"). Returns the new row.
- **Guard every send/preview/stat path against internal notes:**
  - `sendMetaMessage` / Graph send: only ever sends agent-typed replies — notes never go through it (separate action). ✔
  - `getMessagingThreads` last-message preview: **exclude `is_internal=true`** when picking the preview message
    (a private note shouldn't surface as the customer-facing last line). Add `is_internal` to the message select.
  - `getMessagingStats` "awaiting reply" (last inbound): ignore internal notes when determining the last message.
- `getMessagingThread` returns notes inline (they carry `created_at`, so they interleave chronologically).

### 3.3 Frontend
- Composer gets a **Reply / Note toggle** (or a distinct "Add note" affordance). Note mode → `addThreadNote`,
  visually distinct (amber/"internal" styling, lock icon, "Only your team can see this"), no 24h-window logic.
- `Bubble` renders `is_internal` rows full-width, centered, amber, labelled "Internal note · <agent>".

---

## 4. Feature C — Composer enhancements

Ordered by value ÷ effort. Each is independently shippable.

| Sub-feature | Effort | Notes / channel reality |
|---|---|---|
| **Emoji selector** | **S** | Pure frontend — insert unicode at caret in the textarea. No worker/schema change. Works on every channel + notes. |
| **Quick replies / canned responses** | **S–M** | `cs_wa_templates` + `getWaTemplates` already exist. Add a picker that **inserts the template body as plain text** into the composer (agent can edit before send). No new send path for IG/FB. (True WA *template* sending stays a C2-B concern.) Consider a lightweight `is_canned`/category filter so the list is CS-reply phrases, not just WA utility templates. |
| **Private-note formatting (bold/italic)** | **S** | Only meaningful on **internal notes** (we render them). Markdown-lite in the note bubble. **Do NOT offer bold/italic on IG/FB replies — Graph drops formatting; it would mislead agents.** (Decision D2.) |
| **Media / file attachment** | **L** | Needs (1) an **upload target** — a Supabase Storage bucket `cs-inbox-media` (signed-URL upload from the app) OR an external CDN; prior Pitstop direction avoided Supabase Storage for WA media, so confirm (Decision D3). (2) Graph send via `message:{attachment:{type,payload:{url}}}` in `sendMetaMessage` (needs a public URL → signed Storage URL works). (3) Record on the outbound row using the **existing** `media_url`/`media_filename`/`media_mime_type`/`media_size_bytes` cols + `kind`. IG/FB accept image/video/file; size + type limits per Meta. Inbound media rendering already exists in `Bubble`. |

---

## 5. Migration (single additive migration `cs_inbox_assignment_notes_v1`)

```sql
-- Feature A: thread assignment
ALTER TABLE store.cs_wa_threads
  ADD COLUMN assigned_agent_id uuid,
  ADD COLUMN assigned_agent_name text,
  ADD COLUMN assigned_at timestamptz;
CREATE INDEX cs_wa_threads_assigned_idx
  ON store.cs_wa_threads (assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;

-- Feature B: internal notes
ALTER TABLE store.cs_wa_messages
  ADD COLUMN is_internal boolean NOT NULL DEFAULT false;
ALTER TABLE store.cs_wa_messages DROP CONSTRAINT cs_wa_messages_kind_check;
ALTER TABLE store.cs_wa_messages ADD CONSTRAINT cs_wa_messages_kind_check
  CHECK (kind = ANY (ARRAY['text','image','video','audio','document','template','note']));
```
RLS already on (service_role-only); no grant changes. Media columns already present — no DDL for Feature C
beyond a possible Storage bucket (Decision D3). Non-destructive (additive + CHECK widen) → runs autonomously
under the sql-gate.

---

## 6. Build phasing (recommended order once approved)

1. **Migration** `cs_inbox_assignment_notes_v1`.
2. **Feature A** (tabs + assignment) — highest-value, mostly server filters + one new action. Pruthvi's #1 ask.
3. **Feature B** (private notes) — small, self-contained; directly the transfer-handoff need.
4. **Feature C-easy** (emoji + canned responses + note formatting) — frontend-led, ship together.
5. **Feature C-attachments** — last; gated on the bucket decision (D3) + Graph attachment testing on a live IG/FB thread.

Worker = `csops` (`cd 05_Throttle/csops-worker && npx wrangler deploy`); app auto-deploys on push.
Build all monorepo apps clean (Pitstop kit is app-local; no `@throttle/ui` blast radius).

---

## 7. Open decisions for Afshaan

- **D1 — Inbox tab scoping:** threads have no department. v1 = assignment-only tabs, every `cs_ticket_view` user
  sees all threads in a channel (recommended, simplest). Or mirror the ticket queue's operator self-scope
  (operators see only mine/unassigned)? *Recommend: assignment-only for v1.*
- **D2 — Bold/italic:** drop for IG/FB replies (Graph won't render), keep only on internal notes? *Recommend: yes.*
- **D3 — Attachment hosting:** new Supabase Storage bucket `cs-inbox-media` (signed-URL) vs external CDN. Prior WA
  media was kept off Supabase Storage — confirm the bucket is acceptable for outbound agent attachments.
- **D4 — Auto-assign on first reply?** When an agent sends the first reply to an unassigned thread, auto-claim it
  to them (like answering a call claims a ticket)? *Recommend: yes — reduces manual claiming.*
- **D5 — Canned-response source:** reuse `cs_wa_templates` as-is, or add a CS-reply-phrase category/flag so the
  picker isn't cluttered with WA utility templates?
