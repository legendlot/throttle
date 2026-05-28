/**
 * Engagement stage vocabulary — must mirror DB CHECK + worker allowedTransitions().
 * PATTERN-076 three-layer encoding.
 */

export const STAGE_VALUES = [
  'identified','invited','engaged','negotiating','agreed',
  'shipped','delivered','script_review','script_signed_off',
  'scheduled','live','tracking','closed',
  'declined','ghosted','dropped',
];

export const TERMINAL_FAIL = new Set(['declined','ghosted','dropped']);

export const STAGE_LABELS = {
  identified:        'Identified',
  invited:           'Invited',
  engaged:           'Engaged',
  negotiating:       'Negotiating',
  agreed:            'Agreed',
  shipped:           'Shipped',
  delivered:         'Delivered',
  script_review:     'Script Review',
  script_signed_off: 'Script Signed Off',
  scheduled:         'Scheduled',
  live:              'Live',
  tracking:          'Tracking',
  closed:            'Closed',
  declined:          'Declined',
  ghosted:           'Ghosted',
  dropped:           'Dropped',
};

export const STAGE_PALETTE = {
  identified:        { fg: 'var(--text-3)',         bg: 'var(--surface-2)' },
  invited:           { fg: 'var(--state-info-fg)',  bg: 'var(--state-info-bg)' },
  engaged:           { fg: 'var(--state-info-fg)',  bg: 'var(--state-info-bg)' },
  negotiating:       { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  agreed:            { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  shipped:           { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  delivered:         { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  script_review:     { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  script_signed_off: { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  scheduled:         { fg: 'var(--state-info-fg)',  bg: 'var(--state-info-bg)' },
  live:              { fg: '#FF6B00',               bg: 'rgba(255,107,0,0.12)' },
  tracking:          { fg: '#FF6B00',               bg: 'rgba(255,107,0,0.12)' },
  closed:            { fg: 'var(--text-2)',         bg: 'var(--surface-2)' },
  declined:          { fg: 'var(--state-error-fg)', bg: 'var(--state-error-bg)' },
  ghosted:           { fg: 'var(--state-error-fg)', bg: 'var(--state-error-bg)' },
  dropped:           { fg: 'var(--state-error-fg)', bg: 'var(--state-error-bg)' },
};

export function allowedTransitions(stage) {
  switch (stage) {
    case 'identified':         return ['invited','declined','dropped'];
    case 'invited':            return ['engaged','ghosted','declined'];
    case 'engaged':            return ['negotiating','ghosted','declined'];
    case 'negotiating':        return ['agreed','declined','dropped'];
    case 'agreed':             return ['shipped','dropped'];
    case 'shipped':            return ['delivered','dropped'];
    case 'delivered':          return ['script_review','dropped'];
    case 'script_review':      return ['script_signed_off','dropped'];
    case 'script_signed_off':  return ['scheduled','dropped'];
    case 'scheduled':          return ['live','dropped'];
    case 'live':               return ['tracking','dropped'];
    case 'tracking':           return ['closed'];
    case 'closed':             return [];
    case 'declined':
    case 'ghosted':
    case 'dropped':            return ['closed'];
    default:                   return [];
  }
}

/** Linear happy-path order used by the StageStepper. */
export const HAPPY_PATH = [
  'identified','invited','engaged','negotiating','agreed',
  'shipped','delivered','script_review','script_signed_off',
  'scheduled','live','tracking','closed',
];
