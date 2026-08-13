-- Campaign audience EXCLUSIONS (S276, 2026-08-13).
--
-- Until now a campaign carried exactly ONE segment_id and nothing else: two campaigns were
-- structurally invisible to each other, and the only cross-campaign brake was the blunt
-- frequency cap (3 marketing / rolling 24h). Measured before this shipped: 15 profile-days
-- where two DIFFERENT campaigns reached the same person on the same day.
--
-- Three exclusion rules, all optional, all evaluated LIVE during the fan-out (not snapshotted
-- at start) so a person contacted while a multi-hour broadcast is still running is dropped
-- from its remaining pages:
--   ① exclude_segment_ids     — anyone in these segments
--   ② exclude_contacted_hours — anyone contacted ON THIS CHANNEL in the last N hours
--   ③ exclude_campaign_ids    — anyone a named campaign already reached
--
-- ⚠️ ② is SAME-CHANNEL by decision (Afshaan, 2026-08-13): an email this morning does not stop
-- a WhatsApp tonight. ③ is deliberately CHANNEL-AGNOSTIC — a campaign has exactly one channel,
-- so filtering ③ by the new campaign's channel would silently make it a no-op whenever the two
-- campaigns differ in channel, which is precisely when you most want it.

ALTER TABLE comms.campaigns
  ADD COLUMN IF NOT EXISTS exclude_segment_ids  uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS exclude_campaign_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS exclude_contacted_hours int;          -- NULL = rule off

COMMENT ON COLUMN comms.campaigns.exclude_contacted_hours IS
  'NULL = off. N = drop anyone contacted on THIS channel within the last N hours.';

-- ── The shared predicate ───────────────────────────────────────────────────────
-- ⚠️ ONE definition, used by BOTH the send-time recipient query and the pre-send count.
-- They must never drift: a preview that says "9,000 will receive" and a fan-out that sends to
-- 12,000 is worse than having no preview, and two hand-copied WHERE clauses is exactly how
-- that happens. Written as plain `sql` + STABLE so the planner can INLINE it — a plpgsql
-- version would be an opaque per-row call and would not use messages_profile_idx.
--
-- ⚠️ WHAT COUNTS AS "CONTACTED" — this set is load-bearing and the obvious version is wrong.
-- `comms.messages` holds a row for every ATTEMPT, including gate-refusals: 12,441 of the
-- marketing rows are status='skipped' (freq cap, budget exhausted, quiet hours, no consent).
-- A skipped row means the person received NOTHING. Counting it as "contacted" would exclude
-- thousands of people who have never heard from us — the exact inverse of the intent.
-- So: only the SENT_LIKE set from send.js (sent/delivered/opened/clicked/bounced) plus a
-- FRESH 'queued' row. `bounced` counts because we did send it (and a hard bounce is handled
-- by suppressions, not here). The fresh-queued window mirrors send.js IN_FLIGHT_MS (10 min)
-- and is what makes two CONCURRENTLY-running campaigns actually exclude each other rather
-- than racing between reserve and send.
CREATE OR REPLACE FUNCTION comms.campaign_excluded(
  p_profile_id uuid,
  p_channel text,
  p_exclude_segments uuid[],
  p_exclude_campaigns uuid[],
  p_exclude_contacted_hours int
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    -- ① in an excluded segment
    (coalesce(array_length(p_exclude_segments, 1), 0) > 0 AND EXISTS (
        SELECT 1 FROM comms.segment_members xm
         WHERE xm.profile_id = p_profile_id
           AND xm.segment_id = ANY(p_exclude_segments)))
    OR
    -- ② contacted on THIS channel inside the window
    (p_exclude_contacted_hours IS NOT NULL AND p_exclude_contacted_hours > 0 AND EXISTS (
        SELECT 1 FROM comms.messages m
         WHERE m.profile_id = p_profile_id
           AND m.channel = p_channel
           AND m.queued_at >= now() - make_interval(hours => p_exclude_contacted_hours)
           AND (m.status IN ('sent','delivered','opened','clicked','bounced')
                OR (m.status = 'queued' AND m.queued_at >= now() - interval '10 minutes'))))
    OR
    -- ③ already reached by a named campaign (any channel — see header)
    (coalesce(array_length(p_exclude_campaigns, 1), 0) > 0 AND EXISTS (
        SELECT 1 FROM comms.messages m2
         WHERE m2.profile_id = p_profile_id
           AND m2.source = ANY (SELECT 'campaign:' || c::text FROM unnest(p_exclude_campaigns) c)
           AND (m2.status IN ('sent','delivered','opened','clicked','bounced')
                OR (m2.status = 'queued' AND m2.queued_at >= now() - interval '10 minutes'))));
$$;

-- ── Recipients ────────────────────────────────────────────────────────────────
-- Drop the 5-arg signature first: adding defaulted params would leave two overloads and make
-- a 5-named-arg PostgREST call ambiguous (42725), which would break the fan-out mid-flight.
DROP FUNCTION IF EXISTS comms.campaign_recipients(uuid, text, text, uuid, int);

-- Keyset-paginated reachable recipients for a campaign's materialized segment.
-- The send gate re-checks consent/suppression at send time — this is the accurate pre-filter
-- + ordered cursor for the queue continuation pattern.
-- ⚠️ The exclusion predicate sits in the WHERE, i.e. BEFORE the LIMIT — so a page still returns
-- a FULL p_limit of sendable recipients whenever any remain, and a short page continues to mean
-- "audience exhausted". If exclusions were applied after the limit instead, a heavily-excluded
-- audience would return a short page on its first chunk and processQueueMessage would mark the
-- campaign 'sent' with most of the audience never attempted.
CREATE OR REPLACE FUNCTION comms.campaign_recipients(
  p_segment_id uuid, p_channel text, p_purpose text,
  p_after uuid DEFAULT NULL, p_limit int DEFAULT 100,
  p_exclude_segments uuid[] DEFAULT '{}'::uuid[],
  p_exclude_campaigns uuid[] DEFAULT '{}'::uuid[],
  p_exclude_contacted_hours int DEFAULT NULL)
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
    AND NOT comms.campaign_excluded(sm.profile_id, p_channel,
              p_exclude_segments, p_exclude_campaigns, p_exclude_contacted_hours)
  ORDER BY sm.profile_id ASC
  LIMIT greatest(p_limit, 1);
$$;

-- ── Reach ─────────────────────────────────────────────────────────────────────
-- total     = segment members
-- reachable = passes suppression + consent (what the UI has always shown)
-- excluded  = of those reachable, how many the three new rules drop
-- sendable  = reachable − excluded  ← the number that will actually receive a message
--
-- Reads comms.segment_members (materialized) for BOTH the target and the excluded segments,
-- exactly like campaign_recipients does — so this count and the fan-out see the same rows.
-- The worker materializes all of them before submit/send; the builder's live preview is an
-- estimate against the last materialize, which is what it has always been.
CREATE OR REPLACE FUNCTION comms.campaign_reach(
  p_segment_id uuid, p_channel text, p_purpose text,
  p_exclude_segments uuid[] DEFAULT '{}'::uuid[],
  p_exclude_campaigns uuid[] DEFAULT '{}'::uuid[],
  p_exclude_contacted_hours int DEFAULT NULL)
RETURNS TABLE(total int, reachable int, excluded int, sendable int) LANGUAGE sql STABLE AS $$
  WITH members AS (
    SELECT sm.profile_id FROM comms.segment_members sm WHERE sm.segment_id = p_segment_id
  ), reach AS (
    SELECT m.profile_id FROM members m
     WHERE EXISTS (SELECT 1 FROM comms.identifiers i WHERE i.profile_id=m.profile_id
                    AND i.type = CASE WHEN p_channel='email' THEN 'email' ELSE 'phone' END)
       AND NOT EXISTS (SELECT 1 FROM comms.suppressions s
                        WHERE s.channel=p_channel AND s.profile_id=m.profile_id)
       AND (p_purpose <> 'marketing' OR EXISTS (
             SELECT 1 FROM comms.consent c
              WHERE c.profile_id=m.profile_id AND c.channel=p_channel AND c.purpose='marketing'
                AND c.state='opted_in'
                AND c.id=(SELECT c2.id FROM comms.consent c2
                           WHERE c2.profile_id=m.profile_id AND c2.channel=p_channel AND c2.purpose='marketing'
                           ORDER BY c2.captured_at DESC LIMIT 1)))
  ), scored AS (
    SELECT comms.campaign_excluded(r.profile_id, p_channel,
             p_exclude_segments, p_exclude_campaigns, p_exclude_contacted_hours) AS is_excluded
      FROM reach r
  )
  SELECT (SELECT count(*) FROM members)::int,
         (SELECT count(*) FROM scored)::int,
         (SELECT count(*) FROM scored WHERE is_excluded)::int,
         (SELECT count(*) FROM scored WHERE NOT is_excluded)::int;
$$;

GRANT EXECUTE ON FUNCTION comms.campaign_excluded(uuid, text, uuid[], uuid[], int) TO service_role;
GRANT EXECUTE ON FUNCTION comms.campaign_recipients(uuid, text, text, uuid, int, uuid[], uuid[], int) TO service_role;
GRANT EXECUTE ON FUNCTION comms.campaign_reach(uuid, text, text, uuid[], uuid[], int) TO service_role;
NOTIFY pgrst, 'reload schema';
