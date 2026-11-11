# Podium — Hiring module (scope)

> 2026-11-11 · status **SCOPE v3 — not built** · owner Afshaan · system Podium (`podiumops` + `apps/podium`)
> v2: Afshaan's answers (openings + bands in Core, over-band → manager above, hiring chain sees its own
> numbers, calendar = Podium link, one standard letter from the mailbox letters). v2.1: JD gate.
> **v3: merged review — Codex (gpt-6-astra, 25 findings) + a self-review against the live schema.** Biggest
> changes: candidate person vs application split; statutory calculator rules made effective-dated (PF ceiling
> and Karnataka PT have changed since the letters were written); a full offer state machine; atomic joining;
> candidate documents in their own table; retention + deletion; approval-bypass and self-approval closed.

## Goal

Every hire's paper trail lives in Podium from opening to joining day, and **no offer letter leaves LOT
unless Podium generated and recorded it.** The application becomes the employee's HR record when they
join; nothing is re-keyed.

| # | Module | Tier | Depends on | Size |
|---|---|---|---|---|
| C1 | Openings: role, JD, reporting manager, approved band, headcount | Core | — | 1 session (with C2) |
| C2 | Candidates + applications + HR documents; joining hand-off | Core | C1 | ↑ + 1 |
| C3 | Offer letter: template, statutory calculator, revisions, approval, PDF, manual send | Core | C1, C2 | 2 sessions |
| C4 | Bulk CV upload → candidates (Claude extraction, review-and-confirm) | Core | C2 + Anthropic API key | 1 session |
| O1 | Send / draft the offer email from Gmail | Optional | C3 + Workspace scope | 1 session |
| O2 | Interview rounds + feedback | Optional | C1, C2 | 1–2 sessions |
| O3 | One-click Calendar scheduling (Podium link) | Optional | O2 + Workspace scope | 1 session |
| O4 | Candidate document-upload link (replaces emailing ID/bank docs) | Optional, recommended | C2 | 1 session |

Scope: **Fraternitas (white-collar) hires, including interns.** Blue-collar contract labour via Silverton is
out of scope (hired and paid through the agency).

---

## Decided by Afshaan (2026-11-11)

1. The opening's chain — hiring owner, reporting manager, approver — sees salary numbers for **that opening
   only**. (Amends RULE-PODIUM-002 for hiring records; employee salaries stay allow-list-only.)
2. Within the approved band → no approval. Above it → the manager above (in practice Vinay or Afshaan).
3. Calendar invites carry a Podium link, not the CV file.
4. One standard "Offer of Employment" letter, as used today.
5. A JD is optional to create an opening, required before CVs, stage moves or interviews.

## Decisions still needed (both reviews raised these)

1. **Does the approver confirm an opening's band at creation (and any later increase)?** Without it, a band
   typed in high skips approval. *Recommendation: yes — one click per opening; offers inside it then go
   freely.* (Codex rates this MUST.)
2. **Employee PF and Professional Tax inside "fixed pay".** Today's annexure counts the employee's own PF
   and PT as part of fixed pay and shrinks the gross to fit. The letter also says the salary is "before all
   customary payroll deductions", which those two are. Keep as is, or show fixed pay = gross + employer PF,
   with employee PF/PT as deductions on the in-hand line? *Recommendation: the second — it's what the
   letter says and what payroll does; check with Mahesh/Finance that RazorpayX is set up the same way.*
3. **Interns:** the salary records already hold six stipend-based people. A second template ("Internship
   Offer", stipend, no PF/PT/variable) — yes?
4. **CC hr@legendoftoys.com on offer emails** (today's habit). Anyone reading hr@ sees the salary, which
   sits outside the access rule in decision 1. Keep, or CC only the chain + you?
5. **"No offer on record" at joining:** block the Directory-sync import, with an HR override that needs a
   written reason (logged)? *Recommendation: yes.*
6. **Retention for candidates who don't join:** delete their CV and documents after 12 months unless moved
   to a talent pool? *Recommendation: 12 months.*

⚠️ **Outside Podium, today:** the EPF wage ceiling went from ₹15,000 to ₹25,000 on 17 Sep 2026, and
Karnataka PT is now nil below ₹25,000/month gross, with ₹200/month and ₹300 in February (₹2,500 a year) above
it. The letters in the mailbox use ₹1,800/month PF and ₹2,400 a year of PT. Any offer issued from the old
Google Doc since 17 Sep may be out of date. Worth Finance checking now, before Podium exists.

---

## What already exists (reuse, don't rebuild)

- Private `podium-documents` bucket, signed-URL-only (RULE-PODIUM-003).
- `podium.job_roles` (title, JD text, band), `employees.manager_id` (approver chain).
- `podium.compensation_events` — **the component keys the payouts screen reads are a fixed contract**:
  `monthly_fixed`, `monthly_variable`, `fixed_yearly`, `variable_yearly`, `gross_yearly`, `bonus_type`,
  `designation` (present on all 52 seeded events; `getPayoutPeriodSheet` reads them). The joining event must
  write exactly these keys, plus the full annexure under `annexure`. `new_ctc` = total CTC.
- `podium.comp_access_log` — keep logging allow-list reads too; extend it to hiring records.
- Appraisal letter print view; Directory sync (review-and-confirm, read-only preview — RULE-PODIUM-007);
  the auth-linking triggers (RULE-PODIUM-004, S393); the Google service account with domain-wide delegation.

---

## C1 — Openings

`openings`: `opening_code` (OPN-NNN), `job_role_id`, designation (editable — letters use designations that
differ from the role name), department, `reporting_manager_employee_id`, `hiring_owner_employee_id`
(defaults to the creator), location (city + **state**, which drives PT), employment type (full-time /
intern), legal entity (Fraternitas), headcount, target joining date, notes, status.

**JD.** File (PDF/DOCX → bucket, versioned) or text; "Use the role's JD" fills it in one click. JD versions
are kept, never deleted once candidates exist, and each interview records the JD version it ran against.

**Band.** `band_min` / `band_max` on **total CTC** (the number the letter leads with); pre-filled from the
job role server-side without exposing the role registry's other bands. Stored as versioned rows
(`opening_budgets`: version, band, who set it, approved_by/at). Each offer freezes the budget version it
was checked against.

**Approver** = the reporting manager's manager (one step up the solid line), **snapshotted** on each
approval request.
- The approver can never be the person asking. If the computed approver is the requester (e.g. a founder
  hiring for their own report), it goes to the other founder.
- If the approver has exited or the chain changed, the request re-resolves and an unsent approval for the
  old approver is cancelled (RULE-PODIUM-010 pattern).

**Status:** `draft` (no JD, or band not yet approved) → `open` → `on_hold` → `filled` / `cancelled`.
- `on_hold`: no new candidates, no offers sent. Existing work stays visible.
- To close or cancel, live applications must first be resolved or moved; open offers must be withdrawn.
- Adding or replacing a JD never reopens a held or closed opening.

**Headcount.** Track approved, offers accepted, and joined. Podium blocks accepting more offers than the
remaining headcount and warns when offers out exceed it. A no-show or withdrawal releases the seat.

**JD gate** (enforced in the worker): no CV/candidate, no stage move, no interview until the opening has a JD.

## C2 — Candidates, applications, documents, joining

**Person vs application — the decision that is hardest to change later.**
- `candidates` = the person: `candidate_code` (CAN-NNNN), name, normalised personal email + phone, location,
  current employer/title, experience, skills, education, `employee_id` once joined.
- `applications` = person × opening: source + referrer, current CTC, expected CTC, notice period, `status`,
  outcome reason, created_by. Offers, interviews, events and feedback hang off the **application**.
- Re-applying later, or two openings at once, is just a new application. "Moving" a candidate closes one
  application and opens another, and offers stay with the opening they were made for.
- Duplicate suggestions match on email or phone; HR can merge two people (logged). A unique index blocks
  two active applications for the same person on the same opening.

**Application status:** `new → screening → interviewing → offer → accepted → joined`, plus `rejected`,
`declined`, `withdrawn`, `no_show` and `on_hold`. Each transition has a named actor and precondition: JD
present, opening open, and an accepted offer before `accepted`. Every change writes an
`application_events` row (actor, time, from→to, reason, request id). Salary values never go in the timeline
text.

**Documents — own table, not `podium.documents`.**
- New `candidate_documents` table. The live `getDocuments` / `getDocumentDownloadUrl` visibility code keys
  on `employee_id`, so mixing candidates into it risks the employee-document rules.
- Bucket path `candidates/<candidate_id>/…`, owner-bound signed uploads, and type and size checks.
- `doc_type`: `cv`, `jd` (on openings), `payslip`, `signed_offer`, `id_proof`, `pan`, `address_proof`,
  `education`, `experience_letter`, `relieving_letter`, `bank`, `photo`, `other`.
- Who sees which documents (enforced on both the metadata and the signed URL):
  - **CV, education, experience:** the opening chain, `podium_hiring` and assigned interviewers.
  - **Payslip, signed offer:** the salary-visible set only (the opening chain and the allow-list).
  - **ID, PAN, bank, address:** HR only, and the person themself once they're an employee (as today).
- **Aadhaar:** ask only at the joining stage, never with the CV. Accept a masked copy or an alternative ID.
  Never send it through CV extraction. Best handled by O4 instead of email.
- On joining, documents are copied into `podium.documents` under the new employee by the joining function
  (below). The candidate copies are then removed under the retention rule.

**Who can do what (worker-enforced; table to be finalised in the build plan).**

| Action | Who |
|---|---|
| Create opening | `podium_hiring`, or anyone with direct reports (becomes hiring owner) |
| Edit opening / JD / band (band increase → re-approval) | hiring owner, `podium_hiring` |
| See opening + applications | hiring owner, reporting manager, approver, `podium_hiring`, interviewers (assigned applications only) |
| See salary numbers (band, current/expected CTC, offers, payslips) | hiring owner, reporting manager, approver (their opening only) + allow-list |
| Add/move candidates, change status | hiring owner, reporting manager, `podium_hiring` |
| Create / revise / send offer | hiring owner, reporting manager |
| Approve | the snapshotted approver only (never the requester) |
| Edit templates | allow-list + `podium_admin` |

- Nobody can assign themselves into another opening's chain to gain salary access. Chain changes need
  `podium_hiring` and are logged.
- These are added to the worker's self-scoped gate lists, so a manager without a Podium role still reaches
  their own openings, and only those.

**After joining:** offers and salary-bearing hiring records follow the employee salary rules (allow-list +
own pay). The hiring chain's access ends at `joined`.

**Joining hand-off (atomic).**
1. The application is `accepted` with exactly one accepted offer revision. IT creates the Workspace account.
2. In the Directory-sync preview, HR **pairs the new Workspace account to the accepted application**.
   Personal emails won't match work emails, so this is an explicit pairing stored with the Google user id,
   never a name match.
3. Confirming runs one database function (idempotent, all-or-nothing). It:
   - creates the employee, or **reactivates the existing exited employee row for a rehire** (employee codes
     are immutable);
   - copies the documents;
   - writes one `initial` compensation event, using the components contract above and dated to the actual
     start date;
   - updates headcount and marks the application `joined`.
4. Being "provisioned" is not the same as "joined": HR confirms the **actual start date**. A no-show releases
   the seat.
5. A new joiner with no accepted Podium offer is blocked, subject to decision 5 above.
6. If the salary vault is ever turned off, the event is written without salary figures (as the vault does
   today).

## C3 — Offer letter

### Template (from the letters in Afshaan's mailbox)

One letter type, **"Offer of Employment"**, written today as a Google Doc copy by whoever is hiring.

- **Page 1:**
  - letterhead: Fraternitas, the address, the signatory's phone;
  - date and greeting;
  - fixed salary per annum "before all customary payroll deductions", paid monthly, plus variable or
    incentive pay of up to X per annum, paid half-yearly;
  - start date "on or before", designation, optional department, location;
  - confidentiality / non-compete paragraph, and a reference to the employment agreement;
  - probation (2 or 3 months, sometimes omitted);
  - "confirm by sending a signed copy over email", signatory.
- **Page 2:** Annexure I, the CTC breakdown (annual / monthly).

`offer_templates`: body with merge fields, the salary **rule set**, letterhead/entity, version. An edit
creates a new version, and offers pin the version they used.
- Entity and location are fields, not hard-coded.
- Signatories come from an **authorised-signatory list** (name, phone, who may sign).
- Merge fields: candidate name, issue date, fixed annual, variable label + annual + frequency, start date,
  designation, department, location, probation, signatory name + phone, annexure, offer ref, valid until.
- A second template for interns, if decision 3 is yes.

⚠️ Legal note (SHOULD): post-employment non-competes are generally unenforceable in India (Contract Act s.27).
Worth a one-time legal read of the paragraph and of the clawback wording before it is locked into a template.

### Statutory calculator — effective-dated rules, not constants

The rule set is data with `effective_from`. Each offer stores the rule-set version it used.
- **Basic** 50% of fixed pay; **HRA** 50% of Basic; **Travel** fixed ÷ 15; **Telephone** fixed ÷ 60.
  These are LOT policy, read from the letters.
- **Special allowance** = the balance. A negative balance is rejected.
- **EPF:** 12% of PF wages, capped at the ceiling. The ceiling is **₹25,000/month from 17 Sep 2026** (was
  ₹15,000), so up to ₹3,000/month. Employer and employee shares are shown separately.
- **Not opting in to PF** replaces the plain on/off switch. It needs a reason and only applies where the
  person is eligible to opt out: not already an EPF member, and wages above the ceiling.
- **ESI:** applies when gross is ≤ ₹21,000/month. Employer 3.25% goes in employer cost; employee 0.75% is a
  deduction. Rare at LOT's pay levels, but the intern template can hit it.
- **Professional Tax by work state.** Karnataka: nil below ₹25,000/month gross; above that ₹200/month and
  ₹300 in February (₹2,500/yr). The annexure shows the real monthly figures.
- **Gratuity:** state on the letter whether it is inside or outside CTC. Today's letters are silent; it is
  not in the annexure.
- **Wages check (Labour Codes):** Basic at 50% of fixed meets the 50% wage rule. Keep that rule as a
  validation, so a future template can't drop below it.
- Rounding: compute at full precision, display to the rupee.
- Regression fixtures: the three mailbox letters must still reproduce exactly under the **pre-17-Sep rule
  set**. New offers use the current one.

### Offer state machine

`draft → (pending_approval → approved | approval_rejected) → ready → sent → accepted | declined | expired`,
plus `withdrawn` (by LOT, any time before joining) and `superseded`.

- **In band** goes from draft straight to `ready`. **Above band** goes through approval.
- **Inside the band check:** total CTC plus any joining or retention bonus. *Any* one-time cash extra needs
  the approver, whether or not it sits "outside CTC" — that closes the extras loophole. Below band min: no
  approval, but flagged.
- **Changing approved terms voids the approval.**
- `valid_until` (default 7 days) sets `expired`. A late acceptance needs a fresh send.
- A **new revision supersedes the old one only when it is sent.** Until then, the old one stays live.
- Each signed document binds to one revision. Only one accepted revision per application.
- A change after acceptance (e.g. joining date) is an **amendment revision** that needs re-acceptance.
  Declined, then re-offered, is a new revision on the same application.

### PDF and sending (Core, without O1)

- The PDF is rendered **server-side** (Cloudflare Browser Rendering, or equivalent) from the frozen HTML,
  stored with a SHA-256 hash. The issued file is the record, not a re-render.
- Footer: `offer_ref` (OFR-2026-NNN).
- Core includes **"Mark as sent"**: record who sent it, to whom, when, and attach the email, or upload the
  exact PDF sent. It also includes **"Record acceptance"**: the signed copy plus the date. Without O1, this
  is how the lifecycle still works.

## C4 — Bulk CV upload

1. Pick an opening that has a JD, then drop 1–100 CVs (PDF/DOCX/scans; size and type limits).
2. Files land in a **staging area** (`cv_imports` batch + per-file rows). An abandoned batch is purged after
   7 days.
3. Per-file jobs are resumable and idempotent (hash of the file), with bounded concurrency and retry with
   backoff.
4. Extraction uses the Claude API (`claude-haiku-5-5`; Sonnet on low confidence).
   - **CV text is untrusted input.** Output is schema-validated, and salary or experience claims carry the
     quoted source line.
   - No inferred sensitive attributes (age, religion, etc.).
   - Model and prompt version are recorded, and so are HR's corrections.
5. Review-and-confirm grid: duplicates flagged by email/phone, manual entry if extraction fails. Confirmed
   rows → candidate + application + CV document.
6. Needs an `ANTHROPIC_API_KEY`. Commercial API terms don't train on inputs. Confirm the retention terms
   once, at key creation.

## Privacy (DPDP readiness)

The DPDP Act's core duties commence on a phased schedule (not all in force today). Build to them now, since
adding them later means rewriting data flows:
- **Notice:** record each candidate's source, and the notice version shown or sent, with a line in the offer
  and outreach emails. Referral and agency CVs record who supplied them.
- **Retention:** non-joiners are deleted after the agreed period (decision 6) unless moved to a talent pool,
  which needs its own consent flag.
- **Deletion is real:** bucket files, staging, extracted text and rows go, leaving a minimal audit stub
  (code, dates, outcome).
- **Erasure on request:** a verified flow handled by HR.

## Audit

- Keep today's `comp_access_log` coverage, including allow-list reads.
- Extend it to opening, application and offer reads that carry salary, including PDF downloads and exports.
- Append-only events for:
  - budget changes, chain changes and approvals;
  - revisions, sends, acceptances and withdrawals;
  - document uploads, downloads and deletes;
  - merges, deletions and Directory pairings.

---

## O1 — Send / draft from Gmail (Optional)

- Sends from the **hiring owner's** Gmail via service-account impersonation (`gmail.compose` on domain-wide
  delegation). The worker only impersonates the hiring owner or reporting manager of that opening, never
  any address.
- The email copies today's wording: congratulations, role and start date, "confirm with a signed copy",
  and the joining-document ask (moved to O4 if built).
- Recipients are checked against the salary rule (decision 4). The attachment and recipients are frozen.
- A send intent is stored first, then reconciled with Gmail, so a timeout can't cause a double send.
- A draft is not a send. Revisions are sent as a reply in the same thread.

## O2 — Interview rounds + feedback (Optional)

- **Rounds:** each opening has a round plan, with default interviewers and a scorecard per round.
- **Interviews:** one per application and round, recording the time, interviewers, mode, status and the JD
  version.
- **Feedback:** a 1–5 rating, a recommendation, scorecard scores and notes. It is **hidden from other
  interviewers until they submit their own**, with a due date of 24h after the interview and a reminder.
- **Round verdict:** advance / reject / hold.
- **What interviewers see:** their assigned applications and the CV. No salary fields, no payslips. A CV
  that mentions its own CTC is accepted as is; no redaction.

## O3 — One-click Calendar scheduling (Optional)

- Creates a Calendar event (`calendar.events`) on the organiser's calendar. The organiser must be in the
  opening's chain or an assigned interviewer. The event has a Meet link and a **Podium link** for internal
  guests.
- The **candidate gets a separate invite** with only the time and the Meet link, and no internal link.
- Guests can't modify the event or invite others.
- Podium stores the event and calendar ids and the timezone, and is idempotent. Reschedule and cancel
  sync both ways, and direct Calendar edits are reconciled on open.
- The JD gate, opening status and interviewer scope are rechecked server-side.

## O4 — Candidate document-upload link (Optional, recommended)

- A single-use, expiring link (e.g. 7 days) lets the candidate upload the joining documents straight into
  the private bucket. That covers the signed offer, payslips, a masked Aadhaar or alternative ID, PAN, bank
  details and the relieving letter.
- It removes the main privacy weakness in today's flow: Aadhaar and PAN emailed to a thread with four or
  five people on CC.

---

## Good-to-haves (not scoped into a module yet)

- **Nudges:** pending approvals, feedback owed, offers expiring and joinings due, as a Slack DM or email to
  the owner. Without these, approvals sit.
- **Next action + owner + due date** on each application. An "aging" view of who has been stuck in a stage
  longer than N days.
- **Hiring analytics:** time-to-hire, offer acceptance rate, source effectiveness, funnel per opening. The
  event log already captures what's needed.
- **Referral bonus tracking:** referrer, payout after N months, linked to `payouts`.
- **Regret email template** for rejected candidates.
- **Pre-joining checklist completion:** each item gets a verifier and a time (documents verified, background
  or reference check, employment agreement signed).
- **Onboarding hand-off after joining:** laptop, email, ID card, RazorpayX setup, UAN.
- **E-sign** (Aadhaar eSign / Leegality) instead of scanned signatures.
- **Cutover:** at launch, load the hires already in flight as openings and applications, so the "No offer on
  record" rule doesn't block them.

## Hard to change later — settle in the build plan, before the first migration

1. Person vs application split (C2).
2. Candidate documents in their own table, plus the copy-on-joining rule (C2).
3. The components keys written into `compensation_events` (the payouts contract).
4. Effective-dated statutory rule sets, and offers pinning rule-set + template + budget versions.
5. Band on total CTC, and versioned opening budgets.
6. Issued PDF + hash as the record (server-side rendering choice).
7. Approver snapshot + no self-approval.
8. Rehire = reactivate the existing employee row.
9. Bucket path layout and the retention/deletion model.

## Build order

C1 + C2 → C3 → C4 → then O4, O1, O2, O3 as picked. Each module gets a manual chapter when it goes live.

Sources for the statutory changes: EPF ceiling ₹25,000 from 17 Sep 2026
([CorpLaw Updates](https://www.corplawupdates.in/updates/epfo-wage-ceiling-rs-25000-cabinet-approval-2026),
[EPFO FAQ](https://www.sgcms.com/regulatory-updates/wp-content/uploads/2026/09/EPFO_Wage_Ceiling_FAQs.pdf)) —
confirm against the gazette (S.O. 5109(E)) before go-live. Karnataka PT
([Commercial Taxes FAQ](https://ptax.karnataka.gov.in/ptemployer/FAQ),
[Feb-2026 ₹300 advisory](https://ascent-hr.com/en-ae/?p=37390)). ESI ([ESIC](https://esic.gov.in/attachments/esistatedirectoratefile/ef84365f31f15306ddb397902d675858.pdf)).
