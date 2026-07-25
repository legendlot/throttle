-- 0034_comms_event_registry — make comms.event_definitions THE single source of truth
-- for every event picker in Relay (segments, journeys, journey-canvas node drawer).
--
-- WHY: the three pickers each carried their own hardcoded EVENT_SUGGEST array (10 / 7 / 10
-- entries, mutually inconsistent), so 24 of the 34 registered events were invisible in the
-- segment builder — including the entire courier lifecycle (order_delivered/_rto/_shipped/
-- _out_for_delivery), payment_link_*, segment_entered, whatsapp_*, shopflo_order_completed.
-- Worse, the segment list SUGGESTED `email_clicked`, which S189 renamed to `link_clicked` —
-- so the one click event on offer could never match a row.
--
-- AFTER THIS: registering an event = INSERT one row here with a `category`. It then appears,
-- correctly grouped, in every picker with no code change anywhere.

-- 1. Grouping key. Deliberately free text (no CHECK/enum) so a genuinely new family can be
--    added without a migration; the UI orders/labels the KNOWN slugs and gracefully appends
--    an unknown one at the end rather than hiding it. Known slugs:
--      order · cart · payment · email · whatsapp · engagement · audience · support
ALTER TABLE comms.event_definitions ADD COLUMN IF NOT EXISTS category text;

COMMENT ON COLUMN comms.event_definitions.category IS
  'Picker grouping slug (order|cart|payment|email|whatsapp|engagement|audience|support). '
  'Free text by design — unknown values still render, grouped last. NULL reads as "other".';

-- 2. Backfill all 34 live definitions.
UPDATE comms.event_definitions SET category = 'order' WHERE name IN (
  'order_placed','order_fulfilled','order_shipped','order_out_for_delivery',
  'order_delivered','order_cancelled','order_rto','return_created','shopflo_order_completed');

UPDATE comms.event_definitions SET category = 'cart' WHERE name IN (
  'add_to_cart','cart_viewed','cart_item_removed','checkout_started','checkout_abandoned',
  'product_viewed','collection_viewed','search_submitted');

UPDATE comms.event_definitions SET category = 'payment' WHERE name IN (
  'payment_link_paid','payment_link_failed');

UPDATE comms.event_definitions SET category = 'email' WHERE name IN (
  'email_delivered','email_opened','email_clicked','email_bounced','email_received','email_replied');

UPDATE comms.event_definitions SET category = 'whatsapp' WHERE name IN (
  'whatsapp_delivered','whatsapp_read','whatsapp_inbound','whatsapp_reply');

-- link_clicked is deliberately channel-AGNOSTIC (S189) — it is not an email event, and SMS/WA
-- will emit the same name via the Phase-B redirect. Its own group keeps that contract visible.
UPDATE comms.event_definitions SET category = 'engagement' WHERE name IN ('link_clicked');

UPDATE comms.event_definitions SET category = 'audience' WHERE name IN (
  'segment_entered','opted_out');

UPDATE comms.event_definitions SET category = 'support' WHERE name IN (
  'ticket_opened','repair_status_changed');

-- 3. Retire the stale `email_clicked` definition. S189 renamed the engagement event
--    email_clicked -> link_clicked (channel-agnostic); the old name has NEVER been written
--    (0 rows all-time) and is referenced by no segment, journey trigger or journey version
--    (verified 2026-07-24). Leaving it active meant the segment builder offered a click
--    condition that silently matched nothing. Row is kept (not removed) for provenance —
--    `is_active=false` simply takes it out of every picker.
UPDATE comms.event_definitions
   SET is_active = false,
       description = COALESCE(description || ' ', '')
         || '[RETIRED S233 — renamed to link_clicked in S189; never written. Use link_clicked.]'
 WHERE name = 'email_clicked' AND is_active;

-- 4. ONE set-based read backing every picker: the active registry + live usage, so an author
--    can see at a glance that an event has never fired (the exact trap email_clicked was).
--    Usage is bounded to p_days and served by events_name_time_idx (name, occurred_at DESC).
CREATE OR REPLACE FUNCTION comms.event_registry(p_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH usage AS (
    SELECT e.name, COUNT(*) AS n, MAX(e.occurred_at) AS last_seen
      FROM comms.events e
     WHERE e.occurred_at > now() - make_interval(days => GREATEST(p_days, 1))
     GROUP BY e.name
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'name',         d.name,
             'description',  d.description,
             'category',     COALESCE(NULLIF(d.category, ''), 'other'),
             'recent_count', COALESCE(u.n, 0),
             'last_seen_at', u.last_seen
           )
           ORDER BY COALESCE(NULLIF(d.category, ''), 'other'), d.name
         ), '[]'::jsonb)
    FROM comms.event_definitions d
    LEFT JOIN usage u ON u.name = d.name
   WHERE d.is_active;
$$;

GRANT EXECUTE ON FUNCTION comms.event_registry(int) TO service_role;
