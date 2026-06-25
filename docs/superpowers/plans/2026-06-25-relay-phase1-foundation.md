# Relay — Phase 1 (Foundation + Email Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full `comms` substrate skeleton + the `commsops` worker + the `apps/relay` app, then flesh out the **email channel end-to-end** — Shopify-fed profiles/consent, a central send gate, segments, broadcasts, and one journey — so the marketing team can build and send governed email without engineering, on an architecture that grows to SMS/WhatsApp without a rethink.

**Architecture:** Independent LOT system (sibling of Odo). New Cloudflare Worker `commsops` is the only DB client for a new RLS-on, service_role-only Supabase `comms` schema. A Next.js static-export app `apps/relay` (on `@throttle/*`) is perm-gated by a `relayops` permission layer (`store.relayops_roles` + custom role builder). Every send — campaign, journey, or external caller — funnels through one `send(channel, profile, template, vars)` spine that enforces suppression → consent → frequency cap → quiet hours → channel rule, logs to `comms.messages`, and emits engagement events. The journey engine compiles versioned-JSON journeys to Cloudflare Workflows + Durable Objects + Queues + Alarms. v1 implements only the **email** adapter; SMS/WhatsApp slots exist but stay empty.

**Tech Stack:** Cloudflare Workers (CommonJS, `fetch`-based, no npm deps beyond `wrangler`), Cloudflare Workflows + Durable Objects + Queues (journey engine — new to this monorepo), Supabase Postgres (`comms` schema via PostgREST `Accept-Profile`/`Content-Profile`), Resend (ESP), Next.js 14 static export + Turborepo + `@throttle/{ui,auth,db,domain}`, Shopify Admin API webhooks + Web Pixel.

---

## Phase-0 decisions locked (2026-06-25, S170)

| Decision | Choice | Consequence in this plan |
|---|---|---|
| ESP | **Resend** | Email adapter targets Resend HTTPS API; domain auth on Cloudflare DNS. |
| Consent backfill | **Honor Shopify marketing opt-ins** (`source='shopify_import'`, original `captured_at`); **re-collect Bitespeed WA** (seed `unknown`) | M4 backfill writes `opted_in` rows only for explicit Shopify marketing consent; WA identities get no marketing consent row (→ `unknown`). |
| Marketing sending subdomain | **`comms.legendoftoys.com`** | Single `sender_identities` email row; SPF/DKIM/DMARC verified on this subdomain; kept distinct from `carecrew@` inbound. |
| Email volume | **50k–250k/month** | Resend mid tier (~$20–100/mo). Broadcast fan-out must be Queue-throttled (50-subrequest Worker limit); no budget blocker. |
| WA number cutover (Phase 3) | default migrate-existing, test on temp number | Out of Phase-1 scope; `sender_identities` slots reserved only. |

---

## Naming & seams (read before any task)

| Thing | Name | Notes |
|---|---|---|
| Worker | `commsops` | dir `05_Throttle/commsops-worker/`; URL `https://commsops.afshaan.workers.dev`. **NOT** `relayops-worker`. |
| Schema | `comms` | RLS-on, service_role-only (RULE-RLS-001). Must be added to PostgREST exposed-schemas (RULE-IGN-007 / PATTERN-092). |
| App | `apps/relay` | `@throttle/relay`, served at `relay.legendoftoys.com`. Brand: Relay Yellow `#F2CD1A`, Ink `#282828`, Signal Red `#DE2A2A` (PRD §17). |
| Permission layer | `relayops` | tables `store.relayops_roles` + `store.relayops_user_roles` (Snorkel/Podium pattern — live in `store`, not `comms`). |
| App→worker env | `NEXT_PUBLIC_WORKER_URL` = `https://commsops.afshaan.workers.dev` | also `NEXT_PUBLIC_COMMSOPS_URL`. |

**The three contracts that must never drift (every milestone depends on these):**

1. **Ingestion contract** — `POST /?action=ingest` with body
   `{ identifiers: [{type,value}], name, occurred_at, properties, source, idempotency_key }`
   → resolves identity → appends `comms.events` row → derives attributes → fires triggers. Idempotent on `idempotency_key`. This is the single seam Shopify, internal events, delivery receipts, and (later) Pitstop all call.

2. **Send contract** — internal `send({ channel, profile_id|identifiers, template_id, vars, purpose, source, dedup_key })` → runs the gate → on pass calls `adapter.send(rendered)` → writes one `comms.messages` row → returns `{ message_id, status }`. On gate-fail writes a `skipped`/`suppressed` messages row (never a silent drop). Exposed as `POST /?action=send` for internal callers (so Pitstop can re-point here at WhatsApp cutover — Phase 3).

3. **Adapter contract** — the only channel-specific code anywhere:
   `send(rendered) → { provider_message_id, status }` ·
   `parseStatusWebhook(payload) → [{ provider_message_id, canonical_status, at, reason }]` ·
   `parseInbound(payload)` (two-way channels only — not email).
   v1 ships `adapters/email.js` (Resend) only.

**Permission keys (seeded in M0, enforced in M1, gated in M2):**
`relay_view`, `segment_manage`, `template_manage`, `campaign_build`, `send_activate`, `approve`, `data_consent_admin`, `connector_channel_manage`, `relay_admin`, `relay_super_admin`.

---

## File structure (created across the whole plan)

```
05_Throttle/
├── commsops-worker/                         # NEW worker (M1)
│   ├── package.json                          # CommonJS, wrangler devDep only
│   ├── wrangler.toml                         # name=commsops; [vars] SUPABASE_URL; Queues + DO + Workflows bindings (M7)
│   ├── migrations/
│   │   ├── 0001_comms_schema_v1.sql          # M0 — full substrate+delivery+orchestration skeleton
│   │   ├── 0002_relayops_perms.sql           # M0 — store.relayops_roles/user_roles + 6 seeded presets
│   │   ├── 0003_comms_seed.sql               # M0 — event_definitions + comms.settings + sender_identities email placeholder
│   │   └── 0004_expose_schema.sql            # M0 — add comms to PostgREST exposed-schemas
│   └── src/
│       ├── index.js                          # M1 — fetch handler, CORS, routing, verifyJWT, sb client
│       ├── auth.js                            # M1 — verifyJWT + getRelayopsPerms + permission gates
│       ├── identity.js                        # M3 — resolveIdentity / merge
│       ├── ingest.js                          # M3 — /ingest handler + attribute derivation + trigger fan-out
│       ├── consent.js                         # M3/M5 — consent ledger writes + latest-state reader
│       ├── gate.js                            # M5 — the central send gate
│       ├── render.js                          # M5 — template + variable rendering + validation
│       ├── send.js                            # M5 — send() spine + messages log + dedup
│       ├── adapters/email.js                  # M5 — Resend adapter (the only channel code in v1)
│       ├── webhooks.js                        # M4/M5 — Shopify + Resend webhook receivers
│       ├── shopify.js                         # M4 — backfill + webhook→ingest mapping
│       ├── segments.js                        # M6 — AST eval + materialization + reachable-count
│       ├── campaigns.js                       # M6 — broadcast CRUD + approval lifecycle + scheduled fan-out
│       ├── journeys.js                        # M7 — journey/version CRUD + compile + enrol
│       ├── journey-workflow.js                # M7 — Cloudflare Workflow entrypoint (per-enrolment)
│       └── enrolment-do.js                    # M7 — Durable Object (per-enrolment timer/state/caps)
├── apps/relay/                               # scaffold in M2 (public/ assets already staged)
│   ├── package.json  next.config.js  jsconfig.json
│   ├── public/  (favicon set already staged S170)
│   └── src/
│       ├── app/
│       │   ├── layout.js  globals.css  redesign.css
│       │   ├── page.js  login/page.js
│       │   └── (auth)/
│       │       ├── layout.js                  # Sidebar + nav, perm-filtered
│       │       ├── campaigns/{page,new,detail}/page.js   # M6
│       │       ├── journeys/{page,new,detail}/page.js    # M7
│       │       ├── segments/{page,new,detail}/page.js    # M6
│       │       ├── templates/{page,new,detail}/page.js   # M5
│       │       ├── contacts/{page,detail}/page.js        # M3/M4 (profiles browser)
│       │       ├── analytics/page.js                     # M6 (derived)
│       │       └── admin/{roles,users,settings,senders,connectors}/page.js  # M2
│       ├── components/chrome/Sidebar.js  components/ui.js
│       └── lib/nav.js
├── packages/ui/AppLauncher.js                # M2 — add Relay entry
└── .github/workflows/deploy-relay.yml        # M2 — new deploy workflow (→ legendlot/relay gh-pages)
```

---

## Milestone map & dependency order

| # | Milestone | Depends on | Independently testable deliverable |
|---|---|---|---|
| **M0** | `comms` schema full skeleton + `relayops` perms + seeds + exposed-schema | — | Every v1 table exists; PostgREST routes `comms`; 6 preset roles + seed rows present |
| **M1** | `commsops` worker shell + `relayops` auth | M0 | `/health` ok; `getMe` returns perms for a seeded role; unauth rejected |
| **M2** | `apps/relay` scaffold + AppLauncher + deploy + **admin (role-builder, settings, sender identities)** | M1 | App builds + deploys; login; nav perm-filtered; role-builder CRUD; thresholds editable |
| **M3** | Substrate write path: `/ingest` + identity resolution + events + consent ledger | M1 | Synthetic ingest creates/merges profiles, appends events, writes consent; idempotent |
| **M4** | Shopify sync: customer/consent backfill + webhooks + Web Pixel (cart) | M3 | Backfill populates profiles/identifiers/consent; webhook + pixel events land via `/ingest` |
| **M5** | **Email delivery spine**: Resend adapter + templates + variables + **send gate** + `messages` log + suppression + unsubscribe + delivery webhooks | M3 | One templated email sends end-to-end; gate writes skip/suppress rows; unsubscribe opts out; bounce → suppression + event |
| **M6** | Audience + broadcast: segments (static+dynamic AST) + campaigns + scheduler + **approval lifecycle/thresholds** | M5 | Build segment, see reachable-count, create campaign, submit→approve→throttled send to seed list |
| **M7** | Journey engine: CF Workflows + DO + Queues; versioned-JSON journeys; one journey (abandoned cart) | M5, M6 | Trigger enrols a profile; wait→branch→send runs durably; enrolment pinned to version |

> **Scope-Check recommendation (writing-plans skill):** M4 (Shopify sync), M5 (email delivery spine) and M7 (journey engine on CF Workflows — new infra for this monorepo) are each a substantial subsystem. M0–M3 are fully spelled out below as TDD tasks. M4–M7 are given complete file lists, the binding contracts, representative code, and a per-milestone test definition; **each should be expanded into its own detailed plan when greenlit** (offered at the end). Building all seven in one pass without per-subsystem plans is not advised.

> **Deploy safety:** `commsops` is greenfield — deploying it cannot break any live system (it serves nothing until cutover). `apps/relay` auto-deploys on push to `main`, but only after its `turbo build --filter=@throttle/relay` is green; never merge a red Relay build. SQL is applied via the Supabase MCP `apply_migration` (non-destructive → autonomous). Do **not** touch the in-flight `odoops-worker` WIP in this repo.

---

# M0 — `comms` schema full skeleton + `relayops` perms

**Files:**
- Create: `05_Throttle/commsops-worker/migrations/0001_comms_schema_v1.sql`
- Create: `05_Throttle/commsops-worker/migrations/0002_relayops_perms.sql`
- Create: `05_Throttle/commsops-worker/migrations/0003_comms_seed.sql`
- Create: `05_Throttle/commsops-worker/migrations/0004_expose_schema.sql`

Migrations are applied via the Supabase MCP `apply_migration` tool (name = file stem). Verify after each with a `SELECT`.

- [ ] **Step 1: Pre-flight — confirm current exposed-schemas list**

Run (Supabase MCP `execute_sql`):
```sql
SELECT setting FROM pg_settings WHERE name = 'pgrst.db_schemas';
-- fallback if empty:
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'authenticator';
```
Expected: a list containing `public, graphql_public, store, brand, ignition, podium, docket, manifest, sales` (per CORE.md). Record the exact current value — Step 8 appends `comms` to it verbatim.

- [ ] **Step 2: Write `0001_comms_schema_v1.sql` — substrate + delivery + orchestration tables**

```sql
-- Relay comms schema — v1 full skeleton (substrate + delivery + orchestration).
-- RLS-on, service_role-only (RULE-RLS-001). Commsops worker is the only client.
CREATE SCHEMA IF NOT EXISTS comms;

-- ── SUBSTRATE ──────────────────────────────────────────────────────────────
-- profiles: one row per real person. Promoted hot-filter cols + attributes jsonb.
CREATE TABLE comms.profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text,
  locale        text,
  city          text,
  attributes    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- identifiers: per-channel keys. UNIQUE(type,value) = the dedup backbone.
CREATE TABLE comms.identifiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  type         text NOT NULL,          -- phone | email | shopify_customer_id | whatsapp | instagram | messenger | device | ...
  value        text NOT NULL,
  is_verified  boolean NOT NULL DEFAULT false,
  source       text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identifiers_type_value_uniq UNIQUE (type, value)
);
CREATE INDEX identifiers_profile_idx ON comms.identifiers(profile_id);

-- profile_merges: merge audit (survivor/merged), traceable + reversible.
CREATE TABLE comms.profile_merges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id  uuid NOT NULL REFERENCES comms.profiles(id),
  merged_id    uuid NOT NULL,          -- no FK: merged profile row is deleted post-merge
  merged_at    timestamptz NOT NULL DEFAULT now(),
  merged_by    text,                   -- user id or 'system'
  reason       text,
  snapshot     jsonb                   -- merged profile's pre-merge state for reversibility
);

-- events: generic append-only envelope. One table, infinite event types.
CREATE TABLE comms.events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid REFERENCES comms.profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  properties      jsonb NOT NULL DEFAULT '{}',
  source          text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_idempotency_uniq UNIQUE (idempotency_key)
);
CREATE INDEX events_profile_name_idx ON comms.events(profile_id, name, occurred_at DESC);
CREATE INDEX events_name_time_idx ON comms.events(name, occurred_at DESC);

-- event_definitions: lightweight registry powering dropdowns + guarding the generic table.
CREATE TABLE comms.event_definitions (
  name           text PRIMARY KEY,
  description    text,
  expected_props jsonb NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- consent: append-only ledger. Grain = profile × channel × purpose. Read latest per tuple.
CREATE TABLE comms.consent (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  channel           text NOT NULL,     -- email | sms | whatsapp
  purpose           text NOT NULL,     -- marketing | transactional | utility
  state             text NOT NULL,     -- opted_in | opted_out | unknown | pending
  source            text,              -- shopify_import | unsubscribe_link | manual | ...
  captured_at       timestamptz NOT NULL DEFAULT now(),
  evidence          jsonb,
  unsubscribe_token text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_lookup_idx ON comms.consent(profile_id, channel, purpose, captured_at DESC);
CREATE INDEX consent_token_idx ON comms.consent(unsubscribe_token);

-- suppressions: hard blocks, distinct from consent. Checked first, honoured forever.
CREATE TABLE comms.suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL,
  value       text,                    -- the address/number (works even pre-profile)
  profile_id  uuid REFERENCES comms.profiles(id) ON DELETE SET NULL,
  reason      text NOT NULL,           -- hard_bounce | complaint | invalid | global_opt_out
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppressions_channel_value_uniq UNIQUE (channel, value)
);

-- ── AUDIENCE ───────────────────────────────────────────────────────────────
CREATE TABLE comms.segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL,           -- static | dynamic
  definition  jsonb NOT NULL DEFAULT '{}',   -- JSON predicate AST (dynamic) or null (static)
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE comms.segment_members (
  segment_id  uuid NOT NULL REFERENCES comms.segments(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, profile_id)
);

-- ── DELIVERY ───────────────────────────────────────────────────────────────
CREATE TABLE comms.sender_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL,       -- email | sms | whatsapp
  address         text,                -- email address / sender header / WA number
  purpose         text,                -- marketing | transactional | utility | all
  provider        text,                -- resend | trustsignal | meta_cloud | ...
  status          text NOT NULL DEFAULT 'inactive',  -- active | inactive
  credentials_ref text,                -- name of the wrangler secret, never the secret
  metadata        jsonb NOT NULL DEFAULT '{}',        -- WA quality/limits, dkim status, etc.
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text NOT NULL,
  name                text NOT NULL,
  purpose             text NOT NULL,   -- drives the consent gate
  language            text NOT NULL DEFAULT 'en',
  status              text NOT NULL DEFAULT 'draft',   -- draft | submitted | approved | active | archived
  version             integer NOT NULL DEFAULT 1,
  provider_template_id text,
  approval_status     text,            -- null (email) | submitted | approved | rejected (sms/wa)
  content             jsonb NOT NULL DEFAULT '{}',     -- channel-shaped (email: subject/html/text/from)
  variables           jsonb NOT NULL DEFAULT '[]',     -- [{token, source, fallback}]
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_channel_status_idx ON comms.templates(channel, status);

-- messages: the unified outbound send log. One row per send on every channel/purpose.
CREATE TABLE comms.messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid REFERENCES comms.profiles(id) ON DELETE SET NULL,
  channel             text NOT NULL,
  purpose             text NOT NULL,
  sender_identity_id  uuid REFERENCES comms.sender_identities(id),
  template_id         uuid REFERENCES comms.templates(id),
  template_version    integer,
  source              text,            -- campaign:<id> | journey:<enrolment> | api | test
  provider            text,
  provider_message_id text,
  status              text NOT NULL,   -- queued|sent|delivered|read|opened|clicked|replied|failed|bounced|rejected|skipped|suppressed
  provider_status     text,            -- raw provider status, kept for audit
  reason              text,            -- skip/fail reason
  cost                numeric,
  dedup_key           text,
  to_address          text,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  CONSTRAINT messages_dedup_uniq UNIQUE (dedup_key)
);
CREATE INDEX messages_profile_idx ON comms.messages(profile_id, queued_at DESC);
CREATE INDEX messages_source_idx ON comms.messages(source);
CREATE INDEX messages_provider_msg_idx ON comms.messages(provider, provider_message_id);

-- ── ORCHESTRATION ──────────────────────────────────────────────────────────
CREATE TABLE comms.campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  channel       text NOT NULL,
  purpose       text NOT NULL,
  segment_id    uuid REFERENCES comms.segments(id),
  template_id   uuid REFERENCES comms.templates(id),
  template_version integer,
  vars          jsonb NOT NULL DEFAULT '{}',   -- per-campaign constants
  status        text NOT NULL DEFAULT 'draft', -- draft|submitted|pending_approval|approved|scheduled|sending|sent|cancelled|rejected
  scheduled_at  timestamptz,
  created_by    text,
  approved_by   text,
  sent_by       text,
  reject_reason text,
  audience_snapshot integer,           -- count captured at send
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.journeys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft',  -- draft|active|paused|archived
  active_version  integer,
  trigger         jsonb NOT NULL DEFAULT '{}',     -- {type:'event', name, filter} | {type:'schedule'} | {type:'manual'}
  reenrolment     text NOT NULL DEFAULT 'once_while_active', -- once_ever|once_while_active|cooldown
  reenrol_cooldown_hours integer,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.journey_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id  uuid NOT NULL REFERENCES comms.journeys(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  definition  jsonb NOT NULL,          -- the versioned, immutable step graph
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_version_uniq UNIQUE (journey_id, version)
);

-- enrolments: per-profile journey runtime state. Pinned to the version it started on.
CREATE TABLE comms.enrolments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES comms.journeys(id),
  journey_version integer NOT NULL,
  profile_id      uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active',  -- active|completed|exited|failed
  current_step    text,
  context         jsonb NOT NULL DEFAULT '{}',
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX enrolments_journey_idx ON comms.enrolments(journey_id, status);
CREATE INDEX enrolments_profile_idx ON comms.enrolments(profile_id);

CREATE TABLE comms.enrolment_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid NOT NULL REFERENCES comms.enrolments(id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  step_type     text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  result        jsonb
);
CREATE INDEX enrolment_steps_enrolment_idx ON comms.enrolment_steps(enrolment_id, entered_at);

-- comms.settings: single-row config (approval thresholds, freq caps, quiet hours).
CREATE TABLE comms.settings (
  id                          smallint PRIMARY KEY DEFAULT 1,
  approval_required_marketing boolean NOT NULL DEFAULT true,
  approval_audience_threshold integer NOT NULL DEFAULT 500,
  frequency_cap_per_day       integer NOT NULL DEFAULT 3,
  frequency_cap_window_hours  integer NOT NULL DEFAULT 24,
  quiet_hours_start           smallint NOT NULL DEFAULT 21,  -- 21:00 IST
  quiet_hours_end             smallint NOT NULL DEFAULT 9,   -- 09:00 IST
  attribution_window_days     integer NOT NULL DEFAULT 7,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comms_settings_singleton CHECK (id = 1)
);

-- ── RLS + grants (service_role only; no policies = locked) ────────────────────
ALTER TABLE comms.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.identifiers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.profile_merges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.event_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.consent           ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.suppressions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.segments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.segment_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.journeys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.journey_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.enrolments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.enrolment_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.settings          ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA comms TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA comms TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA comms TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA comms TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT ALL ON SEQUENCES TO service_role;

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Apply `0001` and verify**

Apply via MCP `apply_migration` (name `0001_comms_schema_v1`). Then:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'comms' ORDER BY table_name;
```
Expected: 18 rows (campaigns, consent, enrolment_steps, enrolments, event_definitions, events, identifiers, journey_versions, journeys, messages, profile_merges, profiles, segment_members, segments, sender_identities, settings, suppressions, templates).

- [ ] **Step 4: Write `0002_relayops_perms.sql` — perm tables in `store` + 6 seeded presets**

```sql
-- Relay permission layer — lives in store (Snorkel/Podium pattern), not comms.
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

-- Six clonable/editable presets (PRD §10). Keys: relay_view, segment_manage,
-- template_manage, campaign_build, send_activate, approve, data_consent_admin,
-- connector_channel_manage, relay_admin, relay_super_admin.
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
```

- [ ] **Step 5: Apply `0002` and verify presets**

```sql
SELECT role_key, label, is_system FROM store.relayops_roles ORDER BY role_key;
```
Expected: 6 rows (admin, approver, author, manager, super_admin, viewer).

- [ ] **Step 6: Write `0003_comms_seed.sql` — event vocabulary + settings singleton + email sender placeholder**

```sql
-- Seed v1 comms-relevant event vocabulary (PRD §5.3).
INSERT INTO comms.event_definitions (name, description) VALUES
 ('order_placed','A Shopify order was created'),
 ('order_fulfilled','Order marked fulfilled'),
 ('order_delivered','Order delivered'),
 ('add_to_cart','Storefront add-to-cart (Web Pixel)'),
 ('checkout_started','Storefront checkout started (Web Pixel)'),
 ('checkout_abandoned','Checkout abandoned (no order within window)'),
 ('return_created','A return was created'),
 ('repair_status_changed','Repair/RMA status changed'),
 ('ticket_opened','A support ticket was opened'),
 ('email_delivered','Email delivered (engagement)'),
 ('email_opened','Email opened (engagement)'),
 ('email_clicked','Email link clicked (engagement)'),
 ('email_bounced','Email bounced (engagement)'),
 ('opted_out','Recipient opted out (engagement)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO comms.settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Email sender identity placeholder for comms.legendoftoys.com (status inactive
-- until DNS verified in M5). credentials_ref names the wrangler secret, not the key.
INSERT INTO comms.sender_identities (channel, address, purpose, provider, status, credentials_ref, metadata)
VALUES ('email','marketing@comms.legendoftoys.com','all','resend','inactive','RESEND_API_KEY',
        '{"dns_verified":false,"from_name":"Legend of Toys"}')
ON CONFLICT DO NOTHING;
```

- [ ] **Step 7: Apply `0003` and verify seeds**

```sql
SELECT count(*) AS events FROM comms.event_definitions;            -- 14
SELECT count(*) AS settings FROM comms.settings;                   -- 1
SELECT channel, address, status FROM comms.sender_identities;      -- email row, inactive
```

- [ ] **Step 8: Write + apply `0004_expose_schema.sql` — add `comms` to PostgREST exposed-schemas**

Use the exact list recorded in Step 1, with `, comms` appended:
```sql
ALTER ROLE authenticator SET pgrst.db_schemas =
  'public, graphql_public, store, brand, ignition, podium, docket, manifest, sales, comms';
NOTIFY pgrst, 'reload config';
```

- [ ] **Step 9: Verify PostgREST routes to `comms`**

Via MCP `execute_sql` is not enough — confirm the REST surface. After the worker exists (M1) a `getMe`/health check proves routing; for now verify config took:
```sql
SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator';
```
Expected: `pgrst.db_schemas` value now ends in `comms`.

- [ ] **Step 10: Commit migrations**

```bash
git -C 05_Throttle add commsops-worker/migrations/
git -C 05_Throttle commit -m "relay(m0): comms schema full skeleton + relayops perms + seeds + exposed-schema"
```
> Note: do not `git add -A` — the repo has unrelated `odoops-worker` WIP that must stay uncommitted. Add only the migrations path.

**M0 Definition of Done:** 18 `comms` tables exist with RLS on + service_role grants; 6 `store.relayops_roles` presets seeded; 14 event definitions + settings singleton + inactive email sender seeded; `comms` on the PostgREST exposed-schemas list.

---

# M1 — `commsops` worker shell + `relayops` auth

**Files:**
- Create: `05_Throttle/commsops-worker/package.json`
- Create: `05_Throttle/commsops-worker/wrangler.toml`
- Create: `05_Throttle/commsops-worker/src/index.js`
- Create: `05_Throttle/commsops-worker/src/auth.js`

Mirrors `docketops-worker` exactly (CommonJS, `sbProfile` factory, `verifyJWT` reading a system permission layer). No test runner exists in these workers — verification is via live `curl` against a deployed worker + a seeded test user. Greenfield deploy is safe.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "commsops-worker",
  "version": "1.0.0",
  "description": "Relay — LOT CX comms orchestration API (Cloudflare Worker)",
  "main": "src/index.js",
  "scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy", "tail": "wrangler tail" },
  "type": "commonjs",
  "devDependencies": { "wrangler": "^4.83.0" }
}
```

- [ ] **Step 2: Write `wrangler.toml` (M1 form — Queues/DO/Workflows bindings added in M7)**

```toml
name = "commsops"
main = "src/index.js"
compatibility_date = "2026-05-28"
workers_dev = true

[vars]
SUPABASE_URL = "https://jkxcnjabmrkteanzoofj.supabase.co"

# Secrets set via `wrangler secret put` — never in this file:
# SUPABASE_ANON_KEY
# SUPABASE_SERVICE_ROLE_KEY
# RESEND_API_KEY            (M5)
# SHOPIFY_WEBHOOK_SECRET    (M4)
# RESEND_WEBHOOK_SECRET     (M5)
```
> `wrangler.toml` edits require explicit permission per CLAUDE.md — this is the initial creation of a new file, which is in-scope for this milestone, but flag to Afshaan before adding the M7 Queue/DO/Workflow bindings.

- [ ] **Step 3: Write `src/auth.js` — sb client factory + verifyJWT + permission gates**

```javascript
// commsops auth — mirrors docketops verifyJWT, reads store.relayops_* perm layer.
function sbProfile(profile) {
  return async function (path, env, opts = {}) {
    const res = await fetch(`${env.SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept-Profile': profile,
        'Content-Profile': profile,
        Prefer: opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  };
}
const sbComms = sbProfile('comms');
const sbStore = sbProfile('store');
const enc = encodeURIComponent;

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`, env);
  const profile = (profRes.ok && profRes.data?.[0]) || null;
  if (!profile || !profile.active) return null;

  // relayops role → permissions
  const urRes = await sbStore(
    `/rest/v1/relayops_user_roles?user_id=eq.${user.id}&active=eq.true&select=role_key&limit=1`, env);
  const roleKey = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  let permissions = {};
  if (roleKey) {
    const rRes = await sbStore(
      `/rest/v1/relayops_roles?role_key=eq.${enc(roleKey)}&select=permissions&limit=1`, env);
    permissions = (rRes.ok && rRes.data?.[0]?.permissions) || {};
  }
  return {
    userId: user.id, email: user.email, role: profile.role,
    fullName: profile.full_name, relayRole: roleKey, permissions,
  };
}

// Permission gates (PRD §10 keys)
const can = (p, key) => !!(p && p[key]);
const canView          = p => can(p, 'relay_view');
const canSegment       = p => can(p, 'segment_manage');
const canTemplate      = p => can(p, 'template_manage');
const canBuild         = p => can(p, 'campaign_build');
const canActivate      = p => can(p, 'send_activate');
const canApprove       = p => can(p, 'approve');
const canConsentAdmin  = p => can(p, 'data_consent_admin');
const canConnector     = p => can(p, 'connector_channel_manage');
const canAdmin         = p => can(p, 'relay_admin');
const canSuperAdmin    = p => can(p, 'relay_super_admin');

module.exports = { sbProfile, sbComms, sbStore, enc, verifyJWT,
  canView, canSegment, canTemplate, canBuild, canActivate, canApprove,
  canConsentAdmin, canConnector, canAdmin, canSuperAdmin };
```

- [ ] **Step 4: Write `src/index.js` — fetch handler, CORS, routing, `getMe`**

```javascript
const A = require('./auth.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const ok  = (data) => json({ ok: true, data });
const err = (msg, status = 400) => json({ ok: false, error: msg }, status);
const nowIso = () => new Date().toISOString();

async function handleGet(url, auth, env) {
  const action = url.searchParams.get('action');
  switch (action) {
    case 'getMe':
      return ok({ userId: auth.userId, email: auth.email, fullName: auth.fullName,
                  relayRole: auth.relayRole, permissions: auth.permissions });
    default:
      return err(`unknown_action:${action}`, 404);
  }
}

async function handlePost(body, auth, env) {
  switch (body.action) {
    // M3: ingest · M5: send · M6: campaigns · M7: journeys — wired per milestone
    default:
      return err(`unknown_action:${body.action}`, 404);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/healthz')
      return ok({ service: 'commsops', time: nowIso() });

    // Public, unauthenticated endpoints (added in later milestones):
    //   /unsubscribe (M5), /webhooks/shopify (M4), /webhooks/resend (M5), /ingest internal (M3)
    // are matched here BEFORE the auth gate.

    const auth = await A.verifyJWT(request.headers.get('Authorization'), env);
    if (!auth) return err('unauthorised', 401);
    if (!A.canView(auth.permissions)) return err('forbidden', 403);

    try {
      if (request.method === 'GET') return handleGet(url, auth, env);
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return handlePost(body, auth, env);
      }
      return err('method_not_allowed', 405);
    } catch (e) {
      return err(e?.message || 'server_error', 500);
    }
  },
};
```

- [ ] **Step 5: Set secrets + deploy**

```bash
cd 05_Throttle/commsops-worker
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```
> `wrangler secret put` prompts for confirmation (kept guardrail) — expected. Reuse the same Supabase project keys as docketops/manifestops.

- [ ] **Step 6: Commit + deploy**

```bash
git -C 05_Throttle add commsops-worker/package.json commsops-worker/wrangler.toml commsops-worker/src/
git -C 05_Throttle commit -m "relay(m1): commsops worker shell + relayops auth + getMe"
git -C 05_Throttle push
cd 05_Throttle/commsops-worker && npx wrangler deploy
```

- [ ] **Step 7: Verify live — health, auth gate, getMe**

```bash
# health (no auth)
curl -s https://commsops.afshaan.workers.dev/health
# Expected: {"ok":true,"data":{"service":"commsops","time":"..."}}

# unauthenticated getMe → 401
curl -s "https://commsops.afshaan.workers.dev/?action=getMe"
# Expected: {"ok":false,"error":"unauthorised"}
```
Then assign a real test user a `relayops` role and confirm `getMe` returns the permission set:
```sql
INSERT INTO store.relayops_user_roles (user_id, role_key, active)
VALUES ('<test-user-uuid>', 'super_admin', true)
ON CONFLICT (user_id) DO UPDATE SET role_key = excluded.role_key, active = true;
```
With that user's access token:
```bash
curl -s "https://commsops.afshaan.workers.dev/?action=getMe" -H "Authorization: Bearer <token>"
# Expected: data.permissions includes relay_super_admin:true
```

**M1 Definition of Done:** `commsops` deployed; `/health` returns ok; unauth requests 401; a seeded `relayops` user gets correct permissions from `getMe`; `comms` schema reachable via `Accept-Profile` (proven indirectly when M3 reads land).

---

# M2 — `apps/relay` scaffold + AppLauncher + deploy + admin

**Files (scaffold — copy Snorkel patterns, restyle to Relay palette):**
- Create: `apps/relay/{package.json,next.config.js,jsconfig.json}`
- Create: `apps/relay/src/app/{layout.js,globals.css,redesign.css,page.js,login/page.js}`
- Create: `apps/relay/src/app/(auth)/layout.js`
- Create: `apps/relay/src/lib/nav.js`
- Create: `apps/relay/src/components/{chrome/Sidebar.js,ui.js}`
- Create: `apps/relay/src/app/(auth)/admin/{roles,users,settings,senders,connectors}/page.js`
- Modify: `packages/ui/AppLauncher.js` (add Relay entry)
- Create: `.github/workflows/deploy-relay.yml`
- Add worker actions (in `commsops-worker/src/index.js`): admin reads/writes (roles, users, settings, senders).

- [ ] **Step 1: `package.json` / `next.config.js` / `jsconfig.json`**

`apps/relay/package.json`:
```json
{
  "name": "@throttle/relay",
  "version": "0.0.1",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build" },
  "dependencies": {
    "next": "14.2.35", "react": "^18", "react-dom": "^18",
    "lucide-react": "^0.469.0",
    "@throttle/auth": "*", "@throttle/db": "*", "@throttle/ui": "*", "@throttle/domain": "*"
  }
}
```
`apps/relay/next.config.js` (identical to Snorkel):
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', trailingSlash: true, images: { unoptimized: true },
  transpilePackages: ['@throttle/auth', '@throttle/db', '@throttle/ui', '@throttle/domain'],
};
module.exports = nextConfig;
```
`apps/relay/jsconfig.json`: copy from `apps/snorkel/jsconfig.json` verbatim (`@/*` → `./src/*`).

- [ ] **Step 2: Root layout + login + landing (copy Snorkel, edit title + favicons + landing route)**

`apps/relay/src/app/layout.js`:
```javascript
import './globals.css';
import './redesign.css';
import { AuthProvider } from '@throttle/auth';
import { ToastProvider } from '@throttle/ui';

export const metadata = { title: 'Relay · Comms' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/favicon.png" sizes="any" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <AuthProvider workerUrl={process.env.NEXT_PUBLIC_WORKER_URL} pingAction="getMe">
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
```
Copy `apps/snorkel/src/app/login/page.js` → `apps/relay/.../login/page.js` (no change). Copy `page.js` (landing) but redirect to `/campaigns/`. `globals.css`/`redesign.css`: copy Snorkel's, then set the palette — `--accent:#F2CD1A; --ink:#282828; --danger:#DE2A2A;`.

- [ ] **Step 3: `src/lib/nav.js` — perm-filtered nav groups**

```javascript
import { Send, GitBranch, Users, FileText, Mail, BarChart3, Settings } from 'lucide-react';
export const NAV_GROUPS = [
  { id:'send', label:'SEND', items:[
    { id:'campaigns', label:'Campaigns', route:'/campaigns', icon:Send,      requires:'relay_view' },
    { id:'journeys',  label:'Journeys',  route:'/journeys',  icon:GitBranch, requires:'relay_view' },
  ]},
  { id:'build', label:'BUILD', items:[
    { id:'segments',  label:'Segments',  route:'/segments',  icon:Users,    requires:'relay_view' },
    { id:'templates', label:'Templates', route:'/templates', icon:FileText, requires:'relay_view' },
  ]},
  { id:'data', label:'DATA', items:[
    { id:'contacts',  label:'Contacts',  route:'/contacts',  icon:Mail,     requires:'relay_view' },
    { id:'analytics', label:'Analytics', route:'/analytics', icon:BarChart3,requires:'relay_view' },
  ]},
  { id:'admin', label:'ADMIN', items:[
    { id:'admin-roles',    label:'Roles',            route:'/admin/roles',      icon:Settings, requires:'relay_super_admin' },
    { id:'admin-users',    label:'Users',            route:'/admin/users',      icon:Settings, requires:'relay_admin' },
    { id:'admin-settings', label:'Approval & Caps',  route:'/admin/settings',   icon:Settings, requires:'relay_super_admin' },
    { id:'admin-senders',  label:'Sender Identities',route:'/admin/senders',    icon:Settings, requires:'connector_channel_manage' },
    { id:'admin-connectors',label:'Connectors',      route:'/admin/connectors', icon:Settings, requires:'connector_channel_manage' },
  ]},
];
export function filterNavByPerms(groups, perms) {
  return groups.map(g => ({ ...g, items: (g.items||[]).filter(it => !it.requires || perms?.[it.requires]) }))
               .filter(g => g.items.length);
}
```
Copy `apps/snorkel/src/app/(auth)/layout.js` + `components/chrome/Sidebar.js` + `components/ui.js`, repointing nav import to the above.

- [ ] **Step 4: Add worker admin actions in `commsops-worker/src/index.js`**

Add to `handleGet`/`handlePost` switches (gates from `auth.js`):
```javascript
// GET
case 'getRoles': {                       // role builder — list
  if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
  const r = await A.sbStore('/rest/v1/relayops_roles?select=*&order=role_key.asc', env);
  return r.ok ? ok(r.data) : err('db_error', 500);
}
case 'getRelaySettings': {
  const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=*&limit=1', env);
  return r.ok ? ok(r.data?.[0] || null) : err('db_error', 500);
}
case 'getSenderIdentities': {
  const r = await A.sbComms('/rest/v1/sender_identities?select=*&order=channel.asc', env);
  return r.ok ? ok(r.data) : err('db_error', 500);
}
// POST
case 'saveRole': {                       // create/clone/edit a custom role
  if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
  const { role_key, label, description, permissions } = body;
  const r = await A.sbStore('/rest/v1/relayops_roles', env, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ role_key, label, description, permissions, is_system: false, updated_at: new Date().toISOString() }),
  });
  return r.ok ? ok(r.data?.[0]) : err('db_error:'+JSON.stringify(r.data), 500);
}
case 'assignUserRole': {
  if (!A.canAdmin(auth.permissions)) return err('forbidden', 403);
  const { user_id, role_key, active } = body;
  const r = await A.sbStore('/rest/v1/relayops_user_roles', env, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ user_id, role_key, active: active !== false, assigned_by: auth.userId, assigned_at: new Date().toISOString() }),
  });
  return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
}
case 'saveRelaySettings': {              // approval thresholds, freq caps, quiet hours
  if (!A.canSuperAdmin(auth.permissions)) return err('forbidden', 403);
  const allowed = ['approval_required_marketing','approval_audience_threshold','frequency_cap_per_day',
    'frequency_cap_window_hours','quiet_hours_start','quiet_hours_end','attribution_window_days'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in body) patch[k] = body[k];
  const r = await A.sbComms('/rest/v1/settings?id=eq.1', env, { method: 'PATCH', body: JSON.stringify(patch) });
  return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
}
case 'saveSenderIdentity': {
  if (!A.canConnector(auth.permissions)) return err('forbidden', 403);
  const { id, channel, address, purpose, provider, status, credentials_ref, metadata } = body;
  const row = { channel, address, purpose, provider, status, credentials_ref, metadata: metadata || {} };
  const r = id
    ? await A.sbComms(`/rest/v1/sender_identities?id=eq.${A.enc(id)}`, env, { method:'PATCH', body: JSON.stringify(row) })
    : await A.sbComms('/rest/v1/sender_identities', env, { method:'POST', body: JSON.stringify(row) });
  return r.ok ? ok(r.data?.[0]) : err('db_error', 500);
}
```

- [ ] **Step 5: Build the admin pages (role-builder, users, settings, senders, connectors)**

`admin/roles/page.js` — the Garage-style custom role builder: list `getRoles`, render a checkbox grid of the 10 permission keys, "Clone" copies a preset's `permissions` into a new `role_key`, "Save" → `saveRole`. `admin/settings/page.js` — a form over `getRelaySettings`/`saveRelaySettings` (the approval thresholds + freq caps + quiet hours). `admin/senders/page.js` — list/edit `sender_identities` (email row shows DNS-verified state from `metadata`). `admin/users/page.js` — assign `relayops` roles via `assignUserRole`. `admin/connectors/page.js` — placeholder showing provider status (Resend key set?), expanded in M5. Use the standard list/form pattern (garageFetch read, workerFetch write, toast on result) from `apps/snorkel/src/app/(auth)/admin/roles/page.js`.

- [ ] **Step 6: Register Relay in AppLauncher**

In `packages/ui/AppLauncher.js` `SYSTEMS` array add:
```javascript
{ key: 'relay', label: 'Relay', url: 'https://relay.legendoftoys.com', mono: 'RY', tint: '#F2CD1A' },
```
> This edits a shared package consumed by all apps — low risk (additive array entry) but rebuilds every app on deploy. Confirm with Afshaan before merging.

- [ ] **Step 7: Deploy workflow**

Create `.github/workflows/deploy-relay.yml` from `deploy-snorkel.yml`, changing: build filter `@throttle/relay`, `NEXT_PUBLIC_WORKER_URL`/`NEXT_PUBLIC_COMMSOPS_URL` = `https://commsops.afshaan.workers.dev`, `external_repository: legendlot/relay`, `cname: relay.legendoftoys.com`, `publish_dir: apps/relay/out`.
> Pre-reqs (confirm with Afshaan, not code): the `legendlot/relay` GitHub repo must exist with gh-pages enabled; the `relay.legendoftoys.com` DNS CNAME; the `DEPLOY_TOKEN` + Supabase secrets present in the monorepo repo.

- [ ] **Step 8: Build locally before any push**

```bash
cd 05_Throttle && npx turbo build --filter=@throttle/relay
```
Expected: build succeeds, `apps/relay/out/` produced, zero errors. **Do not push a red build** (auto-deploys on push to `main`).

- [ ] **Step 9: Commit + push + verify deploy**

```bash
git -C 05_Throttle add apps/relay packages/ui/AppLauncher.js .github/workflows/deploy-relay.yml commsops-worker/src/index.js
git -C 05_Throttle commit -m "relay(m2): apps/relay scaffold + AppLauncher + deploy + admin role-builder/settings/senders"
git -C 05_Throttle push
```
After GH Actions completes (~3-4 min): load `https://relay.legendoftoys.com`, log in as the seeded super_admin, confirm nav renders ADMIN group, role-builder lists 6 presets, settings form loads + saves, sender identities shows the email row, AppLauncher shows Relay. Use the `preview_*` tools or browser to confirm.

**M2 Definition of Done:** Relay app builds green, deploys, login works; nav is perm-filtered; custom role builder creates/clones/edits roles; approval-threshold settings editable; sender identities + users manageable; Relay appears in the AppLauncher.

---

# M3 — Substrate write path: `/ingest` + identity resolution + events + consent

**Files:**
- Create: `commsops-worker/src/identity.js` — `resolveIdentity(identifiers, env)`, `mergeProfiles(survivor, merged, reason, env)`
- Create: `commsops-worker/src/ingest.js` — `ingest(payload, env)` + `deriveAttributes`
- Create: `commsops-worker/src/consent.js` — `recordConsent`, `latestConsent(profile, channel, purpose)`
- Modify: `commsops-worker/src/index.js` — route `POST /?action=ingest` (internal-auth) + contacts reads

**Binding contracts implemented here (see top of plan):** the **Ingestion contract**. Everything downstream (Shopify sync, engagement events, journey triggers) writes through `ingest()`.

Key logic to TDD (representative — expand into a sub-plan if executed standalone):

- **`resolveIdentity(identifiers)`**: for each `{type,value}` look up `comms.identifiers` by `UNIQUE(type,value)`. Zero matches → create a `profiles` row + attach all identifiers. Exactly one distinct profile → attach any new identifiers to it. ≥2 distinct profiles → pick survivor (oldest `created_at`), call `mergeProfiles` for each other (repoint identifiers/events/consent/messages/segment_members/enrolments via UPDATE, write `profile_merges` row with `snapshot`, delete merged profile). Conservative: only auto-merge when the colliding identifier is `phone`/`email`/`shopify_customer_id` (strong + verified); never merge on a shared `whatsapp` alone without a strong key.
- **`ingest(payload)`**: validate `name` exists in `event_definitions` (warn-not-fail if not), resolve identity, insert `events` row (rely on `idempotency_key` UNIQUE → on conflict, no-op return existing), call `deriveAttributes(profile_id, name, properties)` (e.g. `order_placed` → bump `attributes.lifetime_orders`, set `attributes.last_order_at`), then fire triggers (M7: match active journeys whose `trigger.name === name` → enqueue enrol). Buffered: in v1 call inline; flag Queue buffering as the scale path.
- **Internal auth for `/ingest`**: not a user JWT — callers are systems. Accept a shared `INGEST_TOKEN` secret (Bearer) OR the service key; reject otherwise. Add `INGEST_TOKEN` to the wrangler.toml secret comment list.

TDD tasks (abbreviated — each is write-test → run-fail → implement → run-pass → commit):
- [ ] resolveIdentity: new profile when no identifier matches (assert one `profiles` + N `identifiers` rows).
- [ ] resolveIdentity: attaches new identifier to existing profile (single match).
- [ ] resolveIdentity: merges two profiles on a strong-key collision; writes `profile_merges`; repoints rows; deletes merged.
- [ ] resolveIdentity: does NOT merge on a lone `whatsapp` collision (conservative).
- [ ] ingest: idempotent — same `idempotency_key` twice → one `events` row.
- [ ] ingest: `order_placed` derives `attributes.lifetime_orders`/`last_order_at`.
- [ ] consent: `recordConsent` appends a row; `latestConsent` returns the newest per (profile,channel,purpose).
- [ ] index route: `POST /?action=ingest` rejects without `INGEST_TOKEN`; accepts with it.

> Worker has no test harness — "tests" here are scripted `curl` calls against a deployed `commsops` plus `execute_sql` assertions, captured in `commsops-worker/test/ingest.sh`. Document expected JSON/row counts inline.

**M3 Definition of Done:** `POST /?action=ingest` resolves/creates/merges profiles, appends idempotent events, derives attributes, and records consent; a contacts page in Relay can list profiles + their identifiers/consent/events.

---

# M4 — Shopify customer/consent backfill + webhooks + cart Web Pixel

**Files:**
- Create: `commsops-worker/src/shopify.js` — `backfillCustomers(env)`, `mapWebhook(topic, payload) → ingestPayload`
- Modify: `commsops-worker/src/webhooks.js` (new) — `POST /webhooks/shopify` (HMAC-verified) → `ingest()`
- Modify: `commsops-worker/src/index.js` — public route for the webhook (pre-auth), admin action `runShopifyBackfill`
- Create (storefront): Shopify **Web Pixel** extension emitting `add_to_cart` + `checkout_started` to `/?action=ingest`

**Consent backfill rule (locked):** honor **Shopify explicit marketing opt-ins** only — for each customer with `email_marketing_consent.state === 'subscribed'` (and/or `sms_marketing_consent`), write a `comms.consent` row `{channel:'email', purpose:'marketing', state:'opted_in', source:'shopify_import', captured_at: <consent_updated_at>}`. Customers without explicit marketing consent → no marketing consent row (reads as `unknown`). **Bitespeed WhatsApp opt-ins are NOT imported** (re-collect later). Transactional/utility consent is implicit (not gated) so no backfill needed for it.

Key tasks:
- [ ] **Backfill**: page through Shopify Admin API `customers` (use the existing Shopify MCP/credentials pattern; respect the 50-subrequest limit — batch via Queue or chunked cursor, never loop-await per customer). For each: build an ingest payload with identifiers `[{type:'shopify_customer_id'},{type:'email'},{type:'phone'}]`, attributes (name, city, `lifetime_orders`, `total_spent`), and the marketing-consent row per the rule. Idempotent via `idempotency_key = 'shopify_customer:'+id`.
- [ ] **Webhooks**: register `customers/create`, `customers/update`, `checkouts/create`, `checkouts/update`, `orders/create`, `orders/fulfilled`. Verify Shopify HMAC (`SHOPIFY_WEBHOOK_SECRET`). Map each topic → an ingest event (`order_placed`, `order_fulfilled`, `checkout_started`/`checkout_abandoned`, plus profile upsert). Abandoned-checkout = a checkout with no matching order after the window (a scheduled sweep, or Shopify's abandoned-checkout webhook).
- [ ] **Web Pixel**: a Shopify customer-events Web Pixel subscribing to `product_added_to_cart` + `checkout_started`, POSTing to `/?action=ingest` with the `INGEST_TOKEN` and the visitor's identifiers (email/phone if known from checkout; else a `device` identifier — anonymous profiles are model-ready but thin in v1).

**M4 Definition of Done:** backfill populates `profiles`/`identifiers`/`consent` from Shopify (marketing consent only where explicitly subscribed); live webhooks + the Web Pixel land `order_*`/`add_to_cart`/`checkout_started` events through `/ingest`; profiles are deduped by phone/email/shopify_id.

> **Recommend a dedicated sub-plan** — Shopify pagination, HMAC, the Web Pixel extension, and abandoned-checkout detection are each fiddly and external-API-shaped; verify exact payload shapes against current Shopify docs at build time.

---

# M5 — Email delivery spine (the heart of Phase 1)

**Files:**
- Create: `commsops-worker/src/render.js` — `renderTemplate(template, vars, profile, systemVars) → {subject, html, text, to}`; validates every declared variable is bound (unresolved token → throw).
- Create: `commsops-worker/src/gate.js` — `runGate({profile_id, channel, purpose, to, env}) → {pass, reason}` in the fixed order.
- Create: `commsops-worker/src/adapters/email.js` — Resend `send(rendered)` + `parseStatusWebhook(payload)`.
- Create: `commsops-worker/src/send.js` — `send({channel, profile_id|identifiers, template_id, vars, purpose, source, dedup_key, env})` spine.
- Modify: `commsops-worker/src/webhooks.js` — `POST /webhooks/resend` → status normalize → `messages` update + engagement `ingest()`.
- Modify: `commsops-worker/src/index.js` — `POST /?action=send` (internal), `GET /unsubscribe?token=` (public), template CRUD actions, test-send action.

**Binding contracts implemented here:** the **Send contract** + the **Adapter contract**.

**The send gate (fixed order — PRD §5.4):**
```
runGate:
  1. suppression?  comms.suppressions by (channel, to-value)  → fail 'suppressed' (overrides all)
  2. consent?      if purpose==='marketing': latestConsent(profile,channel,'marketing') must be 'opted_in'
                   transactional/utility skip steps 2–4 (but NOT step 1)
  3. frequency cap? count messages(profile, marketing) within settings.frequency_cap_window_hours
                    >= settings.frequency_cap_per_day → fail 'freq_cap'
  4. quiet hours?  now (IST) within [quiet_hours_start, quiet_hours_end) → fail 'quiet_hours' (defer, not drop)
  5. channel rule? email: valid address present; (WA 24h-window rule is Phase 3)
  pass → send; any fail → write a messages row status='skipped'|'suppressed' with reason (never silent)
```

**Resend adapter (verify exact API at build time):**
```javascript
// adapters/email.js
async function send(rendered, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: rendered.from,            // "Legend of Toys <marketing@comms.legendoftoys.com>"
      to: rendered.to, subject: rendered.subject,
      html: rendered.html, text: rendered.text,
      headers: { 'List-Unsubscribe': `<${rendered.unsubscribe_url}>` },
    }),
  });
  const data = await res.json();
  return { provider_message_id: data.id || null, status: res.ok ? 'sent' : 'failed', raw: data };
}
function parseStatusWebhook(payload) {
  // Resend events: email.delivered|opened|clicked|bounced|complained
  const map = { 'email.delivered':'delivered','email.opened':'opened','email.clicked':'clicked',
                'email.bounced':'bounced','email.complained':'failed' };
  const e = payload?.type;
  return [{ provider_message_id: payload?.data?.email_id, canonical_status: map[e] || null,
            at: payload?.created_at, reason: e === 'email.bounced' ? 'hard_bounce' : null }];
}
module.exports = { send, parseStatusWebhook };
```

Key tasks:
- [ ] **DNS + sender activation**: verify `comms.legendoftoys.com` in Resend; add SPF/DKIM/DMARC on Cloudflare DNS; flip the `sender_identities` email row `status='active'`, `metadata.dns_verified=true`. (Manual + a `connectors` admin check.)
- [ ] **render.js**: bind each declared variable from its source (`profile.*`/`event.*`/constant/per-recipient/`system.*`), apply fallbacks, throw on any unresolved `{token}`. System var `unsubscribe_url` = `${APP_URL}/unsubscribe?token=<consent.unsubscribe_token>` (mint a token per marketing recipient).
- [ ] **gate.js**: implement the 5-step order; unit-style assertions per branch (suppressed, no-consent marketing, freq cap, quiet hours, pass). Transactional bypasses 2–4 but not 1.
- [ ] **send.js**: render → gate → on pass `adapter.send` → insert `messages` (queued→sent) with `dedup_key` (UNIQUE → retried step never double-sends) → return `{message_id,status}`. On fail insert skipped/suppressed row.
- [ ] **unsubscribe**: `GET /unsubscribe?token=` → look up `consent.unsubscribe_token` → append `opted_out` row + emit `opted_out` event → render a small confirmation page.
- [ ] **Resend webhook**: `POST /webhooks/resend` (verify `RESEND_WEBHOOK_SECRET`) → `parseStatusWebhook` → update `messages.status`/timestamps by `provider_message_id` → `ingest()` the engagement event (`email_delivered`/`opened`/`clicked`/`bounced`). Hard bounce/complaint → also write a `comms.suppressions` row.
- [ ] **templates CRUD + test-send**: `saveTemplate` (versioning: editing an active template publishes a new `version`), `getTemplates`, and `testSend` (to self/seed list — always allowed, no approval, `purpose='transactional'` bypass) wired into the Relay `templates/` pages.

**M5 Definition of Done:** a templated marketing email sends end-to-end through `send()` and lands; the gate writes skipped/suppressed rows (never silent); unsubscribe link opts the recipient out; Resend delivery/open/bounce webhooks update `messages` + emit engagement events; hard bounces auto-suppress; test-send works without approval.

> **Recommend a dedicated sub-plan** — this is the largest single subsystem; the gate, render/variable binding, Resend webhook normalization, and unsubscribe each warrant explicit TDD detail and build-time verification of Resend's exact request/webhook shapes.

---

# M6 — Audience + broadcast + approval lifecycle

**Files:**
- Create: `commsops-worker/src/segments.js` — `evalAst(ast, env) → profile_ids`, `materialize(segment_id, env)`, `reachableCount(segment_id, channel, purpose, env)`
- Create: `commsops-worker/src/campaigns.js` — campaign CRUD, approval lifecycle, `sendCampaign(id, env)` (Queue-throttled fan-out)
- Modify: `commsops-worker/src/index.js` — segment + campaign actions
- Relay UI: `segments/`, `campaigns/`, `analytics/` pages

**Segment AST (PRD §6)** — JSON predicate tree, never raw SQL. v1 supported predicates: `{attr, op, value}` (on `profiles.attributes`/promoted cols), `{event, count, within}` (occurrence/count in window over `events`), `{consent, channel, purpose, state}`. Groups: `{all:[...]}` / `{any:[...]}` / `{none:[...]}`. `evalAst` compiles to a parameterized Postgres query (or composes PostgREST filters) returning `profile_id`s — never string-concatenated SQL.

**Approval lifecycle (PRD §10):** `draft → submit → pending_approval → approved → scheduled/sending → sent`; reject → `draft` (reason). Threshold logic reads `comms.settings`: a send requires an `approve`-holder iff `purpose==='marketing'` AND `approval_required_marketing` AND `audience_snapshot > approval_audience_threshold`. Test-send + transactional never require approval. Blast-radius: a "send to N people" confirmation (audience snapshot) before live send; cancel window on scheduled sends.

**Throttled fan-out:** `sendCampaign` snapshots the reachable audience, then enqueues recipients to a Cloudflare Queue; the queue consumer calls `send()` per recipient in throttled batches (respects the 50-subrequest limit — never loop-await per recipient inline).

Key tasks:
- [ ] evalAst: each predicate type returns correct profile sets; `all`/`any`/`none` compose; injection-safe (parameterized).
- [ ] materialize: dynamic segment writes `segment_members`; static segments accept a CSV/hand-picked set.
- [ ] reachableCount: returns both segment size and reachable-on-(channel,purpose) after consent + suppression.
- [ ] campaign lifecycle: submit/approve/reject transitions enforce the threshold rule + perm gates (`campaign_build` to draft/submit, `send_activate` to schedule, `approve` to approve).
- [ ] sendCampaign: Queue-throttled fan-out; `dedup_key = 'campaign:'+id+':'+profile_id` so a retried fan-out never double-sends; `audience_snapshot` recorded.
- [ ] analytics: per-campaign sent/delivered/opened/clicked/bounced/opted_out + cost, derived from `messages` (no parallel store).

**M6 Definition of Done:** build a dynamic segment, see segment-size + reachable-count, create a marketing broadcast, run submit→approve→send to a seed list with throttled fan-out and a blast-radius confirmation; per-campaign analytics render from `messages`.

---

# M7 — Journey engine (CF Workflows + DO + Queues) + one journey

**Files:**
- Create: `commsops-worker/src/journeys.js` — journey/version CRUD, `compile(definition)`, `enrol(journey, profile, env)`
- Create: `commsops-worker/src/journey-workflow.js` — the Cloudflare Workflow entrypoint (one instance per enrolment)
- Create: `commsops-worker/src/enrolment-do.js` — Durable Object (per-enrolment timer/state + frequency-cap/quiet-hours/dedup atomicity)
- Modify: `commsops-worker/wrangler.toml` — **add Workflows + Durable Object + Queue bindings** (⚠ requires Afshaan's explicit permission per CLAUDE.md)
- Modify: `commsops-worker/src/ingest.js` — trigger fan-out: on matching event, enqueue enrol
- Relay UI: `journeys/` pages (config-driven step builder)

**This is new infrastructure for the monorepo** — no existing worker uses Workflows/DO/Queues. Verify the current Cloudflare Workflows API + wrangler binding syntax at build time (the `cloudflare` / `workers-best-practices` skills + CF docs).

**Step types (v1):** `send` (channel+template), `wait` (delay / until time-of-day / until window), `condition` (branch on attribute/event/segment), `goal`/`exit`. **Triggers:** event (name+filter), schedule, manual/API. **Versioning (THE critical rule):** each enrolment pinned to its `journey_version`; editing publishes a new version; in-flight enrolments finish on the old version; editing never mutates a running flow. **Re-enrolment default:** `once_while_active`.

**Runtime mapping:** journey JSON → a CF Workflow; `enrolments` row ↔ a Workflow instance / DO; `wait` steps → DO alarms; events → Queue → `enrol`. `dedup_key` on each send step keeps a retried durable step idempotent.

Key tasks:
- [ ] wrangler bindings (Workflow class, DO namespace, Queue producer+consumer) — **get permission first**.
- [ ] journeys CRUD + version pinning: editing an active journey creates `journey_versions` row N+1, sets `active_version`; new enrols use N+1; existing enrolments keep their pinned version.
- [ ] compile(definition): validate the step graph (single entry, reachable exit, declared templates exist + approved).
- [ ] enrol: respects re-enrolment policy (`once_while_active` → skip if an active enrolment exists); creates `enrolments` row + starts the Workflow instance.
- [ ] Workflow run: executes steps durably — `send` calls the M5 `send()` spine; `wait` schedules a DO alarm; `condition` branches; `exit`/`goal` ends the enrolment; each transition writes an `enrolment_steps` row.
- [ ] Ship **one journey — abandoned cart**: trigger `checkout_started`; wait 24h; condition "no `order_placed` since enrol?"; if true → `send` the abandoned-cart email template; else `exit`.

**M7 Definition of Done:** a `checkout_started` event enrols a profile; the durable flow waits, branches on a later `order_placed`, and sends (or exits); editing the journey publishes a new version while the in-flight enrolment completes on its pinned version; per-journey-version funnel analytics render.

> **Recommend a dedicated sub-plan** — introducing CF Workflows + Durable Objects + Queues to this monorepo is the highest-risk, most novel work; it deserves its own plan with explicit API verification, local `wrangler dev` testing, and a deploy-safety review (Queue/DO bindings change the worker's deploy surface).

---

## Self-review (writing-plans skill)

**1. Spec coverage** — checked against PRD §§4–10, 12–13, 16 and the user's Phase-1 brief:
- comms schema FULL skeleton → **M0** (all 18 §16 tables + perms/settings). ✓
- commsops worker shell → **M1**. ✓
- Shopify customer/consent/cart sync → **M4** (backfill + webhooks + Web Pixel), on the **M3** `/ingest` substrate. ✓
- email engine: send gate → **M5** (gate.js, the 5-step order); segments → **M6**; broadcast → **M6**; one journey → **M7** (abandoned cart). ✓
- relayops perms/role-builder → **M0** (tables+presets) + **M1** (enforcement) + **M2** (builder UI). ✓
- approval thresholds → **M0** (`comms.settings`) + **M2** (settings UI) + **M6** (lifecycle enforcement). ✓
- Decided items (PRD §15 Decided): substrate-first skeleton (M0), single send gate (M5), consent grain (M0/M3/M5), segments AST (M6), versioned-JSON journeys pinned (M7), derived analytics (M6), sender_identities first-class (M0). ✓
- Open items resolved this session (ESP/subdomain/backfill/volume) folded into the locked-decisions table + M4/M5. ✓
- **Gap noted (by design):** SMS/WhatsApp adapters, A/B split, visual builder, profile_traits enrichment layer, real-time segment triggers — all explicitly **non-goals / later** (PRD §1, §13 Phases 2–4); schema slots exist (sender_identities, templates.channel, journey step types) but no v1 tasks. Correct per spec.

**2. Placeholder scan** — M0–M2 contain complete SQL/JS/config (no TBD). M3–M7 intentionally use task-level granularity + representative code + binding contracts, with an explicit Scope-Check recommendation that M4/M5/M7 be expanded into their own detailed plans at greenlight. This is the writing-plans "multiple independent subsystems → separate plans" path, not a placeholder gap.

**3. Type/contract consistency** — the three contracts (Ingestion `POST /?action=ingest`, Send `send({...})`/`POST /?action=send`, Adapter `send`/`parseStatusWebhook`/`parseInbound`) are named identically across M3/M5/M6/M7. Permission keys are consistent across M0 seeds, M1 gates (`canView`…`canSuperAdmin`), and M2 nav `requires`. `dedup_key` UNIQUE (M0 messages) is the idempotency anchor referenced in M5 send.js, M6 campaign fan-out, and M7 send steps. `idempotency_key` UNIQUE (M0 events) anchors M3 ingest + M4 backfill. Worker name `commsops` (not `relayops-worker`) used consistently.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-25-relay-phase1-foundation.md`.**

Because Phase 1 is seven independent subsystems, I recommend a **staged execution**: build M0→M1→M2 first (the foundation — fully detailed here), verify the app + worker + perms are live, then **write a dedicated detailed sub-plan for each of M4 (Shopify sync), M5 (email spine) and M7 (journey engine)** before building them, since each is a substantial external-API / new-infra subsystem.

Two execution options for the foundation (M0–M2):

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

**Do not start until Afshaan confirms** (per the session brief: plan first). Which approach — and shall I expand M4/M5/M7 into their own plans now, or when each is greenlit?
