# Podium O2 — interview rounds + feedback — plan

> Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §O2. Afshaan 2026-11-12: "start here"
> (O2 next after C4 + the manual catch-up). O3 (Calendar) is NOT in this build; the interview row only
> leaves room for it (`calendar_event_id` null).

## Decisions

- **D1 Round plan.** `opening_rounds`: per opening, ordered (`seq`), `name`, `default_interviewer_ids uuid[]`,
  `scorecard jsonb` = up to 10 criteria `[{key, label}]` (each scored 1–5), `active`. Edited by
  `canEditOpening` (owner, `podium_hiring`). A round with interviews is never deleted, only deactivated.
  An opening with no rounds can still interview: scheduling then takes a free-text round name (no scorecard).
- **D2 Interviews.** `interviews`: one row per application × round (unique while not cancelled), with
  `opening_id`, `candidate_id`, `round_id` (nullable), `round_name` (snapshot), `scorecard` (snapshot of the
  round's criteria at scheduling), `scheduled_at timestamptz`, `duration_min`, `mode` (`in_person` / `video` /
  `phone`), `location` (room or link text), `status` (`scheduled` → `completed` / `cancelled` / `no_show`),
  `jd_id` = the opening's `current_jd_id` at scheduling (spec: each interview records the JD version),
  `verdict` (`advance` / `reject` / `hold`) + `verdict_by/at` + `verdict_note`, `calendar_event_id` (O3, null),
  `created_by`. Scheduled/edited/cancelled by `canManageApps` (owner, manager, `podium_hiring`).
  Gates rechecked server-side every write: JD present, opening `open`, application status in
  `new / screening / interviewing`. Scheduling on `new` / `screening` moves the application to
  `interviewing` (guarded PATCH + `status_changed` event, detail `{interview_id}`) in the same RPC.
- **D3 Panel = feedback rows.** `interview_panel` (interview_id, employee_id) unique; carries `due_at`
  (= scheduled_at + 24h, moves on reschedule while pending), `rating smallint 1–5`, `recommendation`
  (`strong_yes` / `yes` / `no` / `strong_no`), `scores jsonb` ({key: 1–5} against the interview's scorecard
  snapshot), `notes`, `submitted_at`, `reminded_at`, `remind_count`. Panelists must be active employees
  with a login. A panelist with submitted feedback cannot be removed. Feedback is **submit-once, never
  edited** (once submitted the author can see the others, so an edit would be anchored). Submitting is
  allowed only once `scheduled_at` has passed and the interview is not cancelled.
- **D4 Blind until you submit.** A panelist sees the other panelists' feedback on that interview only after
  submitting their own — **this applies even if they are also on the opening's chain** (a chain member who
  is NOT on that panel sees every submitted feedback on applications they can see). Pending rows show only
  "pending / overdue", never content (there are no drafts).
- **D5 Interviewer scope — a separate surface, existing gates untouched.** `canSeeOpening` and every C1/C2/C3
  read stay exactly as they are; being a panelist grants NOTHING on those endpoints. Panelists use new
  actions only: `getMyInterviews` and `getPanelInterview` / `getPanelDocUrl`. They see: the candidate's name,
  code, current employer + title, experience, skills, education, location, LinkedIn; the opening's code,
  designation, department; the JD the interview ran against (download); the round + scorecard; and
  documents of type `cv`, `education`, `experience_letter` (spec: "the CV"; the opening tier minus photo /
  other). Never email/phone, candidate notes, CTC, offers, events, outcome notes or other applications.
  A panelist on a cancelled interview loses access.
- **D6 Verdict.** `canManageApps` records `advance` / `reject` / `hold` on a `scheduled` or `completed`
  interview whose time has passed; this sets it `completed`. `reject` needs a reason code
  (`OUTCOME_REASON_CODES`) and moves the application to `rejected`; `hold` moves it to `on_hold`; `advance`
  changes nothing on the application (the next round is scheduled by hand; from `interviewing` the offer
  button already shows). The application move reuses `setApplicationStatus`'s rules (transition table,
  no live offer, guarded PATCH, event). Missing feedback is a warning in the UI, not a server block.
- **D7 Reminder — manual, no cron.** podiumops has no cron and `wrangler.toml` is not touched. Overdue
  feedback shows in-app (My interviews, the candidate page, a nav count). The chain gets a **Remind** button
  per pending panelist: a short plain-text Gmail from the caller's own work mailbox (DWD, `gmailSend`) to
  the panelist's work email, naming the candidate code + round and linking `/hiring/interviews`. No salary,
  no candidate contact details. At most one per panelist per 12h (`reminded_at` guard). An automatic
  reminder waits for the "Nudges" good-to-have (needs a cron = Afshaan's go on wrangler.toml).
- **D8 Who sees feedback.** Content (rating, recommendation, scores, notes) is visible to: `canSeeOpening`
  roles on that application's opening (hiring, owner, manager, approver, HR) per D4, and to panelists of
  that interview who have submitted. Notes are free text; they are not salary-redacted (the chain already
  sees the opening), but the reminder email never carries them.
- **D9 Nav.** `hiringAccess` gains "on any non-cancelled interview panel" so a panelist with no other seat
  reaches `/hiring/interviews` (My interviews). getMe adds `podium_interviews_access` (panel seat) for a
  separate nav item "My interviews" (`requires: 'podium_interviews_access'`); the Openings / Candidates
  items keep `podium_hiring_access`, whose meaning is unchanged (a pure panelist sees only My interviews).
  `getMyInterviews` returns `overdue_count` for the nav badge.
- **D10 No self add/remove (D4, review 2026-11-12).** `updateInterview` refuses `add_panel` / `remove_panel` holding the
  caller's own employee id (`panel_self`, 403): joining a panel after feedback is in would reveal it, leaving would dodge
  it. `scheduleInterview` may include the caller (no feedback exists yet).
- **D11 A closed application cancels its scheduled interviews (review 2026-11-12).** A trigger on `applications` (status
  → joined / rejected / declined / withdrawn / no_show, by any path) sets that application's `scheduled` interviews to
  `cancelled` (reason "application closed"); My interviews also ignores owed feedback on a closed application.
- **D12 No reschedule after feedback (review 2026-11-12).** Once any panelist has submitted, the time cannot move
  (`reschedule_after_feedback`, 409, checked under the interview lock in `hiring_update_interview`): cancel and schedule
  a new interview instead.
- **D13 No-show frees the round (build 2026-11-12).** The one-per-round index excludes `cancelled` and `no_show`, so a
  no-show round can be scheduled again.

## Build

1. **Migration `0014_interviews.sql`**: `opening_rounds`, `interviews`, `interview_panel` (+ CHECKs on every
   enum-ish column, FKs, a partial unique index application × round where status <> 'cancelled', grants to
   service_role, RLS on with no policies like the other hiring tables). RPCs (one transaction each, security
   definer, guarded):
   - `hiring_schedule_interview(p jsonb)` — inserts the interview + panel rows, and moves the application
     `new|screening → interviewing` guarded on `expected_status`, with its event; returns the interview.
   - `hiring_interview_verdict(p jsonb)` — sets verdict + `completed` guarded on `status in (scheduled,
     completed)` and `verdict is null`; for reject/hold also moves the application guarded on
     `expected_status` and writes the event. (The no-live-offer check runs in the worker first.)
   - `application_events.event_type` CHECK widened if it has one (check 0006 first) for
     `interview_scheduled`, `interview_rescheduled`, `interview_cancelled`, `interview_verdict`,
     `feedback_submitted` (detail carries ids only, no content).
2. **`src/interviews.js` (pure, unit-tested in `test/interviews.test.mjs`)**: enums, `cleanScorecard`,
   `checkFeedback(scorecard, body)`, `canSeeFeedback({isPanelist, submittedSelf, chainSees})`,
   `panelView(rows, me, chainSees)`, `dueAt(scheduledAt)`, `canSchedule(appStatus)`, `verdictMove(verdict)`,
   `remindAllowed(row, now)`, `PANEL_DOC_TYPES`.
3. **Worker actions** (all SELF_SERVE, self-scoping):
   - rounds: `getOpeningRounds`, `saveOpeningRound` (create/update), `setOpeningRoundActive`, `reorderOpeningRounds`;
   - chain: `getApplicationInterviews` (per application, feedback per D4/D8), `scheduleInterview`,
     `updateInterview` (time / duration / mode / location / panel add-remove; reschedule moves pending
     `due_at`), `cancelInterview` (reason), `markInterviewNoShow`, `recordInterviewVerdict`, `remindPanelist`;
   - panelist: `getMyInterviews` (upcoming / feedback owed / done + `overdue_count`), `getPanelInterview`,
     `getPanelDocUrl`, `submitInterviewFeedback`.
   - `getOpening` adds `rounds` and a per-application `interviews_summary` (count, next time, pending
     feedback); `getCandidate` adds each visible application's interviews (same shape as
     `getApplicationInterviews`).
4. **App**:
   - Opening detail: an **Interview rounds** card (list, add/edit modal with default interviewers + scorecard
     criteria, deactivate, reorder).
   - Candidate detail: per application an **Interviews** block — Schedule interview (round, time IST,
     duration, mode, location, panel pre-filled from the round), each interview's panel with feedback status
     (pending / overdue / submitted), the visible feedback, Remind, Edit, Cancel, No-show, Verdict.
   - `/hiring/interviews` (My interviews: tabs Upcoming / Feedback owed / Done) and
     `/hiring/interviews/detail?id=` (candidate summary, CV links, JD, scorecard form; after submit, the
     others' feedback).
   - Nav item "My interviews" (D9).
5. Manual chapter "Interviews" + changelog (manual-builder), spec row ✅, backlog line.

## Not in O2
Calendar events (O3), automatic reminders (needs a cron), feedback drafts, editing submitted feedback,
interviewer access to anything outside the panel surface.
