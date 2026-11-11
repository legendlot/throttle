# Podium — Hiring module (scope)

> 2026-11-11 · status **SCOPE v3 — not built** · owner Afshaan · system Podium (`podiumops` + `apps/podium`)
> v2: Afshaan's answers (openings + bands in Core, over-band → manager above, hiring chain sees its own
> numbers, calendar = Podium link, one standard letter from the mailbox letters). v2.1: JD gate.
> **v3: merged review — Codex (gpt-6-astra, 25 findings) + a self-review against the live schema.** Biggest
> changes: candidate person vs application split; statutory calculator rules made effective-dated (PF ceiling
> and Karnataka PT have changed since the letters were written); a full offer state machine; atomic joining;
> candidate documents in their own table; retention + deletion; approval-bypass and self-approval closed.
> **v3.1: the six open decisions settled (Afshaan: "yes, all six"); NEW O1 = offer email + candidate
> acceptance link, modelled on Ignition's deal-contract link (S441). The old O4 upload link folds into it.
> v3.2: corrections — hr@ is CC'd on every offer; CTC includes PF + PT (shown as deductions → in-hand).**
> **v4 (2026-11-11, later): C1+C2 and C3 are LIVE. The lifecycle extends past hiring — J1 (Podium creates the
> Workspace account + employee; replaces the Directory-pairing hand-off), J2 (onboarding for joiners and a
> one-time profile completion for existing staff), X1 (exits + no-dues). See "Employee lifecycle" below.**

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
| O1 | Offer email + acceptance link (accept / decline / question → confirmation email → joining documents) | Optional, **build right after C3** | C3 + Workspace scope | 2 sessions |
| O2 | Interview rounds + feedback | Optional | C1, C2 | 1–2 sessions |
| O3 | One-click Calendar scheduling (Podium link) | Optional | O2 + Workspace scope | 1 session |

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
6. **The approver confirms an opening's band at creation and on any increase** (one click); offers inside
   it go freely.
7. **CTC always includes PF and PT (Afshaan, corrected same day).** The offer quotes CTC; employer PF,
   employee PF and PT all sit inside it, exactly as today's annexure. They are deductions, and the annexure
   adds a **"Deductions → estimated monthly in-hand"** block so the candidate sees take-home:
   in-hand = CTC/12 − variable/12 − employer PF − employee PF − PT (− ESI), before income-tax TDS.
   (Under this reading today's "Gross Total" line equals that in-hand figure.)
8. **A second template for interns** ("Internship Offer": monthly stipend; no PF, PT or variable by default).
9. **HR is copied on every offer letter: CC hr@legendoftoys.com + the opening's chain + Afshaan.** hr@
   readers therefore see offer salaries by email — a deliberate exception to decision 1, which governs
   access inside Podium.
10. **A new joiner with no accepted Podium offer is blocked at Directory-sync import**; an HR override needs
    a written reason and is logged.
11. **Non-joiners' CVs and documents are deleted after 12 months** unless moved to a talent pool.

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
  Never send it through CV extraction. Collected through the O1 acceptance link, not email.
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

**Joining hand-off (atomic).** ⚠️ **v4: superseded by J1** — Podium creates the Workspace account, so there
is nothing to pair. Steps 3–6 below (one idempotent DB function: employee or rehire-reactivate, documents copied,
`initial` compensation event via the components contract, headcount, application `joined`; actual start date
confirmed by HR) still hold and move into J1 unchanged.
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
- **Layout (decision 7):** today's annexure unchanged — earnings lines, Gross Total, employer PF, employee PF,
  PT, Total Fixed, Variable, Total CTC — plus a new deductions → estimated monthly in-hand block below it.
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
  is how the lifecycle still works, and it stays as the fallback once O1 exists.

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

## O1 — Offer email + acceptance link (Optional — build right after C3)

Modelled on Ignition's deal-contract link (S441, `systems/ignition.md` §S441), where a creator opens a link,
accepts the contract and submits bank details with no login. The same shape works here: **one email from
Podium carries the offer PDF and a personal link; the candidate accepts (or declines, or asks a question)
on that page; Podium records it, emails the confirmation, then asks for the joining documents.**

**1. Send.**
- "Send offer" on a `ready` offer sends it from the **hiring owner's Gmail** (service-account impersonation,
  `gmail.compose` + `gmail.send` on domain-wide delegation). The worker only ever impersonates the hiring
  owner or reporting manager of that opening, never an arbitrary address.
- To the candidate; CC hr@ + the chain + Afshaan (decision 9).
- The body uses today's wording (congratulations, role, start date), plus the button **"View and respond to
  your offer"**. The PDF is attached too.
- Each send creates a send intent first, then reconciles with Gmail, so a timeout can't double-send.
- A draft is not a send.
- A revision goes as a reply in the same Gmail thread, with a fresh link.

**2. The link.**
- `podium.legendoftoys.com/offer/?t=<token>`. The token is 32 random bytes; **only its SHA-256 hash is
  stored**, never the link (as Ignition does).
- One live link per offer revision. It expires at `valid_until`. Sending a new revision kills the old link.
- Public API `/public/offer*` sits before the login gate and is rate-limited; the page is `noindex`.
- **Reading is GET; every action is POST**, because mail scanners follow GET links and must never accept an
  offer by accident.
- A superseded, withdrawn or expired offer returns only a short notice ("This offer has been replaced —
  check your latest email" / "This offer has expired — contact <hiring owner>"). Never the letter.
- The page shows only that candidate's name, the role, the letter and the annexure. No other Podium data.

**3. The candidate's response (the feedback loop).** Three choices:
- **Accept.** They type their full name (it must match the name on the offer, ignoring case and spacing),
  confirm the joining date, and tick "I have read and accept this offer". Podium then:
  - records an **acceptance evidence row** (`offer_acceptances`): offer and revision, the issued PDF's
    SHA-256, the typed name, the confirmed date, time, IP, user agent, and the token's hash;
  - generates an **acceptance certificate page**, appends it to the issued PDF, and stores the result as the
    `signed_offer` document;
  - moves the offer to `accepted` and the application to `accepted`. The headcount check is atomic: if the
    seat was filled meanwhile, the candidate sees "we'll be in touch" and the hiring owner is alerted,
    instead of a second acceptance landing.
- **Decline** — a reason (picklist: compensation, role, location, another offer, personal, other + free
  text). The offer becomes `declined` and the reason feeds hiring analytics.
- **I have a question / want to discuss** — free text, and optionally "a different joining date". Nothing
  changes state. The hiring owner is notified (email + Podium home) and normally answers with a revision.
  This is the negotiation loop: question → revision → a new link.

**4. On acceptance — confirmation email.**
- Sent automatically from the hiring owner's Gmail, in the same thread. To the candidate; CC hr@ + the
  chain + Afshaan.
- Body: "Thank you — your acceptance of <role> is recorded", the joining date, what happens next, and the
  accepted PDF with its certificate page attached.
- Plus a Podium-home notification for the hiring owner and reporting manager.

**5. Joining documents (Ignition's "bank details" step).**
- Straight after accepting, the same page moves to step 2: upload into the private bucket the previous
  payslips, PAN, a masked Aadhaar or an alternative ID, address proof, the relieving letter (when they have
  it), a photo, and bank details (account, IFSC, a cancelled cheque).
- The link stays valid for this step until the joining date + 7 days. They can return to it any time.
- **Bank details:** stored service-role-only, column names aligned with `store.payment_payees` (as Ignition
  does). Shown masked everywhere. Only the salary allow-list (Finance) can reveal the full number, logged,
  because Finance enters it into RazorpayX.
  - First submit is insert-or-ignore. A change needs HR to issue a one-time "allow update" (Ignition's
    `allowBankUpdate` pattern).
- Each upload ticks the joining checklist (C2). HR verifies each item (verifier + time).
- **This replaces emailing Aadhaar and PAN to a thread with several people on CC.**

**Why this counts as a legitimate record:**
- **Legally:** an electronic acceptance is a valid contract under the IT Act 2000 (s.10A).
- **Evidence:** the typed name, the timestamp, the IP and the hash of the exact PDF prove what was accepted,
  by whom and when.
- **Integrity:** the issued PDF is immutable, so the hash ties the acceptance to one document.
- **Fallback and upgrade:** a scanned signed copy (C3 "Record acceptance") still works for anyone who
  replies by email. Aadhaar eSign stays a good-to-have.

**Build note:** copy Ignition's pieces, don't share them across workers. That means the pure-rules module
(`ignitionops-worker/src/contract.js`), the `/public/*`-before-JWT routing, token-hash storage, the
POST-only accept and the closed-state response. The Podium app's public `/offer` route sits outside the
`(auth)` layout. Ignition's live proof (S441) covers send → accept → bank save; the bank-update path was
only route-tested, so prove it live here.

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

## Employee lifecycle — J1 account creation · J2 onboarding · X1 exits (v4)

**Why.** Podium should be where a person's employment starts and ends, not a mirror of Google updated by hand.
Measured 2026-11-11:
- **Joiners:** IT creates the Google account, then HR runs Directory sync (`/people` → preview → confirm;
  RULE-PODIUM-007; `podiumops-worker/src/index.js` ~1566-1690). Podium's Google token is
  **read-only** (`admin.directory.user.readonly`, index.js ~208). No write scope is used anywhere in the fleet.
- **Exits:** manual `updateEmployee` → exited, or the sync's "suspended in Google / no Google account" review
  item (index.js ~1678-1686). Reports are reassigned on exit (RULE-PODIUM-010). There is no checklist, and no
  Snorkel asset check. **4 of 19 exits have no reason**, including the two most recent (EMP-004, EMP-031).
  **3 have dates derived from the final payslip**, not HR-confirmed.
- **Onboarding:** none. The register gaps (DOB 19 · PAN 15 · DOJ 8 · job_title 8 blank of 62, 2026-09-21) are
  deferred by decision: **"the fix is a JOINER CHECKLIST"** (`reference/decisions.md`, S396). J2 is that.
- **No-dues checklist:** not found in Drive, Gmail or Slack (searched 2026-11-11). Afshaan to share it, or X1
  ships the draft below.

### J1 — Podium creates the work account + the employee (replaces the Directory pairing)

- **Trigger:** an application with an `accepted` offer → HR clicks **"Create work account"**.
- **Address:** Podium proposes it per the naming convention (decision L1) and checks availability with
  `users.get`. HR can edit it. Collisions get a suffix suggestion, never an automatic one.
- **One action, in this order:**
  1. Admin SDK `users.insert`: name, primary email, org unit (from the department, decision L2), random temp
     password with `changePasswordAtNextLogin`.
  2. The J1 joining function (the old hand-off steps 3–6): employee row with `google_user_id` + `work_email`
     set from birth, or a rehire reactivation; documents copied; `initial` compensation event (components
     contract); headcount; application `joined` when HR confirms the actual start date.
  3. The temp credentials are shown **once** to HR, to hand over on day one, and never stored. They are not
     emailed: the personal-email route waits for O1's mail plumbing.
- **Idempotent and recoverable.** If the Google call succeeds but the DB step fails, a retry finds the user by
  email and links it, never creating a second account. The pending account is stored before the call.
- **Directory sync stays as reconciliation only:** anything created in Google outside Podium shows as
  **"created outside Podium"** for HR to adopt or ignore. That is the RULE-PODIUM-007 preview, repurposed.
- **Identity rule kept:** an employee row only ever exists with a real Workspace login (memory "never
  auto-create employees" → intent preserved: the row is born with the account, by an explicit human action).
- **Gate (Afshaan, Admin console — a security setting, his to do):** add
  `https://www.googleapis.com/auth/admin.directory.user` (write) to the existing service account's
  domain-wide delegation. That scope can create **and suspend** any user, so:
  - only HR + founders get the button (decision L3);
  - every call is logged (actor, action, target email, result) in a `podium.google_admin_log`;
  - the worker uses the write scope only in these handlers. Reads keep the readonly token.
- **Amends RULE-PODIUM-007** (sync was read-only by rule) — record the amendment in `decisions.md` when built.
- **Also lands here:** "no accepted Podium offer → blocked" (decision 10). A Google account can't be created
  for anyone without one. An HR override needs a written reason and is logged.

### J2 — Onboarding (joiners) + profile completion (everyone, once)

- **Joiner self-serve** (`/onboarding`, opened by the new Google login, no Podium role needed — self-scoped like
  My Performance):
  - **Profile:** DOB, gender, blood group, PAN, address, personal email/phone, emergency contact, bank account +
    IFSC, PF UAN, ESIC no., previous employer's taxable salary + TDS for the FY. **These are exactly the
    XPayroll onboarding sheet's fields** (Drive "XPayroll-Onboarding-v1-2"), so payroll setup is one export.
  - **Documents:** ID proof, PAN, address proof, education, previous relieving letter, photo. Candidate documents
    (CV, signed offer) carry over from hiring. Bank / ID / PAN are HR-only visibility, as candidate docs today.
  - **Acknowledgements:** policies the employee reads and accepts (list = decision L4), timestamped.
- **Owner tasks** (each a checklist line with an owner and a due date relative to the start date):
  - IT: laptop issued as a **Snorkel asset assignment** (custodian = the employee — so X1 can check it back);
    app access (LOT apps: Podium role / users_profile).
  - Manager: first-week plan, probation goals (links to the existing OKR objects), buddy.
  - HR: payroll set up (XPayroll export done), PF/ESI registration, probation end date set (from the offer's
    probation months), welcome email.
- **Templates:** the checklist is a versioned template per employment type (full-time / intern). Lines are
  added in admin, not code.
- **Completion:**
  - an onboarding is complete when every required line is done;
  - HR sees a board of joiners × lines, with overdue lines highlighted;
  - nothing blocks payroll in Podium — this records, it doesn't gate RazorpayX.
- **Everyone, once ("profile completion"):** the same self-serve profile + documents for the current actives.
  - HR launches it as a campaign.
  - Each employee sees "Complete your profile" on their Podium home until done.
  - HR sees per-field completion.
  - This closes the S396 register gaps at the source; afterwards the profile stays editable by the employee
    with HR approval on PAN/bank changes.

### X1 — Exits + no-dues (the exit is recorded because it can only happen in Podium)

**1. Start.** Either the employee clicks **Resign**, or the manager/HR starts the exit. Both capture:
- a reason code: resignation / termination / absconding / end of internship / end of contract / other;
- the notice date;
- the last working day (LWD) — from the notice period, overridable by HR with a reason;
- whether the person is eligible for rehire, recorded privately.

The employee status becomes `notice` (a new status; still active for everything else).

**2. No-dues checklist**, auto-built. Each line has an owner who signs it off, with a note and optional evidence:

| Line | Owner | Source / check |
|---|---|---|
| Assets returned | Store / IT | **Live from Snorkel** — every asset with `custodian_user_id` = the employee's auth user. The line can't be cleared while any remain assigned. |
| Google account | automatic | Suspended on LWD (decision L5); Drive ownership transferred to the manager (Data Transfer API — needs the `admin.datatransfer` scope; optional, decision L6) |
| LOT app access | automatic | `users_profile` / Podium roles revoked on LWD |
| Other tools (Slack, Shopify, Amazon/Flipkart seller, bank portals …) | IT | manual ticks; list = decision L4 |
| Advances / reimbursements / imprest | Finance | open items listed from Snorkel payment requests where the requester is the employee |
| Handover | Manager | free text + link; reports reassigned (RULE-PODIUM-010) |
| Full & final | Finance / HR | recorded: amount, date, payslip/F&F statement upload. Computed in RazorpayX, not Podium (decision L7) |
| Relieving + experience letters | HR | generated from versioned templates, using the offer-letter engine (pdf-lib, hash stored) and issued after F&F |
| Exit interview | HR | optional, short form |

**3. Close.** The exit closes only when every required line is cleared. Then:
- status `exited`, `date_exited` = LWD, reason required (the DB enforces it);
- comp access ends;
- the employee's documents follow retention rules.

There is **no other path to `exited`** — the manual `updateEmployee` → exited route is removed, so an exit
can't be recorded without its record.

**4. Exits started outside Podium.** The Directory-sync "suspended in Google but active in Podium" item becomes
a red alert: "an exit was started outside Podium — start the exit here". It never auto-exits.

**5. Backfill.** The 4 exits with no reason and the 3 payslip-derived dates get a one-time HR review screen. No
guessing.

### Decisions needed (Afshaan)

- **L1** Email format: `firstname@` or `firstname.lastname@` (collision rule).
- **L2** Org unit per department, or a flat OU.
- **L3** Who can create accounts (HR + founders proposed).
- **L4** The policy acknowledgement list and the "other tools" exit list.
- **L5** Google suspension: automatic at the end of LWD, or an HR click on the day.
- **L6** Drive transfer to the manager: yes/no. This needs the extra `admin.datatransfer` scope.
- **L7** F&F: record only (proposed; RazorpayX computes) or compute in Podium.
- **L8** The no-dues checklist: share the current one, or adopt the draft above.

### Lifecycle — hard to change later

- `google_user_id` + `work_email` set at creation and immutable after.
- One exit record per employment, with a reason code; a rehire = a new employment on the same employee row.
- `notice` as a real status.
- Asset custody keyed on the auth user that Snorkel uses.
- The write-scope audit log from day one.

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
10. Acceptance evidence (`offer_acceptances` + PDF hash + certificate page) and token-hash-only link storage.

## Build order

~~C1 + C2 → C3~~ (live 2026-11-11) → **J1** (account + employee; needs the Admin-console scope first) → **X1**
(exits + no-dues — stops unrecorded exits) → **J2** (onboarding + profile completion) → O1 (acceptance link) →
C4 → then O2, O3 as picked. Each module gets a manual chapter when it goes live.

Sources for the statutory changes: EPF ceiling ₹25,000 from 17 Sep 2026
([CorpLaw Updates](https://www.corplawupdates.in/updates/epfo-wage-ceiling-rs-25000-cabinet-approval-2026),
[EPFO FAQ](https://www.sgcms.com/regulatory-updates/wp-content/uploads/2026/09/EPFO_Wage_Ceiling_FAQs.pdf)) —
confirm against the gazette (S.O. 5109(E)) before go-live. Karnataka PT
([Commercial Taxes FAQ](https://ptax.karnataka.gov.in/ptemployer/FAQ),
[Feb-2026 ₹300 advisory](https://ascent-hr.com/en-ae/?p=37390)). ESI ([ESIC](https://esic.gov.in/attachments/esistatedirectoratefile/ef84365f31f15306ddb397902d675858.pdf)).
