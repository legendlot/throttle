# App Launcher — cross-system navigation waffle

> Design doc · 2026-06-17 · Session 151
> A Google-Workspace-style "waffle" button placed in the header of nine LOT apps,
> opening a grid of links to the other systems for one-click cross-system access.

## Goal

Make jumping between LOT systems easy. Today each system lives on its own
`*.legendoftoys.com` subdomain with no in-app link to the others. Add a single,
consistent launcher button (top-right of the header) that drops down a grid of the
other systems.

## Requirement (confirmed with Afshaan)

- **Host apps (button appears on):** Garage, Redline, Depot, Snorkel, Ignition,
  Docket, Podium, Pitstop, Throttle — **9 apps**. Manifest is excluded.
- **Menu contents (links inside the dropdown):** Garage, Redline, Depot, Snorkel,
  Ignition, Docket, Pitstop, Throttle — **8 systems**. **Podium and Manifest are NOT
  in the menu.**
  - Consequence (intended): from Podium you can reach the 8 others, but none of the
    8 link back to Podium — the confidential People/HR system stays off the launcher
    while Podium users still get the convenience.
- **Current app:** shown in the menu and **highlighted** ("you are here"), but still
  clickable. On Podium nothing highlights (it isn't in the list).
- **Tile style:** 3-across **icon grid**, each tile = the system's live favicon +
  name, mirroring the Google Workspace waffle.
- **Icons:** linked from each system's production favicon (`https://<app>.legendoftoys.com/favicon.png`),
  with a **colored-monogram fallback** on image-load error.
- **Navigation:** links open in a **new tab** (`target="_blank"`).

## Non-goals

- No worker, database, schema, or permission changes. The launcher is pure
  client-side navigation; each destination enforces its own auth on landing.
- Not added to Manifest (external-facing SF system) or to the public floor Scanner.
- No per-user customization, ordering, or favorites in v1 — a fixed list.

## Architecture

### New shared component: `packages/ui/AppLauncher.js`

Additive — a brand-new file, exported from `packages/ui/index.js`. No existing shared
component is modified (consistent with the "additive-only shared changes" rule;
`packages/ui` feeds all monorepo apps).

**Props**
- `current` (string, optional) — the host app's key (e.g. `'garage'`). Used only to
  highlight the matching tile. A value not in the list (e.g. `'podium'`) highlights
  nothing.

**Internal data — hardcoded `SYSTEMS` array** (the single source of truth for the
menu), in display order:

| key | label | url | accent (fallback monogram bg) |
|---|---|---|---|
| garage | Garage | https://garage.legendoftoys.com | (per-system color) |
| redline | Redline | https://redline.legendoftoys.com | |
| depot | Depot | https://depot.legendoftoys.com | |
| snorkel | Snorkel | https://snorkel.legendoftoys.com | |
| ignition | Ignition | https://ignition.legendoftoys.com | |
| docket | Docket | https://docket.legendoftoys.com | |
| pitstop | Pitstop | https://pitstop.legendoftoys.com | |
| throttle | Throttle | https://throttle.legendoftoys.com | |

Each entry also carries a 1–2 letter monogram (e.g. `GA`, `RL`, `DP`, `SN`, `IG`,
`DK`, `PS`, `TH`) for the fallback.

**Render**
- A button showing a 3×3 dot grid (waffle) glyph, `aria-label="Open app launcher"`,
  `aria-expanded={open}`. Sized to sit inline in a 56px header row.
- On click → toggles a dropdown `<div>` panel, anchored to the top-right under the
  button (absolute-positioned; the button wraps in a `position: relative` span).
- Panel: an optional small header label ("Switch system"), then a CSS-grid
  (`grid-template-columns: repeat(3, 1fr)`) of tiles.
- **Tile** = `<a href={url} target="_blank" rel="noopener noreferrer">` containing:
  - an `<img src={`${url}/favicon.png`} onError={…}>` (≈32–36px); on error, swap to a
    colored rounded square showing the monogram (state per-tile, or render the
    fallback element and hide the img).
  - the system label beneath.
  - When `key === current`: an accent ring/background (`--accent`) + a subtle "current"
    treatment; remains a working link.
- Close behaviors: outside-click (document mousedown listener while open) and Escape.

**Theming** — all colors via CSS variables already defined in every app
(`--surface`, `--border`, `--t1`, `--t2`, `--accent`, `--mono`), so the launcher
adopts each system's palette. Mirrors the shared `Manual.js` pattern. No hardcoded
brand colors except the per-system monogram fallback backgrounds (which are
intrinsic to each destination, not the host).

### Host integration

Drop `<AppLauncher current="<app>" />` into the **right-hand cluster** of each app's
header, positioned to the left of the existing refresh/Live/profile controls (matching
the screenshot, where the waffle sits left of the profile avatar).

| App | File | Mechanism |
|---|---|---|
| Garage | `apps/garage/src/components/shell/GarageTopbar.js` | insert in right cluster |
| Redline | `apps/redline/src/components/kit/RedlineTopbar.js` | insert in right cluster |
| Depot | `apps/depot/src/components/kit/DepotTopbar.js` | insert in right cluster |
| Docket | `apps/docket/src/components/DocketTopbar.js` | insert in right cluster |
| Podium | `apps/podium/src/components/PodiumTopbar.js` | insert in right cluster (`current="podium"`) |
| Snorkel | `apps/snorkel/src/components/chrome/ContextBar.js` | insert in right cluster |
| Ignition | `apps/ignition/src/app/(auth)/layout.js` | pass as a child of the shared `<Topbar>` (Topbar renders `{children}` in its right cluster) |
| Pitstop | `apps/pitstop/src/app/(auth)/layout.js` | pass as a child of the shared `<Topbar>` |
| Throttle | `apps/throttle/src/components/throttle/Shell.js` | insert in the top-nav right side |

For each app-specific topbar, the exact insertion point is its existing
`marginLeft: auto` right group; for the shared `Topbar`, the `children` slot already
renders there. Throttle's shell has its own top nav — insert alongside its existing
right-side controls.

## Data flow

Trivial and entirely client-side: static `SYSTEMS` array → click toggles local
`open` state → dropdown renders anchor tiles → browser navigates (new tab) on click.
Favicon `<img>` fetches cross-origin from each destination subdomain; failure path
renders the monogram. No fetch to any worker.

## Error handling

- **Favicon fails to load** (404 / offline / Throttle has none): `onError` swaps the
  tile's image for the colored monogram square. The tile still links correctly.
- **Outside click / Escape:** closes the dropdown.

## Testing / verification

- `npx turbo build` for every affected app — a `packages/ui` change rebuilds all
  monorepo apps; require zero errors across the 9 hosts (plus any other consumers).
- Local preview smoke on at least one app-specific-topbar app (e.g. Garage) and one
  shared-Topbar app (e.g. Ignition): button renders top-right, dropdown opens, tiles
  show favicons (monogram fallback for Throttle), current tile highlighted, links open
  in a new tab, Escape/outside-click close.
- No worker deploy; no DB/schema migration.

## Rollout

Single PR / commit set to `legendlot/throttle` (`05_Throttle`). All 9 apps auto-deploy
on push to `main` via GitHub Actions. No worker or schema step. Knowledge-file update:
note the new shared `AppLauncher` component under CORE.md "Shared monorepo packages".
