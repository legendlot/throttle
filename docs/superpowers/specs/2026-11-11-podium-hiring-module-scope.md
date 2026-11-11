# Podium — Hiring module (scope)

> 2026-11-11 · status **SCOPE — not built** · owner Afshaan · system Podium (`podiumops` + `apps/podium`)
> Inputs still owed by Afshaan: the joining/offer-letter template text and the salary-calculation sheet (§C2).

## Goal

Every hire's paper trail lives in Podium from first CV to joining day, and **no offer letter leaves
LOT unless Podium generated and recorded it.** The candidate record becomes the employee's HR record
when they join; nothing is re-keyed.

Split into **Core** (what you asked for as must-haves) and **Optional upgrades**, each shippable on
its own. Core ships first; the optional upgrades are ordered by value and dependency.

| # | Module | Tier | Depends on | Size |
|---|---|---|---|---|
| C1 | Candidate record + HR documents | Core | — | 1 session |
| C2 | Offer / joining letters: template, salary calculator, revisions, approval, PDF | Core | C1 + your template | 2 sessions |
| C3 | Bulk CV upload → candidate profiles | Core (you asked for it) | C1 + an Anthropic API key | 1 session |
| O1 | Send / draft the offer email from Podium | Optional | C2 + a Workspace scope | 1 session |
| O2 | Hiring pipeline: openings, rounds, feedback per round | Optional | C1 | 2 sessions |
| O3 | One-click interview scheduling on Google Calendar with the CV attached | Optional | O2 + a Workspace scope | 1 session |

---

## What already exists (reuse, don't rebuild)

- `podium.documents` + the private `podium-documents` bucket, signed-URL-only (RULE-PODIUM-003).
  Candidate documents go in the same bucket and the same table.
- `podium.job_roles` with salary bands (comp-gated) — offers are checked against the band.
- `podium.compensation_events` — an accepted offer becomes the employee's `initial` event on joining.
- The appraisal letter print view (`/appraisals/letter`) — the pattern for the offer-letter render.
- The Google service account with domain-wide delegation (`GOOGLE_SA_JSON`, already on podiumops) —
  O1 and O3 add scopes to it; no new credential.
- Google Directory sync's review-and-confirm import — the joining step hooks into it (see C1 "Joining").

---

## C1 — Candidate record + HR documents (Core)

**Tables (new, `podium` schema, RLS-on, service-role-only like every Podium table):**

- `candidates` — `candidate_code` (CAN-NNNN, immutable), full name, personal email, phone, location,
  source (referral / LinkedIn / Naukri / walk-in / agency / other) + referrer, applied-for `job_role_id`,
  `department_id`, `hiring_manager_employee_id`, current employer + title, total experience, current CTC,
  expected CTC, notice period, `status`, `rejection_reason`, notes, `employee_id` (set on joining),
  created_by/at.
- `status`: `new → screening → interviewing → offer → accepted → joined`, plus terminal
  `rejected` / `declined` / `withdrawn` / `on_hold`. Every change writes a `candidate_events` row
  (who, when, from→to, note) — the audit trail.
- `documents` gains a nullable `candidate_id`; a CHECK requires `employee_id` or `candidate_id`. New
  `doc_type`s: `cv`, `id_proof`, `address_proof`, `education`, `experience_letter`, `relieving_letter`,
  `payslip`, `pan`, `bank`, `photo`, `signed_offer`, `other`. Same signed upload/download flow.

**Screens:** `/hiring` (candidate list: status chips, search, role/manager filters) · `/hiring/new` ·
`/hiring/detail` (tabs: Profile · Documents · Offers · Timeline) · a "Documents checklist" on the
profile showing what's still missing before joining (CV, ID, address, PAN, bank, relieving letter).

**Joining (the hand-off to the employee record).** Podium never creates an employee without a work
login (your standing rule). So joining is:
1. Candidate is `accepted` with an accepted offer.
2. IT creates their Workspace account as today.
3. Directory sync's preview **matches the new joiner to the accepted candidate** (by name + joining date,
   HR confirms the pairing) and on import: creates the employee with department, role, manager, joining
   date from the offer; re-points every candidate document to the new `employee_id`; writes the
   `initial` `compensation_events` row from the accepted offer; sets the candidate `joined`.
4. A new joiner in the sync with **no accepted Podium offer** is flagged "No offer on record" — this is
   how "no offer goes without Podium" becomes visible rather than a policy line.

**Access.** New permission key **`podium_hiring`** (+ a preset role "Hiring"): see the candidate list
and profiles, upload documents, move status. Hiring managers see their own candidates without the key.
Salary fields on a candidate (current/expected CTC) follow the offer access rule in C2.

---

## C2 — Offer / joining letters (Core)

**Templates — editable in Podium, versioned.** `offer_templates`: name, legal entity (Fraternitas for
white-collar), letter type (offer / joining / revised offer), body with merge fields, the salary
structure, `version`, active flag. Editing a template creates a new version; every offer stores the
template version it was generated from, so an old letter always re-renders exactly as sent.

Merge fields (first cut — finalised from your template): `{{candidate_name}}`, `{{designation}}`,
`{{department}}`, `{{reporting_manager}}`, `{{location}}`, `{{joining_date}}`, `{{offer_valid_until}}`,
`{{annual_ctc}}`, `{{annual_ctc_words}}`, `{{probation_months}}`, `{{notice_period}}`,
`{{salary_annexure}}`, `{{perks}}`, `{{bonuses}}`, `{{offer_ref}}`, `{{issue_date}}`, `{{signatory}}`.

**Salary calculator — rules live in the template, computed in the worker.** You give the CTC (or the
monthly gross); the template's structure turns it into the annexure. Each component is one of:
percent of CTC, percent of another component (e.g. HRA = 50% of Basic), fixed amount, statutory
(employer PF 12% of Basic with the ₹15,000 wage cap toggle, ESI only under the gross threshold,
Professional Tax, gratuity 4.81% of Basic), or balancing (Special Allowance = whatever makes the total
hit CTC). Output = monthly + annual per component, gross, employer contributions, CTC, and an
estimated in-hand. Computed server-side so the letter, the record and the eventual comp event can never
disagree. **The exact components and percentages come from your sheet** — I'll encode it as the first
structure and check it reproduces three of your existing letters to the rupee before go-live.

**Offers and revisions.** `offers`: candidate, `revision_no`, the inputs (CTC, joining date, designation,
manager, probation, notice), the computed annexure (frozen jsonb), perks and bonuses (below), the
rendered letter (frozen), PDF in the private bucket, `offer_ref` (OFR-2026-NNN, printed on the letter),
status `draft → pending_approval → approved → sent → accepted / declined / expired`, and `superseded`.
- A sent offer is immutable. A negotiation is **a new revision** with a reason ("candidate countered at
  ₹X", "added joining bonus"); the previous one is marked `superseded`. The Offers tab shows every
  revision side by side with what changed.
- **Perks and bonuses** are line items on the offer, not free text: joining bonus (with clawback months),
  retention bonus (amount + payout date), variable / performance pay (target % or amount), relocation,
  laptop / phone / internet, insurance, ESOP note, other. Each says whether it's inside or outside CTC.
- **Band check:** an offer above the role's salary band max is flagged and needs approval.
- **Approval** before `sent` (rule to confirm — see Decisions). Approval records who and when.
- **Acceptance:** HR uploads the signed copy (`signed_offer` document) and marks it accepted; the
  accepted revision is what joining uses.

**PDF:** an HTML print view (like the appraisal letter) on LOT letterhead, rendered to PDF and stored.
Every page footer carries the `offer_ref`.

---

## C3 — Bulk CV upload → candidate profiles (Core)

1. Drop 1–100 CVs (PDF, DOCX, image scans) on `/hiring/import`, optionally pre-tagged to a role and
   hiring manager.
2. Each file uploads to the private bucket; the worker sends it to the Claude API (model:
   `claude-haiku-5-5` for cost; Sonnet only if Haiku misreads) and gets back structured fields: name,
   email, phone, location, current employer/title, total experience, skills, education, CTC and notice
   period if stated. Files go one per request, client-driven, so 100 CVs never hit a worker timeout
   (same pattern as the RazorpayX scan).
3. **Review-and-confirm** grid (like Directory sync): each row editable, duplicates flagged against
   existing candidates and employees by email/phone, low-confidence fields highlighted. Nothing is
   written until HR confirms. Confirmed rows become candidates with the CV attached as their first
   document.

Needs an `ANTHROPIC_API_KEY` on podiumops (vendor key — you'd create it). CVs are personal data; they
go only to the API for extraction and are not retained there for training on a commercial key.

---

## O1 — Send / draft the offer email from Podium (Optional)

One button on an approved offer: **"Create draft"** or **"Send"**. Sends from the **hiring manager's own
Gmail** via the existing service account (domain-wide delegation, impersonating them), so the email sits
in their Sent folder and replies come back to them — not Resend, which is the marketing rail.
- Email subject/body is a second editable template with the same merge fields; PDF attached; CC HR.
- Podium records the Gmail message and thread id on the offer and moves it to `sent`.
- "Create draft" puts it in their Drafts for a final read; Podium marks `sent` once Gmail shows it sent
  (checked on open of the offer).
- **Setup:** add `https://www.googleapis.com/auth/gmail.compose` to the service account's domain-wide
  delegation in Workspace Admin (one-time, your admin login).
- Later, if wanted: a candidate accept/decline link instead of a signed scan.

## O2 — Hiring pipeline: openings, rounds, feedback (Optional)

- `openings` (requisitions): role, department, hiring manager, headcount, budget band, status
  (open / on hold / filled / cancelled), the **round plan** (e.g. HR screen → Technical → Founder),
  default interviewers per round.
- Candidates attach to an opening and move through its rounds on a **board** (columns = rounds).
- `interviews`: candidate × round, scheduled time, interviewers, mode (in person / Meet / phone),
  status (scheduled / done / no-show / cancelled).
- `interview_feedback`: one per interviewer — 1–5 rating, recommendation (strong no → strong yes),
  per-criterion scores from the round's scorecard, notes. **An interviewer can't see others' feedback
  for that round until they submit their own** (stops anchoring). Round verdict: advance / reject / hold.
- Interviewers see only the candidates they're assigned to, with the CV, and never the CTC fields.
- Opening dashboard: candidates per stage, time in stage, offers out, accepted.

## O3 — One-click interview scheduling (Optional, after O2)

On an interview: pick date + time + duration → **"Schedule"**. Podium creates a Google Calendar event on
the organiser's calendar (impersonated) with the interviewers as guests, a Meet link, the round name and
a link to the candidate's Podium page. Reschedule/cancel in Podium updates the event.
- **CV on the invite:** Calendar can only attach Drive files. Two options — (a) **default:** the invite
  carries a link to the candidate page in Podium (sign-in required; the CV never leaves the private
  bucket); (b) Podium copies the CV into a restricted Drive folder shared only with the internal
  interviewers and attaches it. (b) is what you described; it puts CVs in Drive, which is a second home
  for personal data. Your call — see Decisions.
- Optional: free/busy check across interviewers to suggest the first common slot.
- Candidate is not invited by default (a separate "invite candidate" toggle).
- **Setup:** add `calendar.events` (+ `calendar.freebusy`, + `drive.file` if option b) to domain-wide
  delegation.

---

## Decisions I need from you

1. **Who sees offer salary numbers?** Today salaries are visible only to the 4-person comp allow-list
   (RULE-PODIUM-002). Hiring managers negotiate the offer, so they need to see *their own candidate's*
   numbers. Recommendation: a hiring manager can draft and see offers for candidates they own; nobody
   else outside the allow-list; every read is logged to `comp_access_log`. This is a deliberate widening
   of the salary rule — needs your yes.
2. **Approval rule before an offer is sent.** Recommendation: any comp-allow-list member approves; offers
   above the band max need you or Vinay.
3. **CV on calendar invites:** link-only (recommended) or Drive copy.
4. **Template set:** one offer template + one joining letter, or separate templates per level
   (e.g. intern / associate / manager)?

## What I need to start C2

- The letter text (current offer letter and joining letter, as you use them).
- The salary calculation (the sheet or a filled example for 2–3 CTCs so the calculator is checked
  against real letters).

## Build order

C1 → C2 (once the template arrives) → C3 → then O1, O2, O3 as you pick them. Each module ships behind
the `podium_hiring` key and gets a manual chapter when it goes live.
