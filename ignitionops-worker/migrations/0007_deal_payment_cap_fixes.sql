-- 0007 — Reann #2 money-path review fixes (S443, 2026-11-09). Re-runnable: create or replace +
-- drop trigger if exists. Plan: docs/superpowers/plans/2026-11-09-ignition-snorkel-payment-requests.md
--
-- 1. The cap counts a PAID request at greatest(amount, paid gross). deal_payment_requests stores
--    Snorkel's paid_amount as-is (NET of TDS, applySnorkelStatus) and tds_amount beside it, so the
--    gross is paid_amount + tds_amount. Finance may pay more than was requested; counting only
--    `amount` let the next raise go over the fee by the difference.
--    One helper, deal_payment_committed, is the sum for both the raise/send guard and the fee guard.
-- 2. The fee cannot be cut below what is committed. A BEFORE UPDATE trigger on engagements (not an
--    RPC): it covers every writer — updateEngagement, advanceStage's incidental fields, any future
--    one — and runs under the row lock the UPDATE already holds, the same lock raise_deal_payment /
--    claim_deal_payment_send take FOR UPDATE, so a cut and a raise cannot both pass.
--    Only a DECREASE is checked: 4 live deals (2026-11-09) were hand-paid above their fee, and
--    raising their fee toward the truth must stay possible.
-- 3. No hand-logged payment once a deal has a live Snorkel request (Snorkel is its one payment
--    path). BEFORE INSERT on payments, hand-log rows only (snorkel_request_id null), under the
--    engagement lock — so it serialises with raise_deal_payment, which counts the hand log.
-- Both triggers refuse with errcode P0001, a plain-sentence message and a HINT ignitionops maps to a
-- 409 (dealPaymentTriggerRefusal): ignition_payment_amount_below_committed / ignition_snorkel_owns_payments.

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
        and r.state not in ('rejected', 'cancelled')),
    (select coalesce(sum(p.amount), 0)
       from ignition.payments p
      where p.engagement_id = p_engagement_id and p.snorkel_request_id is null)
$$;

-- Same body as 0006 except the two sums, which now come from deal_payment_committed.
create or replace function ignition.deal_payment_refusal(
  p_engagement_id uuid, p_kind text, p_amount numeric, p_exclude uuid
) returns text
language plpgsql stable
set search_path = ignition, pg_temp
as $$
declare
  v_stage text; v_fee numeric; v_live numeric; v_hand numeric;
begin
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
               and r.state not in ('rejected', 'cancelled')) then
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

create or replace function ignition.engagements_payment_amount_guard() returns trigger
language plpgsql
set search_path = ignition, pg_temp
as $$
declare
  v_live numeric; v_hand numeric;
begin
  if coalesce(new.payment_amount, 0) >= coalesce(old.payment_amount, 0) then return new; end if;
  select c.live, c.hand into v_live, v_hand from ignition.deal_payment_committed(new.id, null) c;
  if coalesce(new.payment_amount, 0) < v_live + v_hand then
    raise exception using errcode = 'P0001', hint = 'ignition_payment_amount_below_committed',
      message = format('The fee cannot go below ₹%s: ₹%s is already raised in Snorkel and ₹%s paid by hand on this deal.',
                       round(v_live + v_hand, 2), round(v_live, 2), round(v_hand, 2));
  end if;
  return new;
end $$;

drop trigger if exists engagements_payment_amount_guard on ignition.engagements;
create trigger engagements_payment_amount_guard
  before update of payment_amount on ignition.engagements
  for each row execute function ignition.engagements_payment_amount_guard();

create or replace function ignition.payments_hand_log_guard() returns trigger
language plpgsql
set search_path = ignition, pg_temp
as $$
begin
  if new.snorkel_request_id is not null or new.engagement_id is null then return new; end if;
  perform 1 from ignition.engagements where id = new.engagement_id for update;   -- same lock as the raise
  if exists (select 1 from ignition.deal_payment_requests r
             where r.engagement_id = new.engagement_id and r.state not in ('rejected', 'cancelled')) then
    raise exception using errcode = 'P0001', hint = 'ignition_snorkel_owns_payments',
      message = 'This deal has a payment request in Snorkel; Finance pays it there.';
  end if;
  return new;
end $$;

drop trigger if exists payments_hand_log_guard on ignition.payments;
create trigger payments_hand_log_guard
  before insert on ignition.payments
  for each row execute function ignition.payments_hand_log_guard();

revoke execute on function ignition.deal_payment_committed(uuid, uuid) from public, anon, authenticated;
revoke execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function ignition.engagements_payment_amount_guard() from public, anon, authenticated;
revoke execute on function ignition.payments_hand_log_guard() from public, anon, authenticated;
grant execute on function ignition.deal_payment_committed(uuid, uuid) to service_role;
grant execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) to service_role;
