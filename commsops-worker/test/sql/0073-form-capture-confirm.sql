-- Live-DB check for migration 0073 (comms.form_capture / comms.form_confirm), S377.
-- SAFE TO RUN ON PRODUCTION: everything happens inside one DO block that ends by RAISING, so
-- every row it writes is rolled back. The results arrive as the error text (ROLLBACK_TEST_OUTPUT).
-- Run via Supabase execute_sql, then confirm nothing survived:
--   select count(*) from comms.form_submissions where dedupe_key like 'S377TEST%' or confirm_token='S377TOKEN';
-- Expected (2026-09-11): 1 consent=1 · 2 deduped consent=1 · 3 consent_channels [whatsapp] consent=2
-- channels={email,whatsapp} · 4a mkt=0 · 4b channels [email] mkt=1 · 4c already mkt=1 ·
-- 4d invalid_token · 5 raised 23503, surviving submissions=0 · 6 anon=false auth=false service=true
do $$
declare
  f uuid := (select id from comms.forms where slug='back-in-stock');
  p uuid := (select id from comms.profiles order by created_at limit 1);
  r jsonb; out text := '';
  n_sub int; n_con int; ch text[];
begin
  -- 1 fresh
  r := comms.form_capture(f, p, '{"email":"t@x.test"}', 'S377TEST:k1', array['email'], 'u', null, null, 'service', 'website_form:back-in-stock', '{"t":1}');
  select count(*) into n_con from comms.consent where profile_id=p and evidence->>'t'='1';
  out := out || '1:' || r::text || ' consent=' || n_con || E'\n';
  -- 2 exact repeat
  r := comms.form_capture(f, p, '{"email":"t@x.test"}', 'S377TEST:k1', array['email'], 'u', null, null, 'service', 'website_form:back-in-stock', '{"t":1}');
  select count(*) into n_con from comms.consent where profile_id=p and evidence->>'t'='1';
  out := out || '2:' || r::text || ' consent=' || n_con || E'\n';
  -- 3 repeat adding whatsapp
  r := comms.form_capture(f, p, '{"email":"t@x.test"}', 'S377TEST:k1', array['email','whatsapp'], 'u', null, null, 'service', 'website_form:back-in-stock', '{"t":1}');
  select count(*) into n_con from comms.consent where profile_id=p and evidence->>'t'='1';
  select channels into ch from comms.form_submissions where form_id=f and dedupe_key='S377TEST:k1';
  out := out || '3:' || r::text || ' consent=' || n_con || ' channels=' || ch::text || E'\n';
  -- 4 confirmed opt-in: capture writes no consent; confirm writes marketing; re-confirm is a no-op
  r := comms.form_capture(f, p, '{"email":"t@x.test","phone":"9999999999"}', 'S377TEST:k2', array['email'], 'u', null, 'S377TOKEN', null, 'website_form:back-in-stock', '{"t":2}');
  select count(*) into n_con from comms.consent where profile_id=p and purpose='marketing' and captured_at = now();
  out := out || '4a:' || r::text || ' mkt_consent=' || n_con || E'\n';
  r := comms.form_confirm('S377TOKEN');
  select count(*) into n_con from comms.consent where profile_id=p and purpose='marketing' and captured_at = now();
  out := out || '4b:' || r::text || ' mkt_consent=' || n_con || E'\n';
  r := comms.form_confirm('S377TOKEN');
  select count(*) into n_con from comms.consent where profile_id=p and purpose='marketing' and captured_at = now();
  out := out || '4c:' || r::text || ' mkt_consent=' || n_con || E'\n';
  r := comms.form_confirm('nope');
  out := out || '4d:' || r::text || E'\n';
  -- 5 atomicity: consent insert fails (FK on a non-existent profile) -> no submission row survives
  begin
    r := comms.form_capture(f, gen_random_uuid(), '{"email":"z@x.test"}', 'S377TEST:k3', array['email'], 'u', null, null, 'service', 'website_form:back-in-stock', '{"t":3}');
    out := out || '5: NO ERROR ' || r::text || E'\n';
  exception when others then
    select count(*) into n_sub from comms.form_submissions where dedupe_key='S377TEST:k3';
    out := out || '5: raised ' || sqlstate || ', surviving submissions=' || n_sub || E'\n';
  end;
  -- 6 privileges (comms is PostgREST-exposed; anon must not reach these)
  out := out || '6: anon=' || has_function_privilege('anon','comms.form_capture(uuid, uuid, jsonb, text, text[], text, text, text, text, text, jsonb)','execute')
     || ' auth=' || has_function_privilege('authenticated','comms.form_confirm(text)','execute')
     || ' service=' || has_function_privilege('service_role','comms.form_confirm(text)','execute');
  raise exception 'ROLLBACK_TEST_OUTPUT%', E'\n' || out;
end $$;
