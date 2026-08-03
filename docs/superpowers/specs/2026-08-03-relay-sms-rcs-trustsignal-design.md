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
  🔴 **F1 — see §6b. The naive rendering is a customer-harming bug, not a formatting detail.**
- **Three incompatible error shapes** (`errors[]`, flat `message`, single `error`). All carry
  `success:false`. `109`/`114` return **HTTP 400, not 404** — never branch on HTTP status alone.
- **No idempotency key anywhere.** Relay must dedupe *before* calling and retry only on
  connection-level failures, never on a response actually received.
- **No documented rate limits or bulk caps.** Implement our own token bucket; assume nothing.
- **`success: true` means accepted, not delivered.**

## 4. Live provisioning state (verified 2026-08-03)

**SMS — working, and better provisioned than a first read suggested**

| | |
|---|---|
| DLT header | `LGNDRC`, entity id `1701175957030337181`, Active (2026-07-28) |
| Templates | **20, all Active** — see the registry below |
| Webhook | none configured |
| Credits | ~₹9.85 — enough for live tests, not a campaign |

⚠️ **An earlier revision of this spec said "1 template exists". That was wrong** — it read only the
first table row. There are 20, and the coverage closely matches Relay's existing journeys, so SMS is
substantially more ready than that revision implied. Corrected 2026-08-03.

| Template id | Name | DLT type | DLT template id |
|---|---|---|---|
| `plsFsHlz6` | Order Shipped | **explicit** ⚠️ | 1707176156464942410 |
| `0gH2lpi5C` / `EpxvxiaP8` | Order Delivered | implicit | …313308513 / …263977465 |
| `efznzdt0l` | Order Cancellation | implicit | 1707176243410733011 |
| `amrIObqWc` | Order Cancellation | **explicit** ⚠️ | 1707176130203997578 |
| `vyNTAwgHa` | Prepaid Order Confirmation | implicit | 1707176130196189451 |
| `nWF2BOmTZ` | Prepaid Order Confirmation | **explicit** ⚠️ | 1707176249263781789 |
| `ZZEOOb542` / `UmtXBfUjb` | COD Amount Confirmation | implicit | …292738539 / …232974575 |
| `C1kDRPdk4` / `cccum9TCT` | ABC 1 | explicit | …299669109 / …241447254 |
| `fg0JrV2rN` / `9q1mj62AN` | ABC 2 | explicit | …306921545 / …255793178 |
| `G38A46v1i` / `8uzRdXnHh` | Product Page kwikpass | explicit | …350090048 / …411229833 |
| `Ia0ksdTNB` / `HGwYYNWru` | Collection KwikPass | explicit | …337166145 / …432006550 |
| `26B23IQ01` / `Pmpenlzye` | Home Page KwikPass | explicit | …323707514 / …369724799 |
| `WoiNXptjM` | Add to Cart KwikPass | explicit | 1707176130420370110 |

🔴 **F2 — two traps in this registry, both load-bearing:**

1. **Almost every name is duplicated, and two pairs DISAGREE on DLT consent type**
   (Order Cancellation, Prepaid Order Confirmation each have one `implicit` and one `explicit`
   twin). **Bind templates by `provider_template_id`, NEVER by name.** A name lookup is
   non-deterministic and picks the wrong regulatory class half the time.
2. **`Order Shipped` is registered `explicit`**, as is one Order Cancellation and one Prepaid
   Order Confirmation. In DLT, `explicit` = promotional-consent — **those messages will not be
   delivered to DND-registered numbers.** A shipping notification that silently skips DND
   customers is a real customer-facing failure. **Confirm with TrustSignal / re-register as
   `implicit` before routing transactional journeys to them.** Until then, prefer the `implicit`
   twin wherever one exists.

`template_type` (`explicit`|`implicit`) must be stored on the Relay template row and cross-checked
against `route` at bind time — see §6a.

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

**F9 — `pr1..pr5` is a hard ceiling of five variables.** A template needing six would silently
truncate and send a broken message. Validate `var_order.length <= 5` **at template-bind time, not
at send time**, so it fails in the authoring UI rather than in front of a customer.

**F10 — gate SMS sends on template status too.** The spec originally required this only for RCS.
Both registries carry a status and both push a `Template` webhook event; never send on a template
whose last known status is not Active/approved, on either channel.

## 6c. Template authoring — LOT authors, and it is fully API-driven

Confirmed against the vendor collection 2026-08-03. **We author templates; TrustSignal is the
registry and the carrier route, not the author.** This makes SMS template management a first-class
Relay feature (same shape as the WhatsApp template flow), not a vendor-panel chore.

```
POST /v1/accounts/templates   { name, content, headers:["LGNDRC"], dlt_entity_id }
POST /v1/templates/:id        { name, content, headers, dlt_entity_id, template_type }
```

⚠️ **`template_type` is NOT accepted on create — only on update.** It is absent from the create
payload and returns `""` in the create response. **Authoring is therefore a two-call sequence**, and
a single-call implementation silently leaves every template with an empty consent type, which is
precisely the F2 ambiguity. Treat create+set-type as one atomic operation in the adapter; if the
second call fails, surface the template as *incomplete*, never as ready to send.

Vocabulary: `Service-Explicit` · `Service-Implicit` · `Promotional`.

⚠️ **TrustSignal does NOT perform the DLT registration.** `dlt_entity_id` is a **required input** on
create (the failure case is literally `"Duplicate DLTID"`), so a DLT template id must already exist.
That registration happens on the operator's DLT portal, where **LOT is the Principal Entity** — which
is the arrangement the BACKLOG flagged as essential precisely so leaving a vendor never means
re-registering the estate. Two independent systems, both LOT-controlled:

| Layer | Owner | What it governs |
|---|---|---|
| DLT portal registration | LOT (Principal Entity) | the **real** consent category the carrier enforces (DND) |
| TrustSignal `template_type` | LOT, via the API above | how TrustSignal routes the send |

**Both must agree.** A TrustSignal label of `Service-Implicit` over a DLT registration of
Promotional looks correct and still skips DND-registered customers — the carrier enforces on DLT,
not on TrustSignal's copy. Validate the pair, do not assume the mirror is truth.

## 6a. `purpose` → `route`, and the DLT consent cross-check (F3)

The spec previously left this undefined, which is how a compliance bug gets built by accident.

| Relay `purpose` | TrustSignal `route` | Required DLT `template_type` |
|---|---|---|
| `marketing` | `promotional` | `explicit` |
| `utility` | `transactional` | `implicit` |
| `transactional` | `transactional` | `implicit` |
| *(OTP, if ever)* | `otp` | `implicit` |

⚠️ **Route and template_type must agree, and the mismatch must be a hard error at bind time.**
Sending a `utility` journey on an `explicit` template is exactly the F2 trap — it looks fine, it
returns `success: true`, and it silently fails to reach every DND-registered customer.
`global` is deliberately unmapped: it is the no-template-required international route and must
never be reachable from a normal Relay send (see §6b).

## 6b. Phone rendering — the F1 rule, stated because the obvious version is dangerous

Relay stores canonical E.164. Live data: **82,964 `+91` · 177 non-`+91` · 1 malformed `+91`**
(measured 2026-08-03).

**Never derive the SMS recipient by taking the last 10 digits.** `+14155550123` → `4155550123` is a
valid Indian mobile belonging to an unrelated person, and nothing in the send path would error.

The rule:

1. `+91` **and** exactly 13 chars → strip `+91`, send the bare 10 digits to `/v1/sms`.
2. `+91` but **not** 13 chars (the 1 malformed row) → **hard fail**, `reason='invalid_phone'`. Do
   not attempt repair at send time.
3. Non-`+91` → **hard fail** with `reason='unsupported_country'` in v1. The DLT header and template
   registry are India-only, so an international SMS could not be compliant anyway. Routing these
   via `/v1/sms/countrycode` + the `global` route is a deliberate later decision, not a default.
4. RCS takes the stored E.164 unchanged.

This is one function in `trustsignal-client.js` with a unit test per branch, including an explicit
test that a `+1` number is **rejected rather than truncated**.

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

⚠️ **F7 — D2 and D3 are tautological TODAY, and the code must say so.** Since `rcs` resolves to the
SMS opt-in, "require both" currently evaluates the SMS opt-in twice. That is not a bug, but a reader
can easily believe the gate is doing more than it is. D2 is the **durable** rule and matters the
moment `rcs` gains a real independent consent axis; D3 is the **current resolver**. Write the check
as two explicit calls with a comment stating they collapse today — do not "simplify" it to one call,
because that silently removes the guard the day someone gives RCS its own consent.

**F5 — DND failures must write a suppression.** SMS has **no inbound channel**, so there is no STOP
path and a customer cannot opt out to us directly; DND is carrier-side and surfaces as a `dndcf`
stat / a DND failure code on the delivery webhook. Without writing a `comms.suppressions` row we
re-send and re-pay to the same dead numbers indefinitely, and the failure rate quietly becomes the
channel's baseline. On a DND failure: suppress `(channel='sms', value=<phone>)` with
`reason='dnd'`. ⚠️ Suppress **SMS only, never the profile globally** — a DND registration is a
carrier-SMS state and says nothing about email or WhatsApp reachability.

**F6 — `isdesturl` and DLT template matching.** The shortener rewrites URLs in the outgoing body.
DLT matches delivered content against the registered template, so **a URL that appears literally in
approved DLT content will no longer match once rewritten → carrier rejection.** A URL must always
sit inside a `{#var#}` variable. Validate at bind time: if `isdesturl` is on and the template's
static content contains an `http(s)://` literal, refuse the binding. (Our current templates put the
URL in a trailing `{#var#}`, so they are safe — but nothing enforces that for the next one.)

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

**F4 — the channel flip must be ONE-WAY and IDEMPOTENT.** Both `Fallback` and
`Delivery_status(status='nonrcs')` imply the same thing, they can both arrive, and they can arrive
in either order — so a naive handler could flip twice, or flip back when a late RCS event lands.
Rules:

- The flip is `rcs → sms` **only**. Nothing ever sets `channel` back to `rcs`.
- It is keyed on `fallback_from IS NULL` — applying it twice is a no-op, not a second write.
- **Cost is overwritten only by the SMS leg's credit**, and only on the flip. A later RCS-side
  event must never re-apply the RCS cost to a row that already fell back.
- A `read` or `delivered` event carrying `route:'rcs'` that arrives *after* a flip is **discarded**,
  not applied — it describes a leg that did not deliver.

**F8 — terminal status when the fallback ALSO fails.** Defined explicitly, because the vendor does
not: the row ends `channel='sms'`, `fallback_from='rcs'`, `status='failed'`, with the **SMS** leg's
error in `reason`. One logical send, one terminal state. Never two failure rows, and never a row
left `accepted` because each individual leg reported separately.

Receiver hardening, all of it required because there is no signature:
- Respond 200 immediately, process asynchronously.
- Dedupe on `(transaction_id, status)`; these webhooks retry and reorder.
- **Only ever move state forward** — `read` can arrive before `delivered`.
- Log unknown status/error codes with the raw body rather than crashing; the published error
  catalogue is explicitly partial.

**F12 — clicks emit the EXISTING `link_clicked` event, not a new one.** S189 deliberately renamed
`email_clicked` → `link_clicked` to be channel-agnostic, specifically so SMS/WA would emit the same
name. Both the SMS `clickwebhook_url` and the RCS `Click` event map onto it, with `channel` in the
properties. Do not mint `sms_clicked`/`rcs_clicked` — that would fragment every click segment.

**F11 — cost typing.** SMS returns `sms_cost` as a **number**, RCS returns `cost` as a **string**
(`"0.1"`). `comms.messages.cost` is numeric, and PostgREST hands numerics back as strings anyway
(CORE.md). Coerce with `Number()` on both read and write, and record the unit — the vendor's
"credit" is not obviously ₹, so reconcile against `/v1/sms/stats` (`credits`, `dl_credits`) before
trusting any cost figure in reporting.

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

1. **`trustsignal-client.js`** — hosts, auth+redaction, error normaliser, **phone renderer (§6b)**,
   token bucket. Unit tests, no network, **including the `+1`-is-rejected-not-truncated test**.
2. **`adapters/sms.js` + send-path wiring** — sender identity, template model incl. `var_order`,
   `template_type`, the route cross-check (§6a), `isdesturl`. Unit tests including the
   positional-mapping test (§6) and the route↔template_type mismatch hard-error.
3. **SMS webhook receiver** + status mapping + token header + **DND→suppression (F5)**; register
   the URL on Sigmo.
   ⚠️ **F14 — webhook registration takes up to 10 minutes to propagate.** Verify it is live before
   step 4, or the first send will produce no status and read as a broken receiver.
4. **First live SMS** to an internal number under TEST MODE, on an `implicit` template.
   ⚠️ **F13 — TEST MODE matches the `to` string and does NOT strip `+`** (`compactAddr` removes
   spaces/parens/hyphens/dots only). An allowlist holding bare `9999999999` will not match a sent
   `+919999999999`; it fails **closed**, so this is a blocked test rather than a leak — but add the
   internal numbers in full E.164 or the first SMS test will silently refuse to send.
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
- **20 DLT templates are live**, covering Order Shipped/Delivered/Cancellation, COD + Prepaid
  confirmation, ABC 1/2 and the KwikPass browse set — good coverage of Relay's existing journeys.
  Any *new* SMS content variant still needs its own DLT registration.
- 🔴 **Fix the mis-classified templates — but diagnose which layer is wrong first (see §6c).**
  `Order Shipped` (`plsFsHlz6`) and one twin each of Order Cancellation / Prepaid Order
  Confirmation read `explicit`, so as things stand they will not reach DND-registered numbers.
  **Two very different fixes:**
  1. Mislabelled only in TrustSignal's mirror → a single `POST /v1/templates/:id` with
     `template_type: "Service-Implicit"`. Minutes, and ours to do.
  2. Genuinely registered as promotional on the **DLT portal** → must be re-registered there. The
     carrier enforces on the DLT category, so no API call fixes it.
  ⚠️ **Do not fix the label first.** A corrected TrustSignal label over an uncorrected DLT
  registration looks fixed and still silently skips DND customers — the worst of both states.
  **This remains the single highest-value external action**: it is the difference between shipping
  notifications reaching everyone and quietly skipping a slice of customers with no error anywhere.
- **Prune the duplicate templates** once the correct twin of each pair is chosen, so a future
  name-based lookup cannot pick wrong. (Binding is by id per F2, but removing the ambiguity is
  cheaper than relying on discipline forever.)
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
