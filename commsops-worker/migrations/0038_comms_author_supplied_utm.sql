-- 0038 — author-supplied UTM parameters, settable from the Relay UI.
-- Applied to lot-production 2026-07-30 as `comms_author_supplied_utm`.
--
-- WHY. UTM tagging shipped in S189 but was wired into the EMAIL branch of send.js only, and
-- email-marketing volume is ZERO — so 100% of real sends went out untagged (2,985 WhatsApp
-- marketing sends in the trailing 30d, none attributable in GA4/Odo; 35 WA templates, 0 with a
-- hardcoded utm_). The values were also entirely auto-derived, with no way for the team to set
-- utm_campaign/utm_content themselves.
--
-- PRECEDENCE (commsops `resolveUtm`, one resolver for every channel so email and WhatsApp cannot
-- drift apart again). Most specific wins, merged PER KEY:
--   templates.utm  >  journeys.utm / campaigns.utm  >  settings.utm_defaults  >  auto-derived
-- Auto-derived (utm_source='relay', utm_medium=<channel>, utm_campaign=<journey|campaign name>,
-- utm_content=<template name>) stays the FLOOR, so a send with nothing configured anywhere is
-- tagged exactly as before this migration. Every column is nullable with no default: absent
-- means "inherit", never "empty".
--
-- Shape is jsonb {"utm_campaign":"diwali_2026","utm_content":"hero_a"}. The worker's
-- normalizeUtm() also accepts the shorthand {"campaign":"..."} and FORCES any unprefixed key
-- into the utm_ namespace (`ref` -> `utm_ref`) — these values become query params on
-- customer-facing links, so nothing may escape utm_*; namespacing is what makes custom keys
-- safe. Blank strings are dropped so an empty UI field never overrides a broader layer.
--
-- Only MARKETING sends are tagged. Utility/transactional are deliberately left clean so order
-- and shipping notifications do not pollute campaign attribution.

ALTER TABLE comms.templates  ADD COLUMN IF NOT EXISTS utm jsonb;
ALTER TABLE comms.journeys   ADD COLUMN IF NOT EXISTS utm jsonb;
ALTER TABLE comms.campaigns  ADD COLUMN IF NOT EXISTS utm jsonb;
ALTER TABLE comms.settings   ADD COLUMN IF NOT EXISTS utm_defaults jsonb;

COMMENT ON COLUMN comms.templates.utm IS
  'Author-supplied utm_* overrides for this template — the MOST specific layer (beats journey/campaign, account defaults, auto-derived). Typically utm_content, i.e. which creative/variant. NULL = inherit. Keys without the utm_ prefix are forced into the utm_ namespace by the worker (ref -> utm_ref); blanks are dropped so an empty field never overrides a broader layer.';
COMMENT ON COLUMN comms.journeys.utm IS
  'Author-supplied utm_* for every marketing send in this journey. Typically utm_campaign. Overridden per template; NULL = inherit account defaults, then auto-derived (the journey name). Merged PER KEY, so setting utm_campaign here does not wipe the auto-derived utm_content.';
COMMENT ON COLUMN comms.campaigns.utm IS
  'Author-supplied utm_* for this broadcast. Typically utm_campaign. Overridden per template; NULL = inherit account defaults, then auto-derived (the campaign name).';
COMMENT ON COLUMN comms.settings.utm_defaults IS
  'Account-wide utm_* floor (e.g. pin utm_source). Overridden per journey/campaign and per template. NULL = auto-derived only. Only MARKETING sends are tagged at all.';

-- A new COLUMN is invisible to PostgREST until the schema cache reloads, and the worker selects
-- these by name — without this the reads 404 the column (CORE.md documents the same trap for
-- tables; it applies to columns too).
NOTIFY pgrst, 'reload schema';
