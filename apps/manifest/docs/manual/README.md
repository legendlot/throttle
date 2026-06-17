# Manifest Operations Manual

The self-serve system + process manual for **Manifest** (LOT ↔ Solve Factory China-import OS).
One source, two outputs: a downloadable **PDF** and the in-app **System Manual** tab.

## Layout

```
docs/manual/
├── manual.json        spine: title, version, accent, roles, ordered parts → chapters
├── content/*.html     one body-only HTML fragment per chapter
├── assets/theme.css   shared print theme (rarely edited)
├── build.py           PDF build (self-bootstrapping venv + headless Chrome)
├── README.md          this file
├── CHANGELOG.md       version history
└── Manifest-Operations-Manual.pdf   the committed PDF the team opens
```

## Editing

- Reword / fix a chapter: edit its `content/*.html`.
- Add a chapter: add a fragment in `content/` and a chapter entry in `manual.json`.
- Reorder / re-part: move entries in `manual.json` (TOC, bookmarks, page numbers follow).
- Retheme: set `accent` in `manual.json` (no theme.css edits needed).
- House style: **no em dashes** in copy. Verify with `grep -rn "—" content/`.

## Building (two steps — Manifest has an in-app manual too)

```bash
# 1) PDF
cd 05_Throttle/apps/manifest/docs/manual && python3 build.py

# 2) in-app data + PDF copy (run from repo root)
cd 05_Throttle && python3 scripts/build-manual-web.py manifest
```

Step 2 regenerates `apps/manifest/src/data/manual.json` and copies the PDF into
`apps/manifest/public/manual/`. **CI only runs `next build`, so commit the source, the
regenerated `src/data/manual.json`, and the PDF copies together.**

## In-app

The manual renders inside Manifest at the **System Manual** sidebar item (a `manual` screen in
the Pit Wall SPA, `src/mf/`), using the shared `@throttle/ui` `Manual` viewer and the generated
`src/data/manual.json`, with a Download-PDF button that serves `public/manual/`.

Upkeep is in-system: when a screen changes, update its chapter in the same PR and rebuild both
outputs. Do not track manual content as separate backlog items.
