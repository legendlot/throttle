# Relay Journey J2 — Exit-rules UX + per-branch funnel analytics

> Phase J2 of the journey-authoring program (design spec
> `docs/superpowers/specs/2026-07-13-journey-authoring-ui-design.md` §5.4).
> J1 already shipped the ambient exit-rule ENGINE + a basic exit-rules canvas panel.
> J2 = the analytics that make escalation legible + polish. **No external deps.**

## Context / gap
- `enrolment_steps.result` is logged with a discriminating field for every step type
  EXCEPT `wait_response`: it logs `{awaited, within}` on ENTRY and never records whether
  it resolved `responded` / `timeout` / an ambient exit. So the funnel cannot show
  per-branch counts for the escalation gate — the whole point of J1.
- `#logStep` is keyed `step.do(log:<stepId>)` → callable once per step (replay-safe), so
  wait_response can't be logged twice (entry + resolution) without a step-name collision.
- Safe to change interpreter step-naming: 0 enrolments / 0 waits / 0 step-rows live (TEST
  MODE, journey draft). No in-flight durable instances to break on replay.

## Build
1. **Interpreter (`commsops-worker/src/journey-workflow.js`)** — wait_response:
   - Entry: set `current_step` only (`step.do(enter:<id>)` PATCH), no enrolment_steps row.
   - Resolution: `#logStep(id,'wait_response',{awaited,within,outcome})` where
     `outcome = terminateOutcome ? 'exit:'+terminateOutcome : outHandle` (responded|timeout).
   - Per-branch counts then derive from the existing RPC `result->>'outcome'` key.
2. **RPC `comms.journey_funnel`** (CREATE OR REPLACE, additive) — add `parked` =
   active enrolments grouped by `current_step` (who is currently held at each wait). Keep
   existing per-step `results` (per-branch counts) + `enrolments{status}` + `total`.
3. **UI (`apps/relay/.../journeys/page.js` Funnel panel)** — per step: entered count +
   outcome chips (handle label → count → target step id, from `j.definition`) + a
   "N waiting" badge from `parked`. Keep the enrolment-status summary (terminal outcomes).
4. **Exit-rules panel** — light polish; ensure terminal/exit outcomes read clearly.

## Verify
- Node: interpreter wait_response logs outcome once (replay-safe step name).
- SQL: exercise `journey_funnel` on a synthetic VALUES set (responded/timeout/exit +
  send sent/skipped + condition branches) → per-branch `results` + `parked` correct.
- Build relay (zero errors); deploy commsops. Browser smoke (canvas/funnel) = Afshaan.
- TEST MODE stays ON; zero customer effect.
