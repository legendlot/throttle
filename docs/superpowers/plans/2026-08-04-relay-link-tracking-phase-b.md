# Relay link tracking Phase B — the `/r/<code>` redirect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A first-party redirect we own, so that (a) WhatsApp URL-button clicks can be attributed and
tagged *after* Meta approval, (b) `link_clicked` stops being 0-events-ever on every non-email channel,
and (c) the 11 RCS creatives currently pointing at `bspd.me` can be re-authored against a LOT host.

**Spec:** `docs/superpowers/specs/2026-07-30-relay-link-tracking-phase-b-redirect.md`.
**Predecessor:** Phase A — `2026-07-01-relay-link-tracking-utm-design.md` (`src/tracking.js`, shipped).

---

## Two findings from the live inventory that the spec did not have

Measured 2026-08-04 against `comms.templates` (15 URL buttons across 15 templates — 11 active,
3 draft, 1 archived). Both change the shape of the work:

**1. The cart-recovery set does not point at a LOT host at all.** Four active marketing templates —
`Abandoned Cart v3`, `ABC2 10 hours`, `Cart abandonment 2_v1_10hrs`, `Cart ABC 1` — have the approved
base `https://checkout.shopflo.co/stable/{{1}}`. The spec framed the button problem as "we cannot
rewrite the suffix". The stronger truth is that **`appendUtm` would refuse these anyway**, because
`isLotHost()` rejects `checkout.shopflo.co` — so for LOT's highest-volume marketing templates the
redirect is not an improvement on Phase A, it is the *only* mechanism that can ever attribute them.

**2. `Shipment Update-Out for Delivery_WA` is worse than "blocked".** Its button base is the literal
`https://shiprocket.co/tracking/123456789` — a hardcoded AWB, with no variable at all. It is draft, so
nothing has shipped it, but it cannot be activated in any form without this work.

Also noted: `PR_Browse Ab v1` and `PR_Cart Ab v1` hardcode `/products/vortex`, and five buttons carry
no suffix variable at all. Those five are the cheapest re-approval candidates and should go first.

---

## The design decision the spec left open: where the real destination lives

Once a template is re-approved as `https://<short-host>/r/{{1}}`, **the template no longer knows where
the button goes.** The approved base is the redirect; the suffix is the code. So the real destination
has to be declared somewhere that is ours, not Meta's.

**Decision: a new `target_base` on the button object in `comms.templates.content`.** Authoring-side
only, never sent to Meta. The existing `mapping` entry (`component:'button'`, `sub_type:'url'`) keeps
supplying the suffix token exactly as it does today. At send time:

```
target = content.buttons[i].target_base + <resolved suffix token>
code   = mint(target, utm, message_id, profile_id)
button param {{1}} = code
```

A button with no `target_base` is not redirect-backed and behaves exactly as it does now. That is what
makes this shippable ahead of any re-approval: **the feature is inert until a template opts in**, one
template at a time, which is also the sequencing the S241 incident demands.

## The second open decision: what a mint failure does

Phase A's spec says "minting failure falls back to the untracked link". **That is no longer available
post-re-approval** — the untracked link *is* the redirect, so there is nothing to fall back to. The
choice is between sending a message whose only CTA lands on the homepage, and not sending it.

**Decision: retry the insert once, then FAIL the send** with `reason='link_mint_failed'`. A failed send
is visible in journey analytics and gets retried; a delivered cart-recovery message whose button drops
the customer on the homepage instead of their cart is invisible damage that looks like a conversion
problem. This is deliberately the opposite of the *click*-path rule below, and the asymmetry is the
point: a failed analytics write must never cost a customer their click, but a failed mint means there
is no working link to click.

---

## File structure

| File | Responsibility |
|---|---|
| `commsops-worker/migrations/0039_comms_links.sql` (create) | `comms.links` + RLS + grants + `NOTIFY pgrst`. |
| `commsops-worker/src/links.js` (create) | Mint + resolve + click accounting. Pure-ish; the only DB touch is via `A.sbComms`. |
| `commsops-worker/src/send.js` (modify, ~line 296) | Mint per redirect-backed button; replaces the excluded-buttons branch. |
| `commsops-worker/src/index.js` (modify, ~line 1552) | Public route `GET /r/:code`, above the JWT block. |
| `commsops-worker/test/link-code.test.js` (create) | Code generation: unguessable, no PII, right alphabet. |
| `commsops-worker/test/link-resolve.test.js` (create) | Target composition + UTM append + unknown/expired → homepage. |
| `commsops-worker/test/link-prefetch.test.js` (create) | Bot/HEAD/sub-second hits do not count as clicks but DO redirect. |
| `commsops-worker/test/link-mint-button.test.js` (create) | `target_base` opt-in, suffix resolution, non-opted button untouched. |

**Config, not hardcode:** the short host lives in `comms.settings.link_base_url` (nullable text).
**Null means the whole feature is off** — `mintButtonLink` returns null and `send.js` leaves the button
exactly as it is today. So this can ship and sit inert before the DNS exists, and be switched on with
one UPDATE rather than a deploy.

---

## Sequencing — what is NOT in this plan

The Meta re-approval wave is deliberately excluded. It is not code, it is review latency, and per the
S241 incident it must be done as **new template versions with the live journey re-pointed only once the
replacement is APPROVED**. Order when it starts: the five no-suffix buttons first (lowest risk), then
`Order Placed`, then the Shiprocket tracking button, and the four Shopflo cart-recovery templates last —
they carry the volume.

**External gate — and it is bigger than this plan first said.** ⚠️ **CORRECTED 2026-08-04: the spec's
"`go.legendoftoys.com` as a Worker route is sufficient and needs no new domain purchase" is WRONG, and
this plan repeated it uncorrected.** A Cloudflare Worker custom domain requires the zone to be **on
Cloudflare**; `dig NS legendoftoys.com` returns `ns37/ns38.domaincontrol.com` — **GoDaddy**. So there is
no DNS record Afshaan can add today that would make it work. Either register a short domain as its own
Cloudflare zone (the standing BACKLOG ask, and the better answer for SMS character budget), or delegate
`go.legendoftoys.com` to Cloudflare via NS records at GoDaddy — confirm the latter is available on
LOT's plan before promising it. Moving the apex zone is not the cheap option: it touches email/DKIM and
the gh-pages targets.

⚠️ **The host must exist BEFORE the first Meta submission** — the base URL is frozen into the template
at approval, so a `workers.dev` base would be permanent. Everything in this plan is buildable and
testable on `workers.dev`; only the submission wave is gated.

---

### Task 1: `comms.links` + code generation

The code is a **capability** — it maps to one customer's cart or order. Sequential or id-derived codes
would let anyone enumerate other customers' contexts.

**Files:** create `migrations/0039_comms_links.sql`, `src/links.js`, `test/link-code.test.js`

- [ ] **Step 1:** Failing test — `newLinkCode()` returns 22 chars from `[A-Za-z0-9]`, 1000 draws are
  unique, and no draw contains a substring of any input it was given (it takes no input at all).
- [ ] **Step 2:** Implement with `crypto.getRandomValues` (available in Workers), rejection-sampled to
  avoid modulo bias.
- [ ] **Step 3:** Migration. Columns per spec — `code text PK`, `target_url text not null`, `utm jsonb`,
  `message_id uuid`, `profile_id uuid`, `channel text`, `created_at timestamptz default now()`,
  `expires_at timestamptz`, `click_count int default 0`, `first_clicked_at timestamptz`.
  RLS on, `GRANT ALL … TO service_role` only (RULE-RLS-001), and **`NOTIFY pgrst, 'reload schema';`**
  in the same migration — a table created in a schema PostgREST already caches is invisible until the
  reload, and it fails *silently* (CORE.md, cost a live round in S239).
- [ ] **Step 4:** Verify — `node test/link-code.test.js`, then confirm the table is readable through
  PostgREST, not just present in `information_schema`.

### Task 2: Resolve + redirect

**Files:** modify `src/links.js`, `src/index.js`; create `test/link-resolve.test.js`

- [ ] **Step 1:** Failing test — a known code 302s to `target_url` with its stored `utm` appended via
  the existing `appendUtm`; an unknown code, an expired code and a malformed code each 302 to
  `https://legendoftoys.com` with no error surface.
- [ ] **Step 2:** Implement `resolveLink(env, code)`.
- [ ] **Step 3:** Route `GET /r/:code` in `index.js`, **above the JWT block** with the other public
  routes (`/unsubscribe` is the model). Match on `url.pathname.startsWith('/r/')`.
- [ ] **Step 4:** Click accounting is **best-effort and off the response path** — `ctx.waitUntil`, never
  awaited before the 302. The redirect must fire even if the event write throws.
- [ ] **Step 5:** Emit `link_clicked` into `comms.events` with `{url, channel, message_id, code}`. Reuse
  that exact event name — S189 renamed it channel-agnostic precisely so SMS and WhatsApp clicks land
  where email's already do. **Never `wa_clicked`/`sms_clicked`.**

### Task 3: Prefetch filtering

Without this the click-through rate reads high and the number quietly becomes useless — worse than no
number at all.

**Files:** modify `src/links.js`; create `test/link-prefetch.test.js`

- [ ] **Step 1:** Failing test — a `HEAD` request, a known bot UA, and a hit landing <1s after the
  message's `sent_at` each **still 302** but do **not** increment `click_count` or emit `link_clicked`.
  A normal GET from a phone UA 3s later does both.
- [ ] **Step 2:** Implement `countsAsClick({method, ua, sentAt, now})` as a pure function so the rule is
  testable without a request.
- [ ] **Step 3:** Wire it into the route. Redirect first, decide countability second.

### Task 4: Minting on the send path

**Files:** modify `src/send.js`; create `test/link-mint-button.test.js`

- [ ] **Step 1:** Failing test — a template whose button carries `target_base` mints a code and the
  button parameter becomes that code; a template *without* `target_base` is byte-identical to today's
  output; a mint failure after one retry returns `{status:'failed', reason:'link_mint_failed'}`.
- [ ] **Step 2:** Implement in the WhatsApp branch, replacing the current
  `if (comp.type === 'button') continue;` skip with a redirect-backed branch. **Keep the skip for
  non-opted buttons** and keep its comment — the reasoning it records is still correct for them.
- [ ] **Step 3:** Confirm `link_base_url IS NULL` ⇒ no mint, no behaviour change, and add that as an
  explicit test case rather than relying on it.

### Task 5: Verify end to end on workers.dev

- [ ] **Step 1:** Full test suite — every `test/*.test.js`, not just the new ones. The send-path change
  touches a file with existing coverage (`send-dedup`, `test-mode-allow`, `sender-routing`).
- [ ] **Step 2:** Deploy, then `curl -sI` a real minted code against the workers.dev host and confirm a
  302 with the UTM-appended `Location`.
- [ ] **Step 3:** Confirm the `link_clicked` row landed in `comms.events`, and that a `HEAD` to the same
  code did not add a second one.
- [ ] **Step 4:** Confirm no existing template gained a `target_base` — the feature must be provably
  inert on every live journey until someone opts one in.
