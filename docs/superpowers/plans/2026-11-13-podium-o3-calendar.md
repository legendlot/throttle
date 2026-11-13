# Podium O3 — One-click Calendar scheduling (plan, 2026-11-13)

Spec: `docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md` §O3. Builds on O2 (`0014_interviews.sql`,
`podiumops-worker/src/interviews.js`, `apps/podium/src/components/InterviewBits.js`).

## Decisions

- **D1 Identity.** Calendar writes use the podiumops-only write SA (`GOOGLE_ADMIN_SA_JSON`, `podium-admin-write`),
  never the shared SA. New scope `https://www.googleapis.com/auth/calendar.events`, `sub` = the organiser's work
  mailbox. **Afshaan's step:** add that scope to `podium-admin-write`'s client in Admin → Security → API controls →
  Domain-wide delegation. Until then O3 is off and O2 works exactly as before.
- **D2 Off until proven.** `podium.calendar_settings.enabled` (single row, default false). Only the super-admin
  `calendarCheck` POST flips it on, and only after a token mint + `GET calendars/primary` on the caller's own mailbox
  succeeds. `getCalendarCheck` is the read-only probe. While off, the UI shows no Calendar controls.
- **D3 Organiser.** The person who presses Add to Calendar (must be canManageApps on the opening, with an active
  `@legendoftoys.com` mailbox). Their primary calendar holds the events. Later edits by anyone in the chain act as
  the stored organiser calendar.
- **D4 Two events.** Internal event: panel as guests, Podium link, candidate code + name, round, opening; a Meet link
  when the mode is video. Candidate event (optional, needs the candidate's email): only the time, a neutral title
  ("Interview with Legend of Toys: <designation>"), and the Meet link (video) or the place (in person) — no Podium
  link, no panel names, `guestsCanSeeOtherGuests=false`. Both: `guestsCanModify=false`, `guestsCanInviteOthers=false`,
  `sendUpdates=all`, time zone `Asia/Kolkata`. The candidate event reuses the internal event's Meet conference.
- **D5 Idempotent.** Event ids are deterministic (`lotiv` / `lotcd` + the interview uuid hex — valid base32hex). A
  retry after a lost response gets 409 and adopts the existing event. Meet `requestId` = the interview id. One row per
  interview in `podium.interview_calendar` (PK interview_id), claimed before any Google call.
- **D6 Podium → Calendar.** Edit (time, duration, mode, place, panel) patches both events; cancel deletes both
  (guests are told). A failed push leaves `last_error` and the interview row shows Retry. `synced_hash` = the Podium
  fields last pushed, so a missed push is detected later.
- **D7 Calendar → Podium, on open.** The interview block calls `syncInterviewCalendar` per linked interview when a
  manager opens it:
  - event deleted in Calendar + interview scheduled → the interview is cancelled ("Cancelled in Google Calendar").
  - event time/duration moved in Calendar + Podium unchanged since the last sync → Podium reschedules (same RPC as
    an edit, so pending due dates move). If feedback is already in, Podium keeps its time and moves Calendar back.
  - Podium changed since the last push → Podium wins and is pushed again.
  - interview cancelled in Podium (by hand or by the application closing) → events deleted.
  Completed / no-show interviews are left alone. Guest-list edits made in Calendar are not pulled.
- **D8 Rechecked server-side:** JD present, opening open, application New / Screening / Interviewing, interview
  scheduled and in the future, organiser scope. Sweep after a verdict or a terminal status change removes events of
  interviews that the DB auto-cancelled.
- **D9 Who sees the Meet link:** the chain (interview block) and the panel (My interviews, detail).

## Build

1. `migrations/0018_interview_calendar.sql`: `calendar_settings` (single row) + `interview_calendar`; RLS on,
   service_role only.
2. `src/calendar.js` (pure): event ids, the two event bodies, `syncedHash`, `calendarSyncAction`. Unit tests in
   `test/calendar.test.mjs`.
3. `src/index.js`: `calendar` scope on the write SA (with `sub`), `getCalendarCheck` / `calendarCheck`,
   `linkInterviewCalendar`, `syncInterviewCalendar`, push in `updateInterview`, delete in `cancelInterview`, sweep
   after verdict / terminal status; calendar fields in `chainInterviews` + panel views; `calendar_enabled` on reads.
4. UI: Schedule dialog checkboxes (add to Calendar, send candidate invite); per-row Calendar state, Meet link,
   Add to Calendar / Retry; sync on open; Join link in the panel views.
5. Manual chapter update (Interviews) + spec O3 row.

## Not in O3

Pulling guest-list edits; Calendar push notifications (watch channels); rooms/resources; a cron reconcile
(needs a wrangler.toml go).
