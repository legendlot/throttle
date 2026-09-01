# Odo Operations Manual

Source for the Odo manual: the PDF the team downloads, and the in-app **System Manual** tab.

## Why this manual is definitions-first

Afshaan, 2026-09-01: the manual *"should contain how numbers are calculated and the definitions
for all (wherever relevant) numbers seen on the dashboard, so that someone looking at the numbers
knows what calculation has gone into it."*

The primary reader is the **Channels team**, and the reason is a real clash of vocabulary:
their *gross* excludes returns, refunds and taxes, while Odo's *gross* excludes everything
except taxes. Both are defensible. Quoting one into a conversation built on the other produces a
large unexplained gap and a hunt for a bug that does not exist.

So **The Definitions** is part two, before any screen chapter, and every screen chapter assumes
it has been read. When you add a screen chapter, do not redefine a term in it: link the reader
back to the definition instead, or the two will drift.

## Editing

- `manual.json` is the spine: title, version, accent, roles, and the ordered parts and chapters.
- `content/*.html` are body-only fragments. `build.py` adds the title, breadcrumb, route chip and
  role badges.
- House style: **no em dashes**. Check with `grep -rn "—" content/` before building.
- Write each definition **from the code**, not from memory. `apps/odo/src/lib/segregation.js` is
  the ladder of record. This has been got wrong twice in the knowledge layer.

## Building

Two builds, always both:

```bash
cd apps/odo/docs/manual && python3 build.py          # the PDF
python3 05_Throttle/scripts/build-manual-web.py odo  # the in-app data + PDF copy
```

CI only runs `next build`, so the generated `src/data/manual.json` **and**
`public/manual/*.pdf` must be committed alongside the source.

## Upkeep

Manual upkeep travels with the code (LOT decision, S105). When an Odo screen changes, update its
chapter in the same commit and rebuild both outputs. Do not track manual content as backlog items.
