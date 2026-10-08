---
name: Ignition
description: Influencer-marketing CRM for Legend of Toys. Visual system "Pit Control" (S412, 2026-10-08) - dark navy surfaces, ignition-orange accent.
colors:
  bg: "#0e1015"
  rail: "#0a0c10"
  surface: "#13161e"
  surface-hover: "#171a23"
  surface-raised: "#171a22"
  input: "#151821"
  surface-sunk: "#10131a"
  chip-neutral: "#1b1f2a"
  menu: "#171a23"
  menu-hover: "#20242f"
  border: "#1d212b"
  border-2: "#232838"
  border-3: "#2b3142"
  border-hover: "#2e3446"
  border-input-hover: "#3a4156"
  row-divider: "#181b24"
  text-1: "#eef0f4"
  text-2: "#a9b0c2"
  text-3: "#8b93a7"
  text-4: "#6b7385"
  text-5: "#5a6278"
  accent: "#FF6B00"
  accent-hi: "#ff8a33"
  accent-fg: "#0a0a0a"
  ignition-orange-deep: "#cc5500"
  brand-yellow: "#F2CD1A"
  brand-blue: "#213CE2"
  brand-red: "#DE2A2A"
  brand-green: "#22c55e"
  state-warning: "#fbbf24"
  state-error: "#DE2A2A"
  state-success: "#22c55e"
  state-info: "#4f6bff"
typography:
  display:
    fontFamily: "Tomorrow, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
  title:
    fontFamily: "Tomorrow, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
  eyebrow:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "12px"
    letterSpacing: "0.14em"
  body:
    fontFamily: "Hanken Grotesk, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontVariantNumeric: "tabular-nums"
---

# Ignition - Technical Design

> Last updated: 2026-10-08 (S412 - design tokens, typography, components and frontend layout rewritten for the Pit Control redesign; data model / worker / sheet-import sections unchanged)

# Ignition — Technical Design

> Last updated: 2026-05-28 (Session 85 — initial)

## Stack at a glance

- **Worker**: `ignitionops` Cloudflare Worker — `ignitionops.afshaan.workers.dev`
- **Source**: `05_Throttle/ignitionops-worker/src/index.js`
- **Frontend**: `apps/ignition/` (Next.js 14 static-export) → `ignition.legendoftoys.com`
- **Deploy target**: `legendlot/ignition` (public GH-Pages repo — same as Pitstop / Stores / dashboard; GH Pages requires public on the current plan)
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

## Design system - "Pit Control"

Source of truth: `apps/ignition/src/app/globals.css` `:root`. Dark only (no light mode, no
`prefers-color-scheme`). Fonts load once via the `<link>` in `src/app/layout.js`. Component code
styles inline from these tokens; `globals.css` carries only what inline styles cannot (hover/focus,
keyframes, mobile).

### Tokens

- **Surfaces**: `--bg #0e1015` · `--rail #0a0c10` · `--surface #13161e` · `--surface-hover #171a23` · `--surface-raised #171a22` · `--input #151821` · `--surface-sunk #10131a` · `--chip-neutral #1b1f2a` · `--menu #171a23` · `--menu-hover #20242f`
- **Borders**: `--border #1d212b` · `--border-2 #232838` · `--border-3 #2b3142` · `--border-hover #2e3446` · `--border-input-hover #3a4156` · `--row-divider #181b24`
- **Text**: `--text-1 #eef0f4` · `--text-2 #a9b0c2` · `--text-3 #8b93a7` · `--text-4 #6b7385` · `--text-5 #5a6278`
- **Brand**: `--brand-yellow #F2CD1A` (`-deep #d4b200`) · `--brand-blue #213CE2` · `--brand-red #DE2A2A` · `--brand-green #22c55e` · `--brand-orange #f97316`
- **Accent (the "lit fuse")**: `--ignition-orange #FF6B00` (`-deep #cc5500`) · `--accent` = ignition-orange · `--accent-hi #ff8a33` · `--accent-fg #0a0a0a` · `--accent-bg rgba(255,107,0,.14)` · `--accent-bg-soft rgba(255,107,0,.08)`
- **State** (each has `-fg` text and `-bg` tint): `--state-warning #fbbf24` · `--state-error #DE2A2A` (fg `#ff7b7b`) · `--state-success #22c55e` (fg `#4ade80`) · `--state-info #4f6bff` (fg `#8ea2ff`) · `--info-bar #4f6bff` / `--info-bar-2 #7b93ff`
- **Overlay / shadow**: `--scrim` · `--sticky-bar` · `--shadow-menu` · `--shadow-modal` · `--shadow-cta`
- **Type scale**: `--text-2xs 11` · `xs 12` · `sm 13` · `base 14` (body) · `md 16` · `lg 18` · `xl 22` · `2xl 28` · `3xl 36` px. Tracking: `--tracking-tight .04em` · `-mid .06em` · `-wide .08em` · `-eyebrow .14em`
- **Space**: `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 px
- **Radii**: Pit Control scale `--r-card 18` · `--r-tile 16` · `--r-row 14` · `--r-btn 12` · `--r-ctl 10` · `--r-seg 9` · `--r-deal 8`; legacy `--radius-sm 6` · `-md 10` · `-lg 14` · `-full 9999`
- **Fonts**: `--font-ui` Hanken Grotesk (body) · `--font-cond` Tomorrow (headings) · `--font-mono` JetBrains Mono (numbers, eyebrows, tab labels) · `--font-body` = `--font-ui` (read by the shared `@throttle/ui` Manual)
- **Motion**: `--duration-fast 140ms` · `-default 160ms` · `-slow 240ms` · `--ease-out cubic-bezier(0.22,1,0.36,1)`
- **Legacy aliases** (kept so un-restyled pages still render): `--surface2/3`, `--surface-2/3` (-> chip-neutral / menu-hover), `--border2`, `--t1..t4`, `--yellow`, `--yellow2`, `--blue`, `--red`, `--green`, `--orange`, `--mono`, `--cond`, `--r-full`. Prefer the new names in new code.

### Motion

Keyframes: `igUp` `igSlide` `igGrowX` `igGrowY` `igFuse` `igPulse` `igRing` `igPop` `igFade` `igDash` `igBlink` (+ `ig-sheetup` for the mobile sheet). Classes: `.ig-up` (500ms) `.ig-slide` (380ms) `.ig-pop` (240ms) `.ig-fade` (160ms) `.ig-growx` (800ms) `.ig-growy` (600ms) `.ig-fuse` (animated orange stripe) `.ig-live-dot` (pulsing green dot). Entrances use fill-mode `backwards`, never `both` (`both` pins the last keyframe and overrides inline opacity/transform). `prefers-reduced-motion` collapses all durations and stops `.ig-fuse` / `.ig-live-dot`.

### Typography

- Body: `--font-ui` Hanken Grotesk, 14px / line-height 1.45, antialiased. `td, th, .num` get `tabular-nums`.
- Numbers (KPI values, `NumCell`, tab labels): `--font-mono`.
- **Page-header pattern**: a mono 12px `letter-spacing: .14em` UPPERCASE eyebrow in `--text-4` (e.g. "Work · Post dates"), then an `<h1>` in `--font-cond` 32px / 700 with `marginTop: 6`. Card/section titles: `--font-cond` 15-17px / 700 (`SectionTitle`).

### Components

`@throttle/ui` `Sidebar`, `Modal` and `KpiCard` (and `Topbar`) are **no longer used by Ignition**. `packages/ui` is shared by 11 other apps - **never edit it for Ignition**; build/restyle locally. Still imported from `@throttle/ui`: `Spinner`, `Chip`, `Combobox`, `EmptyState`, `Manual`, `AppLauncher`, `ToastProvider`, `useToast`, `useListNav`, `useSearchShortcut`.

**Shell** (`src/components/shell/`, wired in `app/(auth)/layout.js`):
- `IgRail` - icon rail, default collapsed, persisted in `localStorage['ig.rail.expanded']`; `[` toggles. Sections WORK / LISTS / ANALYZE / HELP & ADMIN; nav items with `rail: false` are skipped (New Deal lives in the top-bar CTA). Hidden at <=767px. Props: `navGroups, pathname, onNavigate, userLabel, userInitial, userRole, onLogout`.
- `IgTopbar` - props `refreshing, lastRefreshed, showNewDeal, onNewDeal`. Search field (or Cmd/Ctrl+K) focuses the page's `[data-search-primary]` input; no command palette. Shows a live/sync chip and the New Deal CTA (both hidden on mobile).

**Primitives** (`src/components/ui/`, barrel `index.js`; `import { Card, ... } from '<rel>/components/ui/index.js'`):

| Component | Props / behaviour |
|---|---|
| `Card` | `title, action, hero, hover, as`; #13161e, 1px border, radius 18 |
| `SectionTitle` | `children, action, onAction, actionHref, eyebrow, size=17` |
| `Segmented` | `options [{value,label,count?}], value, onChange, disabled, size`; replaces Chip tab rows |
| `StagePill` | `stage, ugc, size 'sm'|'lg', dot, label`; labels from `lib/stages.js` / `lib/ugcStages.js` |
| `DealPill` | `type`; outlined, labels from `lib/dealTypes.js` |
| `RatingDot` (+ `RATING_COLORS`) | `rating, showLabel, size` |
| `Tile` | KPI tile: `label, value, hint, color, size=24, right, hover, onClick` |
| `FilterSelect` | `value, onChange, options, width`; native `<select>` underneath |
| `SearchField` | `value, onChange, placeholder, primary=true, width=300`; renders `data-search-primary` unless `primary={false}` |
| `TableCard`, `Row`, `NumCell` | CSS-grid table: `columns, head, minWidth=720`; `Row` takes `onClick, focused, first, index, animate`; `NumCell` is mono right-aligned |
| `Avatar` (+ `AVATAR_TINTS`) | `name, seed, index, size=34, square, ring, tint` |
| `Modal` | Same props/behaviour as the `@throttle/ui` Modal, restyled; `footer` replaces Cancel/Confirm, size `'lg'` widens |
| `Stepper` | `steps [{key,label,date?}], current`; done = orange check, current = igRing pulse |
| `ProgressBar` (+ `viewsTone`, `spendTone`, `budgetTone`) | `pct` or `value/max, color, height=8, fuse, delay` |
| `Spark` | `values, color, dim, height=28, highlightLast` |
| `Banner` | `tone='warning', icon, lead, children, action, onAction, actionDisabled` |
| `Menu` | `open, onClose, anchorRef, items [{label,onClick,icon?,danger?,disabled?,active?}], align='right', width=220` |

Hover/focus helper classes in `globals.css` (inline styles cannot do `:hover`; the rules are `!important` because components set resting colours inline): `.ig-card-hover` `.ig-card-action` `.ig-row` `.ig-seg-pill` `.ig-ctl` `.ig-menu-item` `.ig-ghost-btn` `.ig-cta` `.ig-rail-*` `.ig-topbar-search`.

### Layout and mobile rules

- `<main className="ig-main">` padding `8px 32px 40px`; `html, body` are `overflow: hidden` - the main region scrolls.
- **Mobile (<=767px)**: rail hides; fixed bottom tab bar (`.ig-tabbar`: Dashboard / Influencers / Engagements / Schedule / More) + a "More" bottom sheet with the full nav (incl. New Deal). Inputs/selects/textareas are forced to 16px (stops iOS focus zoom); tables scroll sideways inside `.ig-main`.
- **Mobile CSS selects on inline style strings**: `.ig-main [style*="columns: 1fr 1fr"]` collapses two-column form grids to one. A page that wants to stack must write that exact inline `gridTemplateColumns: '1fr 1fr'` string (React serialises it as `grid-template-columns: 1fr 1fr`), and week-grid `repeat(7,...)` is deliberately not matched. Do not reformat those strings.
- **375px must not scroll horizontally** - check every new page at 375px.
- **`data-search-primary`** on each page's search input (via `SearchField`, or the attribute directly): it is the target for `/`, Cmd/Ctrl+K and the top-bar search. Pages without a search: no-op.
- **Presentation never fakes data**: no placeholder numbers, sparkline filler or invented deltas - an empty/zero value renders as empty/zero (`Spark` renders flat stubs for no data).

## Frontend layout

`apps/ignition/` (Next.js static export, `@throttle/{auth,db,ui,domain}` consumed as-is):

```
src/
  app/
    layout.js              // fonts <link>, AuthProvider, ToastProvider
    globals.css            // Pit Control tokens + motion + mobile shell
    login/  page.js
    (auth)/
      layout.js            // RequireAuth + IgRail + IgTopbar + mobile tab bar, useSearchShortcut
      dashboard/ influencers/ engagements/ (detail, new) schedule/ payments/
      connects/ targets/ roster/ blist/ ugc/ campaigns/ discount-codes/
      reports/ manual/ admin/ (users, import)
  components/
    shell/                 // IgRail, IgTopbar
    ui/                    // Pit Control primitives (above)
    StageBadge, RatingBadge, DealTypeBadge, StageStepper, AdvanceModal, NewDealModal,
    NewInfluencerModal, NewPaymentModal, OpenPitstopButton, ... (feature components)
  lib/                     // ignitionopsFetch, stages, ugcStages, dealTypes, nav, metrics, ...
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
