-- 0060 · comms.form_submissions.channels (S331 SP1, final review F2) — persist the channels
-- the customer actually CHOSE, so confirmation cannot fabricate consent for one they declined.
-- Spec: docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md
-- ⚠️ MIRROR MARKER of an applied Supabase migration — the live DB is the source of truth.
--
-- WHY: validateSubmission() already resolves the chosen channels (an explicit `channels`
-- array from the widget, else the reachable defaults), but 0059 gave the row nowhere to keep
-- them. handleFormConfirm therefore RE-DERIVED them from mere field PRESENCE
-- (`sub.payload?.email && 'email'`) — so a customer who typed both an email and a WhatsApp
-- number but ticked only "email" was written a whatsapp/marketing/opted_in row they had
-- declined. Consent here is DPDP evidence; a fabricated row is the worst thing this table can
-- produce. Choice is not derivable from presence, so it has to be stored.
--
-- NULLABLE on purpose: rows captured before this migration have no recorded choice, and
-- forcing a default would assert a choice they never made. handleFormConfirm keeps the old
-- presence-derivation as a fallback for exactly those rows and nothing else.
ALTER TABLE comms.form_submissions ADD COLUMN channels text[];

COMMENT ON COLUMN comms.form_submissions.channels IS
  'Channels the customer chose at capture (email|whatsapp). One consent row per entry at '
  'confirmation. NULL = captured before migration 0060; confirm falls back to field presence.';

-- ⚠️ REQUIRED. PostgREST serves from a cached schema: until the cache reloads, a POST naming
-- `channels` is rejected with PGRST204 "Could not find the 'channels' column" even though the
-- column exists. Same trailing line as 0059.
NOTIFY pgrst, 'reload schema';
