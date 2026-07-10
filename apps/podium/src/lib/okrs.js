// Podium OKR engine (Phase 4) — shared labels + helpers.
// The score math here MIRRORS podium.f_okr_kr_score (SQL is canonical). Used only for
// instant feedback while typing a check-in; server values win on any disagreement.

export const LEVELS = {
  company: 'Company', department: 'Department', individual: 'Individual',
};
export const LEVEL_ORDER = { company: 0, department: 1, individual: 2 };

export const CYCLE_STATUS = {
  draft: 'Draft', active: 'Active', scoring: 'Scoring', closed: 'Closed',
};

export const CONFIDENCE = {
  on_track: 'On track', at_risk: 'At risk', off_track: 'Off track',
};
export const CONFIDENCE_COLOR = {
  on_track: 'var(--state-success-fg)',
  at_risk: 'var(--state-warning-fg)',
  off_track: 'var(--state-error-fg)',
};

export const METRIC_TYPES = [
  { id: 'number',     label: 'Number' },
  { id: 'percentage', label: 'Percentage' },
  { id: 'currency',   label: 'Currency (₹)' },
  { id: 'milestone',  label: 'Milestone (done / not done)' },
];
export const DIRECTIONS = [
  { id: 'increase', label: 'Increase to target' },
  { id: 'decrease', label: 'Decrease to target' },
];

// Reuse the appraisal anchor rhythm (Apr 1 / Oct 1). OKR cycles anchor to the
// appraisal date at the END of the period (so the appraisal join is anchor == appraisal_date).
export function anchorOptions() {
  const out = [];
  const y = new Date().getUTCFullYear();
  for (const yr of [y - 1, y, y + 1]) {
    out.push({ value: `${yr}-04-01`, label: `Apr ${yr} (H2 prior yr → Mar)` });
    out.push({ value: `${yr}-10-01`, label: `Oct ${yr} (H1 → Sep)` });
  }
  return out;
}

// KR score ∈ [0,1] — mirror of f_okr_kr_score.
export function krScore(kr) {
  if (!kr) return 0;
  const start = Number(kr.start_value) || 0;
  const target = Number(kr.target_value);
  const current = Number(kr.current_value) || 0;
  if (kr.metric_type === 'milestone') return current >= target ? 1 : 0;
  const denom = kr.direction === 'decrease' ? (start - target) : (target - start);
  if (!denom) return 0;
  const num = kr.direction === 'decrease' ? (start - current) : (current - start);
  return Math.max(0, Math.min(1, num / denom));
}

// Weighted objective auto-score over active KRs; null when none.
export function objectiveAutoScore(krs = []) {
  const active = krs.filter(k => (k.status || 'active') === 'active');
  const wsum = active.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  if (!wsum) return null;
  const num = active.reduce((s, k) => s + krScore(k) * (Number(k.weight) || 0), 0);
  return num / wsum;
}

export function displayedScore(obj) {
  if (obj?.final_score != null) return Number(obj.final_score);
  if (obj?.auto_score != null) return Number(obj.auto_score);
  const auto = objectiveAutoScore(obj?.key_results);
  return auto == null ? null : auto;
}

// 0..1 → percent int for bars/labels.
export function scorePct(s) {
  return s == null ? null : Math.round(Math.max(0, Math.min(1, Number(s))) * 100);
}

// Progress-bar colour by score (green ≥0.7, amber ≥0.4, red below; grey when null).
export function scoreColor(s) {
  if (s == null) return 'var(--t4)';
  const v = Number(s);
  if (v >= 0.7) return 'var(--state-success-fg)';
  if (v >= 0.4) return 'var(--state-warning-fg)';
  return 'var(--state-error-fg)';
}

export function metricLabel(id) { return METRIC_TYPES.find(m => m.id === id)?.label || id; }

// Format a KR value for display (currency/percentage suffixing).
export function fmtKrValue(kr, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (kr.metric_type === 'currency') return '₹' + n.toLocaleString('en-IN');
  if (kr.metric_type === 'percentage') return n + '%';
  if (kr.metric_type === 'milestone') return n >= 1 ? 'Done' : 'Not done';
  return n.toLocaleString('en-IN') + (kr.unit ? ' ' + kr.unit : '');
}
