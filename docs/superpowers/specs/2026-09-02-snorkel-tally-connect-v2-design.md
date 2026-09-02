# Snorkel ↔ Tally connect v2 — export-first, two-sided, human-committed

> Written S335 snorkel lane, 2026-09-02, on Afshaan's instruction after he lifted the S332 park.
> **Extends — does not replace — [`2026-08-26-snorkel-tally-connect-design.md`](2026-08-26-snorkel-tally-connect-design.md).**
> That document's §1 decisions, §2 identity problem and §8 envelope still hold. Its **§3 population
> figures, §5 GSTIN gate and §7 "what is blocked" are superseded here** — all four moved within a week.
> Decisions ledger: `reference/decisions.md` §S335c.

---

## 0. What changed, and why there is a v2

Three things landed on 2026-09-02 that the first spec could not have known:

1. **The transport assumption was wrong.** v1 assumed one external input (endpoint + credentials)
   and that everything else was buildable. Both halves turned out false — see §2.
2. **Afshaan widened the scope twice in one session** — first to "manual push behind a button", then
   to **payment requests, i.e. the purchase side**. v1 is a sales-only design.
3. **The real ledger master arrived** (`Master.xlsx`, **1,999 ledgers under 88 group rows**, of which 65 directly contain ledgers;
   exported 1-Apr-23 → 1-Sep-26. NB the parse keys on bold=group, and Tally's own footer row
   `83 Group(s)` parses as an empty group — ignore it) and disproved the premise that ledger names can be composed. See §5.

⭐ **The governing sentence for this build, from Afshaan:**
> *"There should be enough backstops or enough checks built into the system so that we're not just
> brute writing all of this into Tally and it becomes very difficult to capture it later."*

Everything in §7 follows from that one requirement.

---

## 1. The two-step model (Afshaan, 2026-09-02)

> *"1. Manual integration, where an export is possible. 2. Directly integrate whenever the right
> pipeline exists. If a direct route exists today, then we should definitely chase it first."*

**Step 1 — file export.** Snorkel renders a Tally-importable file; finance imports it via Tally's own
`O: Import` dialog. Available **today**, no connectivity, no exposure.

**Step 2 — direct push.** The same voucher, POSTed to Tally's XML gateway. Blocked (§2).

⭐ **Step 1 is not throwaway, and this is the load-bearing architectural claim of this document:**

```
 sales order / payment request
        │
        ▼
 [ mapping layer ]      stored, finance-editable in Snorkel UI      ← §5, §6
        │
        ▼
 [ voucher builder ]    ledger lines + amounts + narration          ← §4
        │
        ▼
 [ dry-run preview ]    human sees the exact voucher                ← §7
        │
        ├─ STEP 1 transport: render file → finance imports in Tally
        └─ STEP 2 transport: HTTP POST to the gateway
```

Only the last box differs. Mapping, builder, preview, push log and reconciliation are **common**.
Step 2 is a transport swap, not a rewrite — which is why step 1 is the right thing to build first
even though step 2 is the goal.

---

## 2. Transport: what is ruled out, and on what evidence (measured 2026-09-02)

| Route | Verdict | Evidence |
|---|---|---|
| **ODBC** | ❌ Cannot write | Tally's ODBC is extraction-only ("ODBC Server" = external apps *read* from Tally); writes are documented separately as XML import. Also no ODBC driver exists in the Cloudflare Workers runtime. |
| **Tally.NET remote login** | ❌ Cannot write | Tally FAQ, verbatim: *"import of data is not allowed using a remote login."* Protocol is proprietary encrypted XML (modified DES) "understood only by TallyPrime", so we cannot speak it either. |
| **Direct XML gateway** | ⚠️ The only write path, **not reliably reachable** | See below. |
| **File import** | ✅ **Works today** | Tally `O: Import` accepts **Excel / JSON / XML** from a file path, with a **Mapping Template**, **Preview Import Summary** and **Backup Company Data before Import**. |

### 2.1 Why the direct gateway is not usable yet

Tally is hosted by **cocloud.in** and delivered as a browser/RemoteApp session (`cloud777.cocloud.in`,
`103.171.134.98`). Observed on 2026-09-02:

- **20:12** — `cloud777.cocloud.in:26613` OPEN, replied `<RESPONSE>TallyPrime Server is Running</RESPONSE>`,
  but every company-scoped request returned **empty** and `List of Companies` reported `<COMPANY>0</COMPANY>`.
- **20:20** — the same port **closed/filtered**. `app.cocloud.in` never had it open.
- **20:30** — the session itself required an interactive login (*"ALERT! No logon info found!"*).

⚠️ **Read that as: the gateway comes and goes with a user's remote-app session, and the instance we
briefly reached had no company loaded — it may not even have been ours.** On a shared host only one
process can bind 26613, so it is effectively first-come-first-served between tenants.

**Step 2 therefore has one precondition, and it is a hosting question no Tally document can answer:**
> *A persistent, always-on TallyPrime instance with `Fraternitas Ventures Private Limited` loaded,
> whose XML gateway port is reachable from outside, independent of any user's remote-app session.*

Ask cocloud / PrEm Infotech (Tally Care `9367 34 34 34`). Ask in the same call whether they are on
**TallyPrime Gold** (multi-user licence — what the screenshot shows) or **TallyPrime Server** (the
product built for always-on programmatic access).

⚠️ **Deliberately out of scope here at Afshaan's instruction (2026-09-02): the gateway answered an
unauthenticated request from a laptop.** Recorded, not addressed. Revisit before step 2 ships.

### 2.2 What we already hold

| v1 §7 input | Status |
|---|---|
| Host + port | ✅ `cloud777.cocloud.in:26613` — **not the default 9000** |
| Auth in front | ✅ Answered: none |
| Exact Company Name | ✅ `Fraternitas Ventures Private Limited` — matches `store.company_bank_accounts.legal_name` |
| Byte-exact ledger names | ✅ **All 1,999, from `Master.xlsx`** — the last v1 blocker, now closed |

**Still needed for step 1:** the **`L: Sample Excel File`** from Tally's own Import dialog. It defines
the exact column schema Tally expects; building the generator against it turns the format from
guesswork into a spec. Also confirm how finance moves files onto the import path (`J:\Export`).

---

## 3. Scope: four voucher types, two sides

v1 covered the sales side only. Afshaan added the purchase side on 2026-09-02
(*"snorkel will now start accepting payment requests also, which means invoices, etc will all be
there, i would want to push those as well"*).

| Side | Snorkel source | Tally `VCHTYPE` | Status |
|---|---|---|---|
| Sales invoice | `store.sales_orders` | `Sales` | Data complete — **build first** |
| Credit note | `store.sales_credit_notes` | `Credit Note` | Blocked on cutover (§8.3) |
| Receipt (money in) | `store.sales_payments` | `Receipt` | Needs the finance workflow move |
| **Purchase (vendor invoice)** | `store.po_requests` + PO lines | `Purchase` | ⛔ **Data gap — §6** |
| **Payment (money out)** | `store.payment_requests` | `Payment` | ⚠️ Must not precede Purchase — §6 |

---

## 4. The trigger rule (Afshaan, 2026-09-02)

> *"we do not record anything in Tally till an SO has been fulfilled, and even then we need a
> confirmation."*

- **Nothing is pushed automatically. Ever.** No cron, no on-save hook. A human presses a button.
- **Eligibility = fulfilled**, not invoiced.
  ⚠️ **This corrects `store.tally_push_readiness` as shipped (migration `snorkel_tally_push_gate_v1`),
  which keys on `invoice_generated` per v1 §4.4.** That was right for v1 and is wrong under this rule.
  Fix the view when the fulfilment predicate is settled — `dispatch_shipment_id` / fulfilment-request
  state is the likely source, to be confirmed.
- **Confirmation is a second, explicit act** after eligibility. Record who confirmed and when.
- Batch is opt-in, never the default, and states the count before it acts.

---

## 5. Ledger mapping is STORED, never derived

⛔ **Do not compose ledger names.** Measured across `Master.xlsx`, the same concept is spelled six
different ways in six states:

```
Output Cgst 9% - HYN        Haryana        (HYN, not HR)
Output Cgst 2.5% - KA       Karnataka      ("Cgst")
Output IGST 5% - KA         Karnataka      ("IGST" — same group, different case)
Output CGST 9% - MH         Maharashtra
Output IGST - 18% - PB      Punjab         (extra hyphen before the rate)
Output CGST 9%-TL          Telangana      (no spaces around the dash)
Output IGST - 18% - WB      West Bengal
```

Same on the sales side: `Karnataka Interstate Sales 18%` · `Haryana Interstate Sales - 18%` ·
`Maharastra Interstate Sales @18%` (and "Maharastra" is misspelled in Tally) · `Punjab Interstate Sales @18%`.

⭐ **And three overlapping schemes coexist inside one group.** `Karnataka Sales` holds
`Karnataka Local Sales 18%` / `Karnataka Interstate Sales 18%` (state × supply-type × rate)
**and** `Offline Sales` / `Shopify Sales` (channel-named) **and** `Fair Sales` / `Amazon Sales Return`.
This is Afshaan's *"sometimes it is different, sometimes it is based on some other logic"* made concrete.

### 5.0 ⛔ The PARTY ledger — the mapping this document originally forgot

*Added by the S335 hostile review, which caught its own omission.* `PARTYLEDGERNAME` appears in
**every voucher of every type**, so it is the most-used mapping here, and v2 shipped without it.

**Measured 2026-09-02 against `Master.xlsx` (denominator: 161 active GT/MT partners):**

| | Count | Share |
|---|---|---|
| `sales_partners.name` matches a Tally ledger **exactly** | **148** | 91% |
| Matches only after normalising case/punctuation | 3 | 2% |
| **No Tally ledger at all** | **10** | 6% |

⭐ **91% exact is the good news — the party map can be auto-seeded and then reviewed, not hand-built.**
The other two rows are the danger:

- **Normalised-only** are not all cosmetic: `Wonderland Toys` → `WONDER LAND TOYS` is a word split, not
  a case difference. `Ananya Kids Mall` → `ANANYA KIDS MALL` and `Poonam Trading` → `POONAM TRADING` are.
  ⛔ **Never auto-accept a normalised match** — resolve each one explicitly, because normalisation that
  is right 3 times will be wrong the 4th and nothing will say so.
- ⛔ **The 10 with no ledger are the "brute write" hazard in its purest form.** A Tally import naming a
  party ledger that does not exist does not politely fail — depending on import settings it **creates
  the ledger**, under a default group, silently. Ten duplicate customer ledgers in the books, each
  accruing real balances, is exactly the outcome Afshaan's backstop requirement exists to prevent.
  They include `SMART BABY` — which is also the one live GSTIN blocker (§8.4), so it fails twice.
- ⚠️ **Group names do not tell you what a group holds.** `Warehouse Charges` (483 ledgers) is *vendor*
  party ledgers, not charges; `QuickCom - Zepto` (612) is Zepto's per-warehouse customer entities.
  Do not infer ledger type from its group.

**Therefore:** the party map is a first-class column of the mapping table (§10.3), seeded from
`Master.xlsx`, with every non-exact row defaulting to **unmapped → refuses to push** (backstop 1),
never to a guess and never to auto-create.

### 5.1 Tally carries SIX state GST ledger sets; Snorkel models ONE

Tally carries GST + sales groups for **Karnataka (29), Haryana (06), Maharashtra (27), Punjab (03),
Telangana (36), West Bengal (19)**, with interbranch transfer ledgers between them.
⚠️ **That six separate GST *registrations* exist is an INFERENCE from the ledger structure, not a
verified fact** — the interbranch ledgers make it very likely, but confirm with Mahesh (§9.1 Q2)
before designing around it.
`store.company_addresses` holds exactly one row with a GSTIN — Karnataka `29AAFCF7834H1ZA` — and the
invoice/confirmation pages compute intra-vs-interstate against it.

**Working hypothesis, to be confirmed, not assumed:** the other five exist for marketplace
(the `Ecommerce` group holds Flipkart entities per fulfilment centre — Delhi, HYD, Jhajjar, KA, MH,
TL, TN, WB). If GT/MT only ever sells on the Karnataka registration, Snorkel's single-registration
model is adequate for step 1. **If not, this is a schema change before any push.**

### 5.2 The sales mapping is small

Measured: **every GT/MT invoiced order is 18%** — 217 local (Karnataka), 201 interstate, **zero at 5%**.
So the step-1 mapping is six ledgers:

| Case | Sales ledger | Tax ledgers | Round-off |
|---|---|---|---|
| Local (KA) | ❓ §9.1 | `Output Cgst 9% - KA` + `Output Sgst 9% - KA` | `Round Off` (group `Others`) |
| Interstate | ❓ §9.1 | `Output Igst 18% - KA` | `Round Off` |

### 5.3 Ledger-master defects to hand back to Mahesh

A mapping keyed on names or groups inherits these:

- **`West Bengal Interstate Sales 18%` and `West Bengal Interstate Sales @ 18%`** — two ledgers, one concept.
- **The `Tax Deducted at Source` group is a dumping ground** — it holds `Output IGST - 18% - GJ` plus
  **seven Haryana Input GST ledgers** that belong in `GST - Haryana (06)`. Eight misfiled ledgers.
- **`RCM Output Igst 5%` / `RCM Input Igst 5%`** carry no state suffix, unlike every sibling.

These are finance's to fix. Ours is to not silently depend on them.

---

## 6. The purchase side, and why it is not symmetric

Sales needs ~6 ledgers. Purchases have **three dimensions no automated rule can settle**:

1. **Which expense/asset ledger.** Hundreds of candidates — `Warehouse Charges` (483 ledgers),
   `Influencer Marketing` (75), `Reimbursement` (65), `Plant & Machinery` (44),
   `Professional Fees & Services`, `Travel & Conveyance`… At best a `category_key` → ledger map
   with a per-request override.
2. **Input GST is not one ledger per rate.** Karnataka alone spans 2.5 / 5 / 6 / 9 / 12 / 14 / 18 **and**
   parallel sets for `… to Claim`, `INPUT REVERSAL …`, `Input Ineligible` /
   `Input Unavailable/inelgible`, and `Rcm Input …`. Claimable-vs-deferred-vs-ineligible-vs-RCM is an
   accounting judgement per invoice.
3. **TDS.** `194C`, `194I`, `194J`, `194A`, `192`, the `393(1)` variants, PF/PT payables. The section
   depends on the nature of the service. **Snorkel has no TDS fields at all.**

### 6.1 ⛔ A payment request is NOT a purchase invoice

| Voucher | Entries | Booked when |
|---|---|---|
| **Purchase** | Dr Expense/Asset + Dr Input GST, Cr Vendor | invoice received |
| **Payment** | Dr Vendor, Cr Bank, (Dr/Cr TDS) | money moves |

`store.payment_requests` (5 rows today) carries `invoice_no`, `invoice_date`, `invoice_total`,
`amount_to_pay`, `payment_mode`, `payment_ref`, `linked_po_number` — a **treasury** record. It has
**no GST breakup, no taxable value, no line detail, no TDS, no input-eligibility flag**.

⚠️ **So it can produce a Payment voucher but not a Purchase voucher — and pushing payments without the
matching purchases posts money against bills Tally does not have, corrupting every vendor ledger it
touches.** That is precisely the "very difficult to capture later" outcome this design exists to prevent.
**Purchase before Payment, always.**

### 6.2 This puts an existing backlog item on the critical path

⭐ **`[snorkel] [build] [MED]` — "the PO request form needs real LINE ITEMS (price + tax% per line)"**
(⏳ Joseph, asked 2026-09-01) is the upstream dependency. Line-level taxable value, HSN and GST% at
capture is exactly what a Purchase voucher needs. It was filed as a usability fix to stop finance
working in sheets; **it is now a prerequisite for the entire purchase-side push.** Re-prioritise it
as such rather than leaving it as an independent multi-session build.

---

## 7. Backstops — the non-negotiable list

Each one exists because of a specific failure this system can produce silently.

1. **Refuse on missing mapping. No default ledger, and NEVER let Tally auto-create a ledger** (§5.0).
   A fallback or an auto-created party ledger is how a thousand wrong postings happen quietly.
   *(original wording:* refuse on missing mapping, no default ledger, ever*)* A fallback ledger is how a thousand wrong
   postings happen quietly. Missing mapping = the document does not push, and says why.
2. **Dry-run before every send.** The operator sees the exact voucher — every ledger line, every
   amount, Dr/Cr — before anything leaves Snorkel. Step 1 gets this free by rendering the file.
3. **`ALTER` vs `CREATE` shown explicitly; `CREATE` needs a second confirmation.** Tally identifies a
   voucher by `DATE + VOUCHERNUMBER + VCHTYPE` and **returns no error either way** (v1 §2) — a wrong
   number silently alters someone else's voucher, a missing one silently duplicates.
4. **Write the voucher number back immediately** on success, or the next run duplicates it.
5. **Append-only push log** — payload, response, resulting voucher number, operator, timestamp, and
   for step 1 the exported file's hash. Without it, a bad push is archaeology.
6. **Read back and reconcile.** After a push, export the voucher and compare amounts to ours; mark
   verified. Turns a blind write into a checked one. Works over the same gateway — no ODBC needed.
7. **Channel allow-list, default off** — shipped: `store.sales_channels.pushes_to_tally`
   (migration `snorkel_tally_push_gate_v1`), FALSE on all 9 channels today.
   ⛔ **Never key this off `feeds_odo_sellout`** — `FLIPKART_MGD` carries it TRUE.
8. **Cutover-date guard.** Refuse anything dated before the cutover; pre-cutover is reconciled history.
9. **Amount tolerance check** against our own `grand_total` before and after.

Note that backstops 2 and 5 are partly **given to us by Tally** in step 1: its import dialog offers
**Preview Import Summary** and **Backup Company Data before Import**. Use both; do not build over them.

---

## 8. Channel scope — and a hazard the v1 filter does not cover

### 8.1 The model changed under the filter

Afshaan, 2026-09-02: *"most of our channels are now going into outright purchase rather than SOR or
single-unit fulfilment, except maybe website and one or two other channels."*

⛔ **This supersedes `reference/decisions.md` §S312**, which excluded marketplace *because* it was
sale-or-return and therefore unrealized. Outright purchase **is** a realized sale and belongs in the books.

### 8.2 ⚠️ A boolean flag is not sufficient

The same channel was SOR before the change and outright after. **Flipping `pushes_to_tally = true` for
Flipkart retroactively books ₹1.55 Cr of genuinely unrealized historic placements.**
`pushes_to_tally` likely needs an **effective-from date per channel**, not just a boolean.

**Needed from Afshaan/Mahesh: which channels changed to outright purchase, and from what date.**
Not derivable from our data.

### 8.3 Credit notes

**All 61 FY26-27 credit notes carry no `tally_voucher_no` (61 of 61** — v1 §4.5 said "59 of 90"; both
figures moved). They already exist in Tally un-numbered, so every one would duplicate. This is a
reconciliation problem, not a mapping problem, and it must be resolved before CN push is enabled.

### 8.4 The GSTIN gate has effectively cleared

v1 §5 called it a hard prerequisite at **113 of 204** active partners. After the S335 backfill it is
**53 of 207**, and `store.tally_push_readiness` shows that with GT+MT enabled only **73 orders** block
on a missing GSTIN — of which **72 are FY25-26 or earlier**. Exactly **one** is FY26-27: ₹9,813.84,
`SP-0077 SMART BABY`, the single row still open with Prarthi.
⭐ **Under any cutover date from 2026-04-01 the gate reduces to one order.**
⚠️ Still unverified: v1 §5 asserts Tally refuses a GST voucher against a party ledger with no GSTIN.
That should not hold for a genuinely **unregistered B2C** party. Check before treating the two
settled-unregistered partners as blockers.

---

## 9. Open questions — owner named, none guessable

### 9.1 Mahesh / finance
1. **`Offline Sales`, or `Karnataka Local Sales 18%` / `Karnataka Interstate Sales 18%`?** Both sit in
   the same group; GT/MT *is* the offline business. This one answer decides the whole sales-ledger half.
2. Do the other five GST registrations ever apply to **GT/MT**, or are they marketplace-only? (§5.1)
3. The eight misfiled ledgers and the West Bengal duplicate (§5.3).
4. For purchases: the `category_key` → expense-ledger map, who decides input-GST eligibility, and
   where TDS is determined. (§6)
5. Does Tally accept a GST sales voucher against an unregistered (B2C) party ledger? (§8.4)
6. **The 10 GT/MT partners with no Tally ledger (§5.0) — create them in Tally, or are they duplicates
   of ledgers under another name?** Includes `SMART BABY`. Must be settled before any push, or the
   import creates them silently.

### 9.2 Afshaan
7. **Cutover date.** Never chosen (v1 §4.6). `tally_push_readiness` now shows exactly what each date pulls in.
8. **Which channels moved to outright purchase, and from when.** (§8.1–8.2)
9. Does `EVENTS` (`channel_type = 'other'`) push?
10. How the 61 FY26-27 credit notes cut over. (§8.3)
11. When receipts move into Snorkel — a finance workflow change, not code.

### 9.3 cocloud / PrEm Infotech
12. A persistent, reachable, always-on instance? Gold or TallyPrime Server? (§2.1)

---

## 10. Build order

1. ~~`tally_voucher_no` identity column~~ ✅ shipped (v1, `snorkel_tally_voucher_identity_v1`)
2. ~~Channel allow-list + precondition report~~ ✅ shipped (`snorkel_tally_push_gate_v1`)
3. **Ledger mapping table + finance-facing UI in Snorkel — INCLUDING the party map (§5.0).** The piece Afshaan asked for by name:
   *"provide a manual mapping which we can see in a UI that surfaces that mapping, so if at all
   something needs to change, we can change it in Snorkel itself."* Serves all four voucher types.
   Seed it from `Master.xlsx` — the party half auto-seeds at 91% exact (§5.0); the 13 non-exact GT/MT
   rows are a finance review queue, not a build blocker. **Startable once §9.1 Q1 is answered.**
4. **Voucher builder + dry-run preview** for `Sales`. No transport.
5. **Step 1 transport: file export.** Build against Tally's `L: Sample Excel File` schema.
6. Fix the fulfilment predicate in `tally_push_readiness` (§4).
7. Cutover date, then `Credit Note` and `Receipt`.
8. `Purchase` — gated on Joseph's PO-request line items (§6.2).
9. `Payment` — never before `Purchase` (§6.1).
10. **Step 2 transport: direct push**, once §9.3 lands and the exposure in §2.1 is closed.

---

## 11. Figures corrected in this document

Everything below moved between 2026-08-26 and 2026-09-02. **Re-derive; do not quote either spec.**

| v1 said | Today | Where |
|---|---|---|
| GSTIN gate: 113 of 204 partners | **53 of 207**; 1 live FY26-27 order blocked | §8.4 |
| Bucket C: 27 orders, ₹1.11 Cr | **39 orders, ₹1.73 Cr** (GT half 7 → 16) | `decisions.md` §S335c |
| FY26-27 CNs without ref: 59 of 90 | **61 of 61** | §8.3 |
| "One external input blocks this" | **Four**, and the ledger names are now closed | §2 |
| "XML generator + dry-run buildable now" | Both needed the ledger names; only 2 of 4 were | §2 |
| Marketplace never pushes (§S312) | Superseded by the outright-purchase shift | §8.1 |
| Channels: 8 classified | **9** — `OZI` appeared in bucket C on 2026-08-27 | `decisions.md` §S335c |
