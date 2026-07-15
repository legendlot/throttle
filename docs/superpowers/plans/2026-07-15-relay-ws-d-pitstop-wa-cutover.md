# WS-D — Pitstop WhatsApp transport swap (BiteSpeed → Relay)

> Plan (2026-07-15). Executes WS-D of the BiteSpeed-exit runbook
> (`2026-07-12-bitespeed-exit-cutover-runbook.md` §WS-D) for the **support number 9880212323**.
> **Deadline:** BiteSpeed subscription ends **2026-07-31**. Target support cutover **~July 23–24**
> to leave ~7 days of BiteSpeed-alive rollback runway before cancellation.
> **Systems:** Pitstop (`csops`) primary; one crown-jewel-gated change in Relay (`commsops`).
> **Safety:** everything below is **inert until flipped** — the send still passes Relay's full gate
> (TEST MODE stays ON for marketing); rollback = flip the flag back + re-migrate the number to the BSP.

## Contract (confirmed both sides)
- **Relay forwards** (`commsops` `wa-webhooks.js forwardToCsops`): `POST {CSOPS_WA_FORWARD_URL}`,
  header `Authorization: Bearer {CSOPS_WA_FORWARD_TOKEN}`, body
  `{source:'relay_whatsapp', messages:[{from, wa_id, name, text, type, media?, ts, phone_number_id, provider_message_id}]}`.
  `from`/`wa_id` = digits (no `+`); `ts` = ISO; `provider_message_id` = Meta wamid (distinct from Chatwoot numeric ids → no idempotency collision).
- **csops today** (BiteSpeed): `handleBiteSpeedWebhook`→`biteSpeedMessageCreated` (inbound capture), `getWaConversation` (Chatwoot pull), `sendWaReply` (Chatwoot POST). Inbox is **channel-agnostic** (`cs_wa_threads`/`cs_wa_messages`) — email already rides it, so WA swaps only the transport under the inbox.

## Build (csops) — all additive, flag-gated

1. **Inbound receiver — `POST /webhooks/relay-wa`** (public, before JWT; mirror `handleBiteSpeedWebhook` auth pattern with `CSOPS_WA_FORWARD_TOKEN`). For each forwarded message:
   - find-or-create thread by `customer_phone = +{wa_id}`, `channel='whatsapp'` (reuse the `biteSpeedFindOrCreateThread` phone-match logic, but keyed on phone not Chatwoot conv id; `provider_thread_ref`/`provider_account_id` stay null on Relay threads);
   - **idempotency** on `provider_message_id` (the wamid) — skip if already present;
   - map `type`→kind (text/image/video/audio/document/`button`+`interactive`→text w/ payload), media→`media_url/filename`;
   - phone-link to the latest open `cs_tickets` (same as `biteSpeedMessageCreated`);
   - insert inbound `cs_wa_messages` row;
   - **reopen + round-robin assign** (reuse the same tail `biteSpeedMessageCreated` runs — auto-reopen a Done thread, round-robin an unassigned one);
   - **write a real `customer_window_until`** = `ts + 24h` on the thread. *(Improvement over BiteSpeed: Relay controls inbound, so the local 24h window column becomes authoritative — no more live-pull to derive it.)*
   - Receiver can be **deployed now** — it only ever fires once WS-B points the number's Meta webhook at commsops, so it is inert pre-cutover.

2. **Outbound re-point — `sendWaReply`** transport switch: when `waTransport(thread)==='relay'`, `POST {RELAY_SEND_URL}/send` (Bearer `INGEST_TOKEN`, already a csops secret) `{channel:'whatsapp', purpose:'utility', to:customer_phone, template?|text, dedupKey}` instead of the Chatwoot POST. Window check reads the **local** `customer_window_until` (no Chatwoot pull). Agent attribution is now correct **at insert** (we own the send → no post-hoc `sent_by_name` overlay hack needed). Insert the local outbound row directly.

3. **Read path — `getWaConversation`** transport switch: when `relay`, read local `cs_wa_messages` (full history — Relay is now the capture source) + merge internal notes; skip the Chatwoot pull + the attribution overlay. Window from the local column.

4. **Transport flag** — `waTransport(thread)`: **per-number**, keyed on the thread's WABA/number, driven by a `csops` setting/env (e.g. `WA_TRANSPORT_RELAY_NUMBERS` = set of `waba_phone_number_id`/support-number). Per-number (not global) because migration order is marketing→transactional→**support last**, each flipped independently with its own soak. Default = all `bitespeed` → zero behavior change until flip.

5. **Secrets (csops):** `CSOPS_WA_FORWARD_TOKEN` (matches commsops), `RELAY_SEND_URL` (`https://commsops.afshaan.workers.dev`), reuse `INGEST_TOKEN`.

## Crown-jewel change (Relay `commsops`) — NEEDS AFSHAAN SIGN-OFF, not built yet
Live WA agent replies are `purpose:'utility'`, but TEST MODE (gate ⓪) currently blocks **all** purposes.
**Proposal:** add `comms.settings.test_mode_allow_purposes jsonb DEFAULT '[]'`; in `gate.js` step 0, a send whose `purpose` ∈ that list bypasses the TEST-MODE block **only** (suppression + every other step still enforced). Set to `['utility','transactional']` at the support cutover → agent replies send live **while the marketing send-lock stays fully ON** (decouples the support cutover from the M10 marketing go-live). Default `[]` = provably inert. *Do not build until Afshaan approves — it loosens the crown-jewel lock.*

## Cutover choreography (support number, ~July 23–24)
1. WS-B done (Meta app + token + support WABA attached + `WA_*` secrets on commsops + Meta webhook → `/webhooks/whatsapp`).
2. Templates cataloged (already approved on the owned WABA — confirm names/languages).
3. Deploy the csops receiver (inert) + set `CSOPS_WA_FORWARD_*` on both workers.
4. Approve + ship the TEST-MODE purpose carve-out; set `test_mode_allow_purposes=['utility','transactional']`.
5. **Flip:** register `9880212323` on our Cloud API (detaches BiteSpeed for that number) → set the csops transport flag for it → send/receive verify.
6. Soak with rollback hot (re-migrate to BSP + flip flag back) through ~July 29–30 → let BiteSpeed cancel on the 31st.

## Open decisions for Afshaan
- **D1 — transport flag granularity:** per-number (recommended) vs global.
- **D2 — TEST-MODE purpose carve-out:** approve the `test_mode_allow_purposes` bypass (default-off) so the support cutover isn't gated on the full marketing go-live?
