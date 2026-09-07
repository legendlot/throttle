-- S355 fix round 2 (final review, finding I1) — the bot_active rail gets a TTL at READ time.
-- Nothing clears the rail when a customer simply walks away mid-flow: the 6h idle expiry in
-- bot-wa.js only fires on that customer's NEXT inbound, and a web session has no inbound-driven
-- expiry at all. An abandoned session therefore held its thread out of Awaiting, out of the
-- unread counts and out of retroAssignUnownedThreads FOREVER. The workers now read the rail as
-- live only while `last_inbound_at` is inside the same 6h window the session uses
-- (csops-worker/src/bot-forward.js `railLive` / `BOT_RAIL_TTL_MS`, index.js getMessagingThreads +
-- retroAssignUnownedThreads); these two counting RPCs must say the same thing or the topbar pills
-- and the list disagree again — the exact bug v1 was written to close.
--
-- Re-issued VERBATIM from cs_threads_bot_active_v1.sql with exactly one change each:
--   `NOT t.bot_active`  ->  `NOT (t.bot_active AND t.last_inbound_at > now() - interval '6 hours')`
--   `AND NOT bot_active` ->  `AND NOT (bot_active AND last_inbound_at > now() - interval '6 hours')`
-- A NULL `last_inbound_at` would make the inner AND NULL, but it is unreachable in BOTH bodies:
-- `awaiting_reply` and `has_unread_inbound` are generated columns that are both false when
-- `last_inbound_at IS NULL` (verified against information_schema, 2026-09-08), and each guards its
-- own expression. No COALESCE is needed and none is added, so the text stays a verbatim diff of v1.

CREATE OR REPLACE FUNCTION store.cs_messaging_stats(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
WITH elig AS (
  SELECT t.id, t.channel, t.thread_state, t.assigned_agent_id,
         (t.awaiting_reply AND NOT (t.bot_active AND t.last_inbound_at > now() - interval '6 hours')) AS awaiting_reply
  FROM store.cs_wa_threads t
  WHERE COALESCE(t.ignition_connect, false) = false
    AND (t.last_message_at IS NOT NULL OR t.provider_thread_ref IS NOT NULL)
    AND t.channel IN ('instagram', 'messenger', 'whatsapp', 'email', 'web')
),
unread AS (SELECT u.channel, u.cnt FROM store.cs_unread_counts_by_channel() u),
agg AS (
  SELECT e.channel,
    count(*) FILTER (WHERE e.thread_state IN ('open','snoozed'))                                     AS total,
    count(*) FILTER (WHERE e.thread_state IN ('open','snoozed') AND e.assigned_agent_id = p_user_id) AS mine,
    count(*) FILTER (WHERE e.thread_state IN ('open','snoozed') AND e.assigned_agent_id IS NULL)     AS unassigned,
    count(*) FILTER (WHERE e.thread_state = 'closed')                                                AS closed,
    count(*) FILTER (WHERE e.thread_state IN ('open','snoozed') AND e.awaiting_reply)                AS awaiting_raw
  FROM elig e
  GROUP BY e.channel
)
SELECT COALESCE(jsonb_object_agg(c.channel, jsonb_build_object(
         'total',      COALESCE(a.total, 0),
         -- every channel now, not just the three messaging ones
         'awaiting',   COALESCE(a.awaiting_raw, 0),
         'mine',       COALESCE(a.mine, 0),
         'unassigned', COALESCE(a.unassigned, 0),
         'closed',     COALESCE(a.closed, 0),
         'unread',     COALESCE(u.cnt, 0))), '{}'::jsonb)
FROM (VALUES ('instagram'), ('messenger'), ('whatsapp'), ('email'), ('web')) c(channel)
LEFT JOIN agg    a ON a.channel = c.channel
LEFT JOIN unread u ON u.channel = c.channel;
$function$;

CREATE OR REPLACE FUNCTION store.cs_unread_counts_by_channel()
 RETURNS TABLE(channel text, cnt bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'store'
AS $function$
  SELECT channel, count(*)::bigint
  FROM store.cs_wa_threads
  WHERE has_unread_inbound
    AND thread_state IN ('open','snoozed')
    AND COALESCE(ignition_connect, false) = false
    AND NOT (bot_active AND last_inbound_at > now() - interval '6 hours')
  GROUP BY channel;
$function$;

NOTIFY pgrst, 'reload schema';
