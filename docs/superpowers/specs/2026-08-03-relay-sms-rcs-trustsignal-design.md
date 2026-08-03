# Relay — SMS + RCS via TrustSignal (design)

> Status: DESIGN APPROVED 2026-08-03 (Afshaan). Not yet built.
> Vendor reference: `~/.aside/.../artifacts/trustsignal-api-for-relay.md` (+ `trustsignal.postman.json`),
> extracted from https://postman.trustsignal.io on 2026-08-03. Re-fetchable collection id
> `44814789-313cef39-b563-4eda-9126-02e15b12000a`.
> Live provisioning state verified directly on sigmo.ai the same day (read-only).

---

## 1. Why, and what SMS is actually for

SMS is **not** an audience play, and the design should not pretend otherwise.

Measured 2026-08-03: **10,602 profiles hold an SMS marketing opt-in, and 10,532 of them are also
WhatsApp opted-in. SMS adds exactly 70 incrementally reachable people.** Building SMS as "a new
list" would be building it for 70 customers.

Its real value is reliability, and one part of that is large:

1. **The mandatory RCS fallback leg.** TrustSignal exposes no pure-RCS send — `with_fallback` is the
   only path, and it *requires* an SMS sender, message, DLT template and route.
2. **A route around Meta's engagement cap.** Measured the same day: marketing WhatsApp loses
   **~55% of resolved sends** to `wa_131049`, uniformly across all three marketing journeys, and the
   cap is per-recipient and compounding. SMS has no equivalent throttle, so a customer Meta refuses
   is still reachable.
3. **Transactional reach** when a WA template send fails or the 24h window is shut.

RCS is a separate proposition: a genuinely richer surface (cards, carousels, suggested replies,
read receipts) on a bot that is currently **promotional-only**.

## 2. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **One `comms.messages` row per logical send; `channel` flips on fallback** | One send = one row keeps dedupe, frequency cap and journey step counts honest. `channel` always means *what landed*. |
| D2 | **An RCS send requires opted-in on BOTH `rcs` and `sms`** | Either may be what actually delivers. The only reading that cannot message someone who opted out of SMS. |
| D3 | **`rcs` consent inherits the SMS marketing opt-in** | Same phone, same carrier channel, same DLT regime — and the fallback leg *is* an SMS. No new consent axis nobody has granted. |
| D4 | **Use TrustSignal's `isdesturl` shortener now; swap to first-party `/r/` later** | SMS links + click tracking work immediately with no external dependency. Vendor domain in customer messages is accepted **deliberately and temporarily**. |
| D5 | **Build the full RCS rich-content model in v1** | Cards, carousels, text+media, and suggested-reply inbound branching. (Author's note: recommended deferring carousels/branching; Afshaan chose full scope. Sequenced last in §12 so a slip there doesn't block SMS.) |
| D6 | **RCS is `purpose='marketing'` only** | The bot's `message_type` is `promotional`. Utility RCS needs a second bot. |
| D7 | **The RCS SMS-fallback leg is pinned to `route='promotional'`** | The RCS leg is promotional; a `transactional` fallback would put one message in two regulatory classes. Not caller-selectable. |

## 3. Vendor facts that constrain the build

Grounded, not assumed:

- **Auth is `?api_key=` in the query string on every call.** No header, no bearer, no signature.
  → **Redaction is a first-class requirement**, not hygiene: one `console.error(url)` leaks the
  account key into Cloudflare logs. Key is `TRUSTSIGNAL_API_KEY` (set on commsops 2026-08-03).
- **One host per service, inconsistent path prefixes.** `sms.trustsignal.io/v1/...`,
  `rcsapi.trustsignal.io/api/v1/...`, `auth.trustsignal.io/api/v1/...`. Hard-code per endpoint;
  never derive.
- **Phone formats differ by endpoint.** `/v1/sms` takes **bare 10-digit**; RCS takes **E.164**.
  Store canonical E.164, render at the adapter boundary. Never transport a phone as a JSON number.
- **Three incompatible error shapes** (`errors[]`, flat `message`, single `error`). All carry
  `success:false`. `109`/`114` return **HTTP 400, not 404** — never branch on HTTP status alone.
- **No idempotency key anywhere.** Relay must dedupe *before* calling and retry only on
  connection-level failures, never on a response actually received.
- **No documented rate limits or bulk caps.** Implement our own token bucket; assume nothing.
- **`success: true` means accepted, not delivered.**

## 4. Live provisioning state (verified 2026-08-03)

**SMS — working**

| | |
|---|---|
| DLT header | `LGNDRC`, entity id `1701175957030337181`, Active (2026-07-28) |
| Templates | 1 — `G38A46v1i` "Product Page kwikpass", DLT id `1707176249350090048`, Active, non-unicode |
| Content | `Hey {#var#}! Looks like our star legend caught your eye. Don't let it race away; tap 'Add to Cart' now and make it yours : {#var#}` |
| Webhook | none configured |
| Credits | ~₹9.85 — enough for live tests, not a campaign |

**RCS — bot only**

| | |
|---|---|
| Bot | `d91c046d040e4950` "L.O.T", `domestic`, `promotional`, provider `vi`, active (2026-08-03 11:09) |
| Templates | **none** |
| Webhooks | **none** |

⚠️ **`provider: vi` does NOT imply single-carrier reach.** It records the hub TrustSignal
registered through; cross-carrier delivery via Google RBM is the normal case. An earlier draft of
this design leaned on the opposite reading and was wrong. **It is settleable empirically for free
once live** — the delivery webhook returns `route:"rcs"` with `status: delivered` vs `nonrcs`, so a
few real sends give the true RCS-vs-fallback split. Do not theorise about it.

## 5. Architecture

Three new modules, following the existing `{ send, parseStatusWebhook }` adapter contract that
`adapters/email.js` and `adapters/whatsapp.js` already use.

```
adapters/trustsignal-client.js   the ONLY place vendor quirks live
  ├─ per-service host map + hard-coded path prefixes
  ├─ api_key injection + REDACTION on every log/error/exception path
  ├─ error normaliser (3 shapes → 1)
  ├─ phone renderer (E.164 → per-endpoint shape)
  └─ token bucket + backoff (no documented limits)

adapters/sms.js    { send, parseStatusWebhook }
adapters/rcs.js    { send, parseStatusWebhook }
```

Two channels, two files: they differ in template model, consent rule and webhook shape, so keeping
them separate keeps each small and testable. They share exactly the vendor weirdness — which must
not be implemented twice.

**Provider-agnostic seam.** `send.js` dispatches on channel to an adapter; TrustSignal is an
implementation detail behind `adapters/*`. A second SMS provider later touches no journey or
segmentation code. (The vendor doc recommends this explicitly, and it is nearly free here.)

## 6. Data model

**One new column.** There are **no CHECK constraints** on `channel`/`purpose` anywhere in `comms`
(verified), so `'rcs'` is a legal value with no migration. But **the code-side allow-lists are the
real gate** (PATTERN-218) — see §11.

```sql
ALTER TABLE comms.messages ADD COLUMN fallback_from text;
COMMENT ON COLUMN comms.messages.fallback_from IS
  'Set to ''rcs'' when an RCS send fell back to SMS. channel then reads ''sms'' — i.e. channel is
   always what ACTUALLY landed, and cost attributes to the right channel. Null on every other row.';
```

**`sender_identities`** — no change. SMS row: `channel='sms'`, `address='LGNDRC'`,
`provider='trustsignal'`. RCS row: `channel='rcs'`, `address='d91c046d040e4950'`.

**`templates`** — no change to columns.

- SMS: `provider_template_id` = TrustSignal template id (`G38A46v1i`).
  `content = { dlt_template_id, route, header, body, var_order[] }`.
- RCS: `provider_template_id` = RCS template id. `content = { ttype, bot_id, card|carousel spec,
  suggestions[], fallback_template_id }`.

**The variable mapping is the sharp edge of this build.** DLT templates use positional `{#var#}`
placeholders filled by `pr1..pr5`; Relay templates use named `{token}` variables. So an SMS
template carries an explicit ordered map:

```json
{ "var_order": ["first_name", "product_url"] }   // → pr1, pr2
```

⚠️ **Get the order wrong and the customer receives a grammatically perfect message with the wrong
words in it, and nothing errors.** This needs a unit test asserting the positional mapping, not
care. It is the SMS analogue of the `cart_link_suffix`/`product_handle` class we already know bites.

**RCS fallback by reference, not duplication.** An RCS template's `content.fallback_template_id`
points at a real `comms.templates` row with `channel='sms'`. One DLT template, one source of truth,
and the fallback leg inherits the same approval and versioning as any other SMS template. Do **not**
inline DLT text into the RCS row.

## 7. Send path

Unchanged gate, unchanged order: **suppression → consent → frequency cap → quiet hours → channel
rule**. SMS/RCS marketing is subject to all of it exactly as WhatsApp is, including the
journey-level quiet-hours **defer** (park until 09:00 IST, retry once) and TEST MODE.

**SMS send** → `POST /v1/sms` with `sender_id`, `to` (bare 10-digit), `route`, `message`,
`template_id`, `pr1..pr5`, `isdesturl=true` when the body contains a link.

**RCS send** → `POST /api/v1/rcs/with_fallback` with `to` (E.164), `template_id`, `rcs_variables`,
`ttl`, and `sms_fallback { sender, message, template_id, route:'promotional' }` resolved from the
referenced SMS template.

**Consent (D2/D3):** an RCS send checks `rcs` **and** `sms`. `rcs` resolves through the SMS opt-in
per D3 — implemented as a **resolver rule in the gate, not a 10,602-row consent backfill**, so the
inheritance stays visible, reversible, and cannot be mistaken for collected consent.

## 8. Webhooks and status

Both channels use TrustSignal's event-typed webhook UI **with a custom `Header (JSON)` field** —
verified present on SMS *and* RCS. That closes the "unsigned webhook" gap the vendor doc flagged:
we mint a per-receiver bearer token and reject anything without it, rather than relying on an
unguessable URL.

Two routes on commsops: `/webhook/trustsignal/sms`, `/webhook/trustsignal/rcs`.

**RCS events to subscribe:** `Delivery_status`, `Fallback`, `Click`, `User_response`, `Template`,
`Bot`. (`Agent_delivery_status` is agent-level; subscribe but log-only initially.)

**Status mapping**

| Vendor | Relay |
|---|---|
| SMS `delivered` / `failed` / DND | `delivered` / `failed` / `failed` + reason |
| RCS `delivered` | `delivered` |
| RCS `read` | `read` (SMS has no equivalent) |
| RCS `failed` | `failed` |
| RCS **`nonrcs`** / `Fallback` event | **flip `channel` → `sms`, set `fallback_from='rcs'`**, cost from the SMS leg |

Receiver hardening, all of it required because there is no signature:
- Respond 200 immediately, process asynchronously.
- Dedupe on `(transaction_id, status)`; these webhooks retry and reorder.
- **Only ever move state forward** — `read` can arrive before `delivered`.
- Log unknown status/error codes with the raw body rather than crashing; the published error
  catalogue is explicitly partial.

**Registration is eventually consistent** — the vendor states webhook config takes up to 10 minutes
to reflect. Never make it part of a synchronous setup flow.

**Correlation.** `transaction_id` is the join key and is sufficient. `pr1..pr5` are echoed back on
RCS webhooks; **if** they prove settable on send we can additionally carry `journey_id`/`message_id`
through the round trip. Treat that as an upgrade to verify, not a dependency.

## 9. RCS content model (D5 — full)

Four template types, per the vendor payloads:

| `type` | Shape |
|---|---|
| `text_message` | body only |
| `text_message_with_media` | body + media |
| `rich_card` (standalone) | `orientation` V/H, `height` (V only), `alignment` (H only), `standAlone{cardTitle, cardDescription, mediaUrl, thumbnailUrl, suggestions[]}` |
| `carousel` | N cards, same card shape |

**Suggestions** are the interactive surface, and there are three kinds:
`reply` (`displayText` + `postback`), `url_action` (`url`, `application`:
browser/webview-full/webview-tall/webview-half), `dialer_action` (`phoneNumber`).

**`postback` is the inbound-branching key.** A suggested-reply tap arrives on the `User_response`
webhook carrying its postback → journey branch handle. This is structurally identical to the
WhatsApp button-tap contract already specified in J3 (`outcomes[button_id]` / `no_reply`), so the
journey graph reuses `handlesFor` rather than growing a second mechanism.

**Media constraints are hard vendor limits and belong in validation, not documentation:**
- rich card: **3:1**, ≤2MB, optimal 1440×480, JPEG/JPG/PNG/GIF; video ≤10MB
- carousel: **5:4**, ≤1MB, optimal 960×720; video ≤5MB
- template name ≤20 chars · header ≤200 · body ≤2000 · button label ≤25

⚠️ **RCS templates require vendor approval** (`status` on the template record, plus a `Template`
webhook event). Never send on a template whose last known status is not approved — same discipline
as the WA template registry.

## 10. What is NOT in scope

- Otify (managed OTP) — base URL is an unresolved placeholder in the vendor collection.
- Email via TrustSignal — Relay already sends email on Resend; no reason to move it.
- Voice — the collection declares `VOICE_BASE_URL` and ships zero endpoints.
- Sub-accounts — LOT is single-tenant; `register-subaccount` is not needed.
- The first-party `/r/` redirect (deferred by D4, not cancelled).

## 11. The PATTERN-218 sweep

Adding a channel value is never one edit. Every gate that enumerates channels must learn `sms`/`rcs`
together, or the channel silently half-works:

| File | Today | Needs |
|---|---|---|
| `apps/relay/.../templates/page.js` | `['email','whatsapp']` | + sms, rcs |
| `apps/relay/.../campaigns/page.js` | `['email','whatsapp']` | + sms, rcs |
| `apps/relay/.../admin/connectors/page.js` | `['email','sms','whatsapp']` | + rcs |
| `apps/relay/.../admin/senders/page.js` | `['email','sms','whatsapp']` | + rcs |
| `apps/relay/.../contacts/page.js` | `['email','sms','whatsapp']` | + rcs |
| `apps/relay/.../segments/page.js` | `['email','sms','whatsapp']` | + rcs |
| `components/journey-canvas/NodeDrawer.js` | `[email·live, whatsapp·live, sms·live:false "SMS (not live yet)"]` | flip sms to `live:true` + relabel; add rcs |

DB CHECK constraints: **none on channel/purpose** — verified, nothing to widen.

## 12. Build sequence

Ordered so the highest-confidence, lowest-dependency work lands first and an RCS slip cannot block
SMS.

1. **`trustsignal-client.js`** — hosts, auth+redaction, error normaliser, phone renderer, token
   bucket. Unit tests, no network.
2. **`adapters/sms.js` + send-path wiring** — sender identity, template model incl. `var_order`,
   `isdesturl`. Unit tests including the positional-mapping test (§6).
3. **SMS webhook receiver** + status mapping + token header; register the URL on Sigmo.
4. **First live SMS** to an internal number under TEST MODE, on the existing `LGNDRC` template.
5. **UI sweep** (§11) for `sms`.
6. **`adapters/rcs.js`** — `with_fallback`, fallback-by-reference resolution, D7 route pinning.
7. **RCS webhook receiver** — incl. the `nonrcs`/Fallback channel flip (D1) and `Click`.
8. **First live RCS** to internal numbers → **measures the real RCS-vs-fallback split** (§4).
9. **RCS content model** — text/media first, then `rich_card`, then `carousel`.
10. **Suggested-reply inbound branching** — `User_response` → postback → journey handle, reusing
    `handlesFor`.
11. **UI sweep** for `rcs` + RCS template authoring.

## 13. Open items and risks

**External, not code:**
- Only **one** DLT template exists. Every SMS content variant needs its own DLT registration, so
  SMS journey scope is bounded by the template registry, not by this build.
- RCS has **zero** templates. Step 9 cannot be validated until at least one is approved.
- Credits ~₹9.85 — top up before anything beyond internal tests.
- Confirm with TrustSignal: the `vi` provider's actual cross-carrier reach, and what a
  `transactional` RCS bot requires (needed before RCS can carry order/shipping messages).

**Carried risks:**
- Query-string auth — mitigated by redaction, not eliminated.
- No idempotency — mitigated by dedupe-before-send.
- Unsigned webhooks — mitigated by the custom auth header, which is available on both channels.
- The vendor's error catalogue is partial by their own admission; log unknown codes rather than
  branching on an assumed-complete list.
- **The SMS consent list's provenance is inferred, not collected** (10,602 rows, 100% opted-in,
  zero opt-outs — the signature of a Shopify SMS-subscriber import). D3 extends that provenance to
  RCS. This is a known, accepted weakness that predates this design; worth settling before the
  first large marketing SMS, and it is the reason D3 is implemented as a visible resolver rule
  rather than a silent backfill.
