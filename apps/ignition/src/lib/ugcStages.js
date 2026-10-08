/**
 * UGC pipeline stage vocabulary (Reann Batch C1) — must mirror the ignitionops
 * UGC_STAGES set + DB CHECK. Free-transition model (any→any); the UI picks this
 * stage set when engagement_type === 'ugc'. Mirrors lib/stages.js conventions.
 */

export const UGC_STAGE_VALUES = [
  // 'proposed' leads here too — the UGC board buckets by stage with no filter, so a proposed UGC
  // deal missing from this list would be fetched but render in no column (silently invisible).
  // 'agreed' retired 2026-08-27 (Reann #11) in lockstep with lib/stages.js + ignitionops
  // UGC_STAGES. Verified no UGC deal was sitting on it before removing — the label below is
  // kept so a historical row still renders rather than showing a blank badge.
  'proposed',
  'outreach', 'shipped', 'delivered', 'draft', 'live',
  // 'cancelled' added 2026-08-27 in lockstep with lib/stages.js, ignitionops UGC_STAGES and the
  // DB CHECK — a UGC deal gets called off the same way an influencer deal does.
  'paused', 'vault', 'retired', 'dropped', 'cancelled',
];

// Off the happy path; vault/paused are reopenable holds, retired/dropped are exits.
export const UGC_TERMINAL = new Set(['retired', 'dropped', 'cancelled']);

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
  cancelled: 'Cancelled',
};

// Pit Control hexes (2026-10-07 redesign, Phase 1). Labels + stage lists unchanged.
export const UGC_STAGE_PALETTE = {
  proposed:  { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  outreach:  { fg: '#a9b0c2', bg: '#1b1f2a' },
  agreed:    { fg: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  shipped:   { fg: '#8ea2ff', bg: 'rgba(33,60,226,.22)' },
  delivered: { fg: '#4ade80', bg: 'rgba(34,197,94,.14)' },
  draft:     { fg: '#ff8a33', bg: 'rgba(255,107,0,.14)' },
  live:      { fg: '#ff8a33', bg: 'rgba(255,107,0,.14)' },
  paused:    { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  vault:     { fg: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  retired:   { fg: '#ff7b7b', bg: 'rgba(222,42,42,.16)' },
  dropped:   { fg: '#ff7b7b', bg: 'rgba(222,42,42,.16)' },
  cancelled: { fg: '#8b93a7', bg: '#1b1f2a' },
};

/** Happy path for the stepper. Paused/Vault/Retired/Dropped sit off-path. */
export const UGC_HAPPY_PATH = ['outreach', 'shipped', 'delivered', 'draft', 'live'];

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
