# Podium — Appraisal overview + calibration page (Afshaan, 2026-09-22, S396)

Status: AGREED spec, not built. Replaces `/appraisals/cycle` (super admins only — `canCalibrate`).
Context: drafts, suggested increment and the super-admin lock shipped in throttle `b9b9a03c` and `96ffe39b`
(reviews open at `/reviews/review`, calibration at `/appraisals/detail`).

## 1. Cycle overview page (reconciliation + chasing)
- Top strip: enrolled · self done · mgr done · mgr drafts · calibrated · locked · shared · PIP.
- Employee list grouped by MANAGER (toggle: department), per-group pending count; each row = name,
  dept, self status, manager status, final rating, CURRENT CTC (always shown), calibrated incr/bonus.
- Side panel, company level for the cycle: avg increment %, total one-time bonus (OTB), total annual CTC
  before vs after, delta, and BUDGET used vs remaining.
- Budget: entered per cycle as EITHER a % of pre-appraisal CTC OR an absolute ₹ value.
- No in-system nudges (Afshaan: chasing happens outside) — but each MANAGER must see a complete list of
  their team's done vs pending (Reviews page already lists their reports; make sure it's complete).

## 2. Per-employee calibration view (click a row)
- Self-review text as submitted; long text opens in a scrollable modal.
- Manager review text + manager's ADDITIONAL COMMENTS (internal — super admins only, never the subject;
  submitted with the review).
- Manager recommendation: increment % + OTB ₹ + a recommendation comment (for adjustments beyond incr + OTB).
- Calibration: rating meter + final rating + calibration note.
- Calibrated increment % + OTB ₹, with ACCEPT (copies manager's values) or OVERRIDE; current CTC → new CTC live.

## 3. Draft → lock (permanent write)
- Calibrated incr/OTB stay a DRAFT on the appraisal (feeds the budget panel live).
- "Lock in" writes them permanently to `compensation_events` (increment / one_time_bonus, effective =
  cycle appraisal date, appraisal_id set). Lock can be done for ALL, a SELECTION, or ONE person.
- Needs comp allow-list + super admin (existing `applyIncrement` gate).

## 4. Manager / employee side changes
- Manager CANNOT submit until the self-review is submitted — draft only. A super admin can UNLOCK one
  appraisal to let the manager submit without a self-review.
- Rich text (bullets, numbered lists, bold, italic) in self + manager review boxes; stored as sanitized
  HTML; existing plain text still renders.
- Manager form gains: additional comments (internal), OTB ₹ suggestion, recommendation comment.

## Schema sketch (verify live before DDL)
appraisals: manager_comments text, manager_suggested_bonus numeric, manager_recommendation_note text,
calibrated_increment_pct numeric(5,2), calibrated_bonus numeric, comp_locked_at timestamptz,
comp_locked_by uuid, self_review_waived_at/by (the unlock). appraisal_cycles: budget_type ('pct'|'amount'),
budget_value numeric. Drafts: extend manager_draft jsonb with the new fields.
