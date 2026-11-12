-- 0017_leave_close_lock.sql — Podium Leave R1 fixes from the Codex pass (S453, 2026-11-13). Applied as podium_leave_v2.
-- 1. podium.leave_close_years: the year close (D5) moves from the worker into one RPC that takes each person's leave
--    lock and reads the ledger there, so an approve / cancel (same lock) can never land between the close's read and
--    its write. Pending requests no longer hold a close; their later approve / cancel re-closes (leave_reclose).
-- 2. podium.leave_decide: also refuses a decision by the request's own person matched on auth_user_id.

-- p = { employee_ids: [uuid], from_year, to_year } — closes every year in [from_year, to_year] with no
-- leave_year_closes row, in order, per person: lapse = −(closing − keep) when closing > keep (keep 5 PL / 0 SL),
-- closing = Σ delta dated ≤ Y-12-31 except Y's own lapse row (a stale one from a half-done close is replaced).
-- Persons are locked in id order (no deadlock between two closes). → number of years closed
create or replace function podium.leave_close_years(p jsonb)
returns int language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_ids   uuid[];
  v_emp   uuid;
  v_from  int := (p->>'from_year')::int;
  v_to    int := (p->>'to_year')::int;
  y       int;
  t       text;
  v_keep  numeric;
  v_close numeric;
  n       int := 0;
begin
  select array_agg(distinct x::uuid order by x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p->'employee_ids', '[]'::jsonb)) x;
  if v_ids is null or v_from is null or v_to is null or v_to < v_from or v_to - v_from > 50 then return 0; end if;
  foreach v_emp in array v_ids loop
    perform podium.leave_lock(v_emp);
    for y in v_from..v_to loop
      continue when exists (select 1 from podium.leave_year_closes where employee_id = v_emp and year = y);
      foreach t in array array['PL', 'SL'] loop
        v_keep := case when t = 'PL' then 5 else 0 end;
        select coalesce(sum(delta), 0) into v_close from podium.leave_ledger
         where employee_id = v_emp and leave_type = t and effective_date <= make_date(y, 12, 31)
           and not (kind = 'lapse' and period = y::text);
        delete from podium.leave_ledger where employee_id = v_emp and leave_type = t and kind = 'lapse' and period = y::text;
        if v_close > v_keep then
          insert into podium.leave_ledger (employee_id, leave_type, delta, kind, period, effective_date)
          values (v_emp, t, -(v_close - v_keep), 'lapse', y::text, make_date(y, 12, 31));
        end if;
      end loop;
      insert into podium.leave_year_closes (employee_id, year) values (v_emp, y) on conflict do nothing;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

create or replace function podium.leave_decide(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_id        uuid := (p->>'request_id')::uuid;
  v_emp       uuid;
  v_req       podium.leave_requests;
  v_dec       text := p->>'decision';
  v_note      text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_debit     numeric;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if v_dec is null or v_dec not in ('approve', 'reject') then raise exception 'bad_decision'; end if;
  select employee_id into v_emp from podium.leave_requests where id = v_id;
  if not found then raise exception 'not_found'; end if;
  perform podium.leave_lock(v_emp);
  select * into v_req from podium.leave_requests where id = v_id for update;
  if v_req.status <> 'pending' then raise exception 'not_pending'; end if;
  if v_actor_emp is not null and v_actor_emp = v_req.employee_id then raise exception 'no_self_approval'; end if;
  -- By login too, so a caller whose employee id could not be resolved (actor_employee_id null) still cannot decide
  -- their own request (Codex S453).
  if v_actor is not null and exists (select 1 from podium.employees where id = v_req.employee_id and auth_user_id = v_actor) then
    raise exception 'no_self_approval';
  end if;

  if v_dec = 'reject' then
    if v_note is null then raise exception 'note_required'; end if;
    update podium.leave_requests set status = 'rejected', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
        decided_at = now(), decision_note = v_note
     where id = v_id returning * into v_req;
  else
    if v_req.leave_type in ('PL', 'SL') then
      perform podium.leave_check_snapshot(v_req.employee_id, v_req.leave_type, v_req.id, p);
      update podium.leave_requests set status = 'approved', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
          decided_at = now(), decision_note = v_note,
          borrowed_days = coalesce((p->>'borrowed_days')::numeric, 0), lop_days = coalesce((p->>'lop_days')::numeric, 0)
       where id = v_id returning * into v_req;
      v_debit := v_req.days - v_req.lop_days;
      if v_debit > 0 then
        insert into podium.leave_ledger (employee_id, leave_type, delta, kind, effective_date, request_id, created_by)
        values (v_req.employee_id, v_req.leave_type, -v_debit, 'taken', v_req.start_date, v_req.id, v_actor);
        perform podium.leave_reclose(v_req.employee_id, v_req.leave_type, extract(year from v_req.start_date)::int, v_actor, v_actor_emp);
      end if;
    else
      update podium.leave_requests set status = 'approved', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
          decided_at = now(), decision_note = v_note
       where id = v_id returning * into v_req;
    end if;
  end if;

  insert into podium.leave_events (employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_req.employee_id, v_req.id, v_actor, v_actor_emp, case when v_dec = 'approve' then 'approved' else 'rejected' end,
    jsonb_build_object('leave_type', v_req.leave_type, 'days', v_req.days, 'borrowed_days', v_req.borrowed_days, 'lop_days', v_req.lop_days));
  return to_jsonb(v_req);
end $$;

revoke all on function podium.leave_close_years(jsonb) from public, anon, authenticated;
grant execute on function podium.leave_close_years(jsonb) to service_role;
revoke all on function podium.leave_decide(jsonb) from public, anon, authenticated;
grant execute on function podium.leave_decide(jsonb) to service_role;

notify pgrst, 'reload schema';
