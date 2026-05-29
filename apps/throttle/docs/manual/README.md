# Throttle Operations Manual

The self-serve manual for [Throttle](https://throttle.legendoftoys.com), the LOT
brand-team work OS. The source lives inside the Throttle app so the manual
versions with the code it documents.

The deliverable is **`Throttle-Operations-Manual.pdf`** (the build derives the
filename from the `manual.json` title).

Built with the same pipeline as the other LOT manuals:

```bash
cd 05_Throttle/apps/throttle/docs/manual
python3 build.py            # self-bootstraps a venv, renders the PDF with Chrome
python3 build.py --html     # also write manual.debug.html
```

## Structure

- `manual.json` - the spine: title, version, roles (`req` Requester, `mem`
  Member, `lead` Lead, `adm` Admin) and the ordered parts -> chapters.
- `content/*.html` - one fragment per chapter (body only; the build adds the
  title, breadcrumb and role badges).
- `assets/theme.css` - styling (LOT dark; role classes `req`/`mem`/`lead`/`adm`).
- `build.py` - shared build pipeline.

## House style

No em dashes in copy (commas, colons, semicolons, periods, parentheses). En dashes
are fine in ranges. Each chapter opens with a `<p class="lead">` and a `.glance`
strip, then sections and `.callout` boxes. Copy any existing chapter (for example
`content/task-board.html`) to match the components.
