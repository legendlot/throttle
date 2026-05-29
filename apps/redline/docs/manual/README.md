# Redline Operations Manual

The self-serve manual for [Redline](https://redline.legendoftoys.com), the LOT
production-floor app. The source lives **inside the Redline app** so the manual
versions and travels with the code it documents — when a screen changes, its
chapter is updated in the same place, ideally the same commit.

The deliverable is **`Redline-Operations-Manual.pdf`** — share that with the team.

---

## Building the PDF

```bash
cd 05_Throttle/apps/redline/docs/manual
python3 build.py
```

That's it. On first run the script creates a local `.venv` and installs its two
dependencies (`pypdf`, `reportlab`) automatically — no manual setup. It renders
the HTML with headless **Google Chrome** (already on the build machine), so Chrome
or Chromium must be installed.

- `python3 build.py` → writes `Redline-Operations-Manual.pdf`
- `python3 build.py --html` → also writes `manual.debug.html` (the full assembled
  HTML) for quick styling checks in a browser without re-rendering the PDF.

The build is a two-pass render: pass 1 measures which page each chapter lands on,
pass 2 stamps those page numbers into the table of contents and adds PDF bookmarks.

---

## How it's put together

```
docs/manual/
├── manual.json      ← the spine: title, version, date, roles, and the ordered
│                       list of parts → chapters. EDIT THIS to add/reorder chapters.
├── content/         ← one HTML fragment per fully-written chapter (body only —
│                       the build adds the title, breadcrumb, route chip + role badges).
├── assets/
│   └── theme.css    ← all styling. Brand-matched to Redline. Edit here.
├── build.py         ← the build pipeline (self-bootstrapping venv).
├── CHANGELOG.md     ← record every change here; bump the version.
└── Redline-Operations-Manual.pdf   ← generated output (committed, so the team
                                       always has the latest without building).
```

### Adding or editing a chapter

1. **Edit a chapter:** open its file in `content/` and edit the HTML. Re-build.
2. **Fill in a stub:** in `manual.json`, find the chapter and add a `"file"` key
   pointing to a new fragment in `content/` (e.g. `"file": "prod-hourly.html"`),
   then write that fragment. Without a `"file"`, the chapter renders as a styled
   "Documentation in progress" stub from its `"summary"`.
3. **Add a brand-new chapter:** add an entry to the right part's `chapters` array
   in `manual.json` (`id`, `title`, `route`, `roles`, and either `file` or `summary`).
4. **Re-order:** just move entries within `manual.json`. The TOC, bookmarks and
   page numbers all follow automatically.

### Writing style & components

Chapter fragments are plain HTML using the classes defined in `theme.css`. The
fastest way to learn them is to copy from `content/prod-qc.html` or
`content/disp-pipeline.html` — they exercise every component:

- `<p class="lead">` — the opening summary line under the title.
- `<h2 class="sec">` / `<h3 class="sub">` — section / sub-section headings.
- `.glance` — the 4-cell "at a glance" strip.
- `.callout note|tip|warn|danger|floor` — coloured callout boxes.
- `.anatomy` (key/val rows) and `table.tbl` — field references and tables.
- `<ol class="steps">` — the big numbered step list.
- `<span class="role op|sup|dis|adm">` — inline role badges.

**Roles** are defined once in `manual.json` (`op`, `sup`, `dis`, `adm`) and a
chapter's `"roles"` array drives the badges shown on its title and in the
"who uses it" line.

---

## Versioning

The manual is versioned by hand. Three places must always agree: `manual.json`
`version`, the top entry in `CHANGELOG.md`, and (after a build) the cover + footer.

- **Patch** (`0.1.0 → 0.1.1`): typo/wording fixes, small clarifications.
- **Minor** (`0.1.0 → 0.2.0`): a stub filled in, a chapter substantially rewritten,
  a new chapter added.
- **Major** (`0.x → 1.0.0`): every chapter written out — the first complete manual.

On any change: edit content → bump `version` in `manual.json` → add a `CHANGELOG.md`
entry → `python3 build.py` → commit the source **and** the regenerated PDF.

## Keeping it synced with the system

Because this folder lives in the Redline app, treat the manual like code:

- When you change a Redline screen, update its chapter in the same PR.
- Re-build and commit the PDF so the shared copy is never stale.
- The `CHANGELOG.md` is the running record of what the team's manual now covers.
