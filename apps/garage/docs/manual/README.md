# Garage Operations Manual

The self-serve manual for [Garage](https://garage.legendoftoys.com), the LOT
store, inventory, production and procurement app. The source lives inside the
Garage app so the manual versions and travels with the code it documents: when a
screen changes, its chapter is updated in the same place, ideally the same commit.

The deliverable is **`Garage-Operations-Manual.pdf`** (note: `build.py` names the
output `Redline-Operations-Manual.pdf` by default; see "Output name" below).

This manual is built with the exact same pipeline as the Redline manual
(`apps/redline/docs/manual/`); see that README for the full architecture. The
short version:

```bash
cd 05_Throttle/apps/garage/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html for quick styling checks
```

## Structure

- `manual.json` - the spine: title, version, date, roles (`sto` Store, `prd`
  Production, `prc` Procurement, `adm` Admin), and the ordered parts -> chapters.
  Add/reorder chapters here.
- `content/*.html` - one HTML fragment per chapter (body only; the build adds the
  title, breadcrumb, route chip and role badges).
- `assets/theme.css` - all styling (brand-matched to Garage/Redline; role classes
  are `sto`/`prd`/`prc`/`adm`).
- `build.py` - the build pipeline (shared with Redline).
- `CHANGELOG.md` - record every change here and bump the version.

## House style

- No em dashes in copy: use commas, colons, semicolons, periods or parentheses.
- En dashes are fine in numeric ranges (e.g. `1-10,000`, `L1-L3`).
- Each chapter opens with a `<p class="lead">` and a `.glance` strip, then sections,
  with `.callout` boxes for tips, warnings and important notes. Copy from any
  existing chapter (for example `content/inv-receiving.html`) to learn the components.

## Output name

`build.py` is shared verbatim with Redline and writes
`Redline-Operations-Manual.pdf`. For Garage, rename the produced file to
`Garage-Operations-Manual.pdf` before sharing, or adjust the `out_pdf` line in a
Garage-specific copy of `build.py` if the two manuals later diverge. The cover,
title and footer all read "Garage" correctly from `manual.json`.

## Versioning

Three places must always agree: `manual.json` `version`, the top entry in
`CHANGELOG.md`, and the cover/footer after a build. Patch = wording fixes; minor =
a chapter added or substantially rewritten; major = the first complete manual.
On any change: edit content -> bump version -> add a changelog entry ->
`python3 build.py` -> commit the source and the regenerated PDF.
