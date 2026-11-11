# Podium — Hiring module (scope)

> 2026-11-11 · status **SCOPE v2 — not built** · owner Afshaan · system Podium (`podiumops` + `apps/podium`)
> v2 (same day) folds in Afshaan's answers: openings with salary bands move into Core; over-band offers need
> the manager above; hiring managers see their own candidates' numbers; calendar invites carry a Podium link;
> one standard letter, reverse-engineered from the letters in Afshaan's mailbox (§C3).

## Goal

Every hire's paper trail lives in Podium from opening to joining day, and **no offer letter leaves
LOT unless Podium generated and recorded it.** The candidate record becomes the employee's HR record
when they join; nothing is re-keyed.

| # | Module | Tier | Depends on | Size |
|---|---|---|---|---|
| C1 | Openings: role, reporting manager, salary band | Core | — | 1 session (with C2) |
| C2 | Candidate record + HR documents, assigned to an opening | Core | C1 | ↑ |
| C3 | Offer letter: standard template, salary calculator, revisions, over-band approval, PDF | Core | C1, C2 | 2 sessions |
| C4 | Bulk CV upload → candidate profiles | Core | C2 + an Anthropic API key | 1 session |
| O1 | Send / draft the offer email from Podium | Optional | C3 + a Workspace scope | 1 session |
| O2 | Interview rounds + feedback per round | Optional | C1, C2 | 1–2 sessions |
| O3 | One-click interview scheduling on Google Calendar (Podium link to the CV) | Optional | O2 + a Workspace scope | 1 session |

---

## What already exists (reuse, don't rebuild)

- `podium.documents` + the private `podium-documents` bucket, signed-URL-only (RULE-PODIUM-003).
- `podium.job_roles` (title, JD, salary band) — an opening starts from a job role and inherits its band.
- `podium.employees.manager_id` — the solid-line chain decides who approves (C3).
- `podium.compensation_events` — an accepted offer becomes the employee's `initial` event on joining.
- `podium.comp_access_log` — every salary read outside the allow-list is logged here.
- The appraisal letter print view (`/appraisals/letter`) — the pattern for the offer-letter render.
- The Google service account with domain-wide delegation (`GOOGLE_SA_JSON`, already on podiumops).
- Google Directory sync's review-and-confirm import — the joining step hooks into it (C2 "Joining").

---

## C1 — Openings (Core)

The person hiring creates an **opening** and places it under a reporting manager; CVs are then
assigned to it.

`openings`: `opening_code` (OPN-NNN), `job_role_id`, designation (defaults to the role title, editable —
letters use designations like "Assistant Store Manager" that differ from the role name), department,
**reporting manager** (`reporting_manager_employee_id`), **hiring owner** (`hiring_owner_employee_id` —
the person running it, e.g. Finance or the team lead; defaults to the creator), location, headcount,
**salary band** (fixed-pay min / max, annual; variable target optional), target joining date, status
`open / on_hold / filled / cancelled`, notes.

- Band pre-fills from the job role's band and can be changed.
- **Approver** = the reporting manager's own manager (one step up the solid `manager_id` chain), computed
  and shown on the opening. In practice this resolves to Vinay or Afshaan. If the reporting manager is a
  founder, the other founder approves. Either founder can always approve.
- Screens: `/hiring/openings` (list + counts per opening: candidates, offers out, accepted, headcount left) ·
  opening detail (band, approver, its candidates by status).

## C2 — Candidate record + HR documents (Core)

- `candidates`: `candidate_code` (CAN-NNNN, immutable), `opening_id`, full name, personal email, phone,
  location, source (referral / LinkedIn / Naukri / campus / walk-in / agency / other) + referrer, current
  employer + title, total experience, current CTC, expected CTC, notice period, `status`,
  `rejection_reason`, notes, `employee_id` (set on joining).
- `status`: `new → screening → interviewing → offer → accepted → joined`, plus `rejected` / `declined` /
  `withdrawn` / `on_hold`. Every change writes a `candidate_events` row (who, when, from→to, note).
- A candidate can be **moved to another opening** (logged) — common when someone fits a different role.
- `documents` gains a nullable `candidate_id`; a CHECK requires `employee_id` or `candidate_id`. New
  `doc_type`s: `cv`, `id_proof` (Aadhaar), `pan`, `address_proof`, `education`, `experience_letter`,
  `relieving_letter`, `payslip`, `bank`, `photo`, `signed_offer`, `other`.
- **Joining checklist** on the profile, matching what LOT asks for today in the offer email: signed offer,
  previous salary slips, Aadhaar, PAN (+ bank, relieving letter, photo).
- Screens: `/hiring` (all candidates: status chips, opening/manager filters, search) · `/hiring/detail`
  (tabs: Profile · Documents · Offers · Timeline).

**Joining (hand-off to the employee record).** Podium never creates an employee without a work login.
1. Candidate is `accepted` with an accepted offer.
2. IT creates their Workspace account as today.
3. Directory sync's preview **matches the new joiner to the accepted candidate** (HR confirms the pairing);
   on import it creates the employee with department, role, reporting manager and joining date from the
   offer; re-points the candidate's documents to the new `employee_id`; writes the `initial`
   `compensation_events` row from the accepted offer (dated to the joining date); marks the candidate
   `joined` and decrements the opening's headcount (→ `filled` at zero).
4. A new joiner in the sync with **no accepted Podium offer** is flagged "No offer on record" — this is
   how "no offer goes without Podium" is enforced, not just stated.

**Who sees what.**
- New permission key **`podium_hiring`** (+ preset role "Hiring"): create openings, see all openings and
  candidates.
- Without the key, a person sees openings where they are the **hiring owner**, the **reporting manager**,
  or the **approver**, and those openings' candidates.
- **Salary numbers** (band, current/expected CTC, offers) are visible to: the hiring owner, the reporting
  manager and the approver *for that opening only*, plus the salary allow-list. `podium_hiring` alone does
  **not** show numbers. Every read by someone outside the allow-list writes a `comp_access_log` row.
  → This is a recorded amendment to RULE-PODIUM-002 (Afshaan, 2026-11-11): offer salaries are scoped to
  the opening's chain; employee salaries stay allow-list-only.

---

## C3 — Offer letter (Core)

### The standard letter (taken from the letters in Afshaan's mailbox)

LOT sends one letter type, **"Offer of Employment"**, written today as a Google Doc copy by whoever is
hiring (Mahesh, Piyush, Kirti, Karan, Mohit, Afshaan). There is no separate joining letter; the letter
refers to an employment agreement, which stays outside Podium for now. Structure, page 1:

- **Letterhead:** Fraternitas Ventures Private Limited, the Kalyanagar address, and the **signatory's
  phone number**.
- "Offer of Employment", date, "Dear {name},".
- Reference to discussions; offer to join Fraternitas Ventures Private Limited (Legend of Toys).
- Fixed salary per annum, "before all customary payroll deductions", paid monthly; plus **variable *or*
  incentive pay** of up to X per annum, **paid half-yearly**.
- Start date "on or before …", designation, optional department, location (Bangalore).
- Standard confidentiality / non-compete paragraph; other terms per the employment agreement.
- Probation sentence (2 or 3 months; sometimes omitted).
- Confirm by sending a signed copy over email. "Let's build together!" Regards, signatory. Optional
  signature line.

Page 2, **Annexure I: CTC Break Up** (Annual / Monthly).

Today's letters vary in date format, rupee format ("4,32,000" vs "570000/-") and wording ("before … or
before"). Podium standardises these; the text is otherwise kept as is.

### Salary calculator

Input: **annual fixed pay** (F), variable/incentive amount (V) and its label, and a **PF on/off** switch.

| Line | Rule |
|---|---|
| Basic | 50% of F |
| HRA | 50% of Basic |
| Travel reimbursement | F ÷ 15 |
| Telephone reimbursement | F ÷ 60 |
| Employer's PF | ₹1,800/month (12% of the ₹15,000 wage ceiling); 0 if PF off |
| Employee's PF | ₹1,800/month; 0 if PF off |
| Professional Tax | ₹200/month |
| Special allowance | the balance: F − all of the above |
| Gross total | Basic + HRA + Special + Travel + Telephone |
| Total fixed | F |
| Variable / Incentive | V |
| Total CTC | F + V |

Computed at full precision, rounded to the rupee only for display (monthly = annual ÷ 12). **Checked
2026-11-11: this reproduces all three letters read (Jul–Aug 2026; one with PF off) to the rupee.**
The rules are stored on the template as data, so a change to the structure is an edit in Podium, not a
code change. Optional footnote toggle: "Medical insurance premium will be over and above your CTC".

⚠️ For your eye, not changed: the annexure puts **both** employer's and employee's PF inside fixed pay, so
employee PF lowers the gross shown rather than being deducted from it. Podium copies today's structure
exactly; say if you want that revisited.

### Templates

`offer_templates`: the letter body with merge fields, the salary rules above, the letterhead, versioned —
an edit creates a new version and every offer stores the version it used, so an old letter re-renders
exactly as sent. **One standard template** to start; more can be added later.

Merge fields: `{{candidate_name}}`, `{{issue_date}}`, `{{fixed_annual}}`, `{{variable_label}}` (variable /
incentive), `{{variable_annual}}`, `{{variable_frequency}}` (half-yearly), `{{start_date}}`,
`{{designation}}`, `{{department}}` (optional), `{{location}}`, `{{probation_months}}` (optional),
`{{signatory_name}}`, `{{signatory_phone}}`, `{{annexure}}`, `{{offer_ref}}`.

### Offers, revisions and approval

`offers`: candidate, opening, `revision_no`, inputs (F, V, label, PF switch, start date, designation,
probation, signatory), the computed annexure and rendered letter (both frozen), PDF in the private bucket,
`offer_ref` (OFR-2026-NNN, in the footer), status
`draft → pending_approval → approved → sent → accepted / declined / expired`, plus `superseded`.

- **Within band → no approval.** The hiring owner or reporting manager generates and sends it.
- **Above the band max** (fixed pay, or total CTC if the opening sets a CTC cap) → `pending_approval`; the
  approver (C1) gets it on their Podium home and approves or rejects with a note. The approval is stored on
  the offer.
- **Negotiation = a new revision** with a reason ("candidate countered", "added joining bonus"); the
  previous revision becomes `superseded`. Sent revisions are immutable. The Offers tab shows the
  revisions side by side with the changes highlighted. (Revised offers already happen — two of the
  mailbox threads carry an "updated" or "revised" letter.)
- **Extras** as line items: joining bonus (with clawback months), retention bonus, relocation, devices,
  other — each marked inside or outside CTC. Anything outside the standard annexure prints as an extra
  annexure row or paragraph. These count toward the band check when inside CTC.
- **Acceptance:** upload the signed copy (`signed_offer`) and mark accepted. The accepted revision is
  what joining uses.

PDF: an HTML print view on the letterhead (like the appraisal letter), stored in the private bucket.

---

## C4 — Bulk CV upload → candidate profiles (Core)

1. On an opening (or `/hiring/import`), drop 1–100 CVs (PDF, DOCX, scans).
2. Each file goes to the private bucket; the worker sends it to the Claude API (`claude-haiku-5-5`;
   Sonnet only if Haiku misreads) and gets back: name, email, phone, location, current employer/title,
   total experience, skills, education, CTC and notice period if stated. One file per request, driven
   by the browser, so 100 CVs never hit a worker timeout.
3. **Review-and-confirm** grid: editable rows, duplicates flagged against existing candidates and
   employees by email/phone, low-confidence fields highlighted. Nothing is written until confirmed.
   Confirmed rows become candidates on that opening with the CV as their first document.

Needs an `ANTHROPIC_API_KEY` on podiumops (you create it in the Anthropic console).

---

## O1 — Send / draft the offer email from Podium (Optional)

"Create draft" / "Send" on an approved offer. Sends from the **hiring owner's own Gmail** through the
service account (impersonation), so replies come back to them. The email copies what LOT sends today:
- To the candidate; **CC hr@legendoftoys.com, Afshaan, and the reporting manager** (configurable).
- Body from an editable email template: congratulations, role and start date, "confirm by sending a signed
  copy over email", and the joining-document ask (previous salary slips, Aadhaar, PAN).
- PDF attached. A **revision is sent as a reply in the same Gmail thread**, as happens today.
- Podium stores the Gmail message + thread id on the offer and moves it to `sent`.
- Setup: add `gmail.compose` to the service account's domain-wide delegation (Workspace Admin, your login).

## O2 — Interview rounds + feedback (Optional)

(Openings moved into Core, so this is now only the interview layer.)
- Each opening has a **round plan** (e.g. HR screen → Technical → Founder) with default interviewers and a
  short scorecard per round.
- Candidates move through rounds on a board (columns = rounds).
- `interviews`: candidate × round, time, interviewers, mode, status (scheduled / done / no-show / cancelled).
- `interview_feedback`: per interviewer — 1–5 rating, recommendation (strong no → strong yes), scorecard
  scores, notes. **Hidden from other interviewers until they submit their own.** Round verdict: advance /
  reject / hold.
- Interviewers see only their assigned candidates and the CV — never salary numbers.

## O3 — One-click interview scheduling (Optional, after O2)

Pick date + time + duration → "Schedule". Podium creates a Google Calendar event on the organiser's
calendar with the interviewers as guests, a Meet link, the round name, and **a link to the candidate's
Podium page** (sign-in required; the CV never leaves the private bucket). Reschedule/cancel in Podium
updates the event. Candidate not invited unless toggled. Setup: add `calendar.events` to domain-wide
delegation. (Attaching the CV file itself would need Drive; parked until the link has been tried.)

---

## Still open

1. **Does the band on an opening need approval when it's set?** As scoped, the person creating the opening
   sets the band and only over-band offers go up. That means a band typed in high skips approval.
   Recommendation: the approver confirms the opening's band once when it's created (one click); every offer
   inside it then goes out without asking.

## Build order

C1 + C2 together → C3 → C4 → then O1, O2, O3 as picked. Each ships behind `podium_hiring` and gets a
manual chapter when it goes live.
