# Relay link tracking — Phase B: the `/r/<code>` first-party redirect

**Status:** scoped, NOT built. Written 2026-07-30 after Phase A was extended to WhatsApp.
**Predecessor:** `2026-07-01-relay-link-tracking-utm-design.md` (Phase A — UTM tagging + click events).

## What Phase A now covers, and what it structurally cannot

Phase A tags LOT-owned URLs with `utm_*` in message **content**. As of 2026-07-30 that includes
WhatsApp (previously email-only, which meant 0% real coverage — email-marketing volume is zero).
It works because those URLs travel as **body/header variable values**, which we control at send time.

It cannot cover two things, and no amount of extending it will:

1. **WhatsApp URL buttons.** The button's base URL is fixed when Meta **approves** the template, and
   the template variable is only a **suffix appended to that base**. There is no send-time hook to
   rewrite the resolved link. Appending `utm_*` to the suffix either no-ops or corrupts the URL, so
   `send.js` deliberately excludes button parameters.
2. **Click tracking on any non-email channel.** `link_clicked` has **0 events, ever**. Email gets
   clicks natively from Resend's webhook; WhatsApp and SMS have no equivalent, because nothing we
   own sits between the customer's tap and the destination.

Both reduce to the same missing primitive: **a link we own and can resolve per recipient.**

## The mechanism

A short first-party redirect on a LOT-owned host:

```
https://<short-host>/r/<code>   →  302  →  <target>?utm_source=relay&utm_medium=whatsapp&…
```

`<code>` is an unguessable random token minted at send time and bound to one (message, recipient,
target). Resolving it lets us append UTMs **after** approval, record the click, and choose the
destination per recipient.

**Why this satisfies Meta's constraint rather than fighting it:** the approved button URL becomes
`https://<short-host>/r/{{1}}` — a static base plus exactly one trailing variable, which is the
shape Meta already permits (it is the same shape the Shipment-Update tracking button needs). We pass
`<code>` as `{{1}}`. Approval never has to know the destination.

## Scope

**Data.** New `comms.links`: `code` (PK, random ≥16 chars, unguessable — it is effectively a
capability), `target_url`, `utm` jsonb, `message_id`, `profile_id`, `created_at`, `expires_at`,
`click_count`, `first_clicked_at`. RLS on, service_role-only, per RULE-RLS-001.

**Worker.** `GET /r/:code` on commsops, **before** JWT (public by nature):
- unknown/expired code → 302 to `legendoftoys.com` rather than an error page; a customer who taps a
  real link must never see a stack trace.
- append the stored `utm` to the target via the existing, tested `appendUtm`.
- emit `link_clicked` into `comms.events` with `{url, channel, message_id, code}` — the
  channel-agnostic name Phase A already standardised on, so WhatsApp/SMS clicks land in the same
  place as email's.
- writes are best-effort: **the redirect must fire even if the event write fails.** A failed
  analytics write must never cost the customer their click.

**Minting.** `send.js` mints a code per URL when the template declares a redirect-backed button,
storing the resolved target. Fail-soft: minting failure falls back to the untracked link.

**UI.** The existing `components/utm.js` needs no change — Phase B changes *where* the params are
applied, not who authors them.

## What actually sets the timeline

**Not the code — the Meta re-approval.** Every WA template with a URL button must be re-submitted in
the `/r/{{1}}` form and pass review. Sequencing that matters:

1. A template in review **cannot be edited**, and editing an approved template resets it to
   PENDING — see the S241 incident (`⛔ NEVER EDIT A TEMPLATE A LIVE JOURNEY DEPENDS ON`).
   So re-approval must be done as **new template versions**, with the live journey re-pointed only
   once the replacement is APPROVED.
2. Do the low-traffic templates first. The cart-recovery and browse-abandonment templates carry the
   volume and should move last, with the old version live until the new one is confirmed.

**A short host is required.** It must be a host we control end to end — never a third-party
shortener, which would put an outside party between LOT and its customers and break the attribution
it exists to provide.

⚠️ **CORRECTED 2026-08-04 (S261): the original line here — "`go.legendoftoys.com` as a Worker route is
sufficient and needs no new domain purchase" — is WRONG, and it was repeated into the implementation
plan before anyone checked.** A Cloudflare Worker custom domain requires the **zone to be on
Cloudflare**, and `legendoftoys.com` is not: `dig NS legendoftoys.com` returns
`ns37/ns38.domaincontrol.com`, i.e. **GoDaddy**. So no route can attach to `go.legendoftoys.com` as
things stand. **Register a short domain and add it as its own Cloudflare zone** — the standing BACKLOG
ask, and the right answer anyway for SMS, where every character is billed.

⚠️ **Subdomain delegation is NOT an option — checked 2026-08-04.** Adding `go.legendoftoys.com` to
Cloudflare as its own zone while the parent stays at GoDaddy is a **Cloudflare *subdomain setup*, which
is Enterprise-only** (Free/Pro/Business: not available). This was briefly written up here as the cheap
no-purchase path before it was verified; it is not one. Moving the apex zone to Cloudflare is not a
cheap third option either — it touches email/DKIM and the gh-pages deploy targets, and it would not
produce a *short* host anyway.

**The domain need not be bought AT Cloudflare.** Cloudflare only has to be the DNS host: register
anywhere (the short ccTLDs are generally not sold through Cloudflare Registrar), then add the zone and
switch nameservers.

**Where shortness actually pays:** not on WhatsApp — a URL button hides the link behind its label, and
that is the case blocking today. It pays on **SMS** (160 GSM-7 chars per segment, TrustSignal bills per
part) and on an RCS fallback leg. On a dedicated domain the `/r/` prefix can also be dropped and codes
served at the root. `CODE_LENGTH` is tunable: 22 chars is ~131 bits (chosen for margin), 10 chars is
~59 bits, still far beyond guessing for a capability that expires in 30 days.
⚠️ **If `CODE_LENGTH` is shortened, make `mintLink`'s retry draw a FRESH code** — it currently re-posts
the same row, which is correct when a collision is impossible and wrong once it is merely unlikely.

## Two things to design in from the start, not bolt on

- **Prefetch inflation.** WhatsApp (and link-preview bots generally) fetch URLs to build previews,
  which will register as clicks. Filter on request method and known bot user-agents, and treat the
  first hit within a second of send as suspect. Without this, click-through rate reads high and the
  number quietly becomes useless — worse than having no number.
- **The code is a capability.** It maps to one customer's order/cart. Make it random (not sequential,
  not derived from ids), expire it, and never put personal data in the path — an enumerable code
  would leak one customer's context to anyone who guesses it.

## Bonus it unblocks

The **Shipment-Update tracking button**, currently blocked and documented in BACKLOG: fulfilment
tracking URLs span two hosts (`www.delhivery.com` 806 / `shiprocket.co` 40 over 30d), and a
hardcoded Delhivery base would send ~40 customers/month to a Delhivery page holding a Shiprocket
AWB. A per-recipient redirect resolves the correct carrier at tap time — the only mechanism that can.

## Explicitly out of scope

Rewriting body-text links through the redirect. Phase A already tags those correctly and a redirect
would only add a failure point and hide the destination from the customer. Buttons need it; prose
does not.
