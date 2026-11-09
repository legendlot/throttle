-- 0006 — Reann #2, slice S3 review: the money guard lives in the database, atomically (S443, 2026-11-09)
-- Plan: docs/superpowers/plans/2026-11-09-ignition-snorkel-payment-requests.md
--
-- Why: a read-then-insert guard in the worker lets two raises (say advance + full) both pass, and a
-- fee cut or a cancellation between raising and sending went unchecked. Both RPCs take the
-- ENGAGEMENT row FOR UPDATE first, so every raise and every send of one deal is serialised, and the
-- rules below are checked under that lock.
--
-- The rules (deal_payment_refusal):
--   · deal not cancelled / dropped / ghosted; payment_amount > 0
--   · balance only when stage = live (Decision 2)
--   · one live (not rejected/cancelled) request per kind; full excludes advance/balance and vice versa
--   · live requests + the HAND LOG (ignition.payments with snorkel_request_id IS NULL — dozens of
--     live deals were already paid that way) + this amount ≤ payment_amount.
--     Snorkel-paid rows in ignition.payments are NOT counted: their request row already is.
--
-- INVOKER functions (not SECURITY DEFINER); EXECUTE for service_role only, like 0002.
-- Both return jsonb: {ok:true,row} | {ok:false,code:'not_found'|'refused'|'busy',message}.

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
  select coalesce(sum(r.amount), 0) into v_live from ignition.deal_payment_requests r
   where r.engagement_id = p_engagement_id and r.id is distinct from p_exclude
     and r.state not in ('rejected', 'cancelled');
  select coalesce(sum(p.amount), 0) into v_hand from ignition.payments p
   where p.engagement_id = p_engagement_id and p.snorkel_request_id is null;
  if v_live + v_hand + p_amount > v_fee then
    return format('That would take this deal to ₹%s against the agreed ₹%s (₹%s already raised, ₹%s paid by hand).',
                  round(v_live + v_hand + p_amount, 2), round(v_fee, 2), round(v_live, 2), round(v_hand, 2));
  end if;
  return null;
end $$;

create or replace function ignition.raise_deal_payment(
  p_engagement_id uuid, p_kind text, p_amount numeric, p_raised_by uuid, p_raised_by_name text,
  p_invoice_id uuid default null, p_invoice_no text default null, p_invoice_date date default null,
  p_invoice_total numeric default null
) returns jsonb
language plpgsql volatile
set search_path = ignition, pg_temp
as $$
declare
  v_inf uuid; v_why text; v_row ignition.deal_payment_requests;
begin
  select influencer_id into v_inf from ignition.engagements where id = p_engagement_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  if p_kind is null or p_kind not in ('advance', 'balance', 'full') or p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'A kind and an amount above zero are required.');
  end if;
  if p_invoice_id is not null then
    if not exists (select 1 from ignition.deal_invoices i where i.id = p_invoice_id and i.engagement_id = p_engagement_id) then
      return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'That invoice is not on this deal.');
    end if;
    if p_invoice_total is null or p_amount > p_invoice_total then
      return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'The amount is more than the invoice total.');
    end if;
  end if;
  v_why := ignition.deal_payment_refusal(p_engagement_id, p_kind, p_amount, null);
  if v_why is not null then return jsonb_build_object('ok', false, 'code', 'refused', 'message', v_why); end if;
  insert into ignition.deal_payment_requests
    (engagement_id, influencer_id, kind, amount, invoice_id, invoice_no, invoice_date, invoice_total,
     state, raised_by, raised_by_name)
  values (p_engagement_id, v_inf, p_kind, round(p_amount, 2), p_invoice_id, p_invoice_no, p_invoice_date,
          p_invoice_total, 'waiting_for_invoice', p_raised_by, p_raised_by_name)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end $$;

-- Claim a request for sending. Users: from waiting_for_invoice / send_failed (p_stale_before null).
-- Cron re-send: from `sending` last touched before p_stale_before. Invoice fields, when given, are
-- set in the same update (the invoice-before-send CHECK needs them as the row enters `sending`).
-- The full rule set is re-checked under the engagement lock, this row excluded from the per-kind
-- rules and counted once in the sum: the fee may have been cut or the deal cancelled since raising.
create or replace function ignition.claim_deal_payment_send(
  p_id uuid, p_stale_before timestamptz default null,
  p_invoice_id uuid default null, p_invoice_no text default null, p_invoice_date date default null,
  p_invoice_total numeric default null
) returns jsonb
language plpgsql volatile
set search_path = ignition, pg_temp
as $$
declare
  v_eid uuid; v_row ignition.deal_payment_requests; v_why text;
begin
  select engagement_id into v_eid from ignition.deal_payment_requests where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'not_found'); end if;
  perform 1 from ignition.engagements where id = v_eid for update;          -- engagement first, always
  select * into v_row from ignition.deal_payment_requests where id = p_id for update;
  if p_stale_before is null then
    if v_row.state not in ('waiting_for_invoice', 'send_failed') then
      return jsonb_build_object('ok', false, 'code', 'busy', 'message', 'This request is already being sent.', 'state', v_row.state);
    end if;
  elsif v_row.state <> 'sending' or v_row.updated_at >= p_stale_before then
    return jsonb_build_object('ok', false, 'code', 'busy', 'message', 'This request is no longer stuck.', 'state', v_row.state);
  end if;
  if p_invoice_id is not null then
    if not exists (select 1 from ignition.deal_invoices i where i.id = p_invoice_id and i.engagement_id = v_eid) then
      return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'That invoice is not on this deal.');
    end if;
    if p_invoice_total is null or v_row.amount > p_invoice_total then
      return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'The amount is more than the invoice total.');
    end if;
  end if;
  if coalesce(p_invoice_id, v_row.invoice_id) is null then
    return jsonb_build_object('ok', false, 'code', 'refused', 'message', 'Attach the creator''s invoice first.');
  end if;
  v_why := ignition.deal_payment_refusal(v_eid, v_row.kind, v_row.amount, p_id);
  if v_why is not null then return jsonb_build_object('ok', false, 'code', 'refused', 'message', v_why); end if;
  update ignition.deal_payment_requests set
    state = 'sending', last_error = null, updated_at = now(),
    invoice_id    = coalesce(p_invoice_id, invoice_id),
    invoice_no    = case when p_invoice_id is not null then p_invoice_no    else invoice_no    end,
    invoice_date  = case when p_invoice_id is not null then p_invoice_date  else invoice_date  end,
    invoice_total = case when p_invoice_id is not null then p_invoice_total else invoice_total end
  where id = p_id
  returning * into v_row;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end $$;

revoke execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function ignition.raise_deal_payment(uuid, text, numeric, uuid, text, uuid, text, date, numeric) from public, anon, authenticated;
revoke execute on function ignition.claim_deal_payment_send(uuid, timestamptz, uuid, text, date, numeric) from public, anon, authenticated;
grant execute on function ignition.deal_payment_refusal(uuid, text, numeric, uuid) to service_role;
grant execute on function ignition.raise_deal_payment(uuid, text, numeric, uuid, text, uuid, text, date, numeric) to service_role;
grant execute on function ignition.claim_deal_payment_send(uuid, timestamptz, uuid, text, date, numeric) to service_role;
