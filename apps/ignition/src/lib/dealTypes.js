export const DEAL_TYPE_VALUES = ['paid','barter','affiliate','paid_plus_affiliate'];

export const DEAL_TYPE_LABELS = {
  paid:                 'Paid',
  barter:               'Barter',
  affiliate:            'Affiliate',
  paid_plus_affiliate:  'Paid + Affiliate',
};

export const DEAL_TYPE_PALETTE = {
  paid:                 { fg: 'var(--state-success-fg)', bg: 'var(--state-success-bg)' },
  barter:               { fg: 'var(--state-info-fg)',    bg: 'var(--state-info-bg)' },
  affiliate:            { fg: 'var(--state-warning-fg)', bg: 'var(--state-warning-bg)' },
  paid_plus_affiliate:  { fg: '#FF6B00',                 bg: 'rgba(255,107,0,0.12)' },
};

export const PAYMENT_TERMS = ['advance','on_draft','on_release','n_a'];
export const PAYMENT_TERMS_LABELS = {
  advance:    'Advance',
  on_draft:   'On Draft',
  on_release: 'On Release',
  n_a:        'N/A',
};

export const ENGAGEMENT_TYPES = ['video_tracking','ugc'];
export const ENGAGEMENT_TYPE_LABELS = { video_tracking: 'Video', ugc: 'UGC' };

export const INFLUENCER_TYPES = ['nano','micro','macro','brand','store'];

export const RATINGS = ['green','yellow','red','unrated'];
export const RATING_LABELS = { green: 'Green', yellow: 'Yellow', red: 'Red', unrated: '—' };

export const CLOSED_REASONS = ['completed','ghosted','declined','dropped','historical_import'];

export const DIRECTED_TO = ['website','amazon','flipkart'];

export const LIST_STATUSES = ['master','b_list','archived'];
export const LIST_STATUS_LABELS = { master: 'Master', b_list: 'B-List', archived: 'Archived' };

export const CHANNEL_PLATFORMS = ['instagram','youtube','tiktok','other'];
