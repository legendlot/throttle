/**
 * UGC pipeline stage vocabulary (Reann Batch C1) — must mirror the ignitionops
 * UGC_STAGES set + DB CHECK. Free-transition model (any→any); the UI picks this
 * stage set when engagement_type === 'ugc'. Mirrors lib/stages.js conventions.
 */

export const UGC_STAGE_VALUES = [
  // 'proposed' leads here too — the UGC board buckets by stage with no filter, so a proposed UGC
  // deal missing from this list would be fetched but render in no column (silently invisible).
  'proposed',
  'outreach', 'agreed', 'shipped', 'delivered', 'draft', 'live',
  'paused', 'vault', 'retired', 'dropped',
];

// Off the happy path; vault/paused are reopenable holds, retired/dropped are exits.
export const UGC_TERMINAL = new Set(['retired', 'dropped']);

export const UGC_STAGE_LABELS = {
  proposed:  'Proposed',
  outreach:  'Outreach',
  agreed:    'Agreed',
  shipped:   'Shipped',
  delivered: 'Delivered',
  draft:     'Draft',
  live:      'Live',
  paused:    'Paused',
  vault:     'Vault',
  retired:   'Retired',
  dropped:   'Dropped',
};

export const UGC_STAGE_PALETTE = {
  proposed:  { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  outreach:  { fg: 'var(--text-3)',           bg: 'var(--surface-2)' },
  agreed:    { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  shipped:   { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  delivered: { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  draft:     { fg: '#FF6B00',                 bg: 'rgba(255,107,0,0.12)' },
  live:      { fg: '#FF6B00',                 bg: 'rgba(255,107,0,0.12)' },
  paused:    { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  vault:     { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  retired:   { fg: 'var(--state-error-fg)',   bg: 'var(--state-error-bg)' },
  dropped:   { fg: 'var(--state-error-fg)',   bg: 'var(--state-error-bg)' },
};

/** Happy path for the stepper. Paused/Vault/Retired/Dropped sit off-path. */
export const UGC_HAPPY_PATH = ['outreach', 'agreed', 'shipped', 'delivered', 'draft', 'live'];

/**
 * ROAS colour tone (item #5): green >4, yellow 3–4, red <3.
 * Returns '' for null / zero-spend (no meaningful ROAS to colour).
 */
export function roasTone(roas) {
  if (roas == null) return '';
  const n = Number(roas);
  if (!isFinite(n) || n <= 0) return '';
  if (n > 4) return 'good';
  if (n >= 3) return 'warn';
  return 'bad';
}

/** Map a roasTone() key to a CSS colour, matching the state palette. */
export function roasToneColor(tone) {
  if (tone === 'good') return 'var(--state-success-fg)';
  if (tone === 'warn') return 'var(--state-warning-fg)';
  if (tone === 'bad') return 'var(--state-error-fg)';
  return 'var(--text-3)';
}
