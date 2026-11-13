-- Podium Leave R2 follow-up, Afshaan 2026-11-13: "paternity is 15 total days, not business days, so it is 2 weeks in
-- total, including Saturday and Sunday". PATERNITY now counts calendar days like MATERNITY: at most 15 (end = start + 14
-- for the full grant), days = the calendar days in the range. Applied as `podium_leave_paternity_calendar_v1`.
-- No PATERNITY row existed when this was written (the R2 smoke rows were removed), so the new CHECK binds cleanly.
-- (The WFH approver change in the same commit — the direct manager, not the skip-level — is worker-only: src/leave.js.)
alter table podium.leave_requests drop constraint leave_requests_paternity_days;
alter table podium.leave_requests add constraint leave_requests_paternity_span
  check (leave_type <> 'PATERNITY' or (end_date - start_date <= 14 and days = end_date - start_date + 1));
