# Relay A/B testing — design (S272, 2026-08-11)

> Status: **DESIGN, approved in conversation — not yet planned or built.**
> Author: Afshaan + Claude, 2026-08-11. Supersedes the `[relay] [build] [MED]` "A/B testing does
> not exist" backlog item, which stays open until this ships and which this spec corrects in two
> places (see §12).
>
> **Revision 2, same day — after a hostile review.** The primary metric was reversed from
> read÷delivered to read÷**sent** (§6), because conditioning on delivery is post-treatment
> conditioning and Meta's `wa_131049` block rate varies 26–39% across templates. Five further
> holes were closed: the variants read must throw rather than silently degrade to all-arm-A (§5),
> templates freeze alongside variants (§10.3), a Meta status change mid-flight pauses the campaign
> (§10.4), test sends target a named arm (§10.5), and recording a learning snapshots the verdict
> (§8.3). Details of what was wrong and why are kept inline rather than tidied away.

---

## 1. What this is for

A marketer writes a campaign and has no way to know whether a different framing would have done
better. Today a campaign is one template, one audience, one send, and the only feedback is an
aggregate number with nothing to compare it against.

This adds the ability to send two versions of the same campaign to a randomly split audience and
be told, honestly, which did better — **or that the result is not trustworthy**, which is the
harder and more important half.

**The decision it serves:** "which way of writing this should we use next time?"

---

## 2. Scope

**In:**
- N-arm variant model (UI exposes 2), weighted, per campaign.
- Deterministic random assignment at fan-out.
- Read-rate measurement per arm on WhatsApp, with a significance verdict.
- Setup-time power guardrail, pre-flight comparability checks, and refusal states.
- Full self-serve UI: setup, in-flight, results, experiment log.
- A Relay System Manual (Relay has none today) with an A/B chapter.

**Out, deliberately:**
- Auto-select-winner and its scheduler — separately priced, needs a decision step and a definition
  of "winning" that survives being automated.
- Holdout arms — the seam exists (`template_id` nullable) but nothing is built. A holdout is only
  meaningful against purchase data, which means order attribution, not message metrics.
- Click-based winners — blocked on recipient links for campaigns, which is blocked on the Meta
  button re-approval wave. See §12.
- Email tests — blocked on Resend open tracking (0 `email_opened` events ever recorded).
- More than 2 arms in the UI.

---

## 3. Decisions taken, and why

| Decision | Choice | Why |
|---|---|---|
| First test | Message copy, judged on read rate | The only metric with zero prerequisites — WA read tracking is already live and already flowing. |
| Test shape | 50/50 across the whole audience | Simplest engine: bucket and send, no scheduler, no decision step. Both arms mature over the same window, so the comparison is fair by construction. The cost is only the delta on half the list, not the send. |
| Winner calling | Guardrail at setup **and** honest verdict after | The failure this feature most easily creates is a confident number nobody should act on. On a 244-person send, 57% vs 62% is indistinguishable from chance and looks like a win. |
| Arms | N in the model, 2 in the UI | A variants table costs the same to build for 2 or N. Bolting N on later is a migration. |
| Assignment | Deterministic hash, not a materialised table | Stateless, replay-safe, and no population-sized write in a path that is keyset-paginated precisely to avoid one. |

---

## 4. Data model

### `comms.campaign_variants` (new)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `campaign_id` | uuid NOT NULL | → `campaigns(id)` ON DELETE CASCADE |
| `label` | text NOT NULL | 'A', 'B', … — UNIQUE `(campaign_id, label)` |
| `template_id` | uuid NULL | → `templates(id)`. **NULL = holdout arm** (future; nothing reads it yet) |
| `weight` | int NOT NULL DEFAULT 50 | CHECK `weight > 0` |
| `sort_order` | int NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz DEFAULT now() | |

RLS enabled, `service_role` only (RULE-RLS-001). The migration must `NOTIFY pgrst, 'reload schema'`
— a table added to an already-exposed schema is invisible to PostgREST until the cache reloads, and
it fails **silently** as a not-found (CORE.md; cost a debugging round in S239).

### `comms.messages` gains `variant_id uuid NULL`

→ `campaign_variants(id)`, **`ON DELETE NO ACTION`** — matching the house pattern
(`messages_template_id_fkey` and `messages_sender_identity_id_fkey` are both NO ACTION; only
`profile_id` is SET NULL, because a profile can be erased on request and a message log cannot).
Nullable: every existing message and every non-campaign send has none. No backfill.

⚠️ **That FK rule collides with the CASCADE above, deliberately.** `campaign_variants.campaign_id`
cascades from `campaigns`, so deleting a campaign tries to delete its variants — and NO ACTION on
`messages.variant_id` then blocks it. **This is the correct outcome** (you must not be able to erase
the record of what was sent to whom) **but it surfaces as a raw FK violation.** The worker must
catch it on campaign delete and return a named error — *"this campaign has sent messages and cannot
be deleted"* — rather than leaking a 23503 to the UI.

**It is written on every outcome, not just sends** — `finalize()` already writes a `messages` row
for skipped/suppressed/failed, so the variant rides along. That is what makes §7's asymmetry checks
and §8's assigned-vs-delivered funnel possible at all.

### `comms.campaign_experiments` (new)

> ⚠️ **Added while planning — §8 described this data with nowhere to put it.** The hypothesis, the
> pre-committed read time, the recorded learning and the verdict snapshot are all referenced by the
> UI sections and none of them had a home in the data model.

| column | type | notes |
|---|---|---|
| `campaign_id` | uuid PK | → `campaigns(id)` ON DELETE CASCADE. One experiment per campaign. |
| `hypothesis` | text NULL | "what is the one thing that differs between A and B?" (§8.1) |
| `planned_read_at` | timestamptz NULL | the pre-committed read time; drives the peeking guard |
| `learning` | text NULL | free-text conclusion (§8.3) |
| `verdict_snapshot` | jsonb NULL | the full stats payload **as it stood when the learning was recorded** |
| `decided_at` / `decided_by` | timestamptz / uuid NULL | who called it and when |

RLS on, `service_role` only. A row is created when the second variant is added.

### `campaigns` — unchanged

`campaigns.template_id` stays required and **is arm A's template**. Adding a B auto-creates the A
row pointing at the existing `template_id`. So there is always exactly one row per arm, `template_id`
is A's by construction, and the 12 existing campaigns keep working as zero-variant single-arm sends.

> ⚠️ Deliberately NOT modelled as "variants override an ignored `campaigns.template_id`". A
> required-but-ignored field is precisely the kind of state that drifts and then gets "fixed" wrong.

---

## 5. Assignment

In `campaigns.js` `processQueueMessage`, per recipient, immediately before `send()`:

```
h      = fnv1a(`${campaignId}:${profileId}`)   // pure, synchronous, unit-testable
bucket = h % Σweights
arm    = first variant whose cumulative weight exceeds bucket
```

Then `send({ …, templateId: arm.template_id, variantId: arm.id })`. `dedup_key` stays
`campaign:<id>:<profile>` — unchanged, so a replay is still suppressed and would land on the same
arm anyway.

Three properties, all load-bearing:

1. **The hash is salted with `campaign_id`.** Hashing `profile_id` alone puts the same people in
   arm A of every campaign forever — one cohort would only ever see one style of copy, and every
   future test inherits that bias. This is the single genuine footgun in the approach.
2. **Assignment is per-recipient inside the existing pages — never "all of A, then all of B".**
   Fan-out is serial at ~1,200/hr, so sending arm B second pushes it hours later in the day. Read
   rate varies by hour, so that test would measure time-of-day, not copy.
3. **A partial send stays analysable.** Assignment is independent of the keyset order, so a
   cancelled or stalled campaign's sent prefix is still split to the configured weights.
   ⚠️ Do not "improve" this into a pre-assigned table — that property is why it is a hash.

### The variants read must THROW on failure, never fall back

`processQueueMessage` reads the campaign's variants once per page. **If that read fails it must
throw**, so Queues redeliver the page and it eventually DLQs with an alert.

⚠️ **The tempting alternative silently destroys the experiment.** A failed read returning `[]`
falls through to "no variants → send `campaigns.template_id`" — i.e. **arm A for everyone** — so a
transient 5xx thirty minutes into a fan-out produces a campaign that is half a clean A/B and half
all-A, with nothing in the data saying where the boundary was. The verdict computed off that is
garbage that looks fine.

This is the same rule and the same reasoning as the existing `campaign_recipients` guard directly
above it in the same function (*"An RPC failure is NOT fan-out complete (review C2)"*). Follow the
established pattern rather than inventing a softer one.

**Cost note:** one variants read per page. At `SENDS_PER_MSG = 4` a 4,255-person campaign is ~1,064
pages, so ~1,064 extra reads — proportionally minor next to the `getCampaign` and
`campaign_recipients` reads already on that path, and it shrinks directly with the open item to
raise `SENDS_PER_MSG` to ~8. Do not cache variants in the queue message body: they are frozen at
`approved` (§10.1) so staleness is not the risk, but an in-flight message body that predates a
re-approval would be.

---

## 6. Measurement

### The primary metric is read ÷ **sent**, not read ÷ delivered

> ⚠️ **This reverses an earlier decision in this design, and the reversal matters.** The first draft
> used delivered as the denominator, on the reasoning that someone on an undeliverable number never
> had a chance to read. That reasoning is wrong in a way that is easy to miss: **delivery happens
> AFTER the treatment is applied, so conditioning on it is post-treatment conditioning** — the
> classic collider. If the copy itself affects whether Meta delivers, then comparing read-rates
> *among the delivered* compares two differently-filtered populations and can invent a winner.

The mechanism is concrete, not hypothetical. Meta's `wa_131049` ("not delivered to maintain healthy
ecosystem engagement") is a per-recipient pacing block, and measured 2026-08-11 across WhatsApp
marketing conditioned on **provider attempts** (i.e. excluding gate skips, which would otherwise
swamp it):

| template | provider attempts | blocked 131049 | delivered |
|---|---|---|---|
| `atc_cart_abandonment_v2` | 189 | 38.6% | 52.9% |
| Browse Abandonment v2 (redirect) | 759 | 32.9% | 63.5% |
| Browse Abandonment v2 | 1,142 | 30.2% | 64.9% |
| Abandoned Cart v3 | 2,808 | 28.5% | 66.7% |
| Abandoned Cart v3 (redirect) | 1,034 | 27.9% | 67.3% |
| `Roxie Launch_Mishica` | 246 | 26.4% | 69.5% |
| `atc_cart_abandonment_v2` (redirect) | 214 | 26.2% | 65.4% |

A 12pp spread in block rate. **This does not prove content drives it** — these templates also have
different audiences, and the spread is at least as consistent with recipient-level marketing
frequency as with copy. But it is more than enough to stop us conditioning on delivery.

So:

- **Primary: read ÷ sent (intention-to-treat).** Immune to the problem by construction — random
  assignment equalises bad numbers and pacing-prone recipients across arms *in expectation*, so any
  difference is attributable to the treatment. This is the number the verdict is computed on.
- **Secondary, diagnostic: read ÷ delivered.** Shown, clearly labelled as such, because it is what
  a marketer intuitively wants and it is informative when delivery is balanced.
- **Third, and new: delivery rate per arm, tested with the same z-test.** If it differs
  significantly, the results screen says so and marks read÷delivered untrustworthy for that test.

⚠️ **A side effect worth naming: this makes the A/B feature the instrument that finally settles
whether `wa_131049` is content-sensitive.** Nobody currently knows, because in every existing send
content and audience vary together. Inside an A/B the audience is randomised, so a significant
per-arm delivery difference is clean evidence. Log those results in the experiment log (§8.4).

**RPC `comms.campaign_variant_stats(p_campaign_id)`** returns, per arm: assigned / sent / delivered
/ read / failure count / skip count by reason / cost. **Aggregation only — no statistics.**
`campaign_stats_list` itself is untouched: no regression risk to existing campaign analytics.

**The statistics live in a pure worker module (`src/ab-stats.js`), not in SQL.**

> ⚠️ **Revised while planning — the first draft put the maths in SQL** "so the UI cannot compute a
> second, different answer". That property is worth keeping, but SQL was the wrong place to get it:
> this repo has **no SQL test harness** (all 55 test files are `node test/*.test.js`), so a z-test
> in PL/pgSQL would be the single most correctness-critical code in the feature and the only part
> with no tests. The single-source property is preserved anyway, because **the apps never query the
> DB directly** — they go through the worker (`workerFetch`), so one module computing the verdict
> is one answer. The UI renders; it never does arithmetic.

**Verdict — two-proportion z-test**, pooled, two-sided 95%:

```
p̄ = (r₁+r₂)/(n₁+n₂)
z  = (p₁−p₂) / √( p̄(1−p̄)(1/n₁ + 1/n₂) )
|z| > 1.96 → a winner; otherwise "too close to call"
```

**Setup guardrail — minimum detectable effect:**

```
MDE ≈ 2.8 · √( 2·p̄(1−p̄) / n_sent_per_arm )        p̄ = read ÷ sent
```

⚠️ **On `n_sent_per_arm`, not delivered — which is a real simplification, not just a consequence.**
Because the primary metric is now ITT, the setup guardrail no longer needs a delivery-rate
assumption at all: sent-per-arm is just `reachable ÷ arms`, which is known at setup. The earlier
draft had to guess a 69.7% delivery rate to state the guardrail, and that guess was itself drawn
from 244 messages.

Measured baselines, 2026-08-11, **stated with denominators because they differ a lot**:

| population | sent | delivery | read ÷ delivered | **read ÷ sent (ITT)** |
|---|---|---|---|---|
| campaign (broadcast) | **244** | 69.7% | 57.1% | **≈39.8%** |
| journey (triggered) | 6,095 | 65.5% | 72.8% | ≈47.7% |

Use the **broadcast** row — journey sends are behaviourally triggered and read more, so they are
the wrong reference for a campaign. It rests on one 244-person campaign and will firm up.

**ITT is also better powered, not just less biased**: n per arm is the full sent count rather than
the ~70% that were delivered, and that gain outweighs p̄ sitting nearer 0.5.

The curve at p̄ ≈ 0.40 — the numbers the §8.1 UI thresholds are set from:

| sent per arm | detectable difference |
|---|---|
| 2,127 (Roxie split 50/50) | ~4.2pp |
| 1,480 | ~5.0pp |
| 800 | ~6.9pp |
| 400 | ~9.7pp |
| < 400 | not worth running |

⚠️ **The guardrail is robust to the thin baseline:** across p̄ = 0.40 → 0.57 the MDE at n=800 moves
only 6.9 → 6.9pp (p̄ nearer 0.5 raises variance, but only slightly over this range). Quote it as
"about 7 points at 800 per arm". Recompute p̄ as real campaigns land; do not hardcode it.

Typical copy effects are 2–5pp, so anything under ~800 per arm can only catch an unusually large
difference, and under ~400 it is close to a coin toss.

**Maturity, not a scheduler.** Read latency on 3,009 WA marketing messages: **p50 31 min, p80 3.6 h,
p95 39 h.** A result younger than ~4h is labelled *still maturing*. Cheap, and it stops a winner
being called at minute 20.

---

## 7. Refusal states — when the system declines to name a winner

Each is a distinct, named state with its own plain-English explanation, not a generic error.

| State | Condition | Why it refuses |
|---|---|---|
| **Underpowered** | observed gap < MDE for the achieved n | The difference is smaller than this audience can resolve. |
| **Too close to call** | \|z\| ≤ 1.96 | The gap is within chance. |
| **Still maturing** | < **4h** since the campaign reached `sent` (p80 = 3.6h, rounded up) | 20% of reads arrive after 3.6h; the arms may not have matured equally yet. |
| **Asymmetric failures** | the same two-proportion z-test, run on **failure+skip rate** per arm, is itself significant (\|z\| > 1.96) | See below — this one is not a shrunken sample, it is a *biased* one. |
| **Not a test** | < 2 variants | The campaign sent normally; there is nothing to compare. |

### Asymmetric failures, in full

If arm B's template references a variable arm A's does not, B fails for every profile missing that
field — so B's *surviving delivered* population is systematically different from A's (everyone
without a `first_name`, say). That is confounding, not noise, and it produces a plausible,
completely wrong winner.

Two defences:

- **Pre-send:** a variables diff between arms, blocking. Both templates must resolve against the
  same variable set. There is precedent — the `order_placed_wa_r_01` bind ran exactly this diff
  before going live (S265).
- **Post-send:** the verdict refuses when per-arm failure rates diverge, and the results screen
  shows the per-arm failure and skip breakdown by reason rather than only the totals.

---

## 8. UI — every decision surface, in the app

**Design constraint (Afshaan, 2026-08-11): the team must run this end to end without Claude.**
Anything a person needs in order to decide something is a surface in Relay, not a query someone
has to ask for.

`campaigns/page.js` is already **742 lines**; adding setup and results inline would push it past
1,100. Split it — the repo's own convention:

```
campaigns/
  page.js                     (list + existing detail shell, slimmed)
  VariantSetup.js             (arms, weights, template pick, pre-flight checks)
  VariantResults.js           (funnel, verdict, per-arm breakdown)
  VariantProgress.js          (in-flight, per-arm)
  useVariantStats.js          (single read of campaign_variant_stats)
experiments/
  page.js                     (cross-campaign experiment log)
```

### 8.1 Setup — "should I test, and are my arms comparable?"

- **Add a B version** → pick a second template. A only ever mirrors `campaigns.template_id`.
- **Power line, live as the segment changes:** *"~2,127 per arm — you can detect a difference of
  about 4 points. Smaller than that will not be distinguishable."* Thresholds from the §6 curve, so
  the colour means something specific:
  **green** ≥ 800 **sent**/arm (≤ ~7pp) · **amber** 400–800 (*"only a large difference will show
  up"*) · **red** < 400 (*"this audience cannot answer the question — send it as a normal campaign"*).
  Red does not block: it is the marketer's call, and stating the consequence plainly is the job.
  ⚠️ **Sent per arm, not delivered** — a direct consequence of the ITT switch in §6, and it is what
  lets this line be computed at setup from `reachable ÷ arms` with no delivery-rate guess in it.
- **Pre-flight checklist, each item pass/fail with the fix, blocking where it must be:**
  - both templates Meta-approved (`approval_status`) — *blocking*
  - variables diff clean between arms — *blocking* (§7)
  - same channel and purpose — *blocking*
  - estimated send duration vs quiet hours — *warning*: *"~3.5h at the current rate; starting after
    17:30 IST risks the tail being cut at 21:00."*
- **One-variable nudge:** a single prompt — *"What is the one thing that differs between A and B?"*
  — stored as the experiment's hypothesis and shown on the results screen. Not enforceable
  mechanically; the prompt is the intervention.
- **Pre-commit the read time:** *"Check back after ~4h"*, recorded. Feeds the peeking guard.

### 8.2 In-flight — "is it running properly?"

Per-arm progress (assigned / sent / delivered so far), a **variants are frozen** notice with the
reason, and a live skip/failure count per arm so an asymmetry is visible while it is happening
rather than at the end.

### 8.3 Results — "who won, and can I trust it?"

- **Verdict banner first**, in plain English: *"B won — 62.1% vs 57.4%, and that gap is larger than
  chance would produce (p < 0.05)."* Or a refusal from §7, stating which one and what to do about
  it.
- **Per-arm funnel:** assigned → sent → delivered → read, with rates, and **the primary
  (read ÷ sent) visually distinguished from the diagnostic (read ÷ delivered)** so nobody reads the
  wrong one as the answer. The funnel, not just the read
  rate, is what makes quiet-hours truncation and failure asymmetry legible.
- **Skips and failures by reason, per arm.**
- **Cost per arm** — and a line stating there is no cost *delta*: two arms send the same total
  messages as one. Preempts the obvious question.
- **Maturity indicator** with its basis, and the peeking guard: *"you planned to read this at 14:20;
  it is 11:05 and 20% of reads have not arrived."*
- **Inline caveats where the number is, not in a footnote:** read receipts can be switched off by
  the recipient, so read rate is a **floor**, not "% who read it".
- **"Record what we learned"** — a short free-text conclusion saved against the experiment. This is
  what stops the result evaporating the moment the tab closes.
  ⚠️ **Recording the learning SNAPSHOTS the verdict and its numbers onto the experiment row.**
  Without this the verdict is recomputed on every page view forever, so late-arriving reads (5% land
  after 39h) can flip it *after* someone wrote down "B won" and acted on it — leaving the log and
  the live screen permanently contradicting each other, with no way to tell which was ever true.
  The snapshot is the record of what was decided and when; the live figure stays visible beside it,
  and a divergence is shown rather than hidden, because "the numbers moved after we called it" is
  itself worth knowing.

### 8.4 Experiment log — "what have we already tried?"

A cross-campaign list at `/experiments`: hypothesis, arms, audience, verdict, the recorded
learning. Without it every test is run in isolation and the team re-runs the same question in six
months. **This is the surface that makes the feature institutional rather than personal**, and it is
the main thing standing between "we have A/B testing" and "we know what works".

### 8.5 Permissions

`campaign_build` to create/edit variants · `relay_view` to read results and the experiment log ·
`approve` unchanged and now explicitly covers the arms (§10).

---

## 9. Self-serve: the Relay System Manual

**Relay is the only internal LOT app with no System Manual.** Garage, Redline, Ignition, Pitstop,
Podium, Snorkel, Docket and Throttle all have one (CORE.md §In-app System Manuals); Relay has no
`docs/manual/`, no generated `src/data/manual.json`, no nav entry.

Given the stated constraint, that gap is now load-bearing: A/B testing is the most statistically
subtle feature in the fleet and the easiest to misread by someone who was not in this conversation.

Scope here:
- Stand up the standard scaffold — `apps/relay/docs/manual/` (`manual.json` → `content/*.html` →
  `build.py`), `scripts/build-manual-web.py relay`, the shared `<Manual>` viewer, and the flat nav
  entry before the admin group. The pattern is well-trodden; this is assembly, not invention.
- Write the **A/B chapter**: what a test can and cannot tell you, how to read a refusal, why read
  rate is a floor, why not to peek, and the worked Roxie example.
- Seed the other chapters as stubs mapped to the existing routes, so the manual exists and can be
  filled in as features settle rather than blocking this work.

⚠️ Per CORE.md, the generated `src/data/manual.json` and the PDF **must be committed** — CI only
runs `next build`.

---

## 10. Invariants and error handling

1. **Variants freeze at `approved`, not at `sending`.** Between `approved` and `sending` a variant
   could otherwise be added that nobody approved — the approval was granted against arm A alone.
   Adding or editing a variant returns the campaign to `draft`/`pending_approval`.
   ⚠️ Without this the feature is a way around the approval gate.
2. **Mid-flight edits rejected** once `sending`: re-weighting after some recipients are assigned
   makes the arms incomparable.
3. **The arms' TEMPLATES are frozen too, not just the variant rows.** Freezing weights while
   leaving template content editable is a half-measure: `messages.template_version` is stamped per
   send, so editing an arm's template at page 500 of 1,064 splits that arm across two versions and
   the "arm" stops being one thing. Block edits to any template bound to a campaign in `approved`
   or `sending`. `comms.template_versions` (S241) already archives versions, so the results screen
   can state which version each arm ran — and if a mid-send edit ever does occur, the per-arm stats
   must surface the version split rather than silently averaging across it.
4. **A Meta-side template status change mid-flight pauses the campaign.** `wa-webhooks.js` already
   receives `message_template_status_update` and alerts on REJECTED/DISABLED/PAUSED. If that lands
   for a template bound to a `sending` campaign, pause the campaign rather than letting one arm
   fail its way to the end — an arm that Meta disabled halfway produces exactly the asymmetric,
   biased sample §7 exists to refuse.
5. **Test sends target ONE named arm.** `sendCampaignTest` currently uses `campaigns.template_id`,
   which would silently only ever preview arm A. It takes a `variant_id`, and the UI offers *"send
   test of A"* / *"send test of B"* separately, because the whole point of the test send is seeing
   the thing on a real handset and the arms differ. Test sends keep `source='campaign_test:<id>'`
   so they stay out of the campaign's stats, and therefore out of the experiment.
6. **`startCampaign` refuses before any send** if any arm's template is missing or not
   Meta-approved, naming the arm. This also closes the open F10 gap for the variant path.
7. **< 2 variants = a normal campaign.** A half-built test sends correctly and the results screen
   simply does not claim a test happened.
8. **Zero-variant campaigns** (the 12 existing ones) must return cleanly from
   `campaign_variant_stats` as a single arm.
9. Weights are all > 0; Σ > 0.

---

## 11. Testing

Pure unit tests, matching the repo's harness (`node test/*.test.js`, exit-code driven).

**`pickVariant`:** distribution over 10k uuids within tolerance of the weights · determinism across
repeat calls · **campaign salt genuinely re-shuffles** · 80/20 respected · single variant always
wins · zero variants → null.

⚠️ **State the salt assertion precisely, or it will be written wrong.** Running the same 10k
profiles against two different `campaign_id`s, the share landing in the *same* arm both times must
be **≈50% (say 45–55%), not ≈0%** — two independent 50/50 splits agree half the time by chance.
Asserting "different assignment" naively would demand ~0% overlap, which is not re-shuffling, it is
anti-correlation, and the test would fail against correct code. This is the footgun in §5.1, so it
gets its own explicit test.

**Statistics:** equal rates → too close · large gap + large n → winner · **large gap + tiny n →
still too close** (the 244-person trap, the whole point of the guardrail) · known n → known MDE ·
asymmetric failure rates → refusal, not a verdict.

**Integration-ish:** a zero-variant campaign is byte-identical to today's behaviour.

---

## 12. Known limitations — write these into the manual, not just here

1. **Read rate can crown the wrong winner.** It measures whether someone opened it, not whether it
   sold anything. Optimising it selects for curiosity-gap copy — and the nominated first test is
   literally "curiosity vs plain". A winner here is a winner *on opens*, and should not be
   generalised into "this copy sells better". **This raises the Meta button re-approval wave from a
   nice-to-have to the thing that makes A/B trustworthy**, because it is what unlocks click-based
   winners.
2. **Read receipts are recipient-controlled.** If they are off, `read_at` never arrives however
   carefully the message was read. Random assignment spreads this evenly so the comparison holds,
   but 57%/72% are floors and must never be quoted as "% who read it".
3. **Peeking inflates false positives.** Refreshing until significance is crossed will find a
   "winner" in a coin toss. Hence the pre-committed read time and the guard.
4. **Baselines are thin** — 244 broadcast sends. The MDE is robust across the plausible range
   (§6), but recompute rather than hardcode.
5. **Throughput bounds test size, not this build.** 4k is ~3.5h at the observed rate; a 77k list
   would be ~64h. That is the open `[relay] [build] [P1]` throughput item's problem, but it caps
   how large a test can realistically be.

### Corrections to the existing backlog item

- It says the two measurement fixes **must** land first or the engine produces a number nobody
  should act on. That is true for **clicks and for all of email**, and **not** for WhatsApp read
  rate, which is already live and already measured. **This has no blocking prerequisites.**
- It proposes "the variant stamped on `messages`" as a new column, and separately it is tempting to
  note that `messages.template_id` already records the arm for free. That shortcut holds **only
  while arms differ by template** and breaks the moment an arm varies something else — send time
  being the obvious candidate. Hence an explicit `variant_id`.

---

## 13. Sequencing

1. Migration: `campaign_variants` + `messages.variant_id` + `NOTIFY pgrst`.
2. `pickVariant` + tests (pure, no integration).
3. Fan-out wiring + `variant_id` through `send`/`finalize`.
4. `campaign_variant_stats` RPC + statistics tests.
5. Worker actions: variant CRUD, approval freeze, `startCampaign` guards.
6. UI: setup + pre-flight → in-flight → results → experiment log.
7. Relay manual scaffold + A/B chapter.

Steps 1–4 are shippable and inert — nothing changes for a zero-variant campaign — so they can land
before any UI exists.

⚠️ **Step 7 is separable and should probably be its own plan.** Standing up the Relay manual
scaffold is the standard fleet pattern applied to a new app (build script, shared viewer, nav
entry, committed `manual.json` + PDF) and is not A/B-specific — it happens to be pulled in here
because the self-serve requirement exposed that Relay is the only app without one. If it is split
out, **the A/B chapter still has to land somewhere**: either the manual ships first and this feature
writes into it, or the chapter's content lives as inline UI guidance until the manual exists. What
must not happen is the chapter being dropped because the scaffold moved to another plan.
