# Pitstop — Custom Tags, Round-Robin Assignment & Agent Presence (design)

> Status: **DESIGN — awaiting Afshaan sign-off before build**
> Date: 2026-06-23 (Session 163)
> Requested by: Afshaan — three features, one consolidated build.
> Surface: Pitstop — csops worker (`05_Throttle/csops-worker/src/index.js`) + `apps/pitstop`
> North star (Afshaan): **make BiteSpeed redundant** — consolidate all CS activity (tickets + IG/WhatsApp/Messenger threads) onto Pitstop as a full helpdesk.

---

## 1. Context

Pitstop today has two work objects:
- **Tickets** — `store.cs_tickets` (RMA/query lifecycle; manual + telephony auto-created).
- **Threads** — `store.cs_wa_threads` (channel = `whatsapp` | `instagram` | `messenger`), messages in `cs_wa_messages`. IG + FB are two-way (reply via `sendMetaMessage`); WhatsApp is a read-only BiteSpeed/Chatwoot mirror. Thread-level assignment (`assigned_agent_id/_name/_at`), Mine/Unassigned/All tabs, private notes and a rich composer shipped in S162.

This spec adds three capabilities, all channel-agnostic:
1. **Custom tags** on tickets AND threads (any agent tags a conversation/ticket; leads curate the catalogue).
2. **Round-robin auto-assignment** of incoming threads to on-duty agents.
3. **Agent presence** (availability) so an agent who hasn't signed in for the day receives no assignments.

**Layering:** presence is the keystone — round-robin gates on "is this agent on duty," so presence (Phase 1) lands before/with round-robin (Phase 2). Tags (Phase 3) are independent.

### Decisions locked with Afshaan (S163)

| # | Decision | Choice |
|---|---|---|
| Presence model | how "on duty" is determined | **Availability toggle + shift windows** — Online/Away/Offline; auto-online on login + **activity-gated** heartbeat; auto-away on idle; manual topbar toggle. Routing eligibility is gated by the agent's **department shift window**, not a blind heartbeat. (Helpdesk/Chatwoot model.) |
| Shift structure | how working hours are defined | **Per-department windows** — each CS lane (Messaging/Inbound/Outbound/Confirm) has its own daily window; agents inherit their department's hours. |
| Off-schedule | assignable outside scheduled hours? | **Shift OR manual "Available" override** — outside the window an agent gets no auto-assignment UNLESS they manually toggle "Available" (covers a late shift). Carried by `auto=false` on the presence row. |
| RR algorithm | how a thread picks an agent | **Least-loaded + rotation tiebreak** — fewest open threads wins; tie broken by longest-since-last-assigned. |
| WhatsApp transport | the BiteSpeed-redundancy lever | **Workflow-layer first** — ship tags/presence/RR live on IG+FB now; WhatsApp stays read-only mirror; WA send-side is a separate spec/workstream. |
| Tag creation | who can mint tags | **Any agent (`cs_ticket_manage`) creates inline; leads/admins (`cs_ticket_admin`) rename/merge/archive.** |
| RR pool | who is eligible | Present CS agents who are **members of the `messaging` department** (`cs_user_departments`); fallback to all present CS agents if no messaging-dept member is online. |
| Capacity cap | per-agent thread ceiling | `max_open_per_agent` column exists, **default unlimited**; at-capacity agents skipped, but if all are capped it falls back to least-loaded so nothing strands. |
| Offline w/ open threads | mid-day offline handling | v1 **leaves them assigned** + surfaces a lead "Stale / unanswered" view; auto-release cron deferred to v2. |
| RR scope | what gets auto-assigned | **Threads only.** Tickets keep manual/telephony assignment. |

### Verified current state (S163)

- **No presence/heartbeat/activity scaffolding** anywhere in csops (`grep` clean) — Phase 1 is a clean slate.
- Thread assignment lives in `assignThread` + auto-claim-on-first-reply inside `sendMetaMessage` (index.js ~3114) and `sendMetaAttachment` (~3220).
- Webhook thread-creation points (the RR hooks): `metaFindOrCreateThread` (~3003), `biteSpeedFindOrCreateThread` (~2739), `findOrCreateWaThread` (~2367).
- `getCsAgents` already returns a **CS-team-only** roster (CS-tier role or CS-dept member) — the base for the RR pool, minus presence.
- Permission keys (`store.roles`): `cs_ticket_view` / `cs_ticket_manage` / `cs_ticket_reassign` / `cs_ticket_approve` / `cs_ticket_admin` / `cs_reports_view`.
- Departments: `inbound` / `outbound` / `confirm` / `messaging`; multi-dept membership in `store.cs_user_departments`.

> **Schema-verify rule:** before writing any migration/SQL below, run the `information_schema.columns` check on each touched table (CLAUDE.md). Column lists here are from the spoke and must be re-verified at build time.

---

## 2. Feature 1 — Custom tags (tickets + threads)

### 2.1 Data (one migration, additive, RLS-on, service_role-only per RULE-RLS-001)

```
store.cs_tags
  id              uuid PK default gen_random_uuid()
  name            text not null
  slug            text not null unique          -- lower-kebab of name, mint-time
  color           text not null                 -- palette key (see 2.4), not free hex
  description     text
  is_active       boolean not null default true -- archive = false (never hard-delete)
  sort_order      int not null default 0
  created_by_user_id uuid
  created_at      timestamptz default now()
  updated_at      timestamptz default now()

store.cs_ticket_tags
  ticket_id  bigint  references store.cs_tickets(id) on delete cascade
  tag_id     uuid    references store.cs_tags(id)    on delete cascade
  tagged_by_user_id uuid
  tagged_at  timestamptz default now()
  PRIMARY KEY (ticket_id, tag_id)

store.cs_thread_tags
  thread_id  uuid  references store.cs_wa_threads(id) on delete cascade
  tag_id     uuid  references store.cs_tags(id)       on delete cascade
  tagged_by_user_id uuid
  tagged_at  timestamptz default now()
  PRIMARY KEY (thread_id, tag_id)
```

Two explicit junction tables (not one polymorphic `taggable`): preserves real FKs + cascade, matches the `cs_user_departments` precedent, joins cleanly on the list reads. **One shared `cs_tags` catalogue** spans both objects (a tag is reusable across tickets and threads).

`GRANT ALL ON … TO service_role;` on each (RULE; new `store` tables). Indexes: `cs_ticket_tags(tag_id)`, `cs_thread_tags(tag_id)` for facet counts.

### 2.2 Worker (csops)

GET:
- `getTags` — active tags ordered by `sort_order, name`. Gate `cs_ticket_view`.

POST:
- `createTag {name, color}` — mints slug, dedups on slug (409 if active dupe). Gate `cs_ticket_manage`.
- `updateTag {id, name?, color?, is_active?, sort_order?}` — rename/recolor/archive/reorder. Gate `cs_ticket_admin` (lead curation).
- `mergeTags {from_id, into_id}` — repoint both junctions to `into_id`, archive `from_id`. Gate `cs_ticket_admin`. (De-sprawl tool; can be Phase-3.1.)
- `setTicketTags {ticket_id, tag_ids[]}` — replace-set (delete-not-in + insert-missing, batched via `in.()`/array insert — never per-row awaits). Writes a `cs_ticket_history` row (`tags_changed`). Gate `cs_ticket_manage`.
- `setThreadTags {thread_id, tag_ids[]}` — replace-set. Gate `cs_ticket_manage`.

Reads enriched: `getTickets` and `getMessagingThreads` return `tags:[{id,name,color}]` inline — **batched** (one `cs_ticket_tags?ticket_id=in.(…)` / `cs_thread_tags?thread_id=in.(…)` join over the page, not N calls). Add `?tag=<id>` filter to `getTickets`, `getQueueCounts`, and `getMessagingThreads`.

### 2.3 UI (apps/pitstop)

- Reusable **`TagPicker`** (`components/kit/`) — colored multi-select chips, search, inline **"+ Create"** (gate `cs_ticket_manage`, optimistic), **click-outside dismiss** (reuses the exact S162 canned-response popup pattern).
- **Ticket detail** (`/queue/detail`) — tag chips on the identity/issue rail → `setTicketTags`.
- **Inbox** (`/inbox`) — tag chips in the thread header → `setThreadTags`.
- **Filters** — tag facet chips on `/queue` (alongside disposition/category) and `/inbox`.
- **Admin** — small tag-management card on `/admin/departments` (or a new `/admin/tags`): rename/recolor/archive/reorder/merge (gate `cs_ticket_admin`).

### 2.4 Palette
Fixed Volt-themed set (~8 swatches) defined once in the frontend + validated server-side in `createTag`/`updateTag` (reject unknown keys). Keeps the board visually coherent; no free hex.

---

## 3. Feature 2 — Round-robin thread assignment

### 3.1 Data

```
store.cs_routing_config           -- one row per channel
  channel              text PK     -- 'instagram' | 'messenger' | 'whatsapp'
  auto_assign_enabled  boolean not null default false
  algorithm            text not null default 'least_loaded'  -- future-proof; only least_loaded in v1
  max_open_per_agent   int                                   -- null = unlimited
  updated_at           timestamptz default now()
  updated_by_user_id   uuid

cs_wa_threads (additive — the Q1=B work-queue state)
  thread_state       text not null default 'open' CHECK (open|snoozed|closed)
  closed_at          timestamptz
  closed_by_user_id  uuid
  snoozed_until      timestamptz                  -- optional; snooze deferral
```
Seed: `instagram`/`messenger` → enabled **true**; `whatsapp` → enabled **false** (read-only mirror; flip when WA send-side lands). No rotation-pointer table — the tiebreak reads `cs_wa_threads.assigned_at`. Index `cs_wa_threads (assigned_agent_id, thread_state)` for load counts. **Load = open threads assigned to the agent** (snoozed/closed excluded). **Auto-reopen:** an inbound message on a `closed` thread flips it back to `open` (webhook), keeping its prior assignee.

### 3.2 The router — `cs_autoassign_thread(p_thread_id uuid)` SECURITY DEFINER RPC

Single RPC so the pick + claim is **atomic** (two concurrent webhooks can't double-assign). Logic:

1. Load thread; if it already has `assigned_agent_id`, return it (no-op — idempotent).
2. Read `cs_routing_config` for the thread's channel; if `auto_assign_enabled = false`, return null (leave unassigned).
3. **Eligible pool** = users who:
   - hold `cs_ticket_manage` AND are CS-team (mirror `getCsAgents`: CS-tier role OR `cs_user_departments` member),
   - are members of the **`messaging`** department (via `cs_user_departments`); **fallback**: if none of those are present, widen to all present CS agents,
   - are **eligible by presence + shift** (Feature 3): `cs_agent_presence.status='online'` AND `last_seen_at` within the freshness window AND ( **now is inside their department's shift window** OR the presence row is a **manual override** (`auto=false`) ),
   - are **under cap** (`open_thread_count < max_open_per_agent`, or no cap). If everyone is capped, ignore the cap (never strand a customer).
4. **Pick** = the eligible agent with the **fewest open assigned threads**, tie broken by **oldest `assigned_at`** (longest since last assignment), final tie by `user_id` for determinism. "Open" = `cs_wa_threads` rows assigned to them not closed/resolved (define an open predicate — threads have no close field today; use "has an inbound message awaiting reply" OR add a lightweight `thread_state`; **see open question Q1**).
5. **Claim** — `UPDATE cs_wa_threads SET assigned_agent_id/_name/_at` for the chosen agent; return the agent.

`SECURITY DEFINER`, `EXECUTE` to `service_role` only.

### 3.3 Trigger points (webhooks — run as service_role, no JWT)

In each thread-creator, **after** insert/upsert of a new inbound thread (or when an unassigned thread receives a fresh inbound message), call `cs_autoassign_thread(thread.id)`:
- `metaFindOrCreateThread` (IG/FB) — primary v1 path.
- `biteSpeedFindOrCreateThread` / `findOrCreateWaThread` (WhatsApp) — guarded by `cs_routing_config.whatsapp.auto_assign_enabled` (seeded **off**), so the ~4,767 historical WA threads are **never** bulk-assigned and the floodgate only opens when WA send-side is live.

Manual `assignThread` and auto-claim-on-first-reply (S162) remain and **override** RR.

### 3.4 UI
- Inbox already has Mine/Unassigned/All — RR simply means fewer Unassigned. Add an "auto-assigned" subtle marker on the assignee chip (vs manually claimed) for transparency.
- **Admin routing card** (`/admin/departments` or `/admin/routing`): per-channel auto-assign on/off + `max_open_per_agent`. Gate `cs_ticket_admin`.
- **Lead "Stale / unanswered" view** — threads assigned but with no agent reply, especially where the owner is now offline (supports decision: offline keeps threads assigned in v1).

---

## 4. Feature 3 — Agent presence (availability) + shift windows

Eligibility for auto-assignment is the AND of **two independent gates**:
- **Shift window** — "is this agent *scheduled* to be working now?" (predictable, hard boundary; closes the forgotten-open-tab-after-hours hole).
- **Live presence** — "is this agent *actually here* right now?" (online + fresh, activity-gated heartbeat).

Neither alone is sufficient: shift-only would route to an absent-but-scheduled agent; presence-only would route to an off-shift agent who left a tab open. A **manual "Available" override** lets an agent opt in outside their window (late-shift cover).

### 4.1 Data

```
store.cs_agent_presence
  user_id       uuid PK references auth.users(id)
  status        text not null default 'offline'  -- 'online' | 'away' | 'offline'
  status_since  timestamptz default now()        -- when current status began
  last_seen_at  timestamptz                      -- last (activity-gated) heartbeat
  auto          boolean not null default true     -- true = login/heartbeat-derived; false = MANUAL toggle (= off-schedule override)
  updated_at    timestamptz default now()

store.cs_shifts                                   -- per-department working window
  cs_department_id  uuid PK references store.cs_departments(id)   -- cs_departments.id is uuid (verified S163)
  start_min         int not null                  -- minutes past IST midnight (e.g. 600 = 10:00)
  end_min           int not null                  -- (e.g. 1140 = 19:00); end < start => overnight (rare; flag if needed)
  working_days      int[] not null default '{1,2,3,4,5}'  -- ISO dow; default Mon–Fri (Afshaan S163), team edits in UI
  is_active         boolean not null default true
  updated_at        timestamptz
  updated_by_user_id uuid
```
Both RLS-on, service_role-only. Window values are **TBD pending Afshaan** (see §8 Q2). Per-department, agent inherits via their **home** `users_profile.cs_department_id` (and/or messaging-dept membership for thread routing).

**Effective eligibility** (computed live at routing time, no cron needed for correctness):
```
in_shift   = today's ISO-dow ∈ cs_shifts.working_days
             AND now()::IST-time within [start_min, end_min)   (for the agent's dept)
live       = status='online' AND last_seen_at >= now() - INTERVAL '<freshness>'   (≈3 min)
override   = (status='online' AND auto=false)                  -- manual "Available", off-schedule
eligible   = live AND (in_shift OR override)                   -- away/offline never eligible
```
A manual `away`/`offline` (`auto=false`) is respected regardless of heartbeat. `auto=true` online (login/heartbeat) only counts **inside** the shift window — so logging in early or leaving a tab open after hours does **not** make an agent eligible.

### 4.2 Worker (csops)
- POST `setPresence {status}` — manual toggle (`auto=false`); validates enum; gate `cs_ticket_view` (any signed-in CS user). Manual `online` outside the window = the "Available" override.
- POST `heartbeat` — stamps `last_seen_at=now()`; if currently `offline` with `auto=true`, promotes to `online`; **never** overrides a manual `away`/`offline` (`auto=false`). Gate `cs_ticket_view`. Cheap upsert.
- GET `getPresence` — roster of CS agents with effective status + `in_shift` + `last_seen_at` (lead "who's on duty"). Gate `cs_ticket_view`.
- GET `getShifts` / POST `setShift {cs_department_id, start_min, end_min, working_days}` — per-department window admin. Gate `cs_ticket_admin`.

### 4.3 Mechanics
- **Login → online**: authenticated app load calls `setPresence('online')` (`auto=true`) once, then starts the heartbeat. (Eligible only once inside the dept window.)
- **Activity-gated heartbeat**: client pings `heartbeat` every ~60s **only when the tab is visible AND there was real user interaction** (mousemove/keydown/click) in the last interval — Page Visibility API + an interaction flag. So an **unattended-but-awake tab stops beating** → decays stale → ineligible, *without* relying on the shift window. (Docket `user_activity` is the lighter precedent.)
- **Idle → away**: derived from stale `last_seen_at` (no cron needed for correctness). A short idle inside a shift (lunch) decays the agent to ineligible within ~the freshness window; status display may show `away`.
- **No EOD cron (dropped S163)**: `getPresence` computes **effective** status live (`online` only if `last_seen_at` is fresh), so a stale stored `online` never surfaces and never gets routed — there is nothing for a reset job to fix. A cosmetic reset cron can be added later if wanted, but it is not the gate and not built.
- **Manual toggle**: topbar Available/Away/Offline control (`auto=false`). "Available" outside the window is the off-schedule override; Away/Offline removes the agent immediately regardless of shift.

### 4.4 UI
- **Topbar availability toggle** (next to DeptSwitcher) — Online/Away/Offline pill, optimistic.
- **Presence dots** on assignee chips across queue/inbox/roster.
- **Lead roster** (admin/leads) — who's online/away/offline + last-seen, on `/admin/departments` or the Overview.

### 4.5 Optional later — HR attendance record
Not in v1. If wanted, derive daily on-duty sessions/hours from presence transitions (a `cs_agent_presence_log` append table + a report) — additive, no rework of the above.

---

## 5. Migrations
Additive migrations, split per phase: **Phase 1** `pitstop_presence_shifts_v1` = `cs_agent_presence` + `cs_shifts` (+ seed the 4 department windows). **Phase 2** = `cs_routing_config` + the `cs_autoassign_thread` RPC. **Phase 3** = `cs_tags` + `cs_ticket_tags` + `cs_thread_tags`. All RLS-on at creation, service_role grants, advisor-clean. No existing column altered. Schema-verify each touched parent table first.

## 6. Blast radius & deploy
- **csops worker** (Pitstop only — sibling worker, single-system blast radius). Sequence: edit → commit → push → `cd 05_Throttle/csops-worker && npx wrangler deploy`.
- **apps/pitstop** (GH Pages, auto-deploy on push). `TagPicker` is app-local (`components/kit/`) — shared `@throttle/ui` untouched → zero cross-app blast radius.
- **Path-scoped commits** — stage only `csops-worker` / `apps/pitstop` / spec; never `git add -A` (the uncommitted Throttle-worker `wrangler.toml`/`index.js` must stay out).

## 7. Build phasing (each independently shippable)
- **Phase 1 — Presence + shifts** (foundation): migration (`cs_agent_presence` + `cs_shifts` seeded + cosmetic EOD cron) + `setPresence`/`heartbeat`/`getPresence`/`getShifts`/`setShift` + activity-gated heartbeat + topbar availability toggle + lead "who's on duty" roster + per-department shift-window admin.
- **Phase 2 — Round-robin**: `cs_routing_config` + `cs_autoassign_thread` RPC + 3 webhook hooks + admin routing card. Enable IG/FB; WA off.
- **Phase 3 — Tags**: 3 tables + tag worker actions + `TagPicker` + rails + facets + admin tag mgmt.
- **(Parallel) WhatsApp transport** — separate spec; the actual BiteSpeed-retirement lever (direct WhatsApp Cloud API vs C2-B). Until it lands, RR/presence are live on IG+FB and WA stays a read-only mirror.

## 8. Open questions (confirm before/at build)
- **Q1 — RESOLVED (Afshaan S163): Option B — add `cs_wa_threads.thread_state` (`open`/`snoozed`/`closed`, default `open`).** Load = count of `open` threads assigned to an agent (snoozed/closed don't count). Agents click **Done** to close; a **new inbound message auto-reopens** a closed thread (in the webhook), and a reopened thread keeps its prior assignee (continuity). The inbox defaults to active (open+snoozed) with a Closed/All filter — a real work queue, matching the helpdesk model. Snooze is optional/deferrable.
- **Q2 — RESOLVED (Afshaan S163):** seed **all four lanes 10:00–19:00 IST, Mon–Fri** (`start_min=600, end_min=1140, working_days={1,2,3,4,5}`); team edits per-lane in the admin UI. Heartbeat 60s / 3-min freshness; EOD cosmetic-cron TBD time (default ~21:00 IST). **Confirmed model:** window-open + nobody-online → no auto-assign (thread stays Unassigned, safe).
- **Q6 — RESOLVED (Afshaan S163): leave claimable, NO catch-up sweep.** Threads arriving while nobody is online stay Unassigned and are pulled from the Unassigned tab by hand. Round-robin only ever auto-assigns a thread *at the moment a fresh inbound arrives while ≥1 agent is eligible* — it never retro-distributes a backlog.
- **Q3 — does `away` ever receive assignments?** Default: no (only `online`); `away` is excluded but not offline. Confirm.
- **Q4 — auto-release stale threads** when owner goes offline (v2): after how long, and to whom (pool / lead)? Deferred unless wanted in v1.
- **Q5 — notify agent on auto-assign** (in-app/Slack) — v2; ties into the Docket V2 notifications track.

---

## 9. Why this advances "BiteSpeed redundant"
Tags + presence + round-robin turn Pitstop from a reader into a **routed, accountable helpdesk** — the team-workflow half of parity with BiteSpeed/Chatwoot — immediately for IG + FB. The remaining half is **WhatsApp send-side** (its own spec): once agents reply to WhatsApp inside Pitstop, flip `cs_routing_config.whatsapp.auto_assign_enabled = true` and the same routing/presence/tagging applies with zero rework. At that point BiteSpeed has no unique job left.
