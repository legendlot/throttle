# App Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google-Workspace-style "waffle" app launcher to the header of nine LOT apps, opening a grid of links to the other systems for one-click cross-system navigation.

**Architecture:** One new additive shared component (`packages/ui/AppLauncher.js`), exported from `packages/ui/index.js`, dropped into the right-hand cluster of each app's existing header. The menu list (8 systems) is hardcoded in the component. Tiles link to each system's `*.legendoftoys.com` subdomain, opening in a new tab, with each system's live favicon and a colored-monogram fallback. No worker, DB, schema, or permission changes.

**Tech Stack:** Next.js (static export) · React client components · plain inline styles themed via CSS variables. No test framework exists in this monorepo, so verification is `npx turbo build` (zero errors) plus a browser smoke check.

**Reference spec:** `docs/superpowers/specs/2026-06-17-app-launcher-design.md`

**Confirmed decisions:**
- Hosts (button appears on): garage, redline, depot, snorkel, ignition, docket, podium, pitstop, throttle (9). Not manifest.
- Menu (links): garage, redline, depot, snorkel, ignition, docket, pitstop, throttle (8). NOT podium, NOT manifest.
- Current app tile is highlighted but still clickable.
- Links open in a **new tab**.
- Icons linked live per subdomain (`/favicon.png`) with monogram fallback.

---

## File Structure

- **Create:** `packages/ui/AppLauncher.js` — the entire launcher (button + dropdown + tiles + monogram fallback). Self-contained, one responsibility.
- **Modify:** `packages/ui/index.js` — add the export.
- **Modify (host integration, one line + one import each):**
  - `apps/garage/src/components/shell/GarageTopbar.js`
  - `apps/redline/src/components/kit/RedlineTopbar.js`
  - `apps/depot/src/components/kit/DepotTopbar.js`
  - `apps/docket/src/components/DocketTopbar.js`
  - `apps/podium/src/components/PodiumTopbar.js`
  - `apps/snorkel/src/components/chrome/ContextBar.js`
  - `apps/ignition/src/app/(auth)/layout.js`
  - `apps/pitstop/src/app/(auth)/layout.js`
  - `apps/throttle/src/components/throttle/Shell.js`

All 9 apps already depend on `@throttle/ui` — no `package.json` changes.

---

### Task 1: Create the shared `AppLauncher` component

**Files:**
- Create: `packages/ui/AppLauncher.js`
- Modify: `packages/ui/index.js`

- [ ] **Step 1: Write `packages/ui/AppLauncher.js`**

Create the file with exactly this content:

```jsx
'use client';
import { useState, useEffect, useRef } from 'react';

// The cross-system launcher menu. Hardcoded list = the single source of truth.
// Podium and Manifest are intentionally NOT in this list.
const SYSTEMS = [
  { key: 'garage',   label: 'Garage',   url: 'https://garage.legendoftoys.com',   mono: 'GA', tint: '#f2cd1a' },
  { key: 'redline',  label: 'Redline',  url: 'https://redline.legendoftoys.com',  mono: 'RL', tint: '#e5484d' },
  { key: 'depot',    label: 'Depot',    url: 'https://depot.legendoftoys.com',    mono: 'DP', tint: '#3b82f6' },
  { key: 'snorkel',  label: 'Snorkel',  url: 'https://snorkel.legendoftoys.com',  mono: 'SN', tint: '#0ea5e9' },
  { key: 'ignition', label: 'Ignition', url: 'https://ignition.legendoftoys.com', mono: 'IG', tint: '#f97316' },
  { key: 'docket',   label: 'Docket',   url: 'https://docket.legendoftoys.com',   mono: 'DK', tint: '#8b5cf6' },
  { key: 'pitstop',  label: 'Pitstop',  url: 'https://pitstop.legendoftoys.com',  mono: 'PS', tint: '#10b981' },
  { key: 'throttle', label: 'Throttle', url: 'https://throttle.legendoftoys.com', mono: 'TH', tint: '#eab308' },
];

function WaffleIcon({ size = 18 }) {
  const d = size / 8;          // dot diameter
  const positions = [0, 1, 2];
  const dots = [];
  for (const r of positions) for (const c of positions) {
    dots.push(
      <circle key={`${r}-${c}`} cx={c * (size / 2.5) + d} cy={r * (size / 2.5) + d} r={d} fill="currentColor" />
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {dots}
    </svg>
  );
}

function Tile({ sys, current }) {
  const [failed, setFailed] = useState(false);
  const isCurrent = sys.key === current;
  return (
    <a
      href={sys.url}
      target="_blank"
      rel="noopener noreferrer"
      title={isCurrent ? `${sys.label} (current)` : sys.label}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
        padding: '12px 6px', borderRadius: 10, textDecoration: 'none',
        background: isCurrent ? 'var(--accent, var(--yellow, rgba(242,205,26,0.12)))' : 'transparent',
        outline: isCurrent ? '1px solid var(--accent, var(--yellow, #f2cd1a))' : '1px solid transparent',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--surface-2, rgba(255,255,255,0.05))'; }}
      onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{
        width: 40, height: 40, borderRadius: 9, display: 'grid', placeItems: 'center',
        overflow: 'hidden', flexShrink: 0,
        background: failed ? sys.tint : 'transparent',
      }}>
        {failed ? (
          <span style={{
            fontFamily: 'var(--mono, var(--font-mono, monospace))', fontSize: 13, fontWeight: 700,
            color: '#16140b', letterSpacing: '0.02em',
          }}>{sys.mono}</span>
        ) : (
          <img
            src={`${sys.url}/favicon.png`}
            alt=""
            width={36}
            height={36}
            onError={() => setFailed(true)}
            style={{ width: 36, height: 36, objectFit: 'contain', display: 'block', borderRadius: 7 }}
          />
        )}
      </span>
      <span style={{
        fontSize: 12, fontWeight: isCurrent ? 700 : 500,
        color: isCurrent ? 'var(--t1, #fff)' : 'var(--t2, #c7ccd4)',
        whiteSpace: 'nowrap',
      }}>{sys.label}</span>
    </a>
  );
}

export function AppLauncher({ current }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Open app launcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: open ? 'var(--surface-2, rgba(255,255,255,0.06))' : 'var(--surface, transparent)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: 'var(--r-sm, 8px)',
          color: 'var(--t2, #c7ccd4)', cursor: 'pointer', flexShrink: 0,
        }}
      >
        <WaffleIcon />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 400,
            width: 300, padding: 12,
            background: 'var(--surface, var(--bg, #15171c))',
            border: '1px solid var(--border, rgba(255,255,255,0.12))',
            borderRadius: 'var(--r-lg, 14px)',
            boxShadow: 'var(--shadow-pop, 0 12px 40px rgba(0,0,0,0.45))',
          }}
        >
          <div style={{
            fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--t3, #8a909a)', padding: '2px 4px 10px',
            fontFamily: 'var(--mono, var(--font-mono, inherit))',
          }}>Switch system</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
            {SYSTEMS.map((s) => <Tile key={s.key} sys={s} current={current} />)}
          </div>
        </div>
      )}
    </div>
  );
}

export default AppLauncher;
```

- [ ] **Step 2: Add the export to `packages/ui/index.js`**

Append this line after the existing exports (e.g. after the `ProductTag` line):

```js
export { AppLauncher } from './AppLauncher.js';
```

- [ ] **Step 3: Verify the package builds (typecheck via a consuming app build)**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=garage`
Expected: build succeeds with zero errors (Garage doesn't render AppLauncher yet, but the new file + export must compile when bundled).

- [ ] **Step 4: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add packages/ui/AppLauncher.js packages/ui/index.js
git commit -m "feat(ui): add shared AppLauncher (cross-system waffle menu)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Integrate into the five app-specific topbars

**Files:**
- Modify: `apps/garage/src/components/shell/GarageTopbar.js`
- Modify: `apps/redline/src/components/kit/RedlineTopbar.js`
- Modify: `apps/depot/src/components/kit/DepotTopbar.js`
- Modify: `apps/docket/src/components/DocketTopbar.js`
- Modify: `apps/podium/src/components/PodiumTopbar.js`

- [ ] **Step 1: Garage — add import**

In `apps/garage/src/components/shell/GarageTopbar.js`, after line 3 (`import { groupLabelForRoute, ... }`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 2: Garage — render the launcher (rightmost item)**

In the same file, immediately AFTER the `Live` indicator `<span>` block (the one containing `g-pulse`) and BEFORE the closing `</header>`, insert:

```jsx
      <AppLauncher current="garage" />
```

- [ ] **Step 3: Redline — add import**

In `apps/redline/src/components/kit/RedlineTopbar.js`, after line 9 (`import { resolveNav } from '../../lib/nav.js';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 4: Redline — render the launcher**

Inside the right-cluster `<div style={{ marginLeft: 'auto', ... }}>`, after the `Live`/`Sync` `<span>` block and before that `</div>`, insert:

```jsx
        <AppLauncher current="redline" />
```

- [ ] **Step 5: Depot — add import**

In `apps/depot/src/components/kit/DepotTopbar.js`, after line 9 (`import { resolveNav } from '../../lib/nav.js';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 6: Depot — render the launcher**

Inside the right-cluster `<div style={{ marginLeft: 'auto', ... }}>`, after the `Live`/`Sync` `<span>` block and before that `</div>`, insert:

```jsx
        <AppLauncher current="depot" />
```

- [ ] **Step 7: Docket — add import**

In `apps/docket/src/components/DocketTopbar.js`, after line 5 (`import { PanelLeft, Lock } from 'lucide-react';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 8: Docket — render the launcher**

Immediately after the `<span className="tb-live">...</span>` line and before `</div>`, insert:

```jsx
      <AppLauncher current="docket" />
```

- [ ] **Step 9: Podium — add import**

In `apps/podium/src/components/PodiumTopbar.js`, after line 5 (`import { Avatar } from './ui.js';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 10: Podium — render the launcher**

Immediately AFTER the `<Avatar ... />` line and before the closing `</div>`, insert (Podium is a host but NOT a menu entry, so nothing will highlight):

```jsx
      <AppLauncher current="podium" />
```

- [ ] **Step 11: Build the four monorepo-specific apps that changed**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=garage --filter=redline --filter=depot --filter=docket --filter=podium`
Expected: all five builds succeed with zero errors.

- [ ] **Step 12: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add apps/garage/src/components/shell/GarageTopbar.js \
        apps/redline/src/components/kit/RedlineTopbar.js \
        apps/depot/src/components/kit/DepotTopbar.js \
        apps/docket/src/components/DocketTopbar.js \
        apps/podium/src/components/PodiumTopbar.js
git commit -m "feat: mount AppLauncher in garage/redline/depot/docket/podium headers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Integrate into the shared-Topbar apps, Snorkel, and Throttle

**Files:**
- Modify: `apps/ignition/src/app/(auth)/layout.js`
- Modify: `apps/pitstop/src/app/(auth)/layout.js`
- Modify: `apps/snorkel/src/components/chrome/ContextBar.js`
- Modify: `apps/throttle/src/components/throttle/Shell.js`

- [ ] **Step 1: Ignition — add import**

In `apps/ignition/src/app/(auth)/layout.js`, on line 5, add `AppLauncher` to the existing `@throttle/ui` import:

```js
import { Sidebar, Spinner, Topbar, useSearchShortcut, AppLauncher } from '@throttle/ui';
```

- [ ] **Step 2: Ignition — pass the launcher as a Topbar child**

The shared `Topbar` renders `{children}` in its right cluster. Change the self-closing `<Topbar ... />` to wrap a child. Replace:

```jsx
        <Topbar
          navGroups={navGroups}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
          refreshing={refreshing}
          lastRefreshed={lastRefreshed}
        />
```

with:

```jsx
        <Topbar
          navGroups={navGroups}
          pathname={pathname}
          onTabSelect={(item) => router.push(item.route)}
          refreshing={refreshing}
          lastRefreshed={lastRefreshed}
        >
          <AppLauncher current="ignition" />
        </Topbar>
```

- [ ] **Step 3: Pitstop — add import**

In `apps/pitstop/src/app/(auth)/layout.js`, on line 5, add `AppLauncher` to the existing `@throttle/ui` import:

```js
import { Sidebar, Spinner, Topbar, useSearchShortcut, AppLauncher } from '@throttle/ui';
```

- [ ] **Step 4: Pitstop — add the launcher beside the existing DeptSwitcher child**

Replace:

```jsx
        >
          <DeptSwitcher />
        </Topbar>
```

with:

```jsx
        >
          <AppLauncher current="pitstop" />
          <DeptSwitcher />
        </Topbar>
```

- [ ] **Step 5: Snorkel — add import**

In `apps/snorkel/src/components/chrome/ContextBar.js`, after line 4 (`import { matchActive } from './navMatch.js';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 6: Snorkel — render the launcher**

The `ContextBar` ends with `<span className="tb-live">...</span>` then `</div>`. The live dot sits at the far right via the `.cb` layout. Insert the launcher immediately after the `tb-live` span and before `</div>`:

```jsx
      <AppLauncher current="snorkel" />
```

(If on the floor the launcher needs visual separation from the LIVE dot, add `style={{ marginLeft: 12 }}` to the `<AppLauncher>` wrapper — verify during smoke. The `.cb` flexbox pushes `tb-live` right; the launcher will sit just right of it.)

- [ ] **Step 7: Throttle — add import**

In `apps/throttle/src/components/throttle/Shell.js`, after line 7 (`import { MANUAL, TASKS, taskTag } from '@/lib/throttleData';`), add:

```js
import { AppLauncher } from '@throttle/ui';
```

- [ ] **Step 8: Throttle — render the launcher in its local Topbar (rightmost)**

In the `Topbar` function (around line 139–175), immediately AFTER the `Live` indicator `<span>` block (the one ending `...>Live</span>`) and BEFORE the closing `</header>`, insert:

```jsx
      <AppLauncher current="throttle" />
```

- [ ] **Step 9: Build the four apps that changed**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=ignition --filter=pitstop --filter=snorkel --filter=throttle`
Expected: all four builds succeed with zero errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add apps/ignition/src/app/\(auth\)/layout.js \
        apps/pitstop/src/app/\(auth\)/layout.js \
        apps/snorkel/src/components/chrome/ContextBar.js \
        apps/throttle/src/components/throttle/Shell.js
git commit -m "feat: mount AppLauncher in ignition/pitstop/snorkel/throttle headers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full build verification, browser smoke, knowledge files, push

**Files:**
- Modify: `CORE.md` (workspace root) — note the new shared component.

- [ ] **Step 1: Build all apps together**

Run: `cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build`
Expected: every app builds with zero errors. (This is the real guard — a `packages/ui` change rebuilds all consumers.)

- [ ] **Step 2: Browser smoke on two representative apps**

Use the preview tooling (`preview_start` → `preview_snapshot`/`preview_screenshot`) or a local `npx turbo dev --filter=garage`:
- **Garage** (app-specific topbar): waffle button shows top-right; click opens the 8-tile grid; the Garage tile is highlighted; favicons render (Throttle tile shows the `TH` monogram); clicking a tile opens that system in a new tab; Escape and outside-click close the menu.
- **Ignition** (shared Topbar): same checks; the Ignition tile is highlighted.
- Confirm on **Podium** that the launcher appears and NO tile is highlighted (Podium isn't in the list), and there is no Podium tile.

Fix any layout issues (e.g. spacing next to the Live dot) in the relevant header file, rebuild that app, and re-smoke.

- [ ] **Step 3: Update CORE.md**

In `/Users/afshaansiddiqui/Documents/Claude/CORE.md`, under "Shared monorepo packages (`05_Throttle/packages/`)", add `AppLauncher` to the `ui` component list, e.g. change `ui` (Sidebar, Modal, Topbar, Toast, **`Manual`**, ...) to also list **`AppLauncher`** with a short note: "cross-system waffle launcher — 8-system menu (excludes Podium + Manifest), hosted on all 9 internal apps". Bump the file's `Last updated` line.

- [ ] **Step 4: Commit the knowledge-file update and push everything**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add CORE.md
git commit -m "docs(core): note shared AppLauncher component (session 151)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C 05_Throttle push
git push
```

- [ ] **Step 5: Confirm clean state**

Run: `cd /Users/afshaansiddiqui/Documents/Claude && git status && git -C 05_Throttle status`
Expected: both clean and in sync with their remotes. All 9 apps auto-deploy from `05_Throttle` `main` via GitHub Actions (~3–4 min). No worker deploy needed.

---

## Notes for the implementer

- **No worker / DB / schema / permission changes.** This is frontend-only. Do not deploy any worker.
- **Theming:** every style uses `var(--…)` with a sensible dark fallback so the launcher adopts each app's palette. Don't hardcode brand colors except the per-system monogram `tint` (intrinsic to the destination).
- **Cross-origin favicons** are expected (each tile fetches from a different subdomain). The `onError` monogram fallback covers Throttle (no favicon) and any transient failure.
- **`(auth)` paths** contain literal parentheses — keep them escaped in `git add` as shown.
- If a smoke check reveals the dropdown overflows a narrow header, the panel is right-anchored (`right: 0`) so it grows leftward — acceptable; only adjust if it clips off-screen.
