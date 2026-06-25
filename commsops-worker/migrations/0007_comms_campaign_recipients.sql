-- Keyset-paginated reachable recipients for a campaign's materialized segment.
-- The send gate re-checks consent/suppression at send time — this is the accurate
-- pre-filter + ordered cursor for the queue continuation pattern. Applied 2026-06-25.
CREATE OR REPLACE FUNCTION comms.campaign_recipients(
  p_segment_id uuid, p_channel text, p_purpose text,
  p_after uuid DEFAULT NULL, p_limit int DEFAULT 100)
RETURNS TABLE(profile_id uuid, address text) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (sm.profile_id) sm.profile_id,
         (SELECT i.value FROM comms.identifiers i
            WHERE i.profile_id = sm.profile_id
              AND i.type = CASE WHEN p_channel='email' THEN 'email' ELSE 'phone' END
            ORDER BY i.is_verified DESC, i.first_seen ASC LIMIT 1) AS address
  FROM comms.segment_members sm
  WHERE sm.segment_id = p_segment_id
    AND (p_after IS NULL OR sm.profile_id > p_after)
    AND EXISTS (SELECT 1 FROM comms.identifiers i2 WHERE i2.profile_id=sm.profile_id
                 AND i2.type = CASE WHEN p_channel='email' THEN 'email' ELSE 'phone' END)
    AND NOT EXISTS (SELECT 1 FROM comms.suppressions s
                     WHERE s.channel=p_channel AND s.profile_id=sm.profile_id)
    AND (p_purpose <> 'marketing' OR EXISTS (
          SELECT 1 FROM comms.consent c
           WHERE c.profile_id=sm.profile_id AND c.channel=p_channel AND c.purpose='marketing'
             AND c.state='opted_in'
             AND c.id=(SELECT c2.id FROM comms.consent c2
                        WHERE c2.profile_id=sm.profile_id AND c2.channel=p_channel AND c2.purpose='marketing'
                        ORDER BY c2.captured_at DESC LIMIT 1)))
  ORDER BY sm.profile_id ASC
  LIMIT greatest(p_limit, 1);
$$;
GRANT EXECUTE ON FUNCTION comms.campaign_recipients(uuid, text, text, uuid, int) TO service_role;
NOTIFY pgrst, 'reload schema';
