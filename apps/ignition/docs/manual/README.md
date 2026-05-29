# Ignition Operations Manual

The self-serve manual for [Ignition](https://ignition.legendoftoys.com), the LOT
influencer-marketing CRM. The source lives inside the Ignition app so the manual
versions with the code it documents.

The deliverable is **`Ignition-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the other LOT manuals:

```bash
cd 05_Throttle/apps/ignition/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`mkt` Marketer, `lead` Lead,
  `adm` Admin) and the ordered parts -> chapters. Add/reorder chapters here.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling. This copy is rethemed to Ignition's orange
  identity (`--ignition-orange: #FF6B00` drives the cover/divider/accent); role
  classes are `mkt`/`lead`/`adm`.
- `build.py` - shared build pipeline (footer accent set to orange).

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and a `.glance`
strip, then sections and `.callout` boxes. Several Ignition screens are Phase-B
placeholders today; document them as view-only, not as finished tools.
