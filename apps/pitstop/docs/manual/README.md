# Pitstop Operations Manual

The self-serve manual for [Pitstop](https://pitstop.legendoftoys.com), the LOT
customer-support app. The source lives inside the Pitstop app so the manual
versions with the code it documents.

The deliverable is **`Pitstop-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the Redline and Garage manuals:

```bash
cd 05_Throttle/apps/pitstop/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`agt` Agent, `lead` Lead,
  `adm` Admin) and the ordered parts -> chapters. Add/reorder chapters here.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling (LOT dark, role classes `agt`/`lead`/`adm`).
- `build.py` - shared build pipeline.

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and a `.glance`
strip, then sections and `.callout` boxes. Copy any existing chapter (for example
`content/work-ticket.html`) to match the components.
