// Shared option lists + helpers for Podium Phase 2 (performance capture).

export const SENTIMENTS = [
  { id: 'positive',     label: 'Positive',     color: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  { id: 'neutral',      label: 'Neutral',      color: 'var(--text-2)',           bg: 'var(--surface-2)' },
  { id: 'constructive', label: 'Constructive', color: 'var(--brand-orange)',     bg: 'var(--state-warning-bg)' },
];

export const VISIBILITIES = [
  { id: 'private',                label: 'Private',              hint: 'Only you and HR — never the person' },
  { id: 'shared_with_managers',   label: 'Shared with managers', hint: "The person's manager chain + HR" },
  { id: 'shared_with_employee',   label: 'Shared with person',   hint: 'The person can see it too' },
];

export function sentimentMeta(id) {
  return SENTIMENTS.find(s => s.id === id) || { label: id || '—', color: 'var(--text-2)', bg: 'var(--surface-2)' };
}
export function visibilityMeta(id) {
  return VISIBILITIES.find(v => v.id === id) || { label: id || '—', hint: '' };
}

export function parseTags(s) {
  return String(s || '').split(',').map(t => t.trim()).filter(Boolean);
}
export function joinTags(arr) {
  return Array.isArray(arr) ? arr.join(', ') : '';
}
