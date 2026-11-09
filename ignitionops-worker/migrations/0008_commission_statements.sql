-- 0008 — Reann #3, slice S1: monthly affiliate commission (S443, 2026-11-09)
-- Plan: docs/superpowers/plans/2026-11-09-ignition-monthly-commission.md (§Decisions)
-- Re-runnable: if-not-exists / create or replace / drop-if-exists throughout.
--
-- 1. coupon_redemptions.net_ex_gst — Decision 1: commission is on the order's product value after the
--    code's discount and refunds, EXCLUDING GST and shipping. net_value (totalPrice − refunded) includes
--    both, so it is kept for revenue reporting and S2's sync fills this column from Shopify.
-- 2. ignition.commission_statements — one row per (deal, IST month). Ignition keeps `estimate` current
--    until D2C verifies; a verified row is FROZEN (trigger) — the request link lives on
--    deal_payment_requests.statement_id. No future month; verify only after the month ends. One way
--    back: reopen_commission_statement while no request on it is live or paid (a mistyped amount).
--    verify_commission_statement verifies AND raises in one transaction (Decision 4).
--    Commission is payable on a deal cancelled later: the sales were made (no stage check, by design).
-- 3. deal_payment_requests gains kind 'commission' + statement_id. Commission is OUTSIDE the fee cap
--    (payment_amount): the fee sums, the fee-cut trigger and the per-kind exclusivity ignore it, and a
--    commission request is capped by its statement's verified amount instead (one live request per
--    statement). raise_commission_payment is the only way one is created. 0007's hand-log guard now
--    ignores commission requests too.
-- 4. payments.kind gains 'commission' (the Snorkel payout row for a commission request).
-- 5. Permission ignition_commission_verify: admins + a new role for D2C (Decision 3: Mohit Jain).

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
alter table ignition.coupon_redemptions add column if not exists net_ex_gst numeric(12,2);

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ignition.commission_statements (
  id                uuid primary key default gen_random_uuid(),
  engagement_id     uuid not null references ignition.engagements(id) on delete restrict,
  influencer_id     uuid not null references ignition.influencers(id) on delete restrict,
  month             text not null,
  orders            int not null default 0 check (orders >= 0),
  net_sales         numeric(12,2) not null default 0 check (net_sales >= 0),
  rate              numeric(5,2) not null check (rate > 0 and rate <= 100),
  estimate          numeric(12,2) not null default 0 check (estimate >= 0),
  state             text not null default 'estimated' check (state in ('estimated', 'verified')),
  verified_amount   numeric(12,2) check (verified_amount is null or verified_amount >= 0),
  difference_reason text,
  verified_by       uuid,
  verified_by_name  text,
  verified_at       timestamptz,
  last_computed_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Calendar month 'YYYY-MM', IST. Decision 2: nothing before November 2026.
  constraint commission_statements_month_check
    check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and month >= '2026-11'),
  -- Verified = amount + who + when; a different amount needs its reason (Reann: "with the reason").
  constraint commission_statements_verified_complete check (
    state = 'estimated'
    or (verified_amount is not null and verified_by is not null and verified_at is not null
        and (verified_amount = estimate or nullif(btrim(difference_reason), '') is not null))),
  constraint commission_statements_one_per_month unique (engagement_id, month)
);
create index if not exists commission_statements_month_idx on ignition.commission_statements (month, state);

alter table ignition.commission_statements enable row level security;
revoke all on ignition.commission_statements from anon, authenticated;
grant all on ignition.commission_statements to service_role;

-- The current IST month, as 'YYYY-MM'. Its own function so a rolled-back proof can move "now".
create or replace function ignition.commission_current_month() returns text
language sql stable
set search_path = ignition, pg_temp
as $$ select to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM') $$;

-- No statement for a future month, and a month is verified only once it has ENDED (orders after a
-- verify could never be paid: one statement per deal-month).
create or replace function ignition.commission_statement_month_guard() returns trigger
language plpgsql
set search_path = ignition, pg_temp
as $$
begin
  if new.month > ignition.commission_current_month() then
    raise exception using errcode = 'P0001', hint = 'ignition_commission_future_month',
      message = format('%s has not started yet.', new.month);
  end if;
  if new.state = 'verified' and new.month >= ignition.commission_current_month() then
    raise exception using errcode = 'P0001', hint = 'ignition_commission_month_open',
      message = format('%s can be verified once the month is over.', new.month);
  end if;
  return new;
end $$;
drop trigger if exists commission_statement_month_guard on ignition.commission_statements;
create trigger commission_statement_month_guard
  before insert or update on ignition.commission_statements
  for each row execute function ignition.commission_statement_month_guard();

-- A verified statement is frozen and never deleted. The ONE way back is a reopen (verified →
-- estimated, verification cleared) while no request on it is live or paid — the correction path for
-- a mistyped verified amount (reopen_commission_statement; S2 gates it to admins). Estimated rows are
-- rewritten freely.
create or replace function ignition.commission_statement_lock() returns trigger
language plpgsql
set search_path = ignition, pg_temp
as $$
begin
  if old.state = 'verified' then
    if tg_op = 'UPDATE' and new.state = 'estimated'
       and new.verified_amount is null and new.verified_by is null and new.verified_at is null
       and new.engagement_id = old.engagement_id and new.influencer_id = old.influencer_id
       and new.month = old.month then
      perform 1 from ignition.engagements where id = old.engagement_id for update;  -- same lock as the raise
      if exists (select 1 from ignition.deal_payment_requests r
                 where r.statement_id = old.id and r.state not in ('rejected', 'cancelled')) then
        raise exception using errcode = 'P0001', hint = 'ignition_commission_verified_locked',
          message = format('Commission for %s is already raised in Snorkel; cancel that request first.', old.month);
      end if;
      return new;
    end if;
    raise exception using errcode = 'P0001', hint = 'ignition_commission_verified_locked',
      message = format('Commission for %s is verified and locked.', old.month);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists commission_statement_lock on ignition.commission_statements;
create trigger commission_statement_lock
  before update or delete on ignition.commission_statements
  for each row execute function ignition.commission_statement_lock();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
alter table ignition.deal_payment_requests
  add column if not exists statement_id uuid references ignition.commission_statements(id) on delete restrict;
alter table ignition.deal_payment_requests drop constraint if exists deal_payment_requests_kind_check;
alter table ignition.deal_payment_requests add constraint deal_payment_requests_kind_check
  check (kind in ('advance', 'balance', 'full', 'commission'));
alter table ignition.deal_payment_requests drop constraint if exists deal_payment_requests_statement_pair;
alter table ignition.deal_payment_requests add constraint deal_payment_requests_statement_pair
  check ((kind = 'commission') = (statement_id is not null));

-- One live request per fee kind per deal (commission excluded), and one per commission statement.
drop index if exists ignition.deal_payment_requests_one_live_per_kind;
create unique index deal_payment_requests_one_live_per_kind
  on ignition.deal_payment_requests (engagement_id, kind)
  where state not in ('rejected', 'cancelled') and kind <> 'commission';
create unique index if not exists deal_payment_requests_one_live_per_statement
  on ignition.deal_payment_requests (statement_id)
  where state not in ('rejected', 'cancelled') and statement_id is not null;

-- The fee sum leaves commission out (0007's body + `kind <> 'commission'`).
create or replace function ignition.deal_payment_committed(
  p_engagement_id uuid, p_exclude uuid, out live numeric, out hand numeric
)
language sql stable
set search_path = ignition, pg_temp
as $$
  select
    (select coalesce(sum(case when r.state = 'paid'
                              then greatest(r.amount, coalesce(r.paid_amount, 0) + coalesce(r.tds_amount, 0))
                              else r.amount end), 0)
       from ignition.deal_payment_requests r
      where r.engagement_id = p_engagement_id and r.id is distinct from p_exclude
        and r.state not in ('rejected', 'cancelled') and r.kind <> 'commission'),
    (select coalesce(sum(p.amount), 0)
       from ignition.payments p
      where p.engagement_id = p_engagement_id and p.snorkel_request_id is null)
$$;

-- Fee rules ignore commission requests; a commission request is judged against its statement only.
-- For kind 'commission' p_exclude is the request's own id (claim_deal_payment_send passes it).
create or replace function ignition.deal_payment_refusal(
  p_engagement_id uuid, p_kind text, p_amount numeric, p_exclude uuid
) returns text
language plpgsql stable
set search_path = ignition, pg_temp
as $$
declare
  v_stage text; v_fee numeric; v_live numeric; v_hand numeric;
  v_st ignition.commission_statements;
begin
  if p_kind = 'commission' then
    select s.* into v_st from ignition.commission_statements s
      join ignition.deal_payment_requests r on r.statement_id = s.id
     where r.id = p_exclude;
    if not found then return 'Commission is raised from its verified monthly statement.'; end if;
    if v_st.engagement_id is distinct from p_engagement_id then return 'That statement is not on this deal.'; end if;
    if v_st.state <> 'verified' then return format('Commission for %s is not verified yet.', v_st.month); end if;
    if p_amount > v_st.verified_amount then
      return format('That is more than the verified commission for %s (₹%s).', v_st.month, round(v_st.verified_amount, 2));
    end if;
    return null;
  end if;
  select stage, payment_amount into v_stage, v_fee from ignition.engagements where id = p_engagement_id;
  if not found then return 'This deal no longer exists.'; end if;
  if v_stage in ('cancelled', 'dropped', 'ghosted') then return format('This deal is %s.', v_stage); end if;
  if coalesce(v_fee, 0) <= 0 then return 'This deal has no agreed payment amount — set it first.'; end if;
  if p_kind = 'balance' and v_stage is distinct from 'live' then
    return 'The balance can be raised once the deal is Live.';
  end if;
  if exists (select 1 from ignition.deal_payment_requests r
             where r.engagement_id = p_engagement_id and r.id is distinct from p_exclude
               and r.state not in ('rejected', 'cancelled') and r.kind = p_kind) then
    return format('A %s request is already open on this deal.', p_kind);
  end if;
  if p_kind = 'full' and exists (select 1 from ignition.deal_payment_requests r
             where r.engagement_id = p_engagement_id and r.id is distinct from p_exclude
               and r.state not in ('rejected', 'cancelled') and r.kind <> 'commission') then
    return 'An advance or balance is already raised on this deal, so a full payment cannot be added.';
  end if;
  if p_kind <> 'full' and exists (select 1 from ignition.deal_payment_requests r
             where r.engagement_id = p_engagement_id and r.id is distinct from p_exclude
               and r.state not in ('rejected', 'cancelled') and r.kind = 'full') then
    return 'A full payment is already raised on this deal.';
  end if;
  select c.live, c.hand into v_live, v_hand from ignition.deal_payment_committed(p_engagement_id, p_exclude) c;
  if v_live + v_hand + p_amount > v_fee then
    return format('That would take this deal to ₹%s against the agreed ₹%s (₹%s already raised, ₹%s paid by hand).',
                  round(v_live + v_hand + p_amount, 2), round(v_fee, 2), round(v_live, 2), round(v_hand, 2));
  end if;
  return null;
end $$;

-- The one way a commission request is created: from a VERIFIED statement with a non-zero amount,
-- for exactly the verified amount, under the engagement lock (same order as raise/claim: engagement
-- first, then the statement). Starts waiting_for_invoice; S2 sends it like any other request.
create or replace function ignition.raise_commission_payment(
  p_statement_id uuid, p_raised_by uuid, p_raised_by_name text
) returns jsonb
language plpgsql volatile
set search_path = ignition, pg_temp
as $$
declare
  v_eid uuid; v_st ignition.commission_statements; v_row ignition.deal_payment_requests;
begin
  select engagement_id into v_eid from ignition.commission_statements where id = p_statement_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  perform 1 from ignition.engagements where id = v_eid for update;
  select * into v_st from ignition.commission_statements where id = p_statement_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  if v_st.state <> 'verified' then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', format('Commission for %s is not verified yet.', v_st.month));
  end if;
  if coalesce(v_st.verified_amount, 0) <= 0 then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', format('Nothing to pay for %s: the verified commission is ₹0.', v_st.month));
  end if;
  if exists (select 1 from ignition.deal_payment_requests r
             where r.statement_id = p_statement_id and r.state not in ('rejected', 'cancelled')) then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', format('Commission for %s is already raised.', v_st.month));
  end if;
  insert into ignition.deal_payment_requests
    (engagement_id, influencer_id, kind, statement_id, amount, state, raised_by, raised_by_name)
  values (v_eid, v_st.influencer_id, 'commission', p_statement_id, v_st.verified_amount,
          'waiting_for_invoice', p_raised_by, p_raised_by_name)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end $$;

-- Verify + raise in ONE transaction (Decision 4: a non-zero verified amount raises the request at
-- once). Engagement lock first, then the statement — the order every money path here uses.
create or replace function ignition.verify_commission_statement(
  p_statement_id uuid, p_amount numeric, p_reason text, p_verified_by uuid, p_verified_by_name text
) returns jsonb
language plpgsql volatile
set search_path = ignition, pg_temp
as $$
declare
  v_eid uuid; v_st ignition.commission_statements; v_raise jsonb;
begin
  select engagement_id into v_eid from ignition.commission_statements where id = p_statement_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  perform 1 from ignition.engagements where id = v_eid for update;
  select * into v_st from ignition.commission_statements where id = p_statement_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  if v_st.state = 'verified' then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', format('Commission for %s is already verified.', v_st.month));
  end if;
  if p_amount is null or p_amount < 0 then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'Enter the verified amount (₹0 or more).');
  end if;
  update ignition.commission_statements
     set state = 'verified', verified_amount = round(p_amount, 2),
         difference_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         verified_by = p_verified_by, verified_by_name = p_verified_by_name,
         verified_at = now(), updated_at = now()
   where id = p_statement_id
  returning * into v_st;
  if v_st.verified_amount > 0 then
    v_raise := ignition.raise_commission_payment(p_statement_id, p_verified_by, p_verified_by_name);
    if not coalesce((v_raise ->> 'ok')::boolean, false) then
      raise exception using errcode = 'P0001', hint = 'ignition_commission_raise_failed',
        message = coalesce(v_raise ->> 'message', 'The commission request could not be raised.');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'statement', to_jsonb(v_st), 'request', v_raise -> 'row');
end $$;

-- The correction path: reopen a verified statement whose request is not live or paid (none raised,
-- or rejected / cancelled). Clears the verification; the nightly rebuild refreshes the estimate.
create or replace function ignition.reopen_commission_statement(p_statement_id uuid) returns jsonb
language plpgsql volatile
set search_path = ignition, pg_temp
as $$
declare
  v_eid uuid; v_st ignition.commission_statements;
begin
  select engagement_id into v_eid from ignition.commission_statements where id = p_statement_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  perform 1 from ignition.engagements where id = v_eid for update;
  select * into v_st from ignition.commission_statements where id = p_statement_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  if v_st.state <> 'verified' then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', format('Commission for %s is not verified.', v_st.month));
  end if;
  if exists (select 1 from ignition.deal_payment_requests r
             where r.statement_id = p_statement_id and r.state not in ('rejected', 'cancelled')) then
    return jsonb_build_object('ok', false, 'code', 'refused',
      'message', format('Commission for %s is already raised in Snorkel; cancel that request first.', v_st.month));
  end if;
  update ignition.commission_statements
     set state = 'estimated', verified_amount = null, difference_reason = null,
         verified_by = null, verified_by_name = null, verified_at = null, updated_at = now()
   where id = p_statement_id
  returning * into v_st;
  return jsonb_build_object('ok', true, 'statement', to_jsonb(v_st));
end $$;

-- 0007's hand-log guard, now ignoring commission requests: commission is outside the fee, so a
-- commission request (live or paid) must not stop the fee being logged by hand.
create or replace function ignition.payments_hand_log_guard() returns trigger
language plpgsql
set search_path = ignition, pg_temp
as $$
begin
  if new.snorkel_request_id is not null or new.engagement_id is null then return new; end if;
  perform 1 from ignition.engagements where id = new.engagement_id for update;   -- same lock as the raise
  if exists (select 1 from ignition.deal_payment_requests r
             where r.engagement_id = new.engagement_id and r.state not in ('rejected', 'cancelled')
               and r.kind <> 'commission') then
    raise exception using errcode = 'P0001', hint = 'ignition_snorkel_owns_payments',
      message = 'This deal has a payment request in Snorkel; Finance pays it there.';
  end if;
  return new;
end $$;

-- 4 ─────────────────────────────────────────────────────────────────────────────────────────────
alter table ignition.payments drop constraint if exists payments_kind_check;
alter table ignition.payments add constraint payments_kind_check
  check (kind in ('advance', 'final', 'other', 'commission'));

-- 5 ─────────────────────────────────────────────────────────────────────────────────────────────
update store.ignition_roles
   set permissions = permissions || '{"ignition_commission_verify": true}'::jsonb, updated_at = now()
 where role_key = 'ignition_admin' and not coalesce((permissions ->> 'ignition_commission_verify')::boolean, false);
insert into store.ignition_roles (role_key, label, description, permissions, is_system)
values ('ignition_commission_verifier', 'Commission verifier (D2C)',
        'View + reports, and verifies the monthly affiliate commission (Reann #3). No deal editing.',
        '{"ignition_view": true, "ignition_reports_view": true, "ignition_commission_verify": true}'::jsonb, true)
on conflict (role_key) do nothing;

-- Grants (service_role only, like 0006/0007).
revoke execute on function ignition.commission_statement_lock() from public, anon, authenticated;
revoke execute on function ignition.commission_statement_month_guard() from public, anon, authenticated;
revoke execute on function ignition.commission_current_month() from public, anon, authenticated;
revoke execute on function ignition.verify_commission_statement(uuid, numeric, text, uuid, text) from public, anon, authenticated;
revoke execute on function ignition.reopen_commission_statement(uuid) from public, anon, authenticated;
revoke execute on function ignition.payments_hand_log_guard() from public, anon, authenticated;
revoke execute on function ignition.raise_commission_payment(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function ignition.deal_payment_committed(uuid, uuid) from public, anon, authenticated;
revoke execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) from public, anon, authenticated;
grant execute on function ignition.raise_commission_payment(uuid, uuid, text) to service_role;
grant execute on function ignition.verify_commission_statement(uuid, numeric, text, uuid, text) to service_role;
grant execute on function ignition.reopen_commission_statement(uuid) to service_role;
grant execute on function ignition.commission_current_month() to service_role;
grant execute on function ignition.deal_payment_committed(uuid, uuid) to service_role;
grant execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) to service_role;
