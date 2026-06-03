// Appraisal engine — shared labels + helpers (Phase 3).

export const RATING_LABELS = {
  1: 'Unsatisfactory', 2: 'Below expectations', 3: 'Meets expectations', 4: 'Exceeds', 5: 'Outstanding',
};
export const CYCLE_STATUS = {
  draft: 'Draft', active: 'Reviews open', calibration: 'Calibration', closed: 'Closed',
};
export const APPRAISAL_STATUS = {
  self_review: 'Self review', manager_review: 'Manager review', calibration: 'Calibration',
  shared: 'Shared', acknowledged: 'Acknowledged',
};

export function ratingColor(r) {
  if (!r) return 'var(--text-3)';
  if (r >= 4) return 'var(--state-success-fg)';
  if (r === 3) return 'var(--state-warning-fg)';
  return 'var(--state-error-fg)';
}

// Anchor helpers — build an Apr 1 / Oct 1 cycle quickly.
export function anchorOptions() {
  const out = [];
  const now = new Date();
  const y = now.getUTCFullYear();
  for (const yr of [y - 1, y, y + 1]) {
    out.push({ value: `${yr}-04-01`, label: `Apr ${yr} (H1)` });
    out.push({ value: `${yr}-10-01`, label: `Oct ${yr} (H2)` });
  }
  return out;
}

export function fmtMonths(m) { return m == null ? '—' : `${m} mo`; }
