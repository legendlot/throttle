# Depot Operations Manual

Self-serve operations manual for **Depot** (the dispatch back-office app). Single source of
truth for both outputs: the committed PDF and the in-app **System Manual** tab.

## Edit

- **Spine:** `manual.json` (title, version, accent, roles, ordered parts -> chapters).
- **Chapters:** `content/*.html` (body-only HTML fragments; the build adds the title,
  breadcrumb and role badges). One fragment per screen.
- **Theme:** `assets/theme.css` (shared print theme; rarely edited; accent comes from `manual.json`).

House style: plain language for a non-technical reader with the screen open; **no em dashes**
in copy (commas/colons/semicolons/periods/parentheses; an em dash is allowed only when it names
the dash glyph shown on screen). Each chapter: a `.lead` line, a 4-cell `.glance` strip,
sections, and a few callouts.

## Build (two outputs)

```bash
# 1) PDF
cd 05_Throttle/apps/depot/docs/manual && python3 build.py
# 2) in-app data + PDF copy (run from the monorepo root)
cd 05_Throttle && python3 scripts/build-manual-web.py depot
```

`build.py` self-bootstraps a local `.venv` (pypdf + reportlab) and needs Chrome/Chromium.
`build-manual-web.py depot` regenerates `apps/depot/src/data/manual.json` and copies the PDF
into `apps/depot/public/manual/`. **CI only runs `next build`, so commit the generated
`src/data/manual.json` and `public/manual/*.pdf` along with the source.**

## Upkeep

When a Depot screen changes, update its chapter here in the same PR and rebuild both outputs.
The manual travels with the code it documents; it is not tracked as a separate backlog task.
