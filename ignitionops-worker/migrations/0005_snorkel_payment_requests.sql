-- 0005 — Reann #2, slice S1: Ignition → Snorkel payment requests (S443, 2026-11-09)
-- Plan: docs/superpowers/plans/2026-11-09-ignition-snorkel-payment-requests.md
-- Additive only. Nothing reads these columns until S2/S3 ship.

-- 1. Snorkel requests remember where they came from. Both set or both null; the pair is unique,
--    so a retried send cannot create a second request row. (It can still burn a PAY number unless
--    S2 looks the source_ref up BEFORE nextSeq4 — required in S2.)
-- ⚠️ The three source/link/payout unique indexes are FULL, not partial (hostile review S443 #2):
--    PostgREST cannot use a partial index as an on_conflict target (42P10). NULLs never collide,
--    so full indexes behave the same for legacy rows. Applied live as 0005 + 0005b.
alter table store.payment_requests
  add column if not exists source_system text,
  add column if not exists source_ref    text;
alter table store.payment_requests
  add constraint payment_requests_source_system_check
    check (source_system is null or source_system in ('ignition')),
  add constraint payment_requests_source_pair_check
    check ((source_system is null) = (source_ref is null));
create unique index if not exists payment_requests_source_uidx
  on store.payment_requests (source_system, source_ref);

-- 2. A Snorkel payee can be tied to exactly one Ignition influencer (and vice versa).
--    No FK across schemas (RULE-IGN-003 style loose coupling). synced_from='ignition' marks
--    payees Ignition created; the vendors trigger only owns synced_from='vendors'.
alter table store.payment_payees
  add column if not exists linked_influencer_id uuid;
create unique index if not exists payment_payees_linked_influencer_uidx
  on store.payment_payees (linked_influencer_id);

-- 3. Ignition's side of each request. Created as waiting_for_invoice; sent to Snorkel only once an
--    invoice is attached; afterwards `state` mirrors the Snorkel status.
create table if not exists ignition.deal_payment_requests (
  id                 uuid primary key default gen_random_uuid(),
  engagement_id      uuid not null references ignition.engagements(id) on delete restrict,
  influencer_id      uuid not null references ignition.influencers(id) on delete restrict,
  kind               text not null check (kind in ('advance','balance','full')),
  amount             numeric(12,2) not null check (amount > 0),
  invoice_id         uuid references ignition.deal_invoices(id) on delete restrict,
  invoice_no         text,
  invoice_date       date,
  invoice_total      numeric(12,2) check (invoice_total is null or invoice_total > 0),
  state              text not null default 'waiting_for_invoice' check (state in (
                       'waiting_for_invoice','sending','send_failed',
                       'submitted','pending_approval','approved','held','paid','rejected','cancelled')),
  snorkel_request_id bigint unique,
  snorkel_request_no text,
  held_reason        text,
  rejection_note     text,
  paid_at            timestamptz,
  paid_amount        numeric(12,2),
  utr                text,
  tds_amount         numeric(12,2),
  last_error         text,
  last_synced_at     timestamptz,
  raised_by          uuid,
  raised_by_name     text,
  raised_at          timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A request cannot be sent without its invoice.
  constraint deal_payment_requests_invoice_before_send check (
    state in ('waiting_for_invoice','cancelled')
    or (invoice_id is not null and invoice_no is not null and invoice_total is not null)),
  constraint deal_payment_requests_amount_within_invoice check (
    invoice_total is null or amount <= invoice_total)
);
-- One live request per kind per deal (a rejected/cancelled one can be raised again).
create unique index if not exists deal_payment_requests_one_live_per_kind
  on ignition.deal_payment_requests (engagement_id, kind) where state not in ('rejected','cancelled');
create index if not exists deal_payment_requests_open_idx
  on ignition.deal_payment_requests (state) where state not in ('paid','rejected','cancelled');

alter table ignition.deal_payment_requests enable row level security;
revoke all on ignition.deal_payment_requests from anon, authenticated;
grant all on ignition.deal_payment_requests to service_role;

-- 4. The hand log gains what a Snorkel payout carries, so "₹X paid of ₹Y" keeps one source.
alter table ignition.payments
  add column if not exists utr                text,
  add column if not exists tds_amount         numeric(12,2),
  add column if not exists snorkel_request_id bigint;
create unique index if not exists payments_snorkel_request_uidx
  on ignition.payments (snorkel_request_id);
