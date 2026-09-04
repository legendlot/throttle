# Pitstop — Everything Is A Ticket

> Status: **DESIGN PARKED, deliberately.** Afshaan, 2026-09-04: *"this is a spec that should be
> written to a document and should be picked up later with a clear mind."* The Pitstop backlog is
> being burned to zero first; this is the one item that survives that sweep.
> Brainstormed 2026-09-04 (S344). Decisions 1–5 below are SETTLED. Section 7 is what is still open.

---

## 1. The intent

Afshaan, 2026-09-04, verbatim:

> *"I want everything, every kind of interaction, to be a ticket, so that the team is only focusing
> on tickets and not on the kind."*
> *"Whatever is worth acting on should become a ticket. Whatever is not worth acting on should be
> auto-closed."*

Tickets gain a subtype — call, email, WhatsApp, social — and the team works **one queue**, not a
queue per channel. Some tickets are quick closes; some are investigate-evaluate-resolve.

**Why it is worth doing, beyond tidiness:** the CS system currently keeps its work at two different
grains, and that mismatch is already blocking real reporting. `reference/decisions.md` §S340 records
that a "complaints by tag" cut **cannot be built** because a tag lives on a thread and a complaint
row is a ticket, and the two do not join 1:1. Unifying on tickets dissolves that at the root rather
than working around it.

## 2. Scope

**IN:** email · WhatsApp · calls.
**OUT for now:** Instagram / Messenger / social. Afshaan, 2026-09-04: *"keep IG separate until the
handle join is built. Let's keep the social sections out of it for now."*

⚠️ Social is excluded for a **hard technical reason**, not preference: an IG/FB thread carries only a
handle, and **nothing maps a handle to a customer profile** — `comms.identifiers` carries no
Instagram or Facebook identifier type at all (verified 2026-09-04). A WhatsApp thread auto-matches on
its phone; an IG thread has no equivalent. Folding social in before that join exists would make the
ticket's customer identity unreliable for the one channel where it is already weakest.

⛔ **There is NO open backlog item for that identity join — do not go looking for one.** The old
`[pitstop] [build]` "auto-link an IG/FB thread to the customer's prior ticket" was **dropped**
2026-09-04 as a consequence of this scope decision (`archive/BACKLOG_ARCHIVE.md` §S344). **Bringing
social into this design therefore means re-opening that work first**, and the manual *Link ticket*
button remains the current answer in the meantime.

## 3. What is ALREADY built — measure before designing

⭐ **The model is roughly two-thirds shipped. Do not scope this as greenfield.** Measured
2026-09-04 over 30 days from `store.cs_tickets.created_by_user_id` (NULL ⇒ system-made):

| intake_channel | tickets/30d | system-made | agent-made |
|---|---|---|---|
| whatsapp | 1,886 | **1,583** | 303 |
| phone | 1,814 | **1,786** | 28 |
| email | 97 | **0** | 97 |

Source interactions over the same 30 days: WhatsApp threads 4,209 · email threads 1,103 · calls
3,721 (2,731 in / 990 out).

**So:** calls and WhatsApp already auto-create tickets. **Email is the ONLY channel with zero
automatic creation** — all 97 were hand-made. WhatsApp converts ~38% of threads.

⛔ **An earlier claim in this session that "email does not auto-create tickets, only calls do" was
WRONG on the second half and is corrected here.** The email half holds. Re-derive from
`created_by_user_id`, never from reading one ingestion path.

Two more pieces already exist and should be reused, not rebuilt:
- **`cs_tickets.intake_channel`** — the subtype field the model needs is already there.
- **RULE-PITSTOP-018 coalescing** — an answered call whose `customer_phone` already has an OPEN
  ticket in the same department within 24h attaches to it. The "don't spam tickets" problem is
  already solved once, for calls.

## 4. Settled decisions

**D1 — Grain: coalesce, do not map 1:1.** A new inbound attaches to the customer's open ticket if
one exists inside the window; otherwise it opens a new one. The **thread stays the conversation; the
ticket is the unit of work.** Rejected: one-ticket-per-thread (a customer's every future issue lands
on one ever-open ticket) and one-ticket-per-message (spam). This generalises RULE-PITSTOP-018 rather
than inventing anything.

**D2 — Coalescing is per-channel now, cross-channel-ready.** Carry `comms_profile_id` on the ticket
from day one (`cs_wa_threads` already has it), coalesce on phone/email where identity is solid, and
let social join later without a migration. Rejected: full cross-channel identity now — it makes the
whole programme wait on the hardest unsolved piece.

**D3 — 100% coverage, with auto-close.** Every inbound interaction opens a ticket; anything not
worth acting on is **auto-closed on arrival**. Rejected: a bar before ticket creation — it
recreates the exact problem being removed (some interactions live outside tickets, so the team still
looks in two places and "tickets per customer" under-counts).

**D4 — Notifications are FILTERED, and auto-closed tickets NEVER notify.** Afshaan, 2026-09-04:
*"there should be a filter on the notifications. Not every notification will be sent out… Auto-close
tickets would never be sending out notifications."* Customer-facing open/close notifications are a
later phase, not part of the first build.

**D5 — "Tickets per customer" is a first-class metric,** as a measure of CS efficacy and repeat
contact. It is the reason D1 is coalescing rather than 1:1: under a 1:1 model the metric always
reads ~1 and tells you nothing.

## 5. Consequences to plan for

**Volume roughly 2.4×** — ~3,800 → ~9,000 tickets/30d at 100% coverage. Not a technical problem, but
**every report, SLA and "closed today" number changes basis on the day it ships.** Same shape as the
S298 agent-report rebuild: the correction reads as a regression unless the team is told in the same
breath as the release.

⭐ **The coalescing window is the calibration of the "tickets per customer" metric.** Too long and
genuine repeat contacts are absorbed into one ticket (under-reports); too short and one issue
spanning two days reads as two tickets (over-reports). The 24h calls window must be **chosen**
against what "a repeat customer" should mean — not inherited by default.

**Notification cost, when that phase comes.** ~9,000 tickets/month with open *and* close
notifications is ~18,000 customer messages/month through Relay's send gate and frequency cap,
competing directly with campaign volume. This is a messaging-budget decision, not just UX — the same
trap already documented on the CSAT item.

## 6. Interactions with other work

- **Sender rules** (`[pitstop] [build] [HIGH]`) is the **first slice of this design, not a separate
  item.** Its flag is what tells the ticket layer "auto-close this one". Build it with the flag as
  durable state on the thread, named for the sender (`is_automated` / `non_customer`) and never for
  the consequence (`no_ticket` reads absurd on a row that later has a ticket).
- **Issue Analytics** (`[pitstop] [build] [MED]`) — its tag/sub-category cut is the grain-blocked
  one. Scheduling it after this work turns an impossible cut into a normal one.
- **Awaiting Reply filter** (`[pitstop] [build] [MED]`) — deliberately independent. It is a thread
  filter and should ship on threads now; do not hold it for this.
- ⚠️ **Does not conflict with "EVERY call gets a ticket"** (`reference/decisions.md`) — it
  generalises it. The record always exists; auto-close only decides whether a human is needed.

## 7. Still open — answer these before implementing

1. **What actually decides "worth acting on"?** Rules only (sender/domain, bounce detection), rules
   plus an agent one-click "auto-close and remember", or a classifier? Afshaan's sender-rules framing
   leans to the second. Undefined for WhatsApp and calls — only email has a candidate signal today.
2. **The coalescing window per channel.** 24h is the calls precedent; a WhatsApp or email issue may
   deserve longer. See the calibration warning in §5.
3. **Why does WhatsApp convert only 38% of threads today?** The existing rule must be read before it
   is replaced — it may already encode a "worth acting on" judgement worth keeping.
4. **Backfill:** do historic threads get tickets, or is this forward-only? Forward-only leaves
   "tickets per customer" incomparable across the cutover.
5. **What the team actually works** — does the inbox become a ticket list? Afshaan's *"only focusing
   on tickets and not on the kind"* implies yes, which makes this a UI programme as well as a data
   one. Not yet designed.
6. **Auto-closed tickets and metrics** — do they count in "tickets per customer"? They must not
   count as CS workload, but they are real contacts.

## 8. Sequencing

1. Sender rules + the `is_automated` flag (already filed, `[HIGH]`) — the auto-close substrate.
2. Email auto-creation — the only channel with none; the narrowest real gap.
3. Read and reconcile the WhatsApp 38% rule.
4. Coalescing window decision + `comms_profile_id` on tickets.
5. Ticket-list UI.
6. Customer notifications (filtered), last.
