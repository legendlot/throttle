# Relay WhatsApp — WS-B Setup Checklist (guarded)

> ## ⏸️ PROGRESS — paused 2026-07-13 evening (resume in the morning)
> **Blocked on:** generating the system-user token requires a **second LOT admin's approval** (Meta business
> guardrail). Ask another LOT Business admin to approve, then finish the token → outbound test.
>
> **Done + verified:**
> - App **"LOT Relay"** created (App ID `1343061317893118`; business `Legend of Toys`, verification ✓; Unpublished — fine).
> - WhatsApp product added; **test number `+1 555 174 8518`** provisioned. **Phone number ID `1154880417717547`**,
>   **WABA ID `1752135339132947`** (these are identifiers, not secrets).
> - `comms.sender_identities` WhatsApp row inserted + **active** (id `bd9f9323-d14d-442f-ab53-b41f9318ef79`,
>   metadata carries phone_number_id + waba_id).
> - `WA_APP_SECRET` set on commsops + **verified live** (webhook POST now returns `401 bad_signature`, was `503`).
> - System user **"relay wa bot"** (ID `61591826343110`, **Employee**) created; **LOT Relay app assigned Full control**.
>   Token permissions chosen = `whatsapp_business_messaging` + `whatsapp_business_management` (NOT manage_events).
>
> **Also done this session (evening):**
> - `WA_VERIFY_TOKEN` set on commsops (random hex).
> - **Webhook CONFIGURED + VERIFIED** in Meta (Configuration → Webhooks): callback
>   `https://commsops.afshaan.workers.dev/webhooks/whatsapp`, verify token matched → saved (green / "Remove
>   subscription" present). **Subscribed fields:** `messages` ✓, `message_template_status_update` ✓
>   (+ `message_template_quality_update` toggled on, harmless; `phone_number_quality_update` = optional for
>   number-quality alerts).
>
> **⚠️ KEY FINDING — app must be PUBLISHED for real inbound.** The Configuration page banner: *"Apps will
> only receive TEST webhooks (dashboard 'Test' button) while unpublished; no production data delivered until
> the app is published."* Same gate as Pitstop's IG DMs (S161). So a real customer WhatsApp won't reach our
> webhook until **LOT Relay is flipped Unpublished→Live**. Business verification is done + Requirements showed
> "none", so publishing a WhatsApp-only app should be a simple toggle (NOT the messaging/login App Review) —
> confirm the exact publish gate in the morning. Outbound sending is NOT blocked by publish state; only inbound
> webhook delivery is.
>
> **Remaining (morning):**
> 1. Second admin approves → **Generate token** (expiration Never, the 2 perms) → `npx wrangler secret put WA_TOKEN`.
> 2. `npx wrangler secret put WA_WABA_ID` (`1752135339132947`) — and `WA_VERIFY_TOKEN` already set.
> 3. **Publish the app** (Unpublished→Live) so real inbound flows; confirm no App Review is required for WA-only.
> 4. Claude runs Part 8 tests (a Relay `/send` out to your phone; inbound to the test number → window/event —
>    inbound needs the app Published first).
> 5. If a send hits a permissions error: also assign the **test WABA `1752135339132947`** to the "relay wa bot" system user.
>
> **BiteSpeed status: untouched** (all on the test number). Nothing disruptive done or pending here.



> **Companion to** the BiteSpeed-exit runbook (`docs/superpowers/plans/2026-07-12-bitespeed-exit-cutover-runbook.md`, §WS-B).
> **Goal:** stand up a **separate, dedicated Meta app for Relay** + a permanent token + the commsops secrets,
> and prove the WhatsApp adapter end-to-end **on a throwaway test number** — with **zero** effect on BiteSpeed.
> **Owner:** Afshaan (Meta console) + Claude (commsops secrets/SQL/tests).

---

## 🟢 THE GOLDEN RULE (read first)

**Everything in this checklist happens on the Meta-provided TEST number (+1 555…). Do NOT add, connect,
or register any of the 3 LIVE numbers** — `9035697508` (marketing) · `7022142666` (txn/COD) ·
`9880212323` (support). Those move only later, one at a time, in a scheduled WS-C window.

**The ONLY action that can take a number away from BiteSpeed is "register a phone number onto our Cloud
API."** It is flagged **⛔ STOP** wherever it could appear below. If a screen asks you to *add / connect /
register an existing number*, and it isn't the test number — **stop and ask Claude.** Nothing else here is
disruptive: creating an app, generating a token, granting WABA access, submitting templates, and setting
webhooks are all non-destructive and leave BiteSpeed fully running.

Independent safety layers already in place: TEST MODE is ON (Relay can't send to any non-`@legendoftoys.com`
address without a super-admin flip) · the webhook is inert (503) until `WA_APP_SECRET` is set · BiteSpeed
is only cancelled in WS-E, explicitly, last.

---

## Pre-requisites (already true for LOT)
- [ ] A **verified Meta Business Portfolio** (LOT is verified).
- [ ] You own the WABAs (confirmed 2026-07-12 audit).
- [ ] A Facebook account with **admin** on the LOT Business Portfolio.

---

## Part 1 — Create the dedicated Relay app  *(non-disruptive)*
1. Go to **developers.facebook.com** → **My Apps** → **Create App**.
2. **Use case / type:** choose **Other** → **Business** (the type that exposes the WhatsApp product).
   *(If asked "what do you want your app to do", the Business type + adding WhatsApp later is the path.)*
3. **App name:** `LOT Relay` (or `Legend of Toys Relay`). **Contact email:** yours.
4. **Business portfolio:** select the **LOT** portfolio (do NOT create a new one).
5. Create → you land on the app dashboard. Note the **App ID** (public) — you'll grab the **App Secret** in Part 4.

## Part 2 — Add the WhatsApp product + get the test number  *(non-disruptive)*
6. On the app dashboard → **Add products** → find **WhatsApp** → **Set up**.
7. It links a WABA for the app. **⚠️ It will offer a TEST business + a test number (+1 555…). Accept the
   test number** — that's your sandbox. **⛔ STOP — do NOT click "Add phone number" to connect one of the
   3 live numbers here.**
8. Open **WhatsApp → API Setup** (aka Getting Started). You now see:
   - a **test number** and its **`Phone number ID`**  → save as `PHONE_NUMBER_ID_test`
   - the **`WhatsApp Business Account ID`**  → save as `WABA_ID_test`
   - a **temporary access token** (24h) — handy for a first poke, but we'll mint a permanent one in Part 3.
9. On that page, under **"To"**, add **your own phone number** as a test recipient (Meta verifies it with an
   OTP). Click **Send message** (the `hello_world` template). Your phone should receive it. ✅ This proves the
   app + number + Graph path work — **all on the test number, BiteSpeed untouched.**

## Part 3 — System user + permanent token  *(non-disruptive)*
10. Go to **business.facebook.com** → **Business settings** → **Users → System users** → **Add**.
    - Name: `relay-wa-bot`. Role: **Admin** (or Employee with the asset assignments below).
11. **Assign assets** to this system user:
    - **Apps** → `LOT Relay` → toggle **Full control** (Manage).
    - **WhatsApp accounts** → the **test WABA** (`WABA_ID_test`) → **Full control**.
    *(Later, at each WS-C cutover, you'll additionally assign the relevant LIVE WABA here — not now.)*
12. **Generate new token:**
    - App: **`LOT Relay`**.
    - **Token expiration: `Never`** (this is the never-expiring system-user token).
    - Permissions: check **`whatsapp_business_messaging`** + **`whatsapp_business_management`** (only these two).
    - **Generate** → copy the token immediately (shown once). Save as `WA_TOKEN`.

## Part 4 — App secret  *(non-disruptive)*
13. App dashboard → **App settings → Basic** → **App Secret → Show** (re-enter your FB password). Copy →
    save as `WA_APP_SECRET`.

## Part 5 — Set the commsops secrets  *(you run these; non-disruptive)*
14. Pick any random string for the webhook verify token (e.g. run `openssl rand -hex 16`) → save as
    `WA_VERIFY_TOKEN`. **Set the secrets on commsops FIRST, before verifying the webhook in Meta** (the
    verify handshake checks this token; the app secret makes the POST path leave 503):
    ```bash
    cd 05_Throttle/commsops-worker
    npx wrangler secret put WA_APP_SECRET      # paste the Part-4 value
    npx wrangler secret put WA_VERIFY_TOKEN    # paste your random string
    npx wrangler secret put WA_TOKEN           # paste the Part-3 permanent token
    npx wrangler secret put WA_WABA_ID         # paste WABA_ID_test (the test WABA for now)
    # optional — defaults to v21.0 if unset:
    # npx wrangler secret put WA_GRAPH_VERSION
    ```
    `wrangler secret put` updates the live worker immediately — **no redeploy needed.**
    *(Note the phone_number_id is NOT an env secret — it lives on the `sender_identities` row, Part 7,
    because the code reads `sender.metadata.phone_number_id`.)*

## Part 6 — Configure + verify the webhook  *(non-disruptive)*
15. App dashboard → **WhatsApp → Configuration → Webhook** → **Edit**:
    - **Callback URL:** `https://commsops.afshaan.workers.dev/webhooks/whatsapp`
    - **Verify token:** the exact `WA_VERIFY_TOKEN` string from Part 5.
    - **Verify and save.** Meta does a GET handshake → our worker echoes the challenge → ✅ verified.
      *(If it fails: the secret isn't set yet, or a typo — re-check Part 5, then retry. Nothing breaks on failure.)*
16. **Manage webhook fields** → subscribe to: **`messages`** (inbound + delivery statuses),
    **`message_template_status_update`**, **`phone_number_quality_update`**. Save.
    *(These fire only for numbers registered under THIS app — i.e. the test number — so they can't divert
    BiteSpeed's inbound on the live numbers.)*

## Part 7 — Create the WhatsApp sender identity  *(Claude runs the SQL)*
17. Give Claude the **`PHONE_NUMBER_ID_test`** + **`WABA_ID_test`** + the test display number. Claude inserts
    the active sender so `send()` can find it (`getActiveSender('whatsapp')` picks the first active row):
    ```sql
    insert into comms.sender_identities (channel, address, purpose, provider, status, metadata)
    values ('whatsapp', '<+1 555 test number>', 'transactional', 'whatsapp_cloud', 'active',
            jsonb_build_object('phone_number_id','<PHONE_NUMBER_ID_test>',
                               'waba_id','<WABA_ID_test>',
                               'from_name','Legend of Toys'));
    ```
    Keep exactly **one** active `whatsapp` sender (the test number) until WS-C.

## Part 8 — Prove the adapter end-to-end (on the test number)  *(Claude assists)*
- **Inbound + window:** from your phone, **send a WhatsApp message TO the test number.** Meta → our
  `POST /webhooks/whatsapp` → we (1) open the 24h window in `comms.wa_windows`, (2) emit a `whatsapp_inbound`
  event + resolve a profile, (3) best-effort forward to csops (a no-op until WS-D). Claude verifies the
  `wa_windows` row + the event landed. ✅ proves capture + signature + window.
- **Outbound via Relay (real gate path):** because a WA recipient is a phone (not an `@legendoftoys.com`
  email), TEST MODE would block it — so **temporarily add your test phone to `test_mode_allow`** (Relay →
  admin/settings, or Claude patches `comms.settings.test_mode_allow` to include your E.164), then call
  `POST /send` with `{channel:'whatsapp', purpose:'utility', to:'<your phone>', template:{content:{text_body:'test from relay'}}}`
  **inside the open window**. Confirm the WhatsApp arrives + a `messages` row logs `sent`→`delivered`.
  **Remove your phone from the allowlist afterwards.** ✅ proves render → gate → adapter → status webhook.
- **Template submit:** author a WA template row (channel `whatsapp`, `content.meta_name` set) → run
  `waSubmitTemplate` → watch it reach `APPROVED` (or `waSyncTemplateStatus`). ✅ proves the template manager.

---

## ⛔ The disruptive step (NOT part of WS-B — for reference only)
The **register** step — WhatsApp Manager → a LIVE number → *"Register / connect to a new platform"*, or the
API `POST /<live_phone_number_id>/register` — is what moves a live number off its BSP/BiteSpeed onto our
Cloud API. **Do not do this during setup.** It happens per-number in WS-C, scheduled, marketing first,
support last, with rollback = re-register to the BSP. BiteSpeed keeps running until then; it's cancelled
only in WS-E.

## Rollback / "am I safe?" checks
- Nothing in Parts 1–8 registers a live number, so **all 3 live numbers stay on BiteSpeed** the whole time.
- To undo any of this cleanly: delete the sender_identity row, `wrangler secret delete WA_*`, and the
  webhook + app can be left dormant or deleted. No live number was ever touched.
- If ever unsure whether a click is "the register step", **stop and ask Claude before clicking.**

## The commsops env vars this build reads (reference)
| Secret | Read by | Notes |
|---|---|---|
| `WA_TOKEN` | adapter send + templates | permanent system-user token |
| `WA_APP_SECRET` | webhook | required — POST path is 503 until set |
| `WA_VERIFY_TOKEN` | webhook GET verify | your random string; matches Meta |
| `WA_WABA_ID` | template manager | test WABA now; live WABA per WS-C |
| `WA_GRAPH_VERSION` | adapter/templates | optional, default `v21.0` |
| `CSOPS_WA_FORWARD_URL` / `CSOPS_WA_FORWARD_TOKEN` | webhook forward | **WS-D only** (Pitstop inbox) — leave unset now |
| `sender_identities.metadata.phone_number_id` | send() | per number; on the sender row, not env |
