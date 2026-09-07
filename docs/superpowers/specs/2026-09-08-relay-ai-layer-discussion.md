# Relay — an AI layer on the two flow bots: discussion document

> **Status: DISCUSSION, not a design and not a build.** Written 2026-09-08 (S356) from a conversation
> with Afshaan, for him to take into the Relay lane. It proposes changes to the settled 2026-09-07
> design (`2026-09-07-relay-flowbots-wa-web-design.md`), whose §0 records "LLM intent deferred
> (rule-based first)" on Pruthvi's own call (2026-09-05). Reopening that is a deliberate decision and is listed as one in §9.
> Backlog pointer: `backlog/relay.md` `[relay] [ask]` "AI layer on the flow bots — discussion doc".
> Nothing here has been built, costed against a real quote, or agreed with Pruthvi.

## 1. Where we start (measured state, 2026-09-08)

- **Both flow bots are live on ONE engine** (S355, `systems/relay.md` §Two flow bots). WhatsApp is
  in **staff pilot** on the support number (+919880212323) for Pruthvi and Afshaan; the web bot v2
  is behind the staff gate (`bot-widget.js:18`) and its storefront embed tag is currently absent
  from the live theme. Public flips are Afshaan's.
- The engine (`commsops/src/bot-engine.js`) is pure and channel-blind: `message` · `menu` · `collect`
  · `action:order_status` · `subflow` · `handoff` · `end`. Async work returns as effects. Sessions,
  append-only step rows (the analytics substrate), a verified order lookup (order number must match
  the customer's own phone/email; Shopify + `public.ecom_shipments.lifecycle`), agent takeover into
  Pitstop, and a shared FAQ sub-flow all exist.
- **There is no LLM anywhere in Relay today.** Routing is a greeting menu plus keyword matching.
- **The number that motivates this document:** of first inbound messages on the support number
  (last 30 days, 1,891 threads, measured 2026-09-07 in the 7 Sep design §1), **67% carry no intent
  (1,270/1,891) and ~17% carry a keyword (314/1,891)**. A menu bot therefore hands off, or re-shows
  the menu, on most first turns.
- Volume (re-derived 2026-09-08, `store.cs_wa_messages` inbound, 7 days): **WhatsApp 5,356 messages
  / 1,128 conversations a week**; omnichannel 8,298 / 2,030 (instagram 2,041/566 · email 872/332 ·
  messenger 24/3 · web 5/1). ⚠️ The "7,918 / 1,986" figure still quoted in places is the OMNICHANNEL
  total — the S342 review struck it as WhatsApp on 2026-09-03, and this document's first draft
  repeated the error (§11). Web chat was ~90 inbound/day in the BiteSpeed era (`systems/pitstop.md`),
  the only figure we have for what a public widget would carry.

## 2. What "AI" would add — three tiers, by risk

| Tier | What it does | Risk | Rough effort |
|---|---|---|---|
| **1. Intent routing** | One model call per inbound message turns free text into one of Pruthvi's flows (order status · FAQ · sales question · complaint · agent · off-topic). Structured output against a **closed** list; the engine stays in charge. | Low. Wrong route = the menu, which is today's behaviour. | ~1 lane-week incl. an eval built from Pitstop transcripts |
| **2. Grounded answers** (FAQ + sales help) | The model answers only from tool results: catalogue + taxonomy (`product_master`, Shopify), a curated FAQ/policy set Pruthvi owns, live stock, delivery date by pincode (deliveryops already exists), order status (existing verified lookup). | Medium. The safety property is architectural: **price, stock, delivery date and order facts never come from the model's memory, only from a tool.** | 2–3 lane-weeks, mostly content seeding, eval, hostile review |
| **3. Order actions** (cancel / modify / address) | — | High. Already OUT of v1 (Pruthvi, 2026-09-05); C2P handles cancellation; web identity is deliberately a weak key (`is_verified:false`). | Not proposed. Stays a handoff. |

Both channels get tiers 1–2 for free once either has them: the engine is channel-agnostic and the
WhatsApp adapter is already shipped.

**Recommendation that differs from Pruthvi's sequence:** ship tier 1 *with* the public flips, not
after. The 67% figure means a menu-only bot will measure badly in its first month and the conclusion
drawn will be "bots don't work here".

## 3. Running cost — both vendors, same volume model

Assumptions (every total scales linearly with them):

| Input | Value | Basis |
|---|---|---|
| Inbound messages | ~855/day · ~25,700/month | 5,356 WA/week (re-derived 2026-09-08) + ~90/day web. ⚠️ The first draft used 36,000/month (the omnichannel figure) — every cell below was ×1.4 too high |
| Router | every message: 300 fresh + ~1,200 cached input tokens, 30 output | flow list in the cached prefix, **padded past the minimum cacheable prefix** (OpenAI ≥1,024 tokens; Anthropic 1,024 on Sonnet/Opus, 2,048 on Haiku — an 800-token prefix gets NO cache discount on either) |
| Answering model | ⅓ of messages, 2 calls each (tool round trip): 1,500 fresh + 6,000 cached input, 200 output | catalogue + FAQ in the cached prefix |
| Exchange rate | ₹85 / USD | **assumption, not looked up** |

Prices per 1M tokens (input / cached input / output, USD). OpenAI from
`developers.openai.com/api/docs/pricing`, fetched 2026-09-08: gpt-5-nano 0.05/0.005/0.40 ·
gpt-5.4-nano 0.20/0.02/1.25 · gpt-5.6-luna 0.20/0.02/1.20 · gpt-5.4-mini 0.75/0.075/4.50 ·
gpt-5.6-terra 2.00/0.20/12.00 · gpt-5.4 2.50/0.25/15.00 · gpt-5.6-sol 4.00/0.40/20.00 · gpt-5.5
5.00/0.50/30.00 · gpt-6-astra 10.00/1.00/50.00. Anthropic from the `claude-api` skill bundled with
Claude Code (not a workspace file; its table is stamped 2026-06-24, so 2.5 months staler than the
OpenAI half — re-fetch before quoting to anyone): Haiku 4.5 1.00/0.10/5.00 · Sonnet 5 2.00/0.20/10.00
· Opus 5 5.00/0.50/25.00. Batch halves both vendors' rates. ⚠️ Anthropic bills cache *writes* at
1.25× and the default cache TTL is 5 minutes; at ~0.6 router calls/minute the prefix is rewritten
often, so the Anthropic router lines below can roughly double in steady state — OpenAI has no write
premium. Answer-tier lines are dominated by fresh input and output and move little.

| Role | OpenAI model | USD/mo | INR/mo | | Anthropic model | USD/mo | INR/mo |
|---|---|---|---|---|---|---|---|
| Router | gpt-5-nano | ~1 | ~70 | | Haiku 4.5 | ~14 | ~1,200 |
| Router | gpt-5.4-nano / gpt-5.6-luna | ~3 | ~250 | | Sonnet 5 | ~27 | ~2,300 |
| Router | gpt-5.4-mini | ~11 | ~900 | | | | |
| Answers | gpt-5.4-mini | ~43 | ~3,600 | | | | |
| Answers | gpt-5.6-terra | ~113 | ~9,600 | | Sonnet 5 | ~106 | ~9,000 |
| Answers | gpt-5.4 | ~141 | ~12,000 | | | | |
| Answers | gpt-5.6-sol | ~212 | ~18,000 | | Opus 5 | ~264 | ~22,400 |
| Answers | gpt-5.5 | ~282 | ~24,000 | | | | |
| Answers | gpt-6-astra | ~530 | ~45,000 | | | | |

**Reading:** a realistic pairing on either vendor is **~₹10,000–25,000 a month** (nano router +
mini answers is ~₹3,700; the floor of the band is a taste call, not a measurement). A public web
bot at BiteSpeed-era volume adds ~10%; at ten times that it doubles — there is no basis for either
figure yet. Cost does not decide the vendor. The real lever is prefix stability (rebuild the prompt
per request and the answering cost roughly triples, measured 2.6–2.7× on these assumptions). Which
OpenAI tier matches which Anthropic tier in *quality* cannot be read off a price list — a 200-case
eval on Pitstop transcripts settles it in an afternoon. Tier equivalence above is by price band only.

## 4. Auto-classification of EVERY conversation (the reporting ask)

Goal: every conversation — closed by the bot, handed to a human, or human from the start — carries
one classification from a **preconfigured, closed** category list, with nobody having to tag it, so
"biggest query / second biggest / share of all" is a `GROUP BY`.

- **Unit = the conversation**, not the message. Classify the customer side of a thread once, on
  close (the event the resolution clock already keys on: `created_at → closed_at`) **or after 24h
  idle — ⚠️ no idle trigger exists in Pitstop today; the only idle timer in the bot stack is the 6h
  `bot_active` box, so the idle half is new work, not reuse.** Reopen → close again = reclassify,
  latest wins, previous kept.
- **Closed list, enforced structurally.** Categories live in a table. ⚠️ `store.cs_issue_catalog`
  (72 rows, 12 categories, measured 2026-09-08) is a **post-purchase defect taxonomy** — Battery &
  Charging · Damage/Defective · Delivery/Shipment · Returns & Replacement · Wrong Item … — with no
  *pre-sales*, *spam/vendor* or *other*, so the conversation list is an EXTENSION into a different
  kind of taxonomy (intent, not defect), ≥15 top-level, not a top-up of the existing 12; it should
  still map onto the ticket categories where they overlap so the two reports agree. The output
  schema is an **enum of exactly those values** — a new category is not a behaviour to discourage,
  it is an answer the API rejects. *Other* is a configured value, so nothing is ever unlabelled and
  nothing is ever labelled with a word nobody approved.
- **One primary label per conversation** (+ optional secondary + confidence + one-line reason for
  *other*). One primary is what makes the shares sum to 100.
- **Stored beside, never over.** New table keyed by thread: taxonomy version, labels, confidence,
  model, run id. Agent tags (`cs_thread_tags`) untouched; an agent may override, recorded as such.
  Reports default to the auto-label because it has full coverage.
- **Nightly batch** (both vendors: 50% off). Same classifier later serves the live router (tier 1),
  so the taxonomy is built once.
- **Discovery loop is OPTIONAL and off by default:** a monthly report of what fell into *other*;
  adding a category is a row Afshaan/Pruthvi inserts + a cheap reclassification of history.
- **Human check is NOT in the pipeline.** 100 sampled conversations a month labelled by a CS lead
  lets the report print "agrees with a human N%" beside the shares. Skip it and everything still
  labels; you just cannot print the accuracy figure. Why it matters: the only *automated*
  classification tried so far was a keyword regex, the same method that came out 44% wrong on the
  backlog taxonomy (`reference/backlog-taxonomy.md`); the human tags in `cs_thread_tags` (16,429
  rows, measured 2026-09-08) cover only what agents chose to tag.
- **Honest denominator:** *not a query* is a category (the never-replied email audit handed to
  Pruthvi 2026-09-04 found ~53–62 of ~111–112 unanswered emails were vendors — two classifiers
  disagreed by ±10, `archive/BACKLOG_ARCHIVE.md` §S347b). Strip phones, emails and order numbers
  before text leaves.
- **Surface:** Pitstop **`/reports`** (conversation grain — `cs_wa_threads`; daily/weekly/MTD trends
  + Export CSV already exist there) gains a "query mix" panel — share by category, trend, cut by
  channel/product, denominator on the chart. ⚠️ Not `/analytics`, which is ticket-grain; putting a
  conversation share there would print a denominator that is not conversations.
- **Cost:** ~2,000 conversations/week × ~1,500 tokens ≈ 3M tokens/week → ₹50 (nano-class) to ~₹600
  (terra/Sonnet-class) a week, half in batch. 90-day backfill (~25,000 conversations, ~40M tokens):
  ₹500–7,000 once, by tier.
- **Effort:** the taxonomy + the labelled sample are Pruthvi's (~1 week of his time). Pipeline =
  nightly worker job + table + one Analytics panel: ~2 lane-weeks incl. eval.

## 5. Web bot vs WhatsApp bot — same engine

No second engine. Shared: engine, sessions, transcript/analytics rows, order lookup, handoff rail,
Pitstop seam, builder, the shared FAQ sub-flow, and every AI tier above. Per-channel adapters only:

| | Web | WhatsApp |
|---|---|---|
| Transport | widget script, 5s poll | Meta Cloud API webhooks, 4 live numbers |
| Identity | anonymous; collect phone/email, weak key | phone known from message 1 |
| Rendering | no hard limits; list = stacked options | 3 reply buttons × 20 chars, or 10 list rows × 24 (the engine's constants; the 7 Sep design §10 flags them as taken from memory — verify against Meta's docs at implementation) |
| Top menu | own flow | own flow (because of the limits); FAQ tree shared |
| Exposure | public unauthenticated endpoint: CORS lock, 500-char cap, 20 msgs/min/session; per-IP limiting at the edge is a config residual | inbound only from Meta; 24h window + templates |
| Extra rules | session survives navigation | no firing mid-journey; never wake parked C2P steps; sticky handoff |

One flow definition for both channels was considered and rejected in the 7 Sep design (WhatsApp's
limits would cramp the web menu). Web is the *easier* of the two and is ahead: un-gating is the
storefront embed tag + the `bot_active` rail on the web forward + deleting one line
(`backlog/relay.md` `[relay][build]` "WEB BOT — the UN-GATE prerequisites").

## 6. The knowledge library

Needed, but most of it exists as data; the new artefact is a **small curated answer set**.

| Source | Exists | Maintenance |
|---|---|---|
| Order status, EDD by pincode, stock | yes — live lookups (Shopify, `ecom_shipments`, deliveryops, inventory). ⚠️ deliveryops is HTTP-only behind a **Shopify App Proxy** (`SHOPIFY_APP_PROXY_SECRET`), so a bot tool needs an internal auth path to it, not a plain call | none once wired; nothing written to go stale |
| Catalogue: names, variants, colours, category, prices | yes — `product_master` (RULE-TAXONOMY-001; 20 columns, **no age, no price**) + Shopify for prices | brand team already maintains it for the store. **Age does not exist anywhere** — see §9.4 |
| Policies: returns, replacement, warranty, shipping, COD, cancellation | scattered | ~20 short entries written once; Pruthvi owns |
| Troubleshooting: battery, charging, pairing, remote | in product manuals + ticket history | seeded from the top `cs_issue_catalog` categories |
| Offers / promotions | volatile | read live from Shopify discounts, or a table where every row has an expiry date |

Rules: the bot answers only from these and says so otherwise (offering an agent); every entry has an
owner + review date; **anything with a price, date or quantity comes from a live tool, never from
text**. Size is a few hundred entries — fits in the cached prefix; no vector store until >~100k
tokens. The FAQ tree Pruthvi is already authoring is the seed.

## 7. Keeping it on topic (limits)

Prompt instructions are the weakest layer, so they are not the only one.

1. **Scope in the system prompt:** LOT orders, products and shopping help only; off-topic gets one
   friendly line + redirect; no opinions, competitors, politics, homework, roleplay. **Brand
   decision to state plainly: a support assistant for a toy company, not a fun chatbot, even though
   children will find it.**
2. **Structural:** *off-topic* is a fixed router category; the **engine** sends the canned redirect;
   after 3 off-topic turns the engine ends the session politely.
3. **Hard caps:** keep 500 chars/msg + 20 msgs/min/session; add a per-session turn cap (~20) and a
   daily per-phone cap on WhatsApp.
4. **No write tools in v1** — nothing to be talked into.
5. **Customer text is data:** order details release only when the tool verifies order number
   against the customer's own phone/email; the check lives in the tool, not the prompt.
6. **Abuse costs ~₹9 (mini-class) to ~₹23 (terra/Sonnet-class) per 20-turn capped session** on the
   §3 assumptions; the real risk is an off-brand screenshot, so refusal copy is reviewed like any
   customer copy.
7. **Monitoring:** the §4 pipeline reports *off-topic* share weekly.

## 8. What it does NOT need

A new inbox, session store, widget, WhatsApp API onboarding, a vector database, or a second engine.

## 9. Decisions for Afshaan (none made)

1. **Vendor** — Pruthvi assumed OpenAI; the workspace default is Anthropic. Either works; both are a
   **data-sharing sign-off** (customer messages + order facts leave the building). Data-handling /
   retention is an org-level setting on either vendor to review before the sign-off.
2. **Sequence** — tier 1 *with* the public flips (this doc) vs rule-based first, AI later (Pruthvi,
   2026-09-05; the 7 Sep design as written).
3. **Reopening the 7 Sep design's "LLM intent deferred"** — a change to a settled call; record it in
   `reference/decisions.md` if taken.
4. **Sales-help scope** — *answer* product questions (tier 2 as written) vs *recommend* products
   (needs an attribute set per SKU — age, terrain, speed, price band — and a brand-side owner who
   does not exist yet).
5. **Classification taxonomy owner + the closed list** (§4) — Pruthvi, and the first ~15 categories.
6. **Whether the human-check sample runs at all** (§4).
7. **§4 is a THIRD automation build.** `reference/decisions.md` §S352 (Afshaan, 2026-09-04): *"There
   are only two items that we need to build in automations … These two are the only two build
   items."* The classification pipeline (nightly job + table + `/reports` panel, ~2 lane-weeks) is
   neither bot. Taking §4 forward reopens that call; record it if so.

## 11. Hostile-review log (2026-09-08, first draft → this version)

Reviewed by the `hostile-reviewer` agent before commit; 18 findings, all applied above. The ones
that changed a conclusion: **(1)** the volume base was the omnichannel 7,918/1,986 mislabelled as
WhatsApp — the same error S342 struck on 2026-09-03 — so every §3 figure was ~1.4× high; corrected
to 5,356/1,128 and the band to ~₹10–25k. **(2)** the 800-token router prefix was below both vendors'
minimum cacheable prefix, and Anthropic's cache-write premium + TTL were ignored. **(3)** "the only
classification so far was a regex" ignored 16,429 human thread tags. **(4)** the 24h-idle trigger
does not exist. **(5)** `product_master` has no age column. **(6)** the email-audit citation mixed
two measurements. **(7)** the panel belongs on `/reports`, not ticket-grain `/analytics`. **(8)**
`cs_issue_catalog` is a defect taxonomy, not an intent one. **(9)** §S352's "two build items" was
missing from §9. Unverified by the reviewer: the OpenAI page fetch itself, Anthropic's current rates
and cache terms, the live theme, and the Slack thread behind the email audit.

## 10. Proposed next step (if taken forward)

Not code. A short **v3 amendment to `2026-09-07-relay-flowbots-wa-web-design.md`**: (a) the router
as a pre-step to the greeting menu with the closed intent list, (b) the tool contract for tier 2
(`order_status` · `product` · `stock` · `edd` · `faq` · `handoff`, all read-only), (c) the §4
classification table + nightly job, (d) the §7 caps. Then a 200-case eval from Pitstop transcripts
before any vendor is chosen. Hostile-review the amendment before execution, as the 7 Sep design was.
