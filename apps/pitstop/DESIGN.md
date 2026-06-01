---
name: Pitstop
description: Customer Success system for Legend of Toys
colors:
  bg: "#1f1f1f"
  surface: "#2a2a2a"
  surface-2: "#333333"
  surface-3: "#3c3c3c"
  border: "#404040"
  border-2: "#4a4a4a"
  text-1: "#f5f5f5"
  text-2: "#b0b0b0"
  text-3: "#888888"
  brand-yellow: "#F2CD1A"
  brand-yellow-deep: "#d4b200"
  brand-blue: "#213CE2"
  brand-red: "#DE2A2A"
  brand-green: "#22c55e"
  brand-orange: "#f97316"
  accent: "#F2CD1A"          # var(--accent) = brand-yellow
  accent-fg: "#0a0a0a"
  accent-bg: "rgba(242, 205, 26, 0.08)"   # nav-active, selected-row tint
typography:
  display:
    fontFamily: "Tomorrow, system-ui, sans-serif"   # var(--font-cond)
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "0.04em"
    textTransform: "uppercase"
  body:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"   # var(--font-mono)
    fontSize: "14px"
  mono: "JetBrains Mono, ui-monospace, Menlo, monospace"
radius:
  sm: "3px"    # chips, badges, inputs
  md: "4px"    # cards, panels, buttons
  lg: "8px"    # large panels, modals
  full: "9999px"
---

# Pitstop — Design System

> Pitstop shares the Legend of Toys dark base and motorsport type system with Garage / Redline / Ignition, tuned for a support context. The defining design job is **state legibility**: an agent must always know what state a ticket/call is in and what the next legal action is, without reading prose.

## Foundations

- **Base:** `--bg #1f1f1f` body; `--surface #2a2a2a` for cards/panels/sidebar/modals; `--surface-2 #333` for inputs, table-row hover, raised inner; `--surface-3 #3c3c3c` for active fills / neutral chips.
- **Text ramp (AA on `--bg`):** `--text-1 #f5f5f5` primary, `--text-2 #b0b0b0` secondary, `--text-3 #888` tertiary. Never go below `--text-3` for readable text.
- **Accent:** `--accent` = brand-yellow `#F2CD1A` on `--accent-fg #0a0a0a`; `--accent-bg` (8% yellow) tints the active nav item and the selected table row. Accent is for *primary action + active state only* — not decoration.
- **Aliases:** the older short tokens are kept for back-compat — `--t1/--t2/--t3` → text ramp, `--surface2/3`, `--yellow/--blue/--red/--green/--orange`, `--mono`, `--cond`. New code prefers the long names (`--text-1`, `--font-mono`).
- **Radii:** `--radius-sm 3px` (chips/badges/inputs), `--radius-md 4px` (cards/buttons), `--radius-lg 8px` (modals). **Fonts:** `--font-cond` (Tomorrow) for headings/numbers, `--font-mono` (JetBrains Mono) for everything else — Pitstop is a mono-first UI.

## Typography

- **Page title (H1):** Tomorrow 22px/700, `0.04em`, UPPERCASE, `--text-1`.
- **Section label / card header:** 11–12px, `0.06–0.08em`, UPPERCASE, `--text-3`, weight 600.
- **Body / table:** JetBrains Mono 13–14px, `--text-1`/`--text-2`.
- **Numbers (counts, money, KPIs):** Tomorrow, large, `--text-1`; the condensed face reads as "instrument cluster."

## Color semantics (status is the product)

Status is communicated through three disciplined badge families — never ad-hoc colors:

- **DispositionBadge** (`lib/dispositions.js` + `components/DispositionBadge.js`) — `pending` neutral, `query`/`no_action` muted, `awaiting_info` amber, `replacement`/`refund`/`repair` colored per branch. One source of truth shared with the worker's CHECK + `BRANCH_STAGES`.
- **Stage stepper** — renders only the legal path for the ticket's disposition; the current stage is accented, completed stages muted, future stages ghosted.
- **CallStatusBadge** (`components/CallStatusBadge.js`) — `answered` green, `missed` red, `abandoned`/`in_progress` muted.

Reserve `--brand-red` for genuinely negative/destructive (rejected, failed, delete), `--brand-green` for resolved/answered/paid, amber (`--brand-yellow`/`#fbbf24`) for "needs attention / awaiting."

## Components (shared `@throttle/ui`)

`Sidebar`, `Topbar` (with breadcrumb + dept switcher), `Panel`, `Modal` (Esc-close, `confirmLabel`/`onConfirm`/`loading`/`error`), `Toast` (`useToast` → `{ showToast }`/`toast`), `Spinner`, `EmptyState` (icon as string | element | component-ref — never raw component), `Chip`, `KpiCard`. Pitstop-local: `DispositionBadge`, `CallStatusBadge`, `DeptSwitcher`, `ShopifyPanel`.

- **Tables** are the primary surface — sticky `thead` on `--surface-2`, 1px `--border` row separators, row hover → `--surface-2`, selected/focused row → `--accent-bg` + a 2px accent outline (offset -2px).
- **Modals** are for quick-add / confirm only; anything multi-step gets its own route.

## Interaction patterns (Phase E — apply everywhere)

- **Esc** closes any modal/overlay (`useEscapeClose` / Modal built-in).
- **↑ / ↓ + Enter** navigates and opens list rows (`useListNav`); focused row shows the accent outline.
- **`/`** focuses the primary search input on any list (`useSearchShortcut`; input tagged `data-search-primary`).
- Surface mutation errors as a toast — never swallow to console (PATTERN-087 lesson).
- Static-export app: route params are query strings (`/queue/detail?ticket_no=…`), never path params.

## Layout

Sidebar (collapsible) + Topbar + scrollable `main` (`padding: 16px 24px`). Content max-width ~1100–1280 for readability; KPI/stat tiles use a `flex-wrap` row that stacks gracefully on narrow widths. Department switcher lives in the Topbar (admins only); non-admins see their locked department as static text.

## Accessibility / floor realities

- AA contrast minimum on `--bg`; status must never rely on color alone — every badge carries a text label.
- Headset-driven, fast-paced: the queue, claim, advance, and note actions are reachable without leaving the keyboard.
