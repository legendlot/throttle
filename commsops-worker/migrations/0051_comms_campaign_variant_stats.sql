-- 0051 — per-arm aggregation for A/B results (S272). AGGREGATION ONLY.
-- The statistics live in commsops-worker/src/ab-stats.js, where they can be unit-tested;
-- this returns counts. Do not add a z-test here.

CREATE OR REPLACE FUNCTION comms.campaign_variant_stats(p_campaign_id uuid)
RETURNS TABLE (
  variant_id      uuid,
  label           text,
  template_id     uuid,
  weight          int,
  assigned        bigint,
  sent            bigint,
  delivered       bigint,
  read_count      bigint,
  pre_send_failed bigint,
  provider_failed bigint,
  skipped         bigint,
  cost            numeric,
  last_sent_at    timestamptz,
  fail_reasons    jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT v.id, v.label, v.template_id, v.weight,
         count(m.id)                                            AS assigned,
         count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)        AS sent,
         count(m.id) FILTER (WHERE m.delivered_at IS NOT NULL)   AS delivered,
         count(m.id) FILTER (WHERE m.read_at IS NOT NULL)        AS read_count,
         -- ⚠️ THE SPLIT THAT DECIDES WHETHER A RESULT IS BIASED OR MERELY SMALL.
         -- Measured 2026-08-11 across every failed/skipped message in comms.messages:
         --   render failures (unresolved_variables) — 57 rows, 0 with sent_at
         --   gate skips                             — 11,563 rows, 0 with sent_at
         --   wa_131049 pacing blocks                — 1,905 rows, ALL 1,905 with sent_at
         -- PRE-SEND failures never entered `sent`, so they remove people from the ITT
         -- denominator NON-RANDOMLY (everyone missing a first_name) → that biases.
         -- POST-SEND failures are inside `sent` and contribute zero reads → under ITT they
         -- are part of the treatment effect, NOT a confound. Do not conflate the two.
         count(m.id) FILTER (WHERE m.status IN ('failed','skipped','suppressed')
                               AND m.sent_at IS NULL)            AS pre_send_failed,
         count(m.id) FILTER (WHERE m.status = 'failed'
                               AND m.sent_at IS NOT NULL)        AS provider_failed,
         count(m.id) FILTER (WHERE m.status IN ('skipped','suppressed')) AS skipped,
         coalesce(sum(m.cost), 0)                                AS cost,
         -- Maturity must be measured from the last ACTUAL send, never campaigns.updated_at:
         -- that column is bumped by the page heartbeat and by any later edit, so an edit
         -- would make a mature result look immature again.
         max(m.sent_at)                                          AS last_sent_at,
         -- ⚠️ Counts per reason via a GROUPED subquery. `jsonb_object_agg(reason, 1)` over raw
         -- rows silently collapses duplicate keys and reports 1 for EVERY reason — verified
         -- against live data 2026-08-11 (it returned quiet_hours:1 where the truth was 235).
         coalesce((
           SELECT jsonb_object_agg(r.reason, r.n)
             FROM (SELECT m2.reason, count(*) AS n
                     FROM comms.messages m2
                    WHERE m2.variant_id = v.id
                      AND m2.status IN ('failed','skipped','suppressed')
                      AND m2.reason IS NOT NULL
                    GROUP BY m2.reason) r
         ), '{}'::jsonb)                                         AS fail_reasons
    FROM comms.campaign_variants v
    LEFT JOIN comms.messages m ON m.variant_id = v.id
   WHERE v.campaign_id = p_campaign_id
   GROUP BY v.id, v.label, v.template_id, v.weight, v.sort_order
   ORDER BY v.sort_order, v.label;
$$;

GRANT EXECUTE ON FUNCTION comms.campaign_variant_stats(uuid) TO service_role;
