# Pitstop Inbound Email (`carecrew@`) — Design & Handoff

> **Status:** Design / not built. **Date:** 2026-06-25 (S170). **For:** the dedicated Pitstop session.
> **Companion:** Relay foundation PRD `2026-06-25-relay-foundation-design.md` (§2.1 the Relay↔Pitstop boundary, §3 sender identities). This doc is the concrete pick-up material for adding **email as an inbound CX channel in Pitstop**, built on the Relay substrate that is now LIVE.
> **Relay build state it leans on:** `commsops` worker + `comms` schema + `apps/relay` are deployed and verified (M0–M3, M5, M6). The identity substrate (`/ingest`), the outbound send spine (`/send`), the unified `messages` log, and the events stream all exist and are proven. This doc tells the Pitstop session exactly what to reuse, what to build, and the one decision that gates everything.

---

## 0. TL;DR

- **The decisive fact:** `legendoftoys.com`'s root MX → **Google Workspace** (verified: `aspmx.l.google.com`). `carecrew@legendoftoys.com` is therefore a **Workspace mailbox**, not something we can hang a custom MX/parser on. The PRD's "needs MX on the domain" line is **superseded** — do **not** repoint the root MX.
- **Recommended inbound transport: the Gmail API** on the existing `carecrew@` mailbox. It keeps the address, needs zero DNS surgery, and gives native MIME + `threadId` threading for free. (Two alternatives — dedicated inbound subdomain, or Workspace→inbound-service forward — are documented in §2 with tradeoffs.)
- **What Relay already gives Pitstop (built + proven), reuse as-is:**
  - **Identity** — resolve any inbound sender's email → a `comms` profile via `POST /ingest`. Inbound email becomes a first-class profile source (this is how more of the "70% thin" become known).
  - **Outbound replies** — agent email replies can route through Relay's `POST /send` gateway (the exact `send(channel,to/profile,content)` seam the cross-session contract specified), OR stay Gmail-native (§7 lays out the choice).
  - **`messages` log + `events` stream** — every reply logged; every inbound email can emit an event for triggers/analytics.
- **What's NOT built and is Pitstop's to build:** the inbound receiver (Gmail sync), MIME parsing, the **email thread/ticket model + agent inbox UX**, and the routing/assignment/presence that Pitstop already does for WhatsApp.
- **Email is simpler than the WhatsApp cutover:** there is **no "one number, one connection"** constraint. Pitstop can own the inbound email pipe directly (Gmail) without Relay being the transport owner — unlike WhatsApp. Relay is touched only at the two seams: `/ingest` (identity + events) and optionally `/send` (replies).

---

## 1. Scope & the Relay ↔ Pitstop boundary (for email)

**Inbound vs outbound, applied to `carecrew@`:**

| Concern | Owner | Mechanism |
|---|---|---|
| Receiving customer email | **Pitstop** | Gmail API sync of `carecrew@` (§2) |
| Parsing + threading | **Pitstop** | MIME parse; Gmail `threadId` (§5) |
| Inbox / tickets / agent reply UX | **Pitstop** | Pitstop's own schema + UI (§6) |
| Routing / assignment / presence / tags | **Pitstop** | Reuse Pitstop's existing WhatsApp machinery |
| **Customer identity** (sender → profile) | **Relay (shared)** | `POST /ingest` → `comms.resolve_identity` (§3) |
| **Interaction events** (received/replied) | **Relay (shared)** | `POST /ingest` events (§3, §8) |
| **Sending the reply** | **decision** | Gmail-native *or* Relay `/send` (§7) |
| Suppression / consent truth | **Relay (shared)** | `comms.suppressions` + `comms.consent` (§9) |

**Unlike WhatsApp:** email has no single-connection constraint, so Pitstop receiving email directly is fine — Relay does **not** need to be the email transport owner. Keep Relay strictly outbound + substrate-of-record.

---

## 2. Inbound transport — the one decision that gates everything

Root `legendoftoys.com` MX = Google Workspace (verified). `carecrew@legendoftoys.com` is a Workspace mailbox/group today. Three coherent ways to get those emails into Pitstop:

### Option A — Gmail API sync of `carecrew@` (RECOMMENDED for v1)
Pitstop's worker reads the `carecrew@` mailbox via the **Gmail API** (Workspace domain-wide-delegated service account, or OAuth on the mailbox). Use **`users.messages.list/get`** + **push via Cloud Pub/Sub `users.watch`** (or a 1–2 min poll fallback).
- **Pros:** keeps the exact address; **zero DNS/MX change**; native MIME parsing + Gmail's own `threadId` (threading solved for free); attachments via the API; works alongside any human still watching the mailbox during cutover; reversible.
- **Cons:** Workspace/Gmail-API dependency (auth setup + quota); "pull" model (Pub/Sub push removes most latency).
- **Setup:** GCP project + Gmail API enabled + a service account with **domain-wide delegation** scoped to `https://www.googleapis.com/auth/gmail.modify` impersonating `carecrew@`; or per-mailbox OAuth. A Gmail connector already exists in the Claude tooling for prototyping the read path.

### Option B — Dedicated inbound subdomain with its own MX → parser/Worker
e.g. `care.legendoftoys.com` MX → **Cloudflare Email Routing → Worker `email()` handler**, or an inbound-parse service (Resend Inbound / Postmark Inbound / Mailgun Routes) that webhooks the worker.
- **Pros:** clean programmatic pipe; Cloudflare-native (matches our stack); no Workspace dependency.
- **Cons:** customers must email a **new address** (`care@care.legendoftoys.com`-style) or you set Workspace to forward `carecrew@` → the subdomain address; Cloudflare Email Routing needs the subdomain's DNS/MX on Cloudflare (our DNS is GoDaddy — would delegate just that subdomain). More moving parts.

### Option C — Keep `carecrew@`, Workspace routing rule → inbound-parse service
Workspace forwards `carecrew@` to an inbound-parse address (Postmark/Mailgun/SendGrid Inbound Parse) that webhooks Pitstop.
- **Pros:** keeps the address; true push parsing; no Gmail-API quota.
- **Cons:** a forward in the loop (header/threading fidelity slightly messier than Gmail's native thread); another vendor.

**Recommendation:** **Option A (Gmail API)** for v1 — fastest, keeps the address, best threading, no DNS risk. Revisit B/C only if you later want CS email off Workspace entirely. **Verify first:** does `carecrew@` exist as a Workspace mailbox/group today, and does Bitespeed currently ingest it (so you know what you're replacing)?

---

## 3. The reusable Relay seams — exact contracts (LIVE)

Worker base URL: `https://commsops.afshaan.workers.dev`. Service-to-service auth = **`INGEST_TOKEN`** (a Cloudflare secret on `commsops`; ask Afshaan / it's set). Send as `Authorization: Bearer <INGEST_TOKEN>` or header `X-Ingest-Token`.

### 3.1 Identity + events — `POST /ingest`
The single ingestion seam. Pitstop calls this for every inbound email to resolve the sender to a profile and record the interaction.
```http
POST /ingest          Authorization: Bearer <INGEST_TOKEN>
{
  "identifiers": [ {"type":"email","value":"customer@gmail.com"} ],   // phone too if known
  "name": "email_received",                 // see §8 for vocab to seed
  "occurred_at": "2026-06-25T15:00:00Z",
  "properties": { "subject":"...", "gmail_thread_id":"...", "snippet":"..." },
  "source": "pitstop_email",
  "idempotency_key": "gmail:<message_id>"   // dedupes redelivered Gmail history
}
→ { "ok":true, "data":{ "profile_id":"<uuid>", "event_id":"<uuid>", "deduped":false } }
```
`resolve_identity` (atomic, server-side) creates/attaches/merges the profile. **Pitstop stores the returned `profile_id`** on its email thread → that's the link between the CS conversation and the unified customer profile (orders, other channels, consent).

### 3.2 Outbound reply — `POST /send` (if routing replies through Relay; see §7)
```http
POST /send            Authorization: Bearer <INGEST_TOKEN>
{
  "channel":"email", "purpose":"utility",          // utility/transactional → bypasses marketing gate (but NOT suppression)
  "profileId":"<uuid>", "to":"customer@gmail.com",
  "template": { "content": { "subject":"Re: ...", "html_body":"<p>...</p>", "text_body":"..." }, "variables": [] },
  "source":"pitstop:thread:<thread_id>",
  "dedupKey":"pitstop_reply:<outgoing_msg_id>"
}
→ { "ok":true, "data":{ "status":"sent", "message_id":"<uuid>", "provider_message_id":"<resend id>" } }
```
> **⚠ Relay enhancements this reply path needs (small, call them out to the Relay owner — see §7):** (a) a **CS sender identity** so the From is `carecrew@…` not the marketing `hello@`; (b) **sender selection by purpose/explicit id** in `send()` (today it picks the first active email sender); (c) **threading headers** (`In-Reply-To`/`References`) + `reply_to` passthrough in `adapters/email.js`. None exist yet.

### 3.3 What you get back for free
- **`comms.messages`** — every reply logged with status lifecycle + Resend `provider_message_id`; delivery/open/bounce flow back via the Resend webhook (already live).
- **`comms.events`** — `email_received` / `email_replied` events on the profile → usable as journey triggers + analytics later.
- **Identifier types** already supported: `email`, `phone`, `shopify_customer_id`, `whatsapp`, `instagram`, `messenger`, `device`. A customer who emails in and later WhatsApps (same phone/email) **auto-links to one profile**.

---

## 4. Inbound flow (end to end)

```
Gmail (carecrew@)
  └─(Pub/Sub watch or poll)→ Pitstop worker: fetch new message(s)
       ├─ parse MIME (from, to, subject, body html/text, attachments, Message-ID, In-Reply-To, References, Gmail threadId)
       ├─ POST /ingest { identifiers:[email(,phone)], name:"email_received", properties:{subject,gmail_thread_id,...}, idempotency_key:"gmail:<msgId>" }
       │     → profile_id  (the substrate link)
       ├─ upsert Pitstop email_thread (keyed by gmail_thread_id) ← store profile_id
       ├─ insert Pitstop email_message (inbound)
       └─ route/assign into Pitstop inbox (reuse existing WhatsApp routing/presence/tags)

Agent replies in Pitstop
  └─ compose → send via Gmail API (native thread)  OR  Relay POST /send (§7)
       └─ insert Pitstop email_message (outbound) + POST /ingest { name:"email_replied" } (mirror to substrate)
```

---

## 5. Threading rules
- **With Gmail API (Option A):** use Gmail's **`threadId`** as the thread key — Gmail already groups correctly. Store `gmail_thread_id` on the Pitstop thread; new messages with the same `threadId` append.
- **With a parser (Options B/C):** thread by RFC headers — match incoming **`In-Reply-To`/`References`** against stored `Message-ID`s; fall back to normalized `Subject` + sender within a time window. Always store each message's `Message-ID`.
- **Replies must carry threading headers** so the customer's client keeps the conversation together (Gmail-native does this automatically; Relay-routed replies need the `In-Reply-To`/`References` passthrough from §3.2).

---

## 6. Pitstop data model (inbound store — Pitstop owns this, NOT `comms`)
Mirror Pitstop's existing WhatsApp thread/message shape. Suggested (Pitstop schema):
```
pitstop.email_threads(
  id, gmail_thread_id UNIQUE, comms_profile_id uuid,   -- the Relay substrate link
  subject, status (open|pending|closed), assignee_id, tags[], last_message_at, created_at)
pitstop.email_messages(
  id, thread_id FK, direction (in|out), message_id (RFC), in_reply_to, gmail_message_id,
  from_addr, to_addr, html, text, attachments jsonb,
  relay_message_id uuid,            -- if reply sent via Relay /send (links to comms.messages)
  sent_by, occurred_at, created_at)
```
Tickets/assignment/presence: **reuse Pitstop's existing channel-agnostic inbox** — email is just another channel feeding the same router. The `comms_profile_id` lets the agent see the customer's full cross-channel profile.

---

## 7. The reply path — Gmail-native vs Relay-routed (a real decision)

| | **Gmail-native reply** | **Relay `/send` reply** |
|---|---|---|
| Transport | Gmail API `messages.send` (in-thread) | Relay → Resend |
| Threading | Native, perfect | Manual `In-Reply-To`/`References` (needs §3.2 enhancements) |
| From address | Real `carecrew@` mailbox | `carecrew@` **only if** root domain verified in Resend, else a `comms`-subdomain reply address |
| Unified suppression/log | ❌ (unless mirrored) | ✅ gate + `messages` log |
| Setup cost | Low (already on Gmail) | Adds CS sender identity + sender-selection + header passthrough + (maybe) root-domain Resend verify |

**Recommended v1 (hybrid):** **send CS replies via Gmail API** (native threading, real mailbox, no Resend root verification), and **mirror each reply to Relay via `POST /ingest` (`name:"email_replied"`)** so the substrate still sees the interaction. **Before replying, check `comms.suppressions`** (a customer who hard-bounced/complained on email shouldn't be re-mailed) — a cheap read against Relay. This keeps Gmail's UX while preserving the substrate-of-record.
**Long-term (PRD-pure):** move CS replies to Relay `/send` once the §3.2 enhancements land and you want one outbound gateway across all channels. Not required for v1.

---

## 8. Event vocabulary to seed (in `comms.event_definitions`)
Add (the ingest path warns-but-doesn't-fail on unknown names, but seed them so they appear in journey/segment dropdowns):
- `email_received` — inbound CS email (props: subject, gmail_thread_id, snippet)
- `email_replied` — agent reply sent (props: thread_id, channel)
- (`ticket_opened` already seeded — emit when a new thread is created)
These make "customer emailed support in last 30d" a segmentable/triggerable signal later.

---

## 9. Consent & compliance for CS email
- CS inbound + agent replies are **transactional/utility**, not marketing — they **bypass the marketing-consent gate and frequency cap** (a support reply must go), but **never bypass a hard suppression** (don't reply to a complained/hard-bounced address — surface it to the agent instead).
- **Do NOT auto-opt-in marketing** from a support email. Receiving a CS email is not marketing consent. Identity resolution links the profile; consent state stays whatever it was.
- A customer reply within a journey window can later emit a `replied` event (trigger material) — model-ready, not v1.

---

## 10. Auth & secrets
- **Relay seam:** `INGEST_TOKEN` (Cloudflare secret on `commsops`) for `/ingest` + `/send`. Pitstop's worker holds it as its own secret.
- **Gmail:** GCP service account w/ domain-wide delegation (`gmail.modify`) impersonating `carecrew@`, **or** per-mailbox OAuth refresh token. Stored as Pitstop-worker secrets, never in code.
- Per LOT rules: all secrets via `wrangler secret put` / GCP, never in chat or repo.

---

## 11. Open decisions for the Pitstop session
1. **Transport:** confirm Option A (Gmail API). Verify `carecrew@` is a Workspace mailbox/group + what Bitespeed does with it today.
2. **Reply path:** hybrid (Gmail-native + mirror to Relay) vs Relay-routed. Recommend hybrid v1.
3. **Push vs poll:** Pub/Sub `users.watch` (near-real-time) vs 1–2 min poll. Recommend Pub/Sub if the GCP setup is acceptable, poll as the quick start.
4. **Cutover from Bitespeed email inbox:** run Pitstop email read-only/in-parallel first, then make it the system of record (mirrors the WhatsApp de-risking pattern).
5. **Does Pitstop's existing inbox/router need a channel-type abstraction** to accept email alongside WhatsApp, or is it already channel-agnostic? (Likely already abstracted — confirm.)

## 12. What NOT to do
- ❌ Don't repoint `legendoftoys.com` root MX (breaks all company mail).
- ❌ Don't put inbound MX on `comms.legendoftoys.com` — that subdomain is Relay's **outbound sending** identity (SPF/DKIM); keep CS inbound on a distinct address/path (PRD §2.1).
- ❌ Don't make Relay the email transport owner (email has no single-connection constraint — that's a WhatsApp-only concern).
- ❌ Don't write CS email data into `comms` — the inbox lives in Pitstop's schema; `comms` only holds the profile link + interaction events + (if used) outbound `messages`.
- ❌ Don't auto-grant marketing consent from inbound CS email.

## 13. Suggested build sequence
1. **Gmail read path** — service account/OAuth; fetch + parse `carecrew@` messages (prototype with the Gmail connector).
2. **Substrate link** — `POST /ingest` per inbound message; store `profile_id` on the thread.
3. **Pitstop store + inbox** — `email_threads`/`email_messages`; surface in the existing inbox UI as a new channel, with the cross-channel profile panel.
4. **Reply path** — Gmail-native send + mirror event + suppression pre-check.
5. **Real-time** — Pub/Sub `users.watch` push.
6. **Parallel-run** then cut over from Bitespeed's email inbox.

## 14. Appendix — live `commsops` endpoints (verified working)
- `POST /ingest` — identity + event (token auth). §3.1.
- `POST /send` — outbound send through the gate (token auth). §3.2.
- `GET /unsubscribe?token=` — public one-click unsubscribe (marketing only; irrelevant to CS but don't reuse for CS).
- `POST /webhooks/resend` — delivery/open/bounce receipts (already wired; relevant only if replies go via Relay).
- Identifier types, event vocab, `messages` status lifecycle: see the Relay foundation PRD §5/§7 + `commsops-worker/migrations/`.

> **One-line summary for the Pitstop session:** the customer-identity substrate and the outbound send seam are built and proven; build the **Gmail-based inbound receiver + Pitstop email inbox** on top, link every thread to a `comms` profile via `/ingest`, reply Gmail-native (mirroring to Relay) for v1, and keep `carecrew@` on Workspace — the root MX stays Google.
