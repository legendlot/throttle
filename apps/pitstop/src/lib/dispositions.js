// Shared disposition constants — import from here, never redefine locally.

// 'no_action' retired from selection (Pruthvi — redundant with 'query'); its
// label + palette below are kept so existing no_action tickets still render.
export const DISPOSITION_VALUES = [
  'pending',
  'query',
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

// Volt palette (handoff §5). Status IS the product — every entry uses the
// semantic --*-fg/-bg/-bd tokens, never raw brand hues:
//   pending neutral · query info-blue · awaiting_info warn-amber ·
//   replacement info-blue · refund warn-amber · repair ok-green.
export const DISPOSITION_PALETTE = {
  replacement:   { bg: 'var(--info-bg)',  fg: 'var(--info-fg)', border: 'var(--info-bd)' },
  refund:        { bg: 'var(--warn-bg)',  fg: 'var(--warn-fg)', border: 'var(--warn-bd)' },
  repair:        { bg: 'var(--ok-bg)',    fg: 'var(--ok-fg)',   border: 'var(--ok-bd)' },
  query:         { bg: 'var(--info-bg)',  fg: 'var(--info-fg)', border: 'var(--info-bd)' },
  no_action:     { bg: 'var(--surface-3)', fg: 'var(--t3)',     border: 'var(--border-2)' },
  awaiting_info: { bg: 'var(--warn-bg)',  fg: 'var(--warn-fg)', border: 'var(--warn-bd)' },
  pending:       { bg: 'var(--surface-3)', fg: 'var(--t2)',     border: 'var(--border-2)' },
};
