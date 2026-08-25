# Production Relay — cross-system flow map (DRAFT v0.1)

> Training / demonstration chart showing how a part becomes a car and a car becomes a parcel,
> across **Snorkel · Garage · Redline · Depot · Scanner**. Built 2026-08-25 (S310).
> **Status: draft — not yet floor-verified. Do not hand it to a new starter as authoritative yet.**

**Live artifact:** https://claude.ai/code/artifact/35373de7-1adc-4403-898b-6888d389c36b

## What it is

A **relay chart**, not an org chart. The vertical axis is time; the coloured rail down the left
edge of each leg is *which app holds the baton*. When the rail colour changes, responsibility has
changed hands, and the yellow band closing each leg names the exact mechanism that carries it.

Its core device is that **every step is typed as one of four mechanisms**:

| Tag | Means |
|---|---|
| `SCAN` | A physical barcode scan at a station. Nothing moves until the label is read. |
| `SCREEN` | A human opens an app and decides. If nobody opens it, the work waits forever. |
| `AUTO` | A consequence of the previous step. Nobody actions it; it just appears elsewhere. |
| `HANDOFF` | Goods physically move outside the system — to a vendor, a courier, the floor. |

That typing is the point. A new person's real question is not *what happens next* but
*do I have to do something* — and most "who was supposed to tell me?" confusion on the floor is an
`AUTO` leg that somebody was waiting to be handed manually.

## Sections

1. **Four kinds of movement** — the legend above.
2. **The fleet** — all 12 systems, production core called out, each with its worker + URL.
3. **The relay** — 9 legs / 44 steps, expandable, filterable by Store / Production / Dispatch /
   Procurement. Each leg carries its governing rule and its handoff band.
4. **Unit states** — all 18 `units.current_status` values and the scan that sets each.
5. **Start here** — four role cards; Production's is the answer to "how do I start a run?".

## Where the content came from

Derived from source, not from memory:

- `02_scanner/index.html` → `STATION_DEFS` (27 stations)
- `01_worker/worker.js` → `SCANNER_ACTIONS` + every `current_status:` write, each mapped back to
  its owning handler to get station → state transitions right
- `apps/{garage,redline,depot,snorkel}/docs/manual/content/*.html` — the human-facing wording
- `BUSINESS_RULES.md` (RULE-PO-001, RULE-RCV-001, RULE-STOCK-002, RULE-RET-001, RULE-SNORKEL-004)
- `CORE.md` — worker → system blast radius

## How to update it

Edit `production-relay.html` and republish to the **same artifact URL** (pass it as `url` from any
session that did not originally publish it, otherwise a second artifact is created).

The content lives in two plain JS arrays near the bottom of the file — `LEGS` and `STATES` — so a
leg can be corrected in one place. Nothing about the copy is baked into the markup.

## Known gaps — resolve these before calling it v1.0

1. **Not floor-verified.** Mechanisms are code-accurate; *emphasis* is a judgment call that a
   person who runs the floor has not yet checked.
2. **Three flows were deliberately treated as side-loops, not main legs**, and that call may be
   wrong: **Gate Pass**, **Cycle Count**, and **Direct Store Issuance** (DSP). Each currently gets
   only a passing mention.
3. **Single-theme dark** — matches the app fleet (`redline/src/app/globals.css` tokens are used
   verbatim). If it needs to be printed or projected in a bright room, a light theme is a
   separate pass.
4. **Hand-maintained.** `STATION_DEFS` and the `current_status` writes are the real source of
   truth; if a station is added, this file does not know. Generating `LEGS`/`STATES` from the repo
   at build time is the obvious follow-on and would close this permanently.
5. **Not yet in-app.** The in-app route would follow the existing System Manual pattern exactly
   (`docs/manual/` spine → `scripts/build-manual-web.py` → a nav tab). That is a build, and it is
   deliberately not started.
