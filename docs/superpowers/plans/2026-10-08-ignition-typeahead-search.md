# Ignition — typeahead ("combo") search · plan

> S412, 2026-10-08. Asked by Afshaan: "where should there be a search bar, and let's put combo search
> boxes there". **"Combo" = typeahead dropdown** (Afshaan's pick): typing shows matching records in a
> dropdown, picking one jumps to it, and Enter keeps today's behaviour (filter the list).
> Built on the two read-only maps from S412 (page search inventory + worker search endpoints); every
> claim below was spot-checked against the code.

## 0. What exists today (the facts the plan rests on)

- **Only 4 routes have a search box**: `/engagements`, `/influencers` (both worker-side `search`),
  `/admin/users` (client-side), `/engagements/new` (influencer picker). Everything else has none.
- **4 in-form pickers already search**: the New-deal influencer picker (`lib/useDealForm.js:36`,
  `getInfluencers {search, limit 8}`), `NewPaymentModal.js:41` (same call), the Campaign-detail
  "Link deal" modal (`campaigns/detail/page.js:283`, `getEngagements {search, limit 10}`), and
  `ProductLinesEditor` (shared `Combobox` over the whole `getCatalogs` list, matched in the browser).
- **No typeahead debounces and none guards against out-of-order responses.** Each keystroke fires a
  request; a slow early response can overwrite a later one, which shows results for "pe" while the
  box says "petrol".
- **Worker search exists for 2 entities only.** `getInfluencers ?search=` matches `channel_name,
  person_name, email, contact_number, influencer_code, channel_link` (`index.js:500-505`);
  `getEngagements ?search=` matches `engagement_no, video_link, tracking_id, shipping_order_id` plus
  the influencer's name/code/link (`index.js:746-764`). Campaigns, Connects, Payments, Users, Roster
  and UGC have no search param.
- **⚠️ The search term can break out of the PostgREST `or=(…)` group.** `q` goes through
  `encodeURIComponent` only, which leaves `(` `)` `*` as they are, and PostgREST decodes `%2C` back
  to a comma before parsing the group. A term containing `,` or `)` can end the group early or add
  conditions. The impact is read-only and limited to the same table, behind `ignition_view`, but it
  ships with this work (S1).
- **Sizes today:** influencers 1,689 · engagements 605 · connects 1,664 · campaigns 10 · payments 34
  · users 30 · B-List 2 · UGC deals 2. `pg_trgm` is installed but no searched column has a trigram
  index. `ILIKE %q%` seq scans are fine at this size; add `gin_trgm_ops` indexes past ~10–20k rows
  (watchboard line, not a task).
- **Connects rows hold no name / handle / phone** (`ignition.connects`: thread_id, channel, status,
  influencer_id, handoff_note, transferred_by_name…). Names come from the Pitstop thread via the csops
  bridge, so a server-side Connects search is a bridge build, not a quick one.
- **Top bar:** "Search this page" (`IgTopbar.js:12-19`) focuses the page's `[data-search-primary]`
  input; `⌘/Ctrl+K` and `/` both land there. There is no cross-page search.

## 1. Where a search box goes — the ruling

Three kinds of box, one shared component (§3).

### A. Global search in the top bar — every signed-in page
The one that pays most: from any page, type a name, code, deal number or tracking id and jump to the
record. **Groups:** Influencers (≤5) · Deals (≤5, UGC deals open the UGC detail) · Campaigns (≤3).
Connects are **not** in global search (no server-side name to match on — §0); the Connects page has
its own box.
- Desktop: the top bar field; `⌘/Ctrl+K` opens it from anywhere.
- ≤767px: a search icon in the top bar opens a full-screen sheet with the same field and results.
- Detail pages (influencer, deal, UGC, campaign, connect) get no page box. Global search is how you
  jump from one record to another.

### B. Page search on list pages — typeahead on top of today's list filter
| Route | Searches | Source | Dropdown row | Pick → | Enter → |
|---|---|---|---|---|---|
| `/engagements` | deal no, video link, tracking, order id, influencer name/code/link | worker (today's `search`) | IGN no · influencer · stage pill · Video/UGC | deal detail | filter the list (today) |
| `/influencers` | name, handle, code, phone, email, link | worker (today's `search`) | avatar · name · code · rating dot · type · reach | influencer detail | filter the list (today) |
| `/connects` | customer name / handle / phone / last message, over the loaded threads | client-side (the 200 rows the page already loads) | avatar · name · channel · status label | thread | filter the list |
| `/campaigns` | name | client-side (all 10 rows are loaded) | name · status · Consumed ₹ | campaign detail | filter the grid |
| `/payments` | influencer name/code, deal no, kind | client-side (all rows loaded) | date · influencer · deal no · kind · ₹ | the deal | filter the table |
| `/roster` | name, code, handle | client-side over the loaded rows (inherits the filed `getRoster` limit bug until it's fixed) | avatar · name · code · rating | influencer detail | filter the list |
| `/admin/users` | name, role | client-side (today's filter) | name · role · Active/Revoked | the row's access panel | filter (today) |

**No page box** (and why): Dashboard, Reports, Targets (summary pages with nothing to find), Schedule
(a calendar; global search finds the deal), B-List and UGC (2 rows each today; add a client-side box
when either passes ~30 rows, same component, half a day), Import, Manual (it has its own TOC), Login,
`discount-codes` (retired from the nav).

### C. Pickers inside forms — same component, no page change
New-deal influencer picker (page + modal) · NewPaymentModal influencer picker · Campaign "Link deal"
modal. Each gets debounce, the stale-response guard, keyboard nav and the same row look.
`ProductLinesEditor` stays on the shared `Combobox`: it matches in the browser over a 227-row catalogue
that's already loaded, so it has no race and needs no debounce.

## 2. Behaviour rules (all three kinds)

1. **Min 2 characters**, **debounce 200 ms**, **AbortController** on every new keystroke. A response
   is drawn only if its query still equals the box's value (stale guard).
2. **Keyboard:** ↑/↓ move the highlight, Enter picks the highlighted row, **Enter with nothing
   highlighted = the box's submit action** (list filter on list pages; nothing in global), Esc closes
   the dropdown (a second Esc clears the box), Tab leaves without picking. `/` still focuses the page
   box. **`⌘/Ctrl+K` moves to global search** (today it focuses the page box; this is the one
   behaviour change, and `/` keeps the page-box shortcut).
3. **The list filter is unchanged** on `/engagements` and `/influencers`: same worker param, same
   sessionStorage key (`ignition.engagements.filters.v2`), same paging walk and `useListNav`. The
   dropdown is extra, with its own `limit: 6` call, so the 200-row walk never waits on it.
4. **States:** "Type 2+ characters" hint · spinner while loading · "No matches for 'x'" · a
   one-line error with Retry (never an empty list for a failed call). Results show the matched part
   in bold.
5. **Accessibility:** WAI-ARIA combobox pattern (`role=combobox`, `aria-expanded`,
   `aria-activedescendant`, `role=listbox/option`).
6. **375px:** the dropdown is full width under the box; global search is a full-screen sheet; no
   horizontal page scroll.
7. **Permissions:** every read is already gated on `ignition_view` at the router (`index.js:5339`).
   Global search never returns a group the user couldn't open. Picks only navigate; nothing in a
   dropdown mutates.
8. **No fake rows:** a missing field is omitted from the row, never shown as "—" or 0.

## 3. Build — slices (each one is a commit, hostile-reviewed, pushed, smoked)

| # | Slice | Repo / files | Size | Notes |
|---|---|---|---|---|
| S1 | **Worker: safe search term + `searchAll`** | `ignitionops-worker/src/index.js`, new test | ~60k | `searchTerm(q)`: trim, cap 64 chars, strip PostgREST reserved `, ( ) * " \ :`; used by `getInfluencers` and `getEngagements` (fixes §0 ⚠️). New `searchAll?q=` (gate `ignition_view`, min 2) returns `{influencers ≤5, engagements ≤5, campaigns ≤3}` in one round trip, reusing the existing filter builders with small limits, plus a `name.ilike` on campaigns. Tests: the sanitiser (commas, parens, `*`, empty after strip) and the result shape. Deploy ignitionops. |
| S2 | **`Typeahead` primitive + `useTypeahead` hook** | `apps/ignition/src/components/ui/Typeahead.js`, `lib/useTypeahead.js`, test | ~60k | Ignition-local (`packages/ui` untouched). Props: `fetchResults(q, signal) → [{group, items:[{id, primary, secondary, meta, tone, href}]}]`, `onPick(item)`, `onSubmit(q)`, `minChars`, `debounceMs`, `placeholder`, `primary` (sets `data-search-primary`), `value`/`onChange` (controlled, so the list pages keep their state). Pure helpers unit-tested in `node --test`: the debounce/stale guard, match highlighting, keyboard index wrap. |
| S3 | **Global search in the top bar** | `components/shell/IgTopbar.js`, `app/(auth)/layout.js` (mobile sheet) | ~40k | `searchAll` via `Typeahead`; `⌘/Ctrl+K` rebinds here; the "Search this page" button stays for pages with a box. |
| S4 | **List pages, worker-backed:** `/engagements`, `/influencers` | the two `page.js` | ~40k | Swap `SearchField` for `Typeahead` in controlled mode; the list fetch, paging, sessionStorage, `useListNav` untouched. |
| S5 | **List pages, client-side:** `/connects`, `/campaigns`, `/payments`, `/roster`, `/admin/users` | the five `page.js` | ~50k | `fetchResults` filters the rows already in state (no worker call); Enter filters the visible list. Connects matches the fields the list rows already carry (name, handle, channel, last message preview); confirm what the row has before wiring. |
| S6 | **Pickers** | `lib/useDealForm.js`, `NewDealModal.js`, `engagements/new/page.js`, `NewPaymentModal.js`, `campaigns/detail/page.js` (Link deal) | ~40k | Same component; keeps each picker's limit, min chars and its pick handler; adds debounce and the stale guard. The New-deal preset (`?influencer=`) is unchanged. |
| S7 | **Close-out** | manual (Navigation chapter: ⌘K global search, `/` page search; each list chapter one line) · `DESIGN.md` (Typeahead in the primitives list) · `systems/ignition.md` one line | ~30k | manual-builder, version bump. |

Order: S1 → S2 → S3 (global search is the biggest win and proves the component) → S4 → S5 → S6 → S7.
**Total ≈ 320k tokens of lane work, 3–4 sessions.** Each slice fits one session window by itself.

## 4. Risks and how each is handled

- **Breaking the `/engagements` filter persistence or paging.** S4 keeps the list state controlled by
  the page; the Typeahead only renders the box and the dropdown. The S4 smoke reloads the page and
  checks the query and filters come back.
- **⌘K muscle memory.** The rebind is the only behaviour change. `/` still focuses the page box; the
  Navigation chapter of the manual says so.
- **A request per keystroke on slow networks.** 200 ms debounce + AbortController + min 2 chars.
- **Global search leaking a record a user can't open.** Every group comes from an action already
  gated on `ignition_view`; there is no stricter per-record gate in Ignition today. Connects (gated
  `ignition_connects`) are left out of global search entirely.
- **Roster search inherits the `getRoster` limit-before-filter bug** (filed): until it's fixed, roster
  search only sees the 168 rows the page has. Fixing that bug first makes S5's Roster box complete.
- **Engagement search cost.** `searchAll` runs the two-read engagement search with `limit 5`; at 605
  rows that's fine. Watchboard: add trigram indexes when either table passes ~10k rows.

## 5. Regression checklist (smoke per slice)

- Global: ⌘K from 3 different pages; type a code, a deal no, a tracking id, a campaign name; pick
  each group; Esc / Esc; 375px sheet; a user without `ignition_connects` sees no Connects anywhere.
- `/engagements`: type → dropdown + list filters; Enter → list filtered, dropdown closed; reload →
  query and filters restored; ↑↓ list nav still works after closing the dropdown; paging past 200.
- `/influencers`: same; Load more; type cards still scope the list.
- Client-side boxes: each filters the visible rows and picks open the right record.
- Pickers: New deal (page + modal) picks an influencer; `?influencer=` preset still preselects;
  NewPaymentModal picks then loads the deals; Link deal links.
- Injection: a search for `a,b)` or `x)*` returns normal results (no error, no widened match).

## 6. Decisions for Afshaan before S1

1. **⌘/Ctrl+K → global search** (recommended; `/` keeps the page box), or keep ⌘K on the page box
   and open global search from the top-bar field only.
2. **Connects in global search:** leave out (recommended; needs a csops bridge search by name/phone
   — its own build), or include and accept that build.
3. **B-List and UGC boxes now** (2 rows each — recommended: not yet), or add them in S5 anyway for
   consistency (+~10k).
