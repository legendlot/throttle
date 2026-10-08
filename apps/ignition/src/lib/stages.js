/**
 * Engagement stage vocabulary — must mirror DB CHECK + worker allowedTransitions().
 * PATTERN-076 three-layer encoding. S138 (Reann #8): free-transition model.
 * S214 (Reann 6-pt ⑤): 'completed' dropped — **'live' is the terminal success stage**
 * (video posted = deal done); mandatory colour rating + post date enforced at live.
 */

export const STAGE_VALUES = [
  // 'proposed' — mandatory first stage with a HARD approval gate (Reann #5, Afshaan 2026-08-11).
  // Must mirror ignitionops STAGES; PATTERN-076 three-layer encoding.
  // 'agreed' retired 2026-08-27 (Reann #11) — approval is the go-ahead, so the stage was saying
  // the same thing twice. Legal-but-unused in the DB CHECK, exactly like 'completed' (S214);
  // STAGE_LABELS below deliberately KEEPS an entry for it so historical rows still render.
  'proposed',
  'planning','shipped','delivered','scheduled','posting','live',
  // 'cancelled' (Reann, 2026-08-27) — terminal like 'dropped', but the deal was called off
  // before anything was spent, so it is EXCLUDED from every spend/CPM total. 'dropped' still
  // counts: goods went out and never became a video, which is a real loss.
  'delayed','on_hold','ghosted','dropped','cancelled',
];

export const TERMINAL_FAIL = new Set(['ghosted','dropped','cancelled']);

export const STAGE_LABELS = {
  proposed:  'Proposed',
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
  cancelled: 'Cancelled',
};

// Pit Control hexes (2026-10-07 redesign, Phase 1). Labels + stage lists unchanged.
export const STAGE_PALETTE = {
  proposed:  { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  planning:  { fg: '#a9b0c2', bg: '#1b1f2a' },
  agreed:    { fg: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  shipped:   { fg: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  delivered: { fg: '#4ade80', bg: 'rgba(34,197,94,.14)' },
  scheduled: { fg: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  posting:   { fg: '#ff8a33', bg: 'rgba(255,107,0,.14)' },
  live:      { fg: '#4ade80', bg: 'rgba(34,197,94,.14)' },
  delayed:   { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  on_hold:   { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  ghosted:   { fg: '#ff7b7b', bg: 'rgba(222,42,42,.16)' },
  dropped:   { fg: '#ff7b7b', bg: 'rgba(222,42,42,.16)' },
  // Neutral grey, deliberately NOT the error red the other two exits wear: a cancelled deal
  // is not a failure, it is a deal that stopped costing anything.
  cancelled: { fg: '#8b93a7', bg: '#1b1f2a' },
};

// Free model: from any stage you may move to any other.
export function allowedTransitions(stage) {
  return STAGE_VALUES.filter(s => s !== stage);
}

/** Main happy-path order used by the StageStepper. "Draft received" (posting)
 *  sits before "Scheduled": influencer sends the draft → it's scheduled → goes Live
 *  (the terminal success stage). */
export const HAPPY_PATH = [
  'proposed','planning','shipped','delivered','posting','scheduled','live',
];
