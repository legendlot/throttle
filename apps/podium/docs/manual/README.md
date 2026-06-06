# Podium Operations Manual

The self-serve manual for [Podium](https://podium.legendoftoys.com), the LOT
people & performance system. The source lives inside the Podium app so the manual
versions with the code it documents.

The deliverable is **`Podium-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the Redline, Garage and Pitstop manuals:

```bash
cd 05_Throttle/apps/podium/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`emp` Employee, `mgr` Manager,
  `hr` HR, `adm` Admin) and the ordered parts -> chapters. Add/reorder chapters here.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling (LOT dark, role classes `emp`/`mgr`/`hr`/`adm`).
- `build.py` - shared build pipeline.

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and a `.glance`
strip, then sections and `.callout` boxes. Copy any existing chapter (for example
`content/people-profile.html`) to match the components.

Podium is the most privacy-sensitive LOT system, so describe visibility in human
terms (who can see what, and why), never in permission-key or table names. The
two Getting Started chapters on roles and visibility set the tone the rest follow.
