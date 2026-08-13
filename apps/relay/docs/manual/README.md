# Relay Operations Manual

Source for the Relay manual. Produces two outputs from one spine:

1. `Relay-Operations-Manual.pdf` — the committed PDF the Download button serves.
2. `apps/relay/src/data/manual.json` — the in-app **System Manual** tab.

## Editing

- `manual.json` is the spine: title, version, accent, roles, and the ordered
  parts → chapters.
- `content/*.html` holds one body-only fragment per chapter. `build.py` adds the
  title, breadcrumb, route chip and role badges.

## House style

- **No em dashes.** Use commas, colons, semicolons, periods or parentheses.
  Check with `grep -rn "&mdash;\|—" content/` before building (must return nothing).
- Plain language for someone with the screen open in front of them.
- Each chapter opens with a `lead` line and a four-cell `glance` strip.

## Building

```bash
cd apps/relay/docs/manual && python3 build.py                    # the PDF
python3 ../../../scripts/build-manual-web.py relay               # the in-app data + PDF copy
```

`build.py` self-bootstraps a local `.venv` on first run and needs Chrome/Chromium.

## Upkeep

When a Relay screen changes, update its chapter **in the same PR**, bump the version
in `manual.json`, add a `CHANGELOG.md` entry, and run **both** builds. Commit the
source, the regenerated PDF, `src/data/manual.json` and `public/manual/*.pdf` together.
CI only runs `next build`, so the generated files must be committed.

Manual content is not tracked as separate backlog items; it travels with the code.
