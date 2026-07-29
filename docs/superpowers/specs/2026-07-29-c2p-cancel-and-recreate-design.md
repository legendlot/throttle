# COD → Prepaid (C2P) — cancel-and-recreate design

> Status: **BUILT + DEPLOYED 2026-07-29 (S243)** — op `recreate_as_prepaid` is live in commsops
> (version `f40723e5`), inert behind `settings.payment_links_enabled=false` and the journey's
> draft status. Decided by Afshaan 2026-07-28 ~00:30 IST (S241).
> Supersedes the `convert_to_prepaid` (mark-as-paid) approach for the C2P journey.
> Journey `COD → Prepaid (C2P)` (`1fe1c833-9d1c-43e3-8e9f-66c39ef73929`) is still **draft** on
> the mark-as-paid shape — **re-pointing `pay_convert` to the new op is now the open step.**
>
> **Two sections are superseded by the build — read the notes inline:**
> - **§6 (the prepaid price rule) is RESOLVED**, not blocking. Settled + paisa-verified in S242:
>   `prepaid = (COD total − c2p_cod_fee) × (1 − c2p_prepaid_discount_pct/100)` = `(COD − ₹50) × 0.97`,
>   both **settings**. §6's "not a flat percentage" reasoning was drawn from a mis-paired sample
>   (₹2089.05 is the post-fee base of a *coupon* order, not the prepaid total of a ₹2199 one) — the
>   fixed ₹50 subtracted *first* is exactly what makes the effective percentage vary with order value.
> - **§3's single-shot draft flow was refined** to a 3-phase create → discount → **verify before
>   commit**. See the note in §3.

---

## 1. Why mark-as-paid is the wrong mechanism

`order_modify` op `convert_to_prepaid` calls Shopify `orderMarkAsPaid` on the **existing**
order. It works, it is built, and it is guarded to UNFULFILLED orders. It is still wrong for
C2P, for one reason that only surfaced when Pruthvi described the manual process:

**LOT charges COD and prepaid customers different prices.** Measured over 772 single-item
orders carrying `is_cod` (2026-07-23 onwards, when the property began being captured):

| Total | COD orders | Prepaid orders |
|---|---|---|
| ₹2249 | **250** | 0 |
| ₹2133.03 | 0 | **61** |
| ₹2149 | 54 | 0 |
| ₹2089.05 | 0 | 21 |

COD totals are round list prices; prepaid totals carry decimals. **The two price sets are
completely disjoint** — no COD order has ever been placed at a prepaid price or vice versa.
₹2199 → ₹2089.05 is exactly 5%, but ₹2249 → ₹2133.03 is **not** a flat 5% of the total, so the
rule is not a simple percentage on the order value (see §6, OPEN).

`orderMarkAsPaid` cannot change what the customer owes — it settles the existing ₹2249 order.
So a mark-as-paid C2P asks the customer to pay **~₹113 more** than if they had simply chosen
prepaid at checkout. That is not a weak offer, it is a negative one.

**This is why BiteSpeed cancels and recreates** (confirmed by Pruthvi 2026-07-28: *"they cancel
the original COD order, and create a new prepaid order with a tag on it (EG: C2P Converted)"*).
A new order is how you deliver the prepaid price. It is not a platform limitation.

It also matches what LOT already does manually: *"we cancel the present COD order, and place a
new one under prepaid and email the invoice."*

### The second problem it solves — post-dispatch double payment

With mark-as-paid, this sequence takes the customer's money twice:

1. Customer taps **Make Payment**, gets a link
2. Order dispatches — **28% of orders ship within 6 hours; fastest observed 0.9 h; median 16.3 h**
   (198 place→ship pairs, 80 COD)
3. Customer pays at hour 8
4. `convert_to_prepaid` hits the UNFULFILLED guard → `not_done`
5. **Cashfree has the money AND the courier still collects cash at the door**

Whether the courier would ever learn about a paid COD order is **unresolved** — Pruthvi:
*"Technically the update happens with Amazon courier partner, not sure about delhivery or
shiprocket. Never faced it."* He is asking the courier POC.

**Cancel-and-recreate makes that question moot**: the original order is cancelled outright, so
there is no stale COD amount riding on an AWB. This is a real secondary benefit of the choice,
not just a pricing fix.

---

## 2. Scope state (verified 2026-07-29 00:35 IST)

Afshaan added draft-order scopes and reinstalled. App **Relay Sync** (`relay-sync`,
apiKey `1411305e3f60a56351674961679e23b3`) now holds:

| Scope | State |
|---|---|
| `write_draft_orders` | ✅ **granted** (new) |
| `read_draft_orders` | ✅ **granted** (new) |
| `write_orders` | ✅ |
| `read_orders` / `read_all_orders` | ✅ |
| `read_customers` | ✅ |
| `read_discounts` / `write_discounts` | ✅ |
| `write_customers` | ❌ — not needed; we attach an EXISTING customer by id |

Draft orders are therefore the mechanism. `orderCreate` (which needs only `write_orders`) is
**not** required and should not be used — draft orders give explicit control over line-item
pricing, which is the whole point here.

---

## 3. Mechanism

New `order_modify` op: **`recreate_as_prepaid`**.

> **⚠️ AS BUILT (2026-07-29) the flow below was refined in three ways. The built shape is:**
> ```
> read original order  (ORDER_FOR_RECREATE_Q)
>       ↓   idempotency check FIRST (see below), then: not cancelled · UNFULFILLED · within_hours
> draftOrderCreate     replica, NO discount — tags + note ride here (draft tags carry to the order)
>       ↓              read back Shopify's OWN computed total
> draftOrderUpdate     ONE FIXED_AMOUNT order-level discount = draftTotal − prepaidAmount
>       ↓
> VERIFY               draft total == what the customer paid (±1 paisa) — else STOP + alert
> draftOrderComplete   `paymentPending` OMITTED (deprecated; default false = PAID)
>       ↓              ── commit point ──
> tagsAdd              original: relay-c2p-replaced-by-<new name>   ← BEFORE the cancel
>       ↓
> orderCancel          original: reason CUSTOMER, refund:false, restock:FALSE
> ```
> 1. **The concession is sized off the DRAFT's total, not the original's.** Shopify recomputes tax
>    and shipping on the replica, so a discount sized against the original order's total could leave
>    the final total off by that delta. Deriving it from the draft makes the arithmetic exact by
>    construction. This is why there is a `draftOrderUpdate` phase at all.
> 2. **Verify before commit.** If the draft does not total what the customer actually paid, the draft
>    is NOT completed — a wrong-priced *live* order is worse than a failed conversion, because the
>    failure path leaves the original intact and recoverable. The orphan draft is left in admin as
>    evidence and an ops alert fires.
> 3. **The idempotency tag lands BEFORE the cancel attempt**, and the tag *check* runs before the
>    `already_cancelled` guard. Both matter: a completed recreate leaves the original cancelled, so
>    checking cancelled-first would report `not_done` on a retry of a run that fully succeeded; and
>    tagging only after a successful cancel would let a retry after a *failed* cancel mint a second
>    replacement.
>
> **API shapes verified against live Shopify docs, not assumed** — several differ from what a
> reasonable guess would use: `priceOverride` (not `originalUnitPrice`), `purchasingEntity` (not the
> deprecated top-level `customerId`), `priceWithCurrency` (not `price`), `countryCode`/`provinceCode`
> (not `country`/`province`), and `paymentPending` is deprecated so it is omitted entirely.

```
read original order  (ORDER_FOR_RECREATE_Q)
      ↓   guards: not cancelled · UNFULFILLED · not already recreated
draftOrderCreate     line items + customer + both addresses + shipping + prepaid price
      ↓
draftOrderComplete   paymentPending:false  → a real, PAID order
      ↓
tagsAdd              new order:  relay-c2p-converted, relay-c2p-from-<original name>
      ↓
orderCancel          original: reason CUSTOMER, refund:false, restock:FALSE
      ↓
tagsAdd              original:   relay-c2p-replaced-by-<new name>
```

**`restock: false` on the cancel is load-bearing.** The replacement order holds the same units;
restocking the original would double the inventory back and oversell. This differs from the
existing `cancel` op (which uses `restock: true` and is correct for a genuine cancellation).

### Ordering: cancel LAST, and never before the new order exists

The new order must be created and confirmed paid **before** the original is cancelled. If the
draft fails halfway we are left with the original COD order intact — the customer has paid and
we owe them a manual fix, which is recoverable. The reverse order risks cancelling the original
and then failing to create the replacement: the customer has paid and has **no order at all**.

`draftOrderComplete` returning a real order id is the commit point.

### Idempotency

The Workflow memoizes `step.do(stepId)`, so a durable retry will not re-run the action. Belt
and braces anyway: before creating, check the original for a `relay-c2p-replaced-by-*` tag and
return `{outcome:'done', already_recreated:true}` if present. Creating a second replacement
order is the worst failure this action can produce.

---

## 4. Journey shape changes

The draft journey (17 steps) needs three edits, all inside the **Make Payment** branch:

| Step | Today | Becomes |
|---|---|---|
| `pay_link` | amount = order total (COD price) | amount = **prepaid price** (§6) |
| `pay_wait` | `within: 24 hours` | **`2 hours`** — 28% of orders ship inside 6h |
| `pay_convert` | `op: convert_to_prepaid` | **`op: recreate_as_prepaid`** |

Also agreed with Pruthvi, outside this branch:

| Step | Today | Becomes | Why |
|---|---|---|---|
| `ask` | `within: 24 hours` | **2–3 hours** | same-day dispatch |
| `cancel_ask` | `within: 6 hours` | **2 hours** | his call, no risk either way |

`pay_notdone_msg` must stop being reassuring. It currently reads *"Payment received — thank
you! Our team will confirm the update on your order shortly."* If recreation fails, the
customer has paid and the order is still COD. It must say plainly **not to pay the courier**,
and the original order must be tagged `relay-c2p-paid-not-recreated` so CS can find it. A
window narrows this risk; only the message and the tag handle it when it lands.

### Silent expiry

`within` expiring routes to `no_reply` and ends the enrolment. A customer tapping a button
afterwards gets **no response at all** — the reply event arrives with no parked enrolment.
Pruthvi asked for exactly this behaviour ("disable the option"), but silence reads as broken.
Consider a catch-all: a `whatsapp_reply` journey that answers expired taps with "that link has
expired, reply here and we'll help". Not v1.

---

## 5. Failure modes to route explicitly

The engine makes every action handle a compile error if unrouted, which is the forcing function
that surfaced these:

| Failure | Outcome | Customer sees |
|---|---|---|
| Order already fulfilled at pay time | `not_done` | "payment received, do NOT pay the courier, we're fixing this" + tag |
| `draftOrderCreate` fails | `not_done` | same |
| `draftOrderComplete` fails | `not_done` | same — original still intact |
| `orderCancel` fails AFTER new order created | `done` + alert | normal confirmation; **duplicate live orders** — must alert ops loudly |
| Original already cancelled | `not_done` | "this order is already cancelled" |
| Pay-link mint fails | `failed` | "order stays COD, our team will call" |

The `orderCancel`-fails-after-create case is the only one that leaves LOT worse off than doing
nothing (two live orders for one purchase). It needs an ops alert, not just a `not_done`.

---

## 6. ~~⛔ OPEN~~ ✅ RESOLVED (S242, 2026-07-29) — the prepaid price rule

> **This section is kept for its reasoning trail; its conclusion was WRONG and it no longer blocks
> anything.** The rule is `prepaid = (COD total − c2p_cod_fee) × (1 − c2p_prepaid_discount_pct/100)`
> — `(COD − ₹50) × 0.97` — with both values as **`comms.settings`** so a pricing change never needs a
> deploy. Confirmed by Afshaan + Pruthvi and verified to the paisa on 5 live cases (2249→2133.03,
> 2139.05→2026.38 coupon, 2049→1939.03, 2299→2181.53 two-item, 2186.55→2072.45). The ₹50 is **per
> order** and applied **before** the 3%, so a coupon carries through automatically and no coupon or
> `read_discounts` lookup is needed. It is a Shopify-side arithmetic rule, not a Shopflo secret.
>
> **Why the analysis below reached the wrong answer, worth remembering:** it compared ₹2199→₹2089.05
> against ₹2249→₹2133.03 and concluded "not a flat percentage". But ₹2089.05 is the *post-fee base* of
> a **coupon** order, not the prepaid total of a ₹2199 order — the pairs were not comparable. And a
> fixed ₹50 subtracted before a percentage *necessarily* makes the effective percentage vary with
> order value, which is precisely the pattern that looked like "no rule". The 12-different-prices
> observation was the spread across **coupon users**. Lesson: look at the no-coupon price before
> declaring a rule absent.

**~~This blocks the build and nothing else does.~~** We do not know how the prepaid price is
derived, and getting it wrong charges real customers the wrong amount.

Evidence it is not a flat percentage of the total: ₹2199 → ₹2089.05 is exactly 5%, but
₹2249 → ₹2133.03 is 5.16%. Possibly a percentage applied pre-GST, or a per-line discount, or a
COD surcharge on the COD side rather than a discount on the prepaid side.

**Hypothesis: the discount is applied by Shopflo at checkout, not by Shopify.** Pruthvi's
phrasing — *"an invoice, which does not discount as prepaid does"* — points that way. If so,
`read_discounts` on Shopify will not reveal it and we would be replicating a third party's
pricing rule.

**Ask Pruthvi:** is the prepaid discount a Shopflo checkout rule or a Shopify automatic
discount / price rule? If Shopify, read it via `read_discounts` and apply the same rule. If
Shopflo, we need their exact rule in writing, and a plan for what happens when they change it.

Until answered, `pay_link` cannot mint a correct amount and the journey cannot be activated
even behind the test filter — the test would validate the wrong price.

---

## 7. Test plan (unchanged from the S241 sandbox)

Test product: **L.O.T Spare Parts — Set of 4 Drift/Grip Tyres (Ghost)**, handle
`set-of-4-tyres-for-ghost-rc-drift-car`. Only **Grip Tyres** has stock.

- variant `47424955744308` (`lotsp-griptyres-ghost`) — ₹249, **1 in stock**
- variant `47424955777076` (`lotsp-drifttyres-ghost`) — 0 stock, unusable

Journey trigger filter: `is_cod = true` **AND** `variant_ids = 47424955744308`. Both must
match, so only COD orders of that one variant enrol. 10 units sold in 90 days, and it is hidden
in the spares dropdown, so a real customer landing in the test is close to impossible.

**Order only the tyres** — `variant_ids` is the whole order's comma-joined list, so any second
item breaks the equality.

Phases:
1. `payment_links_enabled = false` — proves template, buttons, branching, the free-text confirm
   and the cancel double-check. No money, no Shopify writes (`recreate_as_prepaid` returns
   `not_done` behind the same gate).
2. Flip `payment_links_enabled` — full end-to-end: real ₹249 pay-link, real recreation, real
   cancellation. **Verify the replacement order's price, tags, line items, addresses and that
   the original is cancelled without restocking.**
3. Remove the `variant_ids` row to go wide. Keep `is_cod`.

**Stock is 1.** Each test consumes it; cancelling the replacement must restock manually before
the next run (the C2P cancel path uses `restock:false` by design).

---

## 8. Also decided / carried

- **Order Placed must be filtered to `is_cod = false`** when C2P goes wide, or COD customers get
  both "your order is confirmed and in motion" and "your order is pending confirmation". Split is
  **59% COD / 41% prepaid**, so this cuts Order Placed volume by roughly six in ten — correct, but
  it will look alarming in the numbers if nobody expects it.
- Filtering Order Placed makes it **fail closed**: if `is_cod` ever stops being populated, both
  journeys go silent at once. `is_cod` has only existed since 2026-07-23.
- Trigger filters are **case-sensitive** (`ingest.js` string `===`) while the condition node
  lowercases both sides. `True` silently matches nothing in a filter. Worth unifying.
