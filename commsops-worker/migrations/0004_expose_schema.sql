-- Add comms to the PostgREST exposed-schemas list (RULE-IGN-007 / PATTERN-092).
-- Without this PostgREST refuses to route to comms (PGRST106 Invalid schema).
-- Applied 2026-06-25 (S170) via Supabase apply_migration.
ALTER ROLE authenticator SET pgrst.db_schemas =
  'public, graphql_public, store, brand, ignition, podium, docket, manifest, sales, comms';
NOTIFY pgrst, 'reload config';
