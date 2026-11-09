-- 0009 — Reann, #bugs 1794226469.391889 (2026-11-09, high priority): post date in contracts.
-- The contract no longer needs or prints the expected post date: the published terms say when to
-- post (Reann adds "within 7 days" to them). A FIXED date stays an option for launches — post_date_fixed = true puts
-- expected_post_date into the contract as a firm date (and then the date is required to send).
-- Planning still reads expected_post_date whether or not it is fixed.
alter table ignition.engagements add column if not exists post_date_fixed boolean not null default false;
comment on column ignition.engagements.post_date_fixed is
  'true = expected_post_date is a FIXED date (a launch) and is printed in the contract; false = planning only, the published terms say when to post. Reann #bugs 1794226469.391889.';
