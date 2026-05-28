---
name: Ignition
description: Influencer-marketing CRM for Legend of Toys
colors:
  bg: "#1f1f1f"
  surface: "#2a2a2a"
  surface2: "#333333"
  surface3: "#3c3c3c"
  border: "#404040"
  border2: "#4a4a4a"
  text-1: "#f5f5f5"
  text-2: "#b0b0b0"
  text-3: "#888888"
  text-4: "#666666"
  brand-yellow: "#F2CD1A"
  brand-blue: "#213CE2"
  brand-red: "#DE2A2A"
  brand-green: "#22c55e"
  ignition-orange: "#FF6B00"
  ignition-orange-deep: "#cc5500"
  state-warning: "#fbbf24"
  state-info: "#7b93ff"
  accent-fg: "#0a0a0a"
typography:
  display:
    fontFamily: "Tomorrow, sans-serif"
    fontSize: "28px"
    fontWeight: 700
  headline:
    fontFamily: "Tomorrow, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  title:
    fontFamily: "Tomorrow, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  body:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "13px"
    fontWeight: 400
  body-condensed:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
  numeric:
    fontFamily: "JetBrains Mono, monospace"
    fontVariantNumeric: "tabular-nums"
---

# Ignition — Technical Design

> Last updated: 2026-05-28 (Session 85 — initial)

## Stack at a glance

- **Worker**: `ignitionops` Cloudflare Worker — `ignitionops.afshaan.workers.dev`
- **Source**: `05_Throttle/ignitionops-worker/src/index.js`
- **Frontend**: `apps/ignition/` (Next.js 14 static-export) → `ignition.legendoftoys.com`
- **Deploy target**: `legendlot/ignition` (private GH-Pages repo)
- **DB**: Supabase `lot-production` — `ignition` schema (sibling to `store`, `brand`, `public`)
- **Auth**: Supabase Auth + Google OAuth, `@legendoftoys.com` domain-restricted (RULE-010)
- **Shared packages**: `@throttle/{auth,db,ui,domain}` — same as Pitstop

## Data model

### `ignition.influencers`

```sql
create table ignition.influencers (
  id uuid primary key default gen_random_uuid(),
  influencer_code text unique not null,           -- 'IN0001' from sheet
  channel_name text,
  person_name text,
  channel_link text,
  channel_platform text check (channel_platform in ('instagram','youtube','tiktok','other')),
  influencer_type text check (influencer_type in ('nano','micro','macro','brand','store')),
  categories text[] default '{}',
  reach int,
  audience text,
  location text,
  contact_number text,
  address text,
  email text,
  contact_poc_type text check (contact_poc_type in ('manager','influencer','agency')),
  contact_poc_name text,
  first_invite_sent_at timestamptz,
  list_status text not null default 'master'
    check (list_status in ('master','b_list','archived')),
  quality_rating text not null default 'unrated'
    check (quality_rating in ('green','yellow','red','unrated')),
  rating_notes text,
  legacy_sheet_ref text unique,                   -- idempotency for sheet import
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid                                 -- references auth.users(id)
);
```

`influencer_code` is **immutable** once set (BUSINESS_RULES.md → RULE-IGN-001).

### `ignition.engagements`

```sql
create table ignition.engagements (
  id uuid primary key default gen_random_uuid(),
  engagement_no text unique not null,             -- 'IGN-YYYY-NNNNN'
  influencer_id uuid not null references ignition.influencers(id),
  campaign_id uuid references ignition.campaigns(id),
  engagement_type text not null
    check (engagement_type in ('video_tracking','ugc')),
  product_code text,                              -- text reference, no cross-schema FK
  product_variant text,
  deal_type text not null
    check (deal_type in ('paid','barter','affiliate','paid_plus_affiliate')),
  payment_terms text
    check (payment_terms in ('advance','on_draft','on_release','n_a')),
  payment_amount numeric(12,2) default 0,
  affiliate_pct numeric(5,2),
  commission_amount numeric(12,2),
  ad_spend numeric(12,2) default 0,
  goodies_cost numeric(12,2) default 0,
  shipping_cost numeric(12,2) default 0,
  return_cost numeric(12,2) default 0,
  total_cost numeric(12,2) generated always as (
    coalesce(payment_amount,0) +
    coalesce(commission_amount,0) +
    coalesce(ad_spend,0) +
    coalesce(goodies_cost,0) +
    coalesce(shipping_cost,0) +
    coalesce(return_cost,0)
  ) stored,
  cpm numeric(12,2),
  expected_post_date date,
  post_date date,
  video_link text,
  utm_link text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  views int default 0,
  likes int default 0,
  comments int default 0,
  shares int default 0,
  impressions int default 0,
  sessions int default 0,
  orders int default 0,
  conversions_value numeric(12,2) default 0,
  roas_on_ad_spend numeric(12,4),
  actual_roas numeric(12,4),
  orders_cc int default 0,
  shipping_order_id text,
  tracking_id text,
  shipping_month text,
  shipping_date date,
  directed_to text check (directed_to in ('website','amazon','flipkart')),
  stage text not null default 'identified'
    check (stage in (
      'identified','invited','engaged','negotiating','agreed',
      'shipped','delivered','script_review','script_signed_off',
      'scheduled','live','tracking','closed',
      'declined','ghosted','dropped'
    )),
  closed_reason text check (closed_reason in (
    'completed','ghosted','declined','dropped','historical_import'
  )),
  closed_at timestamptz,
  cs_ticket_no text,                              -- link to store.cs_tickets.ticket_no
  legacy_sheet_ref text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
```

### Sequence RPC

```sql
create or replace function ignition.next_engagement_seq(p_year text)
returns bigint
language plpgsql
security definer
as $$
declare
  v_name text := 'ignition_eng_' || p_year;
  v_next bigint;
begin
  insert into store.sequences(name, current_val) values (v_name, 0)
    on conflict (name) do nothing;
  update store.sequences
    set current_val = current_val + 1
    where name = v_name
    returning current_val into v_next;
  return v_next;
end $$;
```

Reuses `store.sequences` (single source of truth for all LOT counters).

### Append-only audit + side tables

```sql
create table ignition.engagement_history (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references ignition.engagements(id) on delete cascade,
  stage_from text, stage_to text, action text, note text,
  actor uuid, created_at timestamptz not null default now()
);

create table ignition.engagement_notes (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid references ignition.engagements(id) on delete cascade,
  influencer_id uuid references ignition.influencers(id) on delete cascade,
  body text not null, actor uuid,
  created_at timestamptz not null default now(),
  check (engagement_id is not null or influencer_id is not null)
);

create table ignition.engagement_attachments (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references ignition.engagements(id) on delete cascade,
  kind text check (kind in ('brief','script','screenshot','proof')),
  url text not null, name text,
  created_at timestamptz not null default now(),
  created_by uuid
);

create table ignition.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  pool_label text,
  engagement_id uuid references ignition.engagements(id) on delete set null,
  utilized bool not null default false,
  order_name text, order_value numeric(12,2),
  used_at timestamptz, address_pincode text,
  products text[], quantity int, tracking_url text,
  created_at timestamptz not null default now()
);

create table ignition.campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_no text unique not null,
  influencer_id uuid not null references ignition.influencers(id),
  video_count int not null,
  agreed_total numeric(12,2),
  status text not null default 'active'
    check (status in ('active','completed','cancelled')),
  created_at timestamptz not null default now()
);
```

### Grants

```sql
grant usage on schema ignition to service_role;
grant all on all tables in schema ignition to service_role;
grant all on all sequences in schema ignition to service_role;
alter default privileges in schema ignition grant all on tables to service_role;
alter default privileges in schema ignition grant all on sequences to service_role;
```

### Permissions on `store.roles`

```sql
-- Extend each affected role row's permissions JSONB with new keys:
update store.roles set permissions =
  permissions || jsonb_build_object(
    'ignition_view', true,
    'ignition_manage', true,
    'ignition_approve', true,
    'ignition_admin', true,
    'ignition_reports_view', true
  )
  where role_id in ('admin','super_admin');

update store.roles set permissions =
  permissions || jsonb_build_object(
    'ignition_view', true,
    'ignition_reports_view', true
  )
  where role_id = 'production_manager';

-- Two new dedicated roles:
insert into store.roles(role_id, label, permissions) values
  ('ignition_manager', 'Ignition Manager', jsonb_build_object(
    'ignition_view', true, 'ignition_manage', true, 'ignition_reports_view', true
  )),
  ('ignition_lead', 'Ignition Lead', jsonb_build_object(
    'ignition_view', true, 'ignition_manage', true,
    'ignition_approve', true, 'ignition_reports_view', true
  ))
on conflict (role_id) do nothing;
```

## State machine

Three-layer encoding (PATTERN-076):

1. **DB** — CHECK constraint above lists the 16 valid stages
2. **Worker** — `allowedTransitions(stage)` returns the next legal set
3. **UI** — `<StageStepper>` renders the linear path; `<AdvanceModal>` shows next-stage gate fields

Allowed transitions:

```
identified  → invited, declined, dropped
invited     → engaged, ghosted, declined
engaged     → negotiating, ghosted, declined
negotiating → agreed, declined, dropped
agreed      → shipped, dropped
shipped     → delivered, dropped
delivered   → script_review, dropped
script_review     → script_signed_off, dropped
script_signed_off → scheduled, dropped
scheduled   → live, dropped
live        → tracking, dropped
tracking    → closed
```

Damage cases: `cs_ticket_no` is set without changing `stage`. UI surfaces a "damage in flight" badge when `cs_ticket_no IS NOT NULL`.

## Worker shape (clone of csops)

`05_Throttle/ignitionops-worker/src/index.js`:

```js
// Top: CORS headers, json()/err()/ok() helpers (lines 1-35)
// Supabase helpers: sb() / sbPublic() with Accept-Profile: ignition
// JWT verify: clone of csops verifyJWT (reads store.users_profile + store.roles)
// Permission gate: require(permKey, auth)
// Dispatch: /health bypasses JWT; GET ?action=X → handleGet(); POST body.action → handlePost()

// GET handlers: getInfluencers, getInfluencer, getEngagements, getEngagement,
//   getRoster, getBList, getCampaigns, getDiscountCodes, getKpis,
//   getQueueCounts, getReports, getCatalogs

// POST handlers: createInfluencer, updateInfluencer,
//   createEngagement, updateEngagement, advanceStage, closeEngagement,
//   setRating, addNote, addAttachment,
//   markShipped, markDelivered,
//   openPitstopTicket,                   // sibling-worker call → csops
//   assignDiscountCode, createCampaign,
//   bulkImportInfluencers, bulkImportEngagements, bulkImportDiscountCodes
```

`openPitstopTicket`:

```js
// auth + perm gate
// fetch engagement + influencer rows
// POST https://csops.afshaan.workers.dev/?action=createTicket
//   Authorization: Bearer <auth token from incoming request>
//   body: { intake_channel: 'ignition', customer_name, customer_phone,
//           platform, external_order_id, issue_category, issue_description,
//           disposition: 'replacement' }
// on success: patch engagement.cs_ticket_no with returned ticket_no
// add history row 'open_pitstop_ticket'
// return { ok: true, data: { ticket_no, engagement_no } }
```

## Frontend layout (clone of apps/pitstop)

`apps/ignition/` directory:

```
package.json               // @throttle/ignition, deps mirror apps/pitstop
next.config.js             // output: 'export', transpilePackages
jsconfig.json
public/
src/
  app/
    layout.js              // <AuthProvider workerUrl=NEXT_PUBLIC_IGNITIONOPS_URL>
    login/page.js
    (auth)/
      layout.js            // Sidebar + Topbar shell + RequireAuth
      dashboard/page.js
      influencers/page.js
      influencers/detail/page.js
      engagements/page.js
      engagements/detail/page.js
      engagements/new/page.js
      roster/page.js
      blist/page.js
      ugc/page.js
      campaigns/page.js
      discount-codes/page.js
      reports/page.js
      admin/users/page.js
      admin/import/page.js
  components/
    StageBadge.js
    RatingBadge.js
    DealTypeBadge.js
    StageStepper.js
    AdvanceModal.js
    InfluencerCard.js
    EngagementForm.js
    ShipmentTimeline.js
    OpenPitstopButton.js
    IgnitionIcon.js
  lib/
    ignitionopsFetch.js    // mirror of csopsFetch.js
    stages.js              // STAGE_VALUES + STAGE_LABELS + STAGE_PALETTE
    dealTypes.js
    nav.js                 // NAV_GROUPS + filterNavByPerms
  hooks/
```

## Deploy

- Worker: `cd 05_Throttle/ignitionops-worker && npx wrangler deploy`
- Frontend: GH Actions workflow `deploy-ignition.yml` (clone of `deploy-pitstop.yml`, swap target repo + filter + CNAME)
- DNS: `ignition.legendoftoys.com` → GH Pages (CNAME at registrar, manual user step)
- Worker secrets: `wrangler secret put SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` (same as csops)

## Sheet import

Pipeline (per PATTERN-091):

1. `05_Throttle/scripts/import_omnipresent_influencer.py` reads xlsx → batched JSON files
2. SECURITY-DEFINER RPCs in `ignition` schema (one-shot, token-gated, dropped after import):
   `ignition.import_influencer_rows(token, rows)`,
   `ignition.import_engagement_rows(token, rows)`,
   `ignition.import_discount_code_rows(token, rows)`
3. `curl --data-binary @batch.json` POSTs against PostgREST `/rest/v1/rpc/import_*`
4. Idempotency: each row carries `legacy_sheet_ref = SHA1(...)`; the RPC skips rows whose ref already exists
5. Drop RPCs after the cutover

Six sheets:
- `Master Data` (1981) → `influencers`
- `Video Tracking` (1037) → `engagements (video_tracking)`
- `UGC` (987) → `engagements (ugc)`
- `Roster` (2130) → patch `influencers` (rating + onboard date)
- `B List` (25) → `influencers (list_status='b_list')`
- `discountCodes` (1000) → `discount_codes`

## Reuse — don't rebuild

- `verifyJWT` and `require` from `csops-worker/src/index.js:166-220`
- `csopsFetch` pattern → `ignitionopsFetch` mirror
- `@throttle/{auth,db,ui,domain}` packages consumed as-is
- `deploy-pitstop.yml` cloned with field swaps
- `import_og_complaints.py` xlsx→staging→drain template
