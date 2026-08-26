# Snorkel ↔ Tally connect — design

> Written S314 snorkel lane, 2026-08-26. Supersedes the "owner + cadence for a recurring manual
> sync" question: Afshaan's call is **integration, not a recurring sheet load** — Snorkel becomes the
> only entry point, Tally stays the books.
> Step 1 of this design is **SHIPPED** (migration `snorkel_tally_voucher_identity_v1`). The push
> itself is **not built** and is blocked on one external input (§7).

---

## 1. Decisions already taken (do not re-open without Afshaan)

| Question | Answer | Source |
|---|---|---|
| Direction | **Snorkel → Tally push.** Snorkel is source of truth; Tally is the books. | Afshaan 2026-08-26 |
| Tally deployment | **TallyPrime Edit Log edition, cloud-hosted.** | Afshaan 2026-08-26 |
| Receipts | **Move to Snorkel**; Snorkel pushes them. Finance stops keying receipts in Tally. | Afshaan 2026-08-26 |
| v1 scope | **Invoices + credit notes + receipts together.** | Afshaan 2026-08-26 |
| Marketplace | **Never pushed.** Sale-or-return, unrealized. | `reference/decisions.md` §S312 |

The Edit Log edition matters and is a genuine advantage: every alteration Tally receives is
audit-trailed, so a re-push is inspectable on the Tally side rather than silent.

## 2. The identity problem — why a push duplicates by default

Tally has **no external-id field for vouchers**. It identifies a voucher for `ACTION="Alter"` by
**`DATE` + `VOUCHERNUMBER` + `VCHTYPE`**. So the voucher number *is* the idempotency key: push with a
number Tally already holds → it alters that voucher; push with a number it does not → it creates a
new one. There is no third behaviour, and no error to catch.

That makes "which Tally voucher is this Snorkel document?" the single load-bearing fact of the whole
build. Before this session it was stored as **free text in three different columns** —
`sales_orders.notes` (`" · Tally voucher: OFLOT179"`), `sales_credit_notes.reason_note`
(`"CN ref: CNOF07"`), `sales_payments.reference` (`"Tally Rcpt 41"`). A connector cannot key on a
regex over prose, and the S312 reconciliation that established those links would have rotted.

**Shipped:** `tally_voucher_no text` on `store.sales_orders` / `sales_credit_notes` /
`sales_payments`, backfilled from all three sources. Additive; rollback is `DROP COLUMN`.

⚠️ **Its contract is "a key you may safely ALTER on."** A ref that is ambiguous or malformed must be
NULL here, not stored hopefully — a wrong identity is strictly worse than none, because it alters the
wrong voucher silently. Two rows were nulled on exactly this ground (§6).

⚠️ **`sales_payments.tally_voucher_no` is deliberately many-to-one — never make it unique.** 179
payment rows carry 127 distinct receipt refs, because a Tally receipt FIFO-splits across several
invoices (the S312 method). That is correct, not duplication.

## 3. The four populations (measured 2026-08-26)

| Bucket | Orders | Value | What a push does today |
|---|---|---|---|
| A. `invoice_no` **is** the Tally voucher (`OFLOT###`/`FVPLOF###`) | 372 | ₹2,39,55,484.92 | ALTERs the right voucher — safe |
| B. Native `LOT/SL/…`, Tally ref recovered from `notes` | 30 | ₹14,25,668.03 | Safe **only now that the ref is a column** |
| C. Native `LOT/SL/…`, no Tally ref | 27 | ₹1,11,32,635.35 | **Would CREATE a duplicate** |
| D. Confirmed, not yet invoiced | 58 | ₹90,79,494.13 | Nothing to push |

**Bucket C splits into two completely different things, and conflating them is the trap:**

- **20 are marketplace** — Flipkart ₹97,07,009.46 (14) + Instamart ₹8,19,167.04 (6) = **₹1.05 Cr**.
  These have no Tally ref *because they were deliberately excluded* (§S312). They are sell-in
  placements, not realized sales. **A connector without a channel filter books ₹1.05 Cr of
  unrealized revenue into the books.** This is the single most dangerous defect available here.
- **7 are GT** (₹6,06,458.85) — genuine invoices with no Tally counterpart. **4 of them are dated
  2026-08-26**, i.e. raised after the S312 load: this is the divergence still happening, live, and
  the reason the connect exists.

## 4. Invariants the build must hold

1. **Channel filter is a safety property, not a feature.** Only channels where the Snorkel order *is*
   the invoice may push. Marketplace never pushes. Implement as an explicit allow-list/flag on
   `store.sales_channels`, defaulting to **off** — a newly added channel must not start pushing to
   the books because someone forgot a flag.
2. **Never push without a `tally_voucher_no` unless deliberately creating.** The create path must be
   explicit and must write the resulting voucher number back, or the next run duplicates it.
3. **A party ledger needs a GSTIN.** 113 of 204 active partners have none — see §5.
4. **Push only invoiced documents.** `invoice_generated = true`; bucket D is not a book event.
5. **Credit notes have no Tally identity at all for FY26-27** (59 of 90): the source sheet carried no
   voucher numbers, stated verbatim in their own `reason_note`. Those 59 already exist in Tally
   un-numbered, so pushing them **creates duplicates**. FY26-27 CNs are a cutover problem, not a
   mapping problem — resolve before enabling CN push.
6. **Cutover date.** Everything before it is reconciled history and must not be re-pushed; everything
   after flows. Not yet chosen.

## 5. The GSTIN gate

**113 of 204 active partners have no GSTIN** (measured 2026-08-26). Tally will not accept a GST sales
voucher against a party ledger without one. This makes the existing `[snorkel] [data]` backfill item
a **hard prerequisite of this build**, not an adjacent tidy-up. Two of the 7 live GT divergence
orders (SMART BABY, RAMDEV ARTS GIFT AND TOYS) are already blocked on it.

## 6. Data defects surfaced while building step 1 (pre-existing, from the S169 backfill)

- **`CNOF07` is claimed by two credit notes** — `LOT/CN/25-26/0009` (₹12,732.00, 2025-07-31) and
  `LOT/CN/25-26/0011` (₹74,487.40, 2025-10-01). Three months and six figures apart, so one carries
  the wrong ref. Both nulled in `tally_voucher_no`; `reason_note` untouched.
- **`30.0` stored as a CN ref** on `LOT/CN/25-26/0016` (₹67,487.52) — a spreadsheet numeric cell in
  an identifier field. Nulled on the same ground.

Neither is caused by this session's work; both were invisible until the refs were pulled into a
column where uniqueness could be tested.

## 7. What is blocked, and on what

**One external input: the Tally endpoint + credentials.** A cloud-hosted TallyPrime exposes its XML
gateway over HTTP (default port 9000). Needed from Afshaan/finance:

- host + port reachable from Cloudflare (`snorkelops`),
- whatever auth sits in front of it,
- the exact **Company Name** as Tally holds it (it is a required field in every request),
- the Tally **ledger names** for sales, output CGST/SGST/IGST and round-off, byte-exact.

Store as `TALLY_*` secrets on `snorkelops` (`printf`, never `echo` — see CORE.md).

Nothing else is blocked. The voucher-XML generator, the channel filter, the mapping layer and a
dry-run that renders XML without sending are all buildable now and are the natural next slice.

## 8. Voucher XML shape (grounded, not from memory)

```xml
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC>
      <REPORTNAME>Vouchers</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC>
    <REQUESTDATA>
      <TALLYMESSAGE>
        <VOUCHER VCHTYPE="Sales" ACTION="Alter" OBJVIEW="Invoice Voucher View">
          <DATE>YYYYMMDD</DATE>
          <VOUCHERNUMBER>{tally_voucher_no or invoice_no}</VOUCHERNUMBER>
          <PARTYLEDGERNAME>{partner ledger}</PARTYLEDGERNAME>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>...</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes|No</ISDEEMEDPOSITIVE>
            <AMOUNT>...</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>
```

`VCHTYPE` swaps to `Receipt` / `Credit Note`; the envelope is otherwise identical. Amount sign
convention is carried by `ISDEEMEDPOSITIVE`, not by a negative number.

Source: [TallyHelp — Sample XML](https://help.tallysolutions.com/sample-xml/).

## 9. Suggested build order

1. ~~`tally_voucher_no` identity column + backfill~~ ✅ **shipped**
2. Channel allow-list flag (default off) + the GSTIN precondition check as a readable report.
3. Voucher-XML generator + **dry-run action** rendering XML for a given document, no network. Fully
   testable against the 402 already-identified orders without an endpoint.
4. Transport + `TALLY_*` secrets once §7 lands; push behind an explicit enable flag.
5. Cutover date, then receipts move into Snorkel (the finance workflow change).
