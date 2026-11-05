-- snorkel_update_po_request_v1 (2026-11-05, Kirti, #bugs 1793862584.463369): a requester can edit a
-- PO request until procurement starts on it.
-- One function so the header and lines change together: a failed line insert must not leave a
-- request with its old lines deleted. The row lock makes the pending check and the write one step.
-- A live PO raised from the request also ends the window: acceptPO flips the request to approved,
-- but a Draft PO already carries a copy of these lines, and an edit would no longer reach it.
create or replace function store.update_po_request(p_request_no text, p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
set search_path = store, public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from store.po_requests where request_no = p_request_no for update;
  if not found then
    raise exception 'Request not found';
  end if;
  if v_status <> 'pending' then
    raise exception 'Only pending requests can be edited';
  end if;
  if exists (
    select 1 from store.purchase_orders
    where source_request_no = p_request_no and status is distinct from 'Cancelled'
  ) then
    raise exception 'Procurement has already started a PO from this request. Ask them to change it.';
  end if;

  update store.po_requests set
    title            = p_header->>'title',
    details          = p_header->>'details',
    category         = p_header->>'category',
    suggested_vendor = p_header->>'suggested_vendor',
    estimated_cost   = (p_header->>'estimated_cost')::numeric,
    currency         = coalesce(p_header->>'currency', 'INR'),
    urgency          = coalesce(p_header->>'urgency', 'Normal'),
    needed_by        = (p_header->>'needed_by')::date,
    notes            = p_header->>'notes',
    updated_at       = now()
  where request_no = p_request_no;

  delete from store.po_request_lines where request_no = p_request_no;

  insert into store.po_request_lines
    (request_no, line_no, part_code, description, item_type, qty, unit, unit_price, hsn_code, gst_percent, needs_hsn_review)
  select p_request_no, l.line_no, l.part_code, l.description, l.item_type, l.qty, l.unit, l.unit_price, l.hsn_code, l.gst_percent, l.needs_hsn_review
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l(
    line_no int, part_code text, description text, item_type text, qty numeric, unit text,
    unit_price numeric, hsn_code text, gst_percent numeric, needs_hsn_review boolean
  );

  return jsonb_build_object('request_no', p_request_no, 'lines', jsonb_array_length(coalesce(p_lines, '[]'::jsonb)));
end;
$$;

revoke all on function store.update_po_request(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function store.update_po_request(text, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';
