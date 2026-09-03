-- 0063 — comms.forms.slug must be lowercase (S338, 2026-09-03)
--
-- WHY: handleFormSubmit lowercases the incoming slug before lookup (forms.js), but the column is
-- plain `text UNIQUE`, so a form saved with a mixed-case slug is permanently unreachable — the
-- lookup can never match it. Caught in the SP1 final review (residual (c)). There is NO worker
-- writer for comms.forms yet (forms.js only reads; no saveForm action, no Relay editor), so today
-- this guards the only writer that exists — hand-written SQL. When saveForm is built it must
-- lowercase the slug itself; this CHECK is the backstop, not the mechanism.
-- Measured 2026-09-03 before applying: 1 form, 0 rows violate.
ALTER TABLE comms.forms
  ADD CONSTRAINT forms_slug_lower_chk CHECK (slug = lower(slug));
