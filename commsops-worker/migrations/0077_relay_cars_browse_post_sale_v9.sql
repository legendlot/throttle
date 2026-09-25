-- 0077 (S400, 2026-09-25) — APPLIED LIVE via execute_sql; this file is the record.
-- Cars Browse (212ab2a1) post-sale 2nd nudge: Pruthvi's new template
-- "LOTC_Browse Abandonment — WhatsApp (6hrs)" (149b9915, Meta 1611760353959931, APPROVED;
-- test to +917709991011 delivered 18:58 IST). The pre-sale 6h template (a37d51c8) was edited
-- in place to sale copy, which is why 0076 fell back to v3 (single message) for this journey.
--
-- 1. journey_versions v9 = v7's definition with send_mszox9nc2.templateId → 149b9915.
-- 2. comms.s400_post_sale_template_revert(): Cars Browse row (8, 7, 3) → (8, 9, 3), so the
--    27 Sep 15:30 IST pg_cron job `relay-s400-post-sale-revert` lands it on v9 (30m + 6h),
--    v3 only if v9 ever fails the approved/sale-copy guard. Guard dry-run on v9: pass.
insert into comms.journey_versions (journey_id, version, definition, created_by)
select journey_id, 9, jsonb_set(definition, '{steps,send_mszox9nc2,templateId}',
       '"149b9915-6fa1-44c5-9b37-bdaad624e216"'), 'claude-s400-post-sale-lotc'
from comms.journey_versions where journey_id = '212ab2a1-4bd6-460f-8952-cda455332621' and version = 7;
-- (function body: see 0076, with the Cars Browse VALUES row changed to (…, 8, 9, 3))
