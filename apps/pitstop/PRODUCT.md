# Pitstop — PRD
> Customer Success (CS) system for Legend of Toys.
> Last updated: 2026-06-01 (Session 91 — initial)

## Register

store (Pitstop tables: `cs_tickets`, `cs_calls`, `cs_departments`, `myop_accounts`, `cs_issue_catalog`, `cs_wa_*`)

## Users

Pitstop is operated by the Customer Success team led by Pruthvi, working four lanes (departments): **Inbound**, **Outbound ABC**, **Call Confirmation**, **Messaging (WhatsApp/IG/Email)**. Four role tiers:

**Operator** (`cs_agent`, primary persona) — Works a department-scoped queue: claims tickets from Unassigned, advances them through the lifecycle, logs notes/attachments, returns missed calls, sends approved WhatsApp templates. Lives in this system all day; desk + headset.

**Team Lead** (`cs_lead`) — Everything an Operator does, plus assigns/reassigns tickets across the team, approves refunds/replacements, and reads reports. Owns their department's SLA.

**CS Admin** (`admin`) — Everything a TL does, plus force-close mid-flight, re-triage past `awaiting_evidence`, and manage departments / MyOperator accounts / WhatsApp templates.

**Super Admin** (`super_admin`) — CS Admin + cross-department visibility + destructive ops.

Upstream producers (not direct users): **MyOperator** (telephony → auto-creates call tickets), **BiteSpeed/Chatwoot** (WhatsApp → mirrors threads), **Ignition** (damaged-shipment handoff → opens a ticket via a sibling-worker call), and the historic **Product Complaints sheet** (bulk-imported as closed tickets).

## Product Purpose

Pitstop replaces ad-hoc spreadsheets + scattered call logs + WhatsApp screenshots as the single source of truth for every customer issue. It unifies three intake channels (phone, WhatsApp, manual/sheet) into one audited ticket lifecycle, separates **why** a customer contacted us (the *reason* — issue category/subcategory) from **what we decide to do** (the *disposition*), and routes work to the right department with a clean per-agent queue.

Pitstop gives the CS team:

- A **triage-first ticket lifecycle** — every contact starts `pending`; disposition (`query`/`no_action`/`awaiting_info`/`replacement`/`refund`/`repair`) drives the branch it follows through a 17-stage state machine.
- A **unified call log** (`cs_calls`) — every MyOperator event is recorded, including missed/unanswered calls; answered calls (duration > 0) auto-create a ticket, and repeat calls from the same number coalesce into the open ticket instead of flooding the queue.
- A **department-scoped queue** — non-admins see only their lane; admins switch lanes via the topbar.
- **Shopify customer enrichment** — on a ticket, the customer's recent orders auto-load with line items, pricing, shipping address, and AWB/tracking.
- A **WhatsApp continuity mirror** — the customer's WhatsApp thread surfaces on the ticket (inbound mirror via BiteSpeed/Chatwoot; outbound send is Phase C2-B).
- **Reporting** — ticket + call volume, answer rate, per-agent and per-department breakdowns, cost view.

Success looks like: a customer calls, MyOperator creates a ticket pre-enriched with their Shopify order history; the operator triages a disposition in seconds; the ticket flows through exactly the stages its disposition allows, gated on the evidence/fields each transition requires; every call, note, and stage change is on an append-only audit trail.

## Brand Personality

**Calm · Precise · Trustworthy.** Same Legend of Toys motorsport DNA (bold, terse, technical) but tuned for a support context where accuracy and auditability matter more than energy. Yellow (`#F2CD1A`) is the accent on the shared dark base; status is communicated through a disciplined disposition/stage/call-status badge system rather than decoration. The agent should never have to guess what state a ticket is in or what the next legal action is.

## Core Concepts

- **Reason vs disposition (two axes).** Reason = `issue_category` + `issue_subcategory` (from the 12-category / 72-subcategory `cs_issue_catalog`, or a free-text "Other"). Disposition = the decided action. They are independent; disposition — not reason — drives the lifecycle branch.
- **Lifecycle (17 stages).** Shared spine (`intake → awaiting_evidence → verified → pickup_scheduled → picked_up → at_warehouse → inspected`) then a disposition-specific branch (replacement / refund / repair), plus side-exits (`cancelled`, `rejected`, `escalated`). Encoded in three layers that must stay in lockstep: DB CHECK + worker `allowedTransitions()` + UI stepper.
- **Per-stage gates.** Some transitions require fields in the same atomic call (e.g. `verified → pickup_scheduled` needs `return_awb` + `return_courier`); missing gates return 422.
- **Departments.** `cs_department_id` lives on `users_profile`, `cs_tickets`, `cs_calls`, and `myop_accounts.default_department_id`. Non-admins are locked to their own department on every read.
- **Calls are source of truth.** `cs_calls` logs every telephony event; tickets are a derived, deduped layer (one open ticket per caller per department per 24h window).

## Non-Goals / Boundaries

- **Outbound WhatsApp send** is deferred to Phase C2-B (currently a read-only mirror; agents reply in BiteSpeed).
- **Self-serve customer return page** is a Shopify build, out of Pitstop scope.
- Pitstop does not own inventory, dispatch, or production — it links to those via the lotopsproxy cluster (UPC lookup, dispatch info) and to Ignition/Production by reference, never by hard FK.

## Roadmap snapshot

Phases A–E (calls + departments + multi-MyOp + sheet import; WhatsApp scaffold; BiteSpeed inbound mirror; formal 4-tier roles; impeccable UI sweep) are **live**. Open: **C2-B** (WhatsApp send-side, needs BiteSpeed API creds), **Recording-URL CDR resolution** (needs per-account `MYOP_API_TOKEN`). See `systems/pitstop.md` for current truth.
