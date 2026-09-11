-- 0073 — capture-spine residual (e) + the two /f/confirm holes (i)(ii), S377 (2026-09-11).
--
-- forms.js wrote the submission row and its consent rows as SEPARATE PostgREST calls, so:
--   (e)  submit: consent was written first, then the submission insert — a failed insert left a
--        consent claim with no submission (its DPDP evidence) and the customer was told it failed;
--        and two simultaneous FIRST submits both passed the read-then-act dedupe and both wrote
--        consent (the code said so: "strictly no worse, never better than the UNIQUE index").
--   (i)  confirm: a partial consent failure rolled the claim back but not the rows it HAD written,
--        so the retry wrote them again.
--   (ii) confirm: if that rollback PATCH itself failed, confirmed_at stayed set with no consent —
--        the next click answered "You are subscribed" with zero consent rows.
-- One transaction per call removes all of it: the SUBMISSION row and its CONSENT rows land
-- together or not at all. ⚠️ Not the whole request: the `form_submitted` ingest event, the
-- resolved profile and the secondary identifier are written by forms.js BEFORE this call and
-- outside it, so a rolled-back capture can still leave that event behind (S377 hostile review).
-- Callers: forms.js handleFormSubmit -> rpc/form_capture, handleFormConfirm -> rpc/form_confirm.

create or replace function comms.form_capture(
  p_form_id uuid, p_profile_id uuid, p_payload jsonb, p_dedupe_key text, p_channels text[],
  p_source_url text, p_ip_hash text, p_confirm_token text,
  p_consent_purpose text,   -- 'service' for a single requested alert; NULL = confirmed opt-in (no consent until /f/confirm)
  p_consent_source text, p_evidence jsonb
) returns jsonb
language plpgsql
set search_path = comms, pg_temp
as $$
declare
  v_id uuid;
  v_had text[];
  v_channels text[] := coalesce(p_channels, '{}');   -- validated + de-duplicated by validateSubmission
  v_consent text[];
begin
  if p_dedupe_key is not null then
    insert into form_submissions (form_id, profile_id, payload, dedupe_key, channels, source_url, ip_hash, turnstile_ok, confirm_token)
    values (p_form_id, p_profile_id, p_payload, p_dedupe_key, v_channels, p_source_url, p_ip_hash, true, p_confirm_token)
    on conflict (form_id, dedupe_key) do nothing
    returning id into v_id;

    if v_id is null then
      -- Repeat submit. The row lock serialises concurrent repeats (the old read-then-act check
      -- could not). Channel-aware on purpose (S342 hostile review): channels are NOT in the
      -- dedupe key, so a repeat that ADDS a channel must record consent for the new channel only.
      select id, coalesce(channels, '{}') into v_id, v_had
        from form_submissions where form_id = p_form_id and dedupe_key = p_dedupe_key
        for update;
      select coalesce(array_agg(c order by o), '{}') into v_consent
        from unnest(v_channels) with ordinality as t(c, o) where not (c = any(v_had));
      if cardinality(v_consent) = 0 then
        return jsonb_build_object('deduped', true, 'submission_id', v_id);
      end if;
      update form_submissions set channels = v_had || v_consent where id = v_id;
    else
      v_consent := v_channels;
    end if;
  else
    insert into form_submissions (form_id, profile_id, payload, dedupe_key, channels, source_url, ip_hash, turnstile_ok, confirm_token)
    values (p_form_id, p_profile_id, p_payload, null, v_channels, p_source_url, p_ip_hash, true, p_confirm_token)
    returning id into v_id;
    v_consent := v_channels;
  end if;

  if p_consent_purpose is not null then
    insert into consent (profile_id, channel, purpose, state, source, evidence)
    select p_profile_id, c, p_consent_purpose, 'opted_in', p_consent_source, p_evidence
      from unnest(v_consent) as c;
  end if;

  return jsonb_build_object('deduped', false, 'submission_id', v_id, 'consent_channels', to_jsonb(v_consent));
end $$;

create or replace function comms.form_confirm(p_token text)
returns jsonb
language plpgsql
set search_path = comms, pg_temp
as $$
declare
  s record;
  v_now timestamptz := now();
  v_channels text[];
begin
  -- FOR UPDATE: a concurrent confirm (double-click, mail-client prefetch) waits here, then
  -- re-reads the row with confirmed_at set and answers `already` — no second set of rows.
  select fs.id, fs.profile_id, fs.channels, fs.payload, fs.source_url, fs.submitted_at, fs.confirmed_at,
         f.slug as form_slug, f.consent_copy_version as ccv
    into s
    from form_submissions fs left join forms f on f.id = fs.form_id
   where fs.confirm_token = p_token
   for update of fs;
  if not found then return jsonb_build_object('error', 'invalid_token'); end if;
  if s.confirmed_at is not null then return jsonb_build_object('confirmed', true, 'already', true); end if;

  -- The channels the customer CHOSE (0060). The field-presence fallback exists ONLY for rows
  -- written before 0060 (channels NULL) — presence is not choice; do not extend it.
  select coalesce(array_agg(distinct c), '{}') into v_channels
    from unnest(coalesce(s.channels, '{}')) as c where c in ('email', 'whatsapp');
  if cardinality(v_channels) = 0 then
    v_channels := array_remove(array[
      case when coalesce(s.payload->>'email', '') <> '' then 'email' end,
      case when coalesce(s.payload->>'phone', '') <> '' then 'whatsapp' end], null);
  end if;

  update form_submissions set confirmed_at = v_now where id = s.id;
  -- `marketing`, not `service`: this is an ongoing enrolment (purposes.js needsOptIn).
  insert into consent (profile_id, channel, purpose, state, source, evidence, captured_at)
  select s.profile_id, c, 'marketing', 'opted_in', 'website_form:' || coalesce(s.form_slug, 'unknown'),
         jsonb_build_object('form', s.form_slug, 'source_url', s.source_url, 'consent_copy_version', s.ccv,
                            'submitted_at', s.submitted_at, 'confirmed_at', v_now, 'turnstile_ok', true),
         v_now
    from unnest(v_channels) as c;

  return jsonb_build_object('confirmed', true, 'channels', to_jsonb(v_channels));
end $$;

-- comms is PostgREST-exposed: without the revoke, anon could call these with the publishable key.
revoke all on function comms.form_capture(uuid, uuid, jsonb, text, text[], text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function comms.form_confirm(text) from public, anon, authenticated;
grant execute on function comms.form_capture(uuid, uuid, jsonb, text, text[], text, text, text, text, text, jsonb) to service_role;
grant execute on function comms.form_confirm(text) to service_role;

notify pgrst, 'reload schema';
