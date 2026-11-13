# Changelog - Podium Operations Manual

The version here, in `manual.json`, and on the cover/footer of the PDF must always
match. Versioning is manual.

## [1.11.0] - 2026-11-13
### Changed
- Add candidate (C5): on an opening it now offers Upload CV (first) or Enter manually. New source list (Other job
  portal, Direct email, Recruitment agency added; Agency renamed). A referral must name the referrer (employee or
  typed name); CV import now offers Referral. Manual form asks Source, Notice and (salary chain) CTC after
  name/email/phone; the opening's list shows Notice.

## [1.10.1] - 2026-11-13
### Changed
- Exits: the relieving and experience letter wording (v1) is approved by Afshaan; the draft warning is replaced.

## [1.10.0] - 2026-11-13
### Added
- Exits chapter: relieving and experience letters (X1b). HR only; on or after the last working day, on open and
  closed exits (not cancelled); signatory, preview, Issue; REL/EXP references with revisions on re-issue; stored
  as the person's documents; never emailed by Podium; issuing does not tick the checklist line; when a letter is
  refused (no joining date, no designation); editing wording under Exit Checklist, Letter templates (draft v1 wording,
  awaiting approval).

## [1.9.1] - 2026-11-13
### Changed
- Leave: work from home is approved by the manager (the manager's manager or HR can also approve it);
  paternity is 15 calendar days, weekends and holidays included (Afshaan).

## [1.9.0] - 2026-11-13
### Added
- New "Leave" part and chapter: who is covered; PL / SL balances and monthly credits; applying (half days,
  live day count, free weekends and fixed holidays, period leave, optional holiday); borrowing ahead and unpaid
  days; withdraw and cancel; approving (manager, skip-level cover, HR); Who's out; work from home;
  maternity and paternity grants; HR tools (cutover, holidays, opening balances, adjustments, ledger);
  Payroll unpaid-days report (CSV, Mark exported, changes since export); year end and preview; exits.

## [1.8.1] - 2026-11-13
### Changed
- Google Directory Sync chapter: phone numbers are no longer pushed to Google (field list is now six);
  the "Personal phone is visible in Google" callout is replaced by "Phone numbers stay in Podium".
- Google Directory Sync chapter: new callout that the bulk "Push to Google" is paused (Preview still
  works); saving a person still updates their Google account with the changed fields.

## [1.8.0] - 2026-11-13
### Added
- Interviews chapter: new "Google Calendar" section (O3). Admin switch-on; the two Schedule
  tick boxes (interviewers' invite with Meet link, separate candidate invite); the organiser;
  what the candidate's invite does and does not carry; Add to calendar for earlier interviews;
  how edits, cancels, closing an application and changes made in Google Calendar flow back;
  row states and Retry buttons; Join / Join Meet for interviewers.
### Changed
- Interviews chapter: the "Not built yet" callout no longer lists calendar invites.

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
