# Changelog - Podium Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.7.0] - 2026-11-13
### Added
- New "Google Directory Sync" chapter (People part, after Directory): Podium is now the
  source of truth for name, job title, department, manager, personal phone, employee
  code and org unit; saving a person pushes only the changed fields to Google within
  seconds; the "Google not updated, retry" banner, pending chip and 1 / 5 / 30 minute
  retries (Google admins can Retry); who is never written (founders, exited, ignored,
  excluded org units); the Org unit picker (department suggestion, no excluded units,
  empty units hidden); Directory "From Google" (new joiners, departures, ignore list
  only) and "Google vs Podium" (states, tick, Preview, Push only after Preview, stale
  refusals, no automatic retry of admin pushes); personal phone visibility warning.
### Changed
- Directory: the Sync from Google callout no longer says the sync updates people or
  exits them; departures are alerts only and Google no longer updates departments or
  managers.

## [1.6.0] - 2026-11-12
### Added
- New "Interviews" chapter in the Hiring part (after Candidates & Pipeline): who does
  what, rounds and scorecards, scheduling (IST, 30 days back to a year ahead, JD and
  open opening required, candidate moves to Interviewing), editing the panel, My
  interviews (Feedback owed / Upcoming / Done, overdue count) and what an interviewer
  does and does not see, blind submit-once feedback, Remind (own work mailbox, once
  per 12 hours), verdicts, cancel and no-show. No automatic reminders yet.
### Changed
- Candidates & Pipeline: scheduling an interview moves a New or Screening candidate
  to Interviewing; closing a candidate cancels their scheduled interviews; new
  Interviews block on the application.
- Openings: the Interview rounds card (round plan, default interviewers, scorecard).

## [1.5.0] - 2026-11-12
### Added
- New "Hiring" part (6 chapters): Openings (create, JD-first rule, band requested
  then approved by the snapshotted approver, no self-approval, headcount), Candidates
  & Pipeline (candidate vs application, duplicates, documents, statuses), Import CVs
  (AI-read bulk import: nothing added until Accept, Enter by hand reasons, dropped
  unsupported fields, duplicate warnings, AI spend line, 7-day clean-up), Offers
  (templates, statutory calculator, band check and approval, PDF), Offer Link (email
  from the hiring owner's mailbox, what the candidate sees at /offer, HR verify, bank
  reopen, revisions) and Joining (work account, then Confirm joining, no-show).
- New "Onboarding & Exits" part (3 chapters): Onboarding (/onboarding HR board,
  profile campaign, PAN and bank change approvals, payroll export), My Profile
  (/welcome self-serve profile, documents, policies, change requests) and Exits
  (/exits, Exit card, no-dues checklist with live blockers, Close, Google keep /
  suspend / transfer).

## [1.1.0] - 2026-07-07
### Added
- New "Analytics" chapter (Performance part, `/analytics`): the HR/admin
  aggregate analytics page with its three sections (Org & Headcount, Payroll
  Cost, Performance), the salary allow-list gate on Payroll Cost, and the
  aggregates-only privacy model.

## [1.0.0] - 2026-06-06
### Added
- Complete self-serve manual for Podium: 5 parts, 16 chapters (Getting Started,
  People, Performance, Org Design, Administration) covering the dashboard,
  directory, profiles, org chart, new-person form, My Performance, the team feed,
  the full appraisal cycle (HR view and the shared self/manager/HR detail screen),
  the role & KPI registry, departments, and the three admin screens. Tiered by
  access (Employee / Manager / HR / Admin), with the tiered visibility model
  (manager-chain scope, salary vault, HR-only PAN/bank, observation visibility
  tiers and private 1:1 notes) explained in plain language. Built with the shared
  pipeline and the LOT theme; copy in house style (no em dashes).
