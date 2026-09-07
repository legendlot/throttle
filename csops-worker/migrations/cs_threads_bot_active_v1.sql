-- S355 — bot_active rail (spec §5.3). closed_reason CHECK widened in the SAME migration (CLAUDE.md enum rule).
ALTER TABLE store.cs_wa_threads ADD COLUMN IF NOT EXISTS bot_active boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cs_wa_threads_bot_active_idx ON store.cs_wa_threads (bot_active) WHERE bot_active;
ALTER TABLE store.cs_wa_threads DROP CONSTRAINT IF EXISTS cs_wa_threads_closed_reason_check;
ALTER TABLE store.cs_wa_threads ADD CONSTRAINT cs_wa_threads_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('resolved','no_response','no_evidence','no_payment','duplicate','wrong_system','goodwill','no_action','other','bot_resolved'));
-- any human-authored outbound ends the bot's claim on the thread (every agent send path, one site)
CREATE OR REPLACE FUNCTION store.cs_clear_bot_active() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = store, public AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.sent_by_user_id IS NOT NULL THEN
    UPDATE store.cs_wa_threads SET bot_active = false WHERE id = NEW.thread_id AND bot_active;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cs_wa_messages_clear_bot_active ON store.cs_wa_messages;
CREATE TRIGGER cs_wa_messages_clear_bot_active AFTER INSERT ON store.cs_wa_messages
  FOR EACH ROW EXECUTE FUNCTION store.cs_clear_bot_active();
-- an agent closing / snoozing / claiming the thread BY HAND writes no message row (setThreadState,
-- assignThread are PATCH-only) — clear the rail on those transitions too, or the thread is invisible forever
CREATE OR REPLACE FUNCTION store.cs_clear_bot_active_manual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = store, public AS $$
BEGIN
  IF NEW.bot_active AND (
       (NEW.thread_state IS DISTINCT FROM OLD.thread_state AND NEW.thread_state IN ('closed','snoozed'))
    OR (NEW.assigned_agent_id IS NOT NULL AND OLD.assigned_agent_id IS NULL)
  ) THEN
    NEW.bot_active := false;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cs_wa_threads_clear_bot_active_manual ON store.cs_wa_threads;
CREATE TRIGGER cs_wa_threads_clear_bot_active_manual BEFORE UPDATE ON store.cs_wa_threads
  FOR EACH ROW EXECUTE FUNCTION store.cs_clear_bot_active_manual();

-- ── The two counting RPCs, re-issued from their LIVE definitions with exactly one change each ──
-- The topbar Awaiting/unread pills must agree with the list filter (index.js:10335-10337), which
-- now carries &bot_active=is.false. Everything else is verbatim: total/mine/unassigned/closed stay
-- whole-channel — a bot thread is still a thread on the Unassigned tab, with its badge.
CREATE OR REPLACE FUNCTION store.cs_messaging_stats(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
WITH elig AS (
  SELECT t.id, t.channel, t.thread_state, t.assigned_agent_id, (t.awaiting_reply AND NOT t.bot_active) AS awaiting_reply
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
    AND NOT bot_active
  GROUP BY channel;
$function$;

NOTIFY pgrst, 'reload schema';
