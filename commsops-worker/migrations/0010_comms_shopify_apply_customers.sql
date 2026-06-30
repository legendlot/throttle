-- 0010_comms_shopify_apply_customers — bulk-apply a page of mapped Shopify customers
-- in ONE call so the M4 backfill worker stays under the 50-subrequest limit (the
-- per-customer loop runs server-side). Idempotent: identifiers dedup via resolve_identity;
-- consent rows dedup on (profile,channel,purpose,state,source,captured_at).
-- Applied via Supabase apply_migration as comms_shopify_apply_customers_v1.
CREATE OR REPLACE FUNCTION comms.shopify_apply_customers(p_customers jsonb)
RETURNS TABLE(profiles_touched integer, consent_rows integer)
LANGUAGE plpgsql
AS $$
DECLARE
  c jsonb; cr jsonb; v_pid uuid; v_at timestamptz;
  v_prof integer := 0; v_con integer := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(p_customers) LOOP
    v_pid := comms.resolve_identity(c->'identifiers', 'shopify');
    UPDATE comms.profiles SET
      display_name = COALESCE(NULLIF(c->>'display_name',''), display_name),
      city         = COALESCE(NULLIF(c->>'city',''), city),
      locale       = COALESCE(NULLIF(c->>'locale',''), locale),
      attributes   = attributes || COALESCE(c->'attributes', '{}'::jsonb),
      updated_at   = now()
    WHERE id = v_pid;
    v_prof := v_prof + 1;

    IF c ? 'consent' THEN
      FOR cr IN SELECT * FROM jsonb_array_elements(c->'consent') LOOP
        v_at := COALESCE((cr->>'captured_at')::timestamptz, now());
        INSERT INTO comms.consent(profile_id, channel, purpose, state, source, captured_at)
        SELECT v_pid, cr->>'channel', cr->>'purpose', cr->>'state', cr->>'source', v_at
        WHERE NOT EXISTS (
          SELECT 1 FROM comms.consent x
          WHERE x.profile_id = v_pid AND x.channel = cr->>'channel'
            AND x.purpose = cr->>'purpose' AND x.state = cr->>'state'
            AND x.source = cr->>'source' AND x.captured_at = v_at);
        IF FOUND THEN v_con := v_con + 1; END IF;
      END LOOP;
    END IF;
  END LOOP;
  profiles_touched := v_prof; consent_rows := v_con; RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION comms.shopify_apply_customers(jsonb) TO service_role;
