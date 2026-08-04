-- 0041 — rename_media_references(): also repoint the `variables` columns.
-- Applied to lot-production 2026-08-04 as `rename_media_refs_include_variables`.
--
-- THE BUG. The function repointed `templates.content`, `template_versions.content` and
-- `wa_media_cache.asset_url` — but a template's per-variable FALLBACK url lives in
-- `templates.variables`, which it never touched. So renaming a library image silently rotted every
-- template that used it as a fallback, and nothing surfaced until a send failed.
--
-- MEASURED COST (2026-08-04). `email/1784742185064_cart-abandonment-imgupscaler.ai-sharpener-2k.jpg`
-- was renamed to `email/1784742185064_pr-cart-ab-v1.jpg` on 2026-07-22. Six templates (five ACTIVE)
-- kept pointing at the dead name, giving **30 failed sends across 28 distinct customers between
-- 07-24 and 08-04, still running at ~2-3/day**, on the LIVE `Cart Recovery 1&2` and
-- `ATC-Cart Abandonment` journeys. Meta could not fetch the header image and rejected each send
-- with 131053. The fallbacks were repointed by hand (snapshot
-- `comms.safety_tpl_fallback_2026_08_04`); this migration fixes the cause.
--
-- ⚠️ It only bites when the EVENT carries no image and the fallback is actually used, which is why
-- it read as a low background failure rate rather than an outage. Do not dismiss this class on the
-- rate alone — every one of those is a customer who got nothing.
--
-- SCOPE WAS DERIVED EMPIRICALLY, NOT GUESSED — the original omission is exactly what guessing
-- produces. Every column in `comms` currently holding a `relay-email-assets/email/` path,
-- counted 2026-08-04:
--     template_versions.content    27   (already covered)
--     templates.content            19   (already covered)
--     template_versions.variables  16   ← ADDED HERE
--     templates.variables          12   ← ADDED HERE (the live defect)
--     wa_media_cache.asset_url      7   (already covered)
--     journey_versions.definition   0   ← deliberately NOT covered, see below
--     campaigns                     0
--
-- `journey_versions.definition` is left alone ON PURPOSE: it holds zero paths today, and a journey
-- version is the immutable thing an in-flight enrolment is pinned to. Rewriting one would change
-- what a running enrolment renders. If a send step ever embeds a media URL directly, revisit that
-- trade rather than adding it reflexively — and re-run the count above, which is the check that
-- would have caught this bug.
--
-- `template_versions.variables` IS rewritten, matching the existing treatment of
-- `template_versions.content`: the bytes behind the asset are unchanged by a rename, so rewriting
-- keeps the archive renderable instead of pointing it at dead URLs.

CREATE OR REPLACE FUNCTION comms.rename_media_references(p_old_path text, p_new_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_tpl       int := 0;
  v_tpl_vars  int := 0;
  v_ver       int := 0;
  v_ver_vars  int := 0;
  v_cache     int := 0;
BEGIN
  IF p_old_path IS NULL OR p_new_path IS NULL
     OR p_old_path NOT LIKE 'email/%' OR p_new_path NOT LIKE 'email/%' THEN
    RAISE EXCEPTION 'bad_path';
  END IF;

  UPDATE comms.templates
     SET content = replace(content::text, p_old_path, p_new_path)::jsonb,
         updated_at = now()
   WHERE content::text LIKE '%' || p_old_path || '%';
  GET DIAGNOSTICS v_tpl = ROW_COUNT;

  -- THE FIX. A variable's `fallback` is a full URL and is what a send falls back to when the event
  -- carries no image — i.e. exactly the path that fails silently when it rots.
  UPDATE comms.templates
     SET variables = replace(variables::text, p_old_path, p_new_path)::jsonb,
         updated_at = now()
   WHERE variables::text LIKE '%' || p_old_path || '%';
  GET DIAGNOSTICS v_tpl_vars = ROW_COUNT;

  UPDATE comms.template_versions
     SET content = replace(content::text, p_old_path, p_new_path)::jsonb
   WHERE content::text LIKE '%' || p_old_path || '%';
  GET DIAGNOSTICS v_ver = ROW_COUNT;

  UPDATE comms.template_versions
     SET variables = replace(variables::text, p_old_path, p_new_path)::jsonb
   WHERE variables::text LIKE '%' || p_old_path || '%';
  GET DIAGNOSTICS v_ver_vars = ROW_COUNT;

  -- Not strictly required (a miss here just re-uploads the asset to Meta and self-heals),
  -- but keeping it correct avoids pushing a multi-MB file to Meta again for no reason.
  UPDATE comms.wa_media_cache
     SET asset_url = replace(asset_url, p_old_path, p_new_path)
   WHERE asset_url LIKE '%' || p_old_path || '%';
  GET DIAGNOSTICS v_cache = ROW_COUNT;

  -- Keys kept additive: `templates`/`versions`/`media_cache` retain their original meaning so any
  -- existing caller reading them is unaffected.
  RETURN jsonb_build_object(
    'templates',           v_tpl,
    'template_variables',  v_tpl_vars,
    'versions',            v_ver,
    'version_variables',   v_ver_vars,
    'media_cache',         v_cache);
END;
$function$;

COMMENT ON FUNCTION comms.rename_media_references(text, text) IS
  'Repoints a renamed library image across templates.content, templates.VARIABLES, template_versions.content, template_versions.VARIABLES and wa_media_cache.asset_url, in ONE transaction. The two variables columns were added 2026-08-04 after their omission silently rotted 6 templates and cost 30 sends / 28 customers over 11 days. Matches the path SEGMENT (email/<name>), not the full URL — the URL is composed in two differing forms (raw vs encodeURIComponent-ed) and a full-URL match misses one. journey_versions.definition is deliberately excluded: 0 paths today, and it is what in-flight enrolments are pinned to.';
