# Snorkel Operations Manual

The self-serve manual for [Snorkel](https://snorkel.legendoftoys.com), the LOT
procurement app (requests, purchase orders, vendors, payments, offline sales and
the asset register). The source lives inside the Snorkel app so the manual
versions with the code it documents.

The deliverable is **`Snorkel-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the Redline, Garage and Pitstop manuals:

```bash
cd 05_Throttle/apps/snorkel/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`req` Requester, `proc`
  Procurement, `appr` Approver, `fin` Finance, `adm` Admin) and the ordered
  parts -> chapters. Add/reorder chapters here.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling (LOT dark, role classes `req`/`proc`/`appr`/`fin`/`adm`).
- `build.py` - shared build pipeline.

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and a `.glance`
strip, then sections and `.callout` boxes. Copy any existing chapter (for example
`content/po-detail.html`) to match the components. Keep the language plain: no
database, permission-key or worker terms, describe behaviour the way the team
sees it.
