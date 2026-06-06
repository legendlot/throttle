# Docket Operations Manual

The self-serve manual for [Docket](https://docket.legendoftoys.com), the LOT
org-wide task manager. The source lives inside the Docket app so the manual
versions with the code it documents.

The deliverable is **`Docket-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the Redline, Garage and Pitstop manuals:

```bash
cd 05_Throttle/apps/docket/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`mem` Member, `view`
  Reviewer, `adm` Admin) and the ordered parts -> chapters. Add/reorder chapters here.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling (LOT dark, role classes `mem`/`view`/`adm`).
- `build.py` - shared build pipeline.

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and (for screen
chapters) a `.glance` strip, then sections and `.callout` boxes. Copy any existing
chapter (for example `content/task-list.html`) to match the components.

Plain language for a non-technical team: describe behaviour, not table/column or
permission-key names. The audited deadline, abandon-not-delete, the one-owner rule,
Spaces vs Programs and dashboard sharing are the load-bearing ideas to get right.
