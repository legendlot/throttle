// Shared disposition constants — import from here, never redefine locally.

export const DISPOSITION_VALUES = [
  'pending',
  'query',
  'no_action',
  'awaiting_info',
  'replacement',
  'refund',
  'repair',
];

export const DISPOSITION_LABELS = {
  pending:       'Pending',
  query:         'Query',
  no_action:     'No action',
  awaiting_info: 'Awaiting info',
  replacement:   'Replacement',
  refund:        'Refund',
  repair:        'Repair',
};

export const DISPOSITION_PALETTE = {
  replacement:   { bg: 'rgba(123, 147, 255, 0.12)', fg: '#7b93ff', border: 'rgba(123, 147, 255, 0.35)' },
  refund:        { bg: 'rgba(251, 191, 36, 0.12)',  fg: '#fbbf24', border: 'rgba(251, 191, 36, 0.35)' },
  repair:        { bg: 'rgba(74, 222, 128, 0.12)',  fg: '#4ade80', border: 'rgba(74, 222, 128, 0.35)' },
  query:         { bg: 'rgba(99, 179, 237, 0.12)',  fg: '#63b3ed', border: 'rgba(99, 179, 237, 0.35)' },
  no_action:     { bg: 'var(--surface-2)',           fg: 'var(--t3)', border: 'var(--border)' },
  awaiting_info: { bg: 'rgba(251, 191, 36, 0.08)',  fg: '#fbbf24', border: 'rgba(251, 191, 36, 0.25)' },
  pending:       { bg: 'var(--surface-2)',           fg: 'var(--t2)', border: 'var(--border)' },
};
