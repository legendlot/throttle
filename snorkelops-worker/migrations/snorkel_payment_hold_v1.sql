-- snorkel_payment_hold_v1 (S350, 2026-09-04): finance HOLD on payment requests.
-- A held request stays OUTSTANDING to the requester — it is a finance pause, not a closure.
-- Both CHECK-as-enum columns are widened here, in the same migration, on purpose: the status
-- and the notification kind move together, and a half-applied pair detonates on the first real row.
alter table store.payment_requests drop constraint payment_requests_status_check;
alter table store.payment_requests add constraint payment_requests_status_check
  check (status = any (array['submitted','pending_approval','approved','held','paid','rejected','cancelled']));

alter table store.payment_requests
  add column if not exists held_by_user_id uuid,
  add column if not exists held_by_name text,
  add column if not exists held_at timestamptz,
  add column if not exists held_reason text,
  add column if not exists released_by_user_id uuid,
  add column if not exists released_by_name text,
  add column if not exists released_at timestamptz;

-- the notification kinds column is a CHECK-as-enum too — widen it in the SAME migration
alter table store.payment_notifications drop constraint payment_notifications_kind_check;
alter table store.payment_notifications add constraint payment_notifications_kind_check
  check (kind = any (array['approval_needed','payment_needed','approved','rejected','paid','cancelled','held','released']));

notify pgrst, 'reload schema';
