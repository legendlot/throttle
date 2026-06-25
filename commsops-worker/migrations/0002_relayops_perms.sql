-- Relay permission layer — lives in store (Snorkel/Podium pattern), not comms.
-- Applied 2026-06-25 (S170) via Supabase apply_migration.
CREATE TABLE IF NOT EXISTS store.relayops_roles (
  role_key    text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store.relayops_user_roles (
  user_id     uuid PRIMARY KEY,
  role_key    text NOT NULL REFERENCES store.relayops_roles(role_key),
  active      boolean NOT NULL DEFAULT true,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

-- Six clonable/editable presets (PRD §10).
INSERT INTO store.relayops_roles (role_key, label, description, permissions, is_system) VALUES
 ('viewer','Viewer','Read-only',
   '{"relay_view":true}', true),
 ('author','Author','Build segments/templates/campaigns + journeys (draft) + test-send',
   '{"relay_view":true,"segment_manage":true,"template_manage":true,"campaign_build":true}', true),
 ('manager','Manager','Author + activate sends',
   '{"relay_view":true,"segment_manage":true,"template_manage":true,"campaign_build":true,"send_activate":true}', true),
 ('approver','Approver','View + approve sends',
   '{"relay_view":true,"approve":true}', true),
 ('admin','Admin','All build + send + approve + data/consent + connectors',
   '{"relay_view":true,"segment_manage":true,"template_manage":true,"campaign_build":true,"send_activate":true,"approve":true,"data_consent_admin":true,"connector_channel_manage":true,"relay_admin":true}', true),
 ('super_admin','Super-admin','Full governance incl. role builder + thresholds',
   '{"relay_view":true,"segment_manage":true,"template_manage":true,"campaign_build":true,"send_activate":true,"approve":true,"data_consent_admin":true,"connector_channel_manage":true,"relay_admin":true,"relay_super_admin":true}', true)
ON CONFLICT (role_key) DO NOTHING;

ALTER TABLE store.relayops_roles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE store.relayops_user_roles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.relayops_roles      TO service_role;
GRANT ALL ON store.relayops_user_roles TO service_role;

NOTIFY pgrst, 'reload schema';
