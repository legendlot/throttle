# WhatsApp template for submission to Meta — `support_csat_r_01`

> ⭐ **THE TEMPLATE LIVES IN RELAY — this doc is the reasoning behind it, not the artefact.**
> `comms.templates` id **`55795b42-ea6c-451e-a45d-88e746238048`**, `status='draft'`, on the SUPPORT
> WABA `1350960337019398` (+919880212323), which is the number that will send it.
>
> **Submit it from Relay** (`/templates` → Submit, i.e. the `waSubmitTemplate` action), NOT by
> hand-typing into WhatsApp Manager. ⚠️ **An earlier version of this doc framed it as a hand-submit,
> which was wrong twice over:** Relay already owns authoring *and* Meta submission, and a template
> that exists only as prose has no `comms.templates` row — so the CSAT journey would have had no
> `templateId` to reference and could never have compiled, even after Meta approved it.
>
> ✅ **META APPROVED IT 2026-08-13**, during the same session — `approval_status='APPROVED'`,
> `provider_template_id` `1358848345840474`.
> ⚠️ **But `status` is STILL `draft`, and that is what gates the journey.** `journeys.js` `compile()`
> checks `status='active'`, **not** `approval_status`, so approval alone does not unblock anything.
> **Next step: activate it via Relay's Sync/Activate path** (not a raw `UPDATE` — same reasoning that
> kept the journey out of the DB by hand). Then the CSAT journey compiles.
> Created 2026-08-13 (S274) for the Pitstop CSAT rebuild.

---

## Submission fields

| Field | Value |
|---|---|
| **Name** | `support_csat_r_01` |
| **Category** | **UTILITY** |
| **Language** | English (`en`) |
| **Header** | *(none)* |
| **Footer** | *(none)* |
| **Buttons** | *(none)* |

### Body

```
Hi {{1}}, thanks for contacting Legend of Toys about your {{2}} query (ref {{3}}).

How would you rate the support you received? Please reply with a number from 1 to 5, where 1 is poor and 5 is excellent.

Your rating goes straight to the team that helped you.
```

### Variable samples (Meta requires a sample for each)

| Var | Meaning | Sample |
|---|---|---|
| `{{1}}` | Customer first name | `Rahul` |
| `{{2}}` | What the conversation was about — the issue category | `replacement` |
| `{{3}}` | Ticket number, else the conversation reference | `CS-04812` |

---

## Why UTILITY and not MARKETING — and why the wording is shaped this way

Meta's own template-categorization documentation lists feedback collection under **Utility**, with a
condition that decides this template's fate:

> "Collect feedback on previous orders, transactions, or engagements with customers. **Specificity of
> the order or interaction to which these relate is necessary. A general/generic survey or request for
> feedback will not be approved as utility.**"

So the category is not a free choice — it is earned by the wording:

- **`{{2}}` and `{{3}}` are the load-bearing parts.** They tie the request to one specific prior
  support interaction. Strip them and this becomes "How did we do?", which Meta explicitly names as
  the generic case that **will not** be approved as utility and is re-categorized to marketing.
- **Nothing promotional.** Meta requires a utility template to be "non-promotional, not containing any
  promotional or persuasive intent", and states that a feedback survey mixed with promotional content
  is automatically marketing. So: no discount, no product mention, no "shop again", no link.
- **No buttons.** See the correction below — quick replies cap at 3, which cannot express 1–5. Buttons
  are also where promotional intent tends to creep in.

⚠️ **If Meta re-categorizes it to MARKETING on review, do not fight it by making the copy vaguer —
that is the wrong direction.** Re-request review with `{{2}}`/`{{3}}` populated in the samples, since
the reviewer judges the sample values as much as the structure.

---

## ⚠️ Correction — quick-reply buttons cap at 3, not 5

An earlier statement in this session claimed five quick-reply buttons would fit a 1–5 scale exactly.
**That was wrong.** WhatsApp message templates allow a **maximum of 3 quick-reply buttons** (20 chars
each). A 1–5 star scale therefore cannot be captured with template buttons at all.

Options considered:

| Option | Verdict |
|---|---|
| 3 quick-reply buttons | Rejected — cannot express 1–5 without changing the agreed scale |
| Interactive **list** message (up to 10 rows) | Rejected — lists are an in-session/free-form message type, not a template; only usable for the 40.3% of closes where the 24h window is still open, so it cannot be the only path |
| **Numeric text reply (1–5)** | **Chosen** — works identically inside and outside the 24h window, needs no buttons, and keeps one capture path instead of two |

The cost is a slightly lower response rate than one-tap buttons. The benefit is that the same template
and the same parser serve every close, which matters because **59.7% of closes are outside the window**
and could not use an interactive list at all.

---

## Measured facts this template was sized against

All measured 2026-08-13 over the preceding 30 days, WhatsApp threads only:

- **4,140 conversation closes** — the send volume.
- **40.3% (1,667) still have the 24h customer-service window open at close.** Utility templates
  delivered inside an open service window are not charged, so roughly two in five CSAT sends are free.
  The remaining 59.7% are billed at the utility rate.
- **14.5% (601) of closes fall inside Relay's quiet hours** (21:00–09:00 IST): 21:00 ×142, 22:00 ×280,
  23:00 ×177, 01:00 ×2. This is **not** negligible, and it is the reason the send-purpose question
  below is a real decision rather than a formality.

---

## The separate question: Meta category ≠ Relay send purpose

These are two different switches and conflating them is the trap:

- **Meta category (`UTILITY`)** governs what Meta charges and whether the message may be sent outside
  the 24h window.
- **Relay `purpose`** governs *our own* courtesy rules. `gate.js` computes
  `isMarketing = purpose === 'marketing'`; anything else bypasses consent, frequency cap, quiet hours
  and the M9 send budget.

Applying our stricter internal rules to a message Meta considers utility is legitimate — it is us
being more conservative than required, not less. But the choice has a measured consequence:

| Relay `purpose` | Effect |
|---|---|
| `utility` | 601 customers/month are messaged between 21:00 and 01:00 IST |
| `marketing` | Requires **opted_in marketing consent**, so support customers who never opted in are never surveyed — biasing the score to the marketing-consenting subset. Also burns M9 send budget meant for campaigns and competes under the 3/day cap |
| **`service`** ✅ | Bypasses consent + frequency cap + budget, **respects quiet hours and suppression** |

⚠️ **CORRECTION to an earlier draft of this table.** It claimed `marketing` would cause those 601
quiet-hour closes to be **dropped**. That is wrong for journeys: `journey-workflow.js:321` is explicit
— *"Quiet-hours DEFER, not drop"* — so a journey send parks to the boundary and retries in the
morning. The hard-skip applies to non-journey sends. **The real argument against `marketing` is
consent, not quiet hours**, and that is what the decision now rests on.

**DECIDED (Afshaan, 2026-08-13) — `service`. SHIPPED + DEPLOYED** (commsops `78bc70b0`): bypasses
consent + frequency cap + send budget, respects quiet hours + suppression. 4 tests pin both halves,
asserting which *branches* are entered rather than what a given hour yields, since `runGate` has no
injectable clock. Exposed in the journey NodeDrawer purpose dropdown so it is UI-editable, not a
hand-written JSON field.

---

## Sources

- [Meta — Template Categorization (WhatsApp Business Platform)](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines/)
- [Meta — Template categorization (Business Messaging docs)](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [Sprinklr — WhatsApp template categories, service windows and pricing](https://www.sprinklr.com/help/articles/whatsapp-distribution/whatsapp-template-categories-service-windows-and-pricing-considerations/6a1d2685f9cf280e7e3cdf89)
- [Clickatell — Interactive buttons in message templates](https://guides.clickatell.com/whatsapp-channel/channel-capabilities/whatsapp-message-templates/use-interactive-buttons-in-message-templates)
