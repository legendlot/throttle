/**
 * Engagement stage vocabulary — must mirror DB CHECK + worker allowedTransitions().
 * PATTERN-076 three-layer encoding. S138 (Reann #8): free-transition model.
 * S214 (Reann 6-pt ⑤): 'completed' dropped — **'live' is the terminal success stage**
 * (video posted = deal done); mandatory colour rating + post date enforced at live.
 */

export const STAGE_VALUES = [
  'planning','agreed','shipped','delivered','scheduled','posting','live',
  'delayed','on_hold','ghosted','dropped',
];

export const TERMINAL_FAIL = new Set(['ghosted','dropped']);

export const STAGE_LABELS = {
  planning:  'Planning',
  agreed:    'Agreed',
  shipped:   'Shipped',
  delivered: 'Delivered',
  scheduled: 'Scheduled',
  posting:   'Draft received',
  live:      'Live',
  delayed:   'Delayed',
  on_hold:   'On hold',
  ghosted:   'Ghosted',
  dropped:   'Dropped',
};

export const STAGE_PALETTE = {
  planning:  { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
  agreed:    { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  shipped:   { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  delivered: { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  scheduled: { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  posting:   { fg: '#FF6B00',                 bg: 'rgba(255,107,0,0.12)' },
  live:      { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  delayed:   { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  on_hold:   { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  ghosted:   { fg: 'var(--state-error-fg)',   bg: 'var(--state-error-bg)' },
  dropped:   { fg: 'var(--state-error-fg)',   bg: 'var(--state-error-bg)' },
};

// Free model: from any stage you may move to any other.
export function allowedTransitions(stage) {
  return STAGE_VALUES.filter(s => s !== stage);
}

/** Main happy-path order used by the StageStepper. "Draft received" (posting)
 *  sits before "Scheduled": influencer sends the draft → it's scheduled → goes Live
 *  (the terminal success stage). */
export const HAPPY_PATH = [
  'planning','agreed','shipped','delivered','posting','scheduled','live',
];
