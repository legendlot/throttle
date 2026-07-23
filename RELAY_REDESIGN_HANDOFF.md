# Relay Redesign — Claude Code Handoff

> **Goal:** Refresh the existing Relay app (`apps/relay`) to match the approved **COMMAND**
> redesign prototype shipped alongside this doc. This is a **front-end reskin + IA overhaul**
> — no schema changes, no change to how comms are sent, gated, or captured. Every RPC the current
> screens call stays exactly as-is; only the markup, tokens, and navigation change. A small number
> of *read-only* conveniences may be wanted (flagged in §9) — none are required to ship.

---

## 0. How to use this with Claude Code

**Setup (once):** the reference bundle sits at the repo root as:
```
05_Throttle/
  ├─ RELAY_REDESIGN_HANDOFF.md        ← this file
  ├─ Relay COMMAND.dc.html            ← runnable prototype of the whole app (all 12 screens)
  ├─ Relay COMMAND — standalone.html  ← same prototype, fully self-contained (offline, no deps)
  └─ Relay Campaigns — Directions.dc.html  ← direction exploration + colorway study (context only)
```
Open **`Relay COMMAND — standalone.html`** in any browser with no setup — it inlines all fonts,
scripts, and styles and runs offline (it's the file to hand to anyone who just wants to click
through). `Relay COMMAND.dc.html` is the editable source it's compiled from; read that one for
markup/logic. The prototype is a single self-contained **Design Component**. Open it in a browser to see
every screen; click the sidebar to navigate; **click the sidebar header to collapse/expand** it.
It is the **source of truth** for exact tokens, markup, spacing, and interaction — when a spec
here is ambiguous, read the corresponding block in `Relay COMMAND.dc.html` (template markup for
layout, the `Component` logic class for data shapes and computed values).

**Then paste this prompt into a fresh Claude Code session:**
> Read `05_Throttle/RELAY_REDESIGN_HANDOFF.md` and implement the Relay COMMAND redesign it
> describes, modifying `apps/relay/`. Open `05_Throttle/Relay COMMAND.dc.html` as the source of
> truth for exact tokens, markup, and spacing. Follow the implementation order in §8, hold to the
> design tokens and contrast rules in §3 exactly, keep the IA/nav in §4, and **do not change any
> backend RPC, gate, or send path** — wire every screen to the existing Relay RPCs it already
> calls (listed per screen in §7). Stop and ask me before adding anything in §9. Start with §3
> tokens + the app shell, show me the Overview screen first, then proceed screen by screen.

---

## 1. The diagnosis this redesign solves

The old Relay read as **dull, hard to read, and hard to navigate** — three fixable causes:

1. **No typographic hierarchy** — display, UI, and data all sat in one or two near-identical
   sans weights, so nothing led the eye. Fix: three type roles (display / UI / mono), §3.1.
2. **Flat, mislabelled IA** — the sidebar's `SEND / BUILD / DATA / ADMIN` grouping split
   related work (Segments under BUILD, Contacts under DATA) and buried the daily screens next to
   done-once admin. Fix: task-based groups (`Send / Audience / Build & measure / Admin`) + a
   standalone **Overview** + a **⌘K palette**, §4.
3. **No "now" surface** — a marcomms tool with live sends had no home that showed what was on
   air. Fix: a new **Overview / Control tower** dashboard + a persistent **ON AIR** rail, §7.1.

Plus a **contrast + surface pass** (§3.4): lift the flat near-black surfaces into a layered ramp
so cards separate from the background, and tune the text ramp so body/secondary text passes AA.

Relay's identity is **kept, not replaced**: dark theme, **Relay Yellow `#F2CD1A`** as the single
accent (locked — evaluated against 5 alternatives), semantic status colors unchanged.

---

## 2. Source-of-truth files (read these)

| Concern | Where in the prototype |
|---|---|
| Design tokens (color ramps, type, radius, motion) | §3 here + inline styles throughout `Relay COMMAND.dc.html` |
| App shell (sidebar, ⌘K launcher, ON AIR rail, user footer, collapse) | the `<aside>` block + `navGroups`/`toggleSidebar` in the logic class |
| Top context bar (breadcrumb + LIVE indicator) | the `.main` header block; `crumbGroup`/`crumbPage` |
| Overview / Control tower | `isOverview` section; `overviewKpis`, `liveSends`, `activity`, `senderHealth` |
| Campaigns | `isCampaigns` section; `campaigns`, `campaignTabs`, `campaignKpis` |
| Journeys | `isJourneys` section; `journeys` (ON/OFF switch model) |
| Segments | `isSegments` section; `segments` |
| Contacts | `isContacts` section; `contacts` (consent tone map) |
| Templates | `isTemplates` section; `templates` (channel + Meta-approval cells) |
| Analytics | `isAnalytics` section; `analyticsKpis`, `sendBars`, `analyticsRows` |
| Admin · Roles | `isRoles` section; `roles` |
| Admin · Users | `isUsers` section; `users` |
| Admin · Approval & Caps | `isSettings` section; `governance` (test-mode lock) |
| Admin · Sender Identities | `isSenders` section; `senders` |
| Admin · Connectors | `isConnectors` section; `connectorChannels` |
| Direction study + colorway exploration | `Relay Campaigns — Directions.dc.html` (context only) |

> All data in the prototype's `Component` logic class is **mock**, shaped to match what each RPC
> already returns. Field names mirror the live payloads (`attributed_revenue`, `read_rate`,
> `deliveredPct`, `approval_status`, `test_mode`, …). Replace the mock arrays with the existing
> RPC calls named per screen in §7 — do not change the RPCs.

---

## 3. Design system

### 3.1 Fonts
Load via Google Fonts (all free/open). This three-role split is the single biggest reason the
redesign reads "modern" — the old app collapsed all three into one family.
- **Space Grotesk** — display: page titles (`<h1>`), KPI values, panel titles, the brand
  wordmark. Tight tracking (`-.01em`) on headings.
- **Hanken Grotesk** — UI + body: nav, descriptions, table cells, buttons, paragraph text.
  Sentence case.
- **JetBrains Mono** — **numbers, codes, times, IDs, eyebrows/labels, status pills only.**
  Tabular figures. Never set body/UI prose in mono; never set a KPI value in the UI font.

```
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
```
Icons: **Material Symbols Rounded** (weight 400, optical size 24). The prototype uses the
webfont via a `.ms` class. In the app, either keep the webfont or map each glyph name to its
`lucide-react` equivalent (the current app already imports `lucide-react`) — see the icon map in
§3.5. **No emoji** anywhere.

### 3.2 Tokens (introduce as CSS variables; values are copied verbatim from the prototype)
The prototype inlines these hexes; when porting to `apps/relay/src/app/globals.css` +
`redesign.css`, promote them to variables so the existing components can consume them.

Surface ramp (layered — cards must separate from the app background):
```
--bg:#0d0e10;        /* app canvas / main content */
--bg-2:#0a0b0d;      /* recessed: top bar, search field, number inputs */
--surface:#141518;   /* panels, cards, KPI strip */
--surface-2:#111214; /* sidebar */
--surface-hover:#1a1c20;
--border:#212227;    /* panel borders */
--border-2:#202128;  /* sidebar / header dividers */
--row-border:#1a1b1f;/* table row separators */
--border-strong:#2c2f36; /* secondary-button borders */
```
Text ramp:
```
--t1:#f4f5f6;  /* primary — headings, values, key cells */
--t2:#a3a8af;  /* secondary — nav idle, secondary buttons */
--t3:#8b909a;  /* muted — descriptions, sub-labels, table dims */
--t4:#71767c;  /* micro — eyebrows, mono captions, breadcrumb */
--t5:#565b61;  /* faint — em-dash placeholders, group headers */
```
Brand + semantic (Relay Yellow locked; status colors stay semantic — use the bright fg on dark):
```
--accent:#F2CD1A; --accent-ink:#17140a;                 /* ink = text on a yellow fill */
--accent-soft:rgba(242,205,26,.12); --accent-bd:rgba(242,205,26,.34);
--green:#34d399; --blue:#7c9bff; --orange:#fb923c; --red:#f87171; --gray:#9aa0aa;
/* WhatsApp brand green for channel glyphs only: #25D366 */
```
Each status tone renders as a pill: **fg** = the hue above, **bg** ≈ `rgba(hue,.13)`, **bd** ≈
`rgba(hue,.34)`. Gray uses `rgba(255,255,255,.05)` bg / `.11` bd. The exact map is the `ST` object
in the prototype logic class — copy it.

Radius: `--r-sm:6 --r-md:9 --r-lg:10 --r-xl:14 --r-2xl:16 --r-pill:9999`
(pills 6px, buttons/nav 9–10px, panels 14px, cards/rails 16px).
Elevation: primary buttons carry `box-shadow:0 6px 18px -8px rgba(242,205,26,.7)`; panels/frames
`0 40px 90px -40px rgba(0,0,0,.8)` at the top level only.
Motion: page-content fade-in `rfade .3s ease`; sidebar width `.2s cubic-bezier(.4,0,.2,1)`; the
live/ON-AIR dot pulses (`rpulse` keyframe). No bounce, no decorative loops >300ms.

### 3.3 Reusable atoms
- **eyebrow / label** — JetBrains Mono, ~9–10px, `.06–.16em` tracking, uppercase, `--t4`. Used on
  KPI labels, table `<th>`, group headers, breadcrumb.
- **num** — JetBrains Mono, tabular-nums, on every number / code / time / ID / status pill.
- **KPI strip** — a single bordered row of equal cells divided by `--border-2`; the primary cell
  carries a 2px `--accent` top rule; value in Space Grotesk 26–27px; delta in mono
  (`▲` green / neutral `--t3`).
- **Panel** — `--surface` fill, `--border`, radius 14; header row = Space Grotesk 14px title +
  optional mono count + right-aligned action; body is a table or padded content.
- **Status pill** — inline-flex, mono ~10px, 6px radius, `fg/bg/bd` from the tone map, optional
  leading 5–6px dot in `fg`.

### 3.4 Contrast rules (must hold)
- Body/secondary/muted prose uses `--t1/--t2/--t3` only. `--t4/--t5` are for **mono micro-labels,
  eyebrows, breadcrumb, and em-dash placeholders only** — never normal-size prose.
- Status text uses the **bright** tokens (`--green #34d399`, `--blue #7c9bff`, `--red #f87171`),
  never deep hues that fail on dark.
- Keep the layered surface ramp — do **not** flatten back to a single near-black. `--surface`
  (#141518) and `--surface-2` (#111214) must stay visibly separated from `--bg` (#0d0e10).
- On a yellow fill, text is `--accent-ink (#17140a)`, never white.

### 3.5 Iconography (Material Symbols → lucide-react map, if you keep lucide)
`bolt`→Zap · `space_dashboard`→LayoutDashboard · `campaign`→Send · `fork_right`→GitBranch ·
`filter_alt`→Filter · `contacts`→Contact · `mail`→Mail · `monitoring`→BarChart3 · `shield`→Shield ·
`group`→Users · `tune`→SlidersHorizontal · `alternate_email`→AtSign · `cable`→Cable ·
`search`→Search · `add`→Plus · `download`→Download · `refresh`→RefreshCw · `lock`→Lock ·
`chat`→(WhatsApp) MessageCircle · `notifications`→Bell · `left_panel_close`→PanelLeftClose.
Stroke 1.75px, `currentColor`, 16px inline / 18–19px nav.

---

## 4. Navigation (the IA overhaul)

Replace `SEND / BUILD / DATA / ADMIN` with a standalone **Overview** + task-based groups. Routes
are unchanged — this only regroups/relabels and adds Overview + ⌘K.

```
Overview                         → /            (new Control tower dashboard)
Send      ▸ Campaigns · Journeys                → /campaigns · /journeys
Audience  ▸ Segments · Contacts                 → /segments · /contacts
Build & measure ▸ Templates · Analytics         → /templates · /analytics
Admin     ▸ Roles · Users · Approval & Caps · Sender Identities · Connectors
            → /admin/roles · /admin/users · /admin/settings · /admin/senders · /admin/connectors
```
Rules (see the `<aside>` + `navGroups` in the prototype):
- **Active item** highlighted with `--accent-soft` fill, `--accent` text, and a 3px `--accent`
  left bar bleeding off the item's left edge.
- **Collapsible sidebar**: click **anywhere on the header** to toggle between the 256px full rail
  and a 68px icon-only rail. Collapsed mode: icons centered, group labels become 1px divider
  rules, `title` tooltips on every item, and the search / ON-AIR / user cells shrink to single
  glyphs. Persist the state in `localStorage` (suggested key `relay-sb-collapsed`) — the
  prototype holds it in component state; add persistence in the app.
- **⌘K command palette** is the intended primary navigation: fuzzy search across screens, entities
  (campaigns, journeys, segments, templates, contacts), and actions ("New campaign", "New
  journey"). The prototype stubs the launcher (the search field + `⌘K` chip); build the palette
  itself in the app.
- **ON AIR rail** (above the user footer): a live card for the currently-sending broadcast —
  name, `sent / total`, a green progress bar. Driven by the same in-progress campaign data the
  Campaigns list already has (`status: 'sending'`). Collapses to a pulsing glyph.
- **Top context bar**: breadcrumb `GROUP / SCREEN` (mono, uppercase) on the left; a green
  **LIVE · UPDATED h:mm IST** pulse + notifications glyph on the right. Keep the live screens'
  existing refresh cadence.

---

## 5. Shared components → map onto `apps/relay/src/components`

The current app already has a house kit (`components/ui.js`: `PageHead`, `Panel`, `Badge`, `Btn`,
`EmptyState`, `Kpi`, `Switch`, `Pipeline`; `components/format.js`: `fmtDate`, `inr`). **Restyle
these in place** — do not fork new ones — so every screen inherits the new look for free.

| Prototype element | Existing component to restyle | Notes |
|---|---|---|
| Sidebar + groups + collapse + ⌘K launcher + ON AIR rail | `components/chrome/Sidebar.js` | Rework to the §4 grouping; add collapse + ON AIR + palette launcher. |
| Top context bar | `components/chrome/ContextBar.js` | breadcrumb + LIVE; keep sub-tab slot if used. |
| App shell | `(auth)/layout.js` | sidebar + context bar + scroll `<main>` (fade-in on route). |
| Page header (title + sub + actions) | `PageHead` | Space Grotesk title 28px, `--t3` sub, action buttons right. |
| Panel | `Panel` | title row (Space Grotesk + mono count + action) + table/padded body. |
| KPI strip / cards | `Kpi` | eyebrow + Space Grotesk value + delta; accent top-rule on the lead cell. |
| Status/tone pills | `Badge` | map `tone` → the `ST` fg/bg/bd map; add a leading dot option. |
| Buttons (primary yellow / ghost) | `Btn` | primary = yellow fill + ink + glow; ghost = `--border-strong`. |
| ON/OFF row switch | `Switch` | pill track + knob, green when on (Journeys list). |
| Sends-by-day bars | `Pipeline`/new | yellow column = sent, green fill from bottom = delivered. |

Keep IST / `en-IN` formatting (`inr()`, `fmtDate()`), and keep every permission gate and
`disabled`/read-only branch already in the screens — the redesign changes none of that logic.

---

## 6. Signature visuals (keep these — they carry the "control tower" energy)

- **ON AIR rail** (sidebar) and **"Sending now"** card (Overview) — live progress bars for
  in-flight sends, green, with `sent / total` and an ETA. Both read the in-progress campaign(s).
- **KPI strip** — the compact bordered multi-cell strip with the accent top-rule on the lead
  metric; used on Overview and Campaigns.
- **Sends-by-day bars** (Analytics) — per-day column, yellow = sent, green fill from the bottom =
  delivered share (`delivered / sent`). Mirrors the current `SendsBars` intent with the new palette.
- **Test-mode lock banner** — the yellow `LOCKED — internal sends only` block on Approval & Caps
  (and the compact lock chip on Overview) is a first-class safety signal, not decoration. Its
  copy and lock/open colors mirror the live `test_mode` fail-safe (anything but explicit `false`
  = LOCKED).

---

## 7. Screen specs (behavior + data — RPCs are unchanged)

For exact layout/spacing, open the matching `is*` section in `Relay COMMAND.dc.html`. Each screen
below lists the **existing** RPCs it already calls — wire the redesigned markup to these verbatim.

1. **Overview / Control tower** — *new screen* at `/`. Answers "what's on air and how are we
   doing." Blocks: **Sending now** (in-progress campaigns, progress bars) · **Queue & gates**
   (queued / awaiting-approval / failed-24h + the test-mode lock chip) · **KPI strip** (Sent 7d,
   Delivery, Read, Attr. revenue, Blended ROI) · **Recent activity** feed · **Deliverability 7d**
   (per-sender quality). Data: reuse `getSendsOverview`, `getDeliverabilityHealth`, `getCampaigns`
   (+ `getCampaignAttribution`) — the same RPCs Analytics/Campaigns already call. No new write path.
2. **Campaigns** (`/campaigns`) — the finalized layout. KPI strip + tab filter
   (All / Scheduled / Drafts / Sent, counts via `tabOf`) + a **leaner table**: Broadcast (channel
   chip + name + purpose·channel), Status pill, When, Delivered (+%), Read, Click, Revenue, ROI.
   This deliberately drops the old 14-column overload — the full set stays in the CSV export. RPCs:
   `getCampaigns`, `getCampaignsOverview`/`campaign_stats_list`, CSV builder unchanged; keep
   `campaignStatus()`/`tabOf()`, the em-dash-for-null rule, and all create/approve/send paths.
3. **Journeys** (`/journeys`) — test-mode banner + list with the **ON/OFF switch** as the primary
   control (ON = `active`; the switch mirrors `toggleGuard`/`setJourneyStatus` exactly — keep the
   confirm + optimistic-revert). Columns: On/Off, Journey (trigger·version), Enrolled, Conv,
   Revenue, Read, Last activity. RPCs: `getJourneys`, `getJourneysOverview`, `setJourneyStatus`.
   Do not merge the editor/canvas — restyle it later with the same tokens.
4. **Segments** (`/segments`) — list: Name, Kind pill (dynamic=blue / static=gray), Conditions
   (`N · match all/any`), Members, Updated. RPCs: `getSegments` (+ `getSegment`,
   `previewSegment`, `materializeSegment` in the editor). Keep the rule-builder logic.
5. **Contacts** (`/contacts`) — list with an initials avatar, City, **Consent** pill
   (opted_in=green / opted_out=red / unknown=gray), Orders, Lifetime ₹, Added. RPC: `getProfiles`
   (detail `getProfile`, `recordConsent`, `optOutProfile`). Keep the consent ledger + opt-out flow.
6. **Templates** (`/templates`) — list: Name, Channel (glyph + label), Purpose, Status pill,
   **Meta** cell (WhatsApp only: APPROVED/PENDING/REJECTED pill, else "not submitted"; email = —),
   Ver, Updated. RPCs: `getTemplates` (+ `saveTemplate`, `sendTest`, `waSubmitTemplate`,
   `waSyncTemplateStatus`). Keep the email/WA editors and all M13/WA save guards.
7. **Analytics** (`/analytics`) — window picker (7/30/90) + two KPI rows + **Sends-by-day bars** +
   Campaign performance table + Journeys table + Deliverability table. RPCs: `getSendsOverview`,
   `getDeliverabilityHealth`, `getCampaigns`/`getCampaignStats`/`getCampaignAttribution`,
   `getJourneys`/`getJourneyAttribution`. Keep the `statsError` "unavailable, not fake-zero" state.
8. **Admin · Roles** (`/admin/roles`) — permission roles as **cards** (label + system tag, key,
   description, granted-count, View/Edit + Clone). RPC: `getRoles` (+ `saveRole`); keep the
   `PERM_DEFS` matrix + system-role read-only + clone-to-editable behavior. Super-admin gated.
9. **Admin · Users** (`/admin/users`) — Grant-access form (person combobox + role select) + access
   list (User, Email, Role pill, Status, Assigned; inactive rows dimmed). RPCs: `getUserRoles`,
   `getRoles`, `searchUsers`, `assignUserRole`. `relay_admin` gated.
10. **Admin · Approval & Caps** (`/admin/settings`) — the **test-mode global lock** panel
    (LOCKED/OPEN, allowlist) + **Send governance** rows (approval toggle + threshold, frequency
    cap + window, quiet hours, attribution window, daily budget). RPCs: `getRelaySettings`,
    `saveRelaySettings`. Keep the fail-safe (`test_mode !== false` = LOCKED) and the unlock
    confirm. Super-admin gated.
11. **Admin · Sender Identities** (`/admin/senders`) — list: Channel glyph, Address, Provider,
    Status pill, **DNS** (email only: verified/unverified). RPCs: `getSenderIdentities`,
    `saveSenderIdentity`. `connector_channel_manage` gated.
12. **Admin · Connectors** (`/admin/connectors`) — read-only sender overview grouped by channel +
    the **Shopify sync** and **Cashfree payment-link** action panels. RPCs: `getSenderIdentities`,
    `shopifyBackfill`, `shopifyRegisterWebhooks`/`shopifyListWebhooks`, `cashfreeMintTestLink`.
    Keep every confirm and the "no emails are sent" copy.

---

## 8. Implementation order (suggested)

1. **Tokens + fonts + global CSS** (`globals.css` + `redesign.css`) and the type/atom classes.
   Everything keys off this — do it first and verify contrast (§3.4).
2. **Shell**: rework `Sidebar.js` (§4 grouping + header-click collapse + ON AIR rail + ⌘K
   launcher), `ContextBar.js`, and `(auth)/layout.js`. Add the **⌘K CommandPalette** as a global.
3. **Core components**: restyle `Panel`, `Kpi`, `Badge`, `Btn`, `Switch`, `PageHead`, `EmptyState`
   in place (§5).
4. **Overview** first (new, highest-signal), then **Campaigns**, then the rest of Send/Audience/
   Build & measure, then the Admin screens.
5. Wire each screen to its **existing** RPCs (§7) as you go. Preserve every permission gate,
   `disabled` state, confirm dialog, optimistic-update, and em-dash-for-null convention.

---

## 9. Backend — what's needed (nothing required)

This redesign is **front-end only**. No schema changes, no new send/gate logic, no change to data
capture. Everything wires to RPCs the current screens already call (§7). The only *optional*,
purely-additive conveniences — **stop and ask before building any of these**:

- **⌘K search** — a single read endpoint to fuzzy-search campaigns/journeys/segments/templates/
  contacts by string. The palette can also run fully client-side over already-loaded lists to
  ship without it. *Optional.*
- **Overview aggregation** — Overview can be assembled entirely from existing RPCs
  (`getSendsOverview`, `getDeliverabilityHealth`, `getCampaigns` + attribution). A single combined
  read endpoint would cut round-trips but is **not** required. *Optional.*
- Everything else (Campaigns, Journeys, Segments, Contacts, Templates, Analytics, all Admin) maps
  to **existing** Relay RPCs — wire to the current endpoints, change nothing server-side.

---

## 10. QA checklist

- [ ] Fonts: Space Grotesk (display/values) · Hanken Grotesk (UI/body) · JetBrains Mono (numbers/
      codes/labels/pills). No number in the UI font; no prose in mono.
- [ ] Layered surface ramp (no flat near-black); panels visibly separate from `--bg`.
- [ ] Body/secondary/muted text uses `--t1/--t2/--t3` (AA); `--t4/--t5` only on mono micro-labels.
- [ ] Relay Yellow `#F2CD1A` is the only accent; ink on yellow is `#17140a`; status colors semantic
      and bright.
- [ ] IA = Overview + Send / Audience / Build & measure / Admin; routes unchanged.
- [ ] Sidebar collapses on **header click**, persists, shows tooltips + divider rules when collapsed.
- [ ] ⌘K reachable from every screen; ON AIR rail reflects the live in-progress send.
- [ ] Every permission gate, confirm dialog, test-mode fail-safe, and em-dash-for-null rule from
      the current screens is preserved. **No RPC, gate, or send path changed.**
- [ ] No emoji; Material Symbols (or mapped Lucide) throughout.
- [ ] Reduced-motion respected (no infinite decorative loops):
```
@media (prefers-reduced-motion: reduce){ *{animation-duration:.01ms!important;transition-duration:.01ms!important} }
```
