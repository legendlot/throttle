// Ignition performance-metrics framework — Reann 2026-08-10 #2.
//
// ONE definition of every ratio, shared by the engagement detail card, Reports and any CSV. The
// numbers must not be re-derived per surface: two screens quoting different "Like Rate" for the
// same deal is worse than not showing it at all.
//
// Every engagement ratio is normalised to FOLLOWER COUNT AT POST DATE, not the influencer's current
// follower count. That is the whole point of the field: a creator who has doubled since posting
// would otherwise show half the true rate, and the error grows the longer ago they posted. Where
// the at-post count is missing we return null and the UI says so — a plausible-looking wrong
// percentage is the failure mode to avoid.

export const GAP_REASONS = {
  internal_gap:  'Internal gap',
  gated_data:    'Gated data',
  system_timing: 'System / timing',
};

// Platform rules (Reann #2): Instagram and Facebook expose everything; YouTube has no concept of
// reposts or saves, so those are HIDDEN rather than shown as a blank that reads like missing data.
const HIDDEN_BY_PLATFORM = {
  youtube: new Set(['reposts', 'saves']),
};
// Reposts are Instagram-only per the brief — on Facebook the metric exists but Reann does not
// track it, so it is hidden there too.
const REPOST_PLATFORMS = new Set(['instagram']);

export function isMetricApplicable(metric, platform) {
  const p = String(platform || '').toLowerCase();
  if (HIDDEN_BY_PLATFORM[p]?.has(metric)) return false;
  if (metric === 'reposts' && p && !REPOST_PLATFORMS.has(p)) return false;
  return true;
}

const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const pct = (n, d) => (n == null || !d ? null : Math.round((n / d) * 10000) / 100);

// The raw metrics Reann lists, in her order. `key` matches both the DB column and metric_gaps.
export const RAW_METRICS = [
  { key: 'views',            label: 'Views' },
  { key: 'likes',            label: 'Likes' },
  { key: 'comments',         label: 'Comments' },
  { key: 'shares',           label: 'Shares' },
  { key: 'reposts',          label: 'Reposts' },
  { key: 'saves',            label: 'Saves' },
  { key: 'orders',           label: 'Orders' },
  { key: 'followers_gained', label: 'Followers gained' },
];

/**
 * Derive every ratio for one engagement.
 * @param e engagement row
 * @param platform influencer.channel_platform — drives which metrics apply
 * @returns { base, ratios[], business[], missingDenominator }
 */
export function deriveMetrics(e = {}, platform) {
  const base = num(e.follower_count_at_post);
  const applicable = (k) => isMetricApplicable(k, platform);

  // Ratios are all "metric ÷ followers at post × 100", displayed as %.
  const ratioDefs = [
    { key: 'like_rate',      label: 'Like rate',      from: 'likes' },
    { key: 'comment_rate',   label: 'Comment rate',   from: 'comments' },
    { key: 'save_rate',      label: 'Save rate',      from: 'saves' },
    { key: 'share_rate',     label: 'Share rate',     from: 'shares' },
    { key: 'repost_rate',    label: 'Repost rate',    from: 'reposts' },
    { key: 'follower_growth_rate', label: 'Follower growth', from: 'followers_gained' },
  ];
  const ratios = ratioDefs
    .filter(d => applicable(d.from))
    .map(d => ({ ...d, value: pct(num(e[d.from]), base), unit: '%' }));

  // Views-to-followers is a multiplier, not a percentage — 2.3x reads better than 230%.
  const views = num(e.views);
  ratios.push({
    key: 'views_to_followers', label: 'Views / followers', from: 'views', unit: 'x',
    value: (views == null || !base) ? null : Math.round((views / base) * 100) / 100,
  });

  // Business metrics are absolute, never normalised to followers.
  const cost = num(e.total_cost);
  const revenue = num(e.conversions_value);
  const business = [
    { key: 'cost_per_video', label: 'Cost per video', value: cost, unit: '₹' },
    { key: 'cpm',            label: 'CPM',            unit: '₹',
      value: (cost == null || !views) ? null : Math.round((cost / views) * 1000 * 100) / 100 },
    { key: 'revenue_per_view', label: 'Revenue per view', unit: '₹',
      value: (revenue == null || !views) ? null : Math.round((revenue / views) * 100) / 100 },
  ];

  return { base, ratios, business, missingDenominator: !base };
}

// A metric is "unexplained missing" when it applies to the platform, has no value, and nobody has
// said why. Those are the cells worth chasing — as opposed to a gap with a recorded reason, which
// is a known state, or a hidden metric, which was never expected.
export function unexplainedGaps(e = {}, platform) {
  const gaps = e.metric_gaps || {};
  return RAW_METRICS
    .filter(m => isMetricApplicable(m.key, platform))
    .filter(m => num(e[m.key]) == null && !gaps[m.key])
    .map(m => m.key);
}
