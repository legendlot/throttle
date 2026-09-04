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

// Reann 2026-09-04 #7 — followers at post date is MANDATORY: a video cannot be saved without it.
// It is the only metric that gets this treatment, and deliberately the only one a metric_gaps
// reason cannot satisfy: the count is point-in-time and NOT backfillable (see the column comment
// in ignitionops-worker), so "we'll note why it's blank" means the number is gone for good and
// every ratio on this deal is permanently unavailable. Every other metric can be filled later.
export const REQUIRED_METRICS = ['follower_count_at_post'];

// Which required metrics are still blank in a set of edited values. Platform-gated like everything
// else — a hard stop must never fire for a metric that does not apply to the channel.
export function missingRequiredMetrics(values = {}, platform) {
  return REQUIRED_METRICS
    .filter(k => isMetricApplicable(k, platform))
    // ⚠️ `<= 0`, not just null. `num(0)` returns 0, so a typed or tabbed-through zero passed the
    // gate and produced exactly the failure it exists to prevent: deriveMetrics sets base = 0,
    // every ratio goes null via missingDenominator, and — unlike a blank — nothing on screen says
    // anything is wrong. Nobody has 0 followers at post time.
    .filter(k => { const v = num(values[k]); return v == null || v <= 0; });
}

// Reann 2026-09-04 #5 — "flag missing data on engagements: warning if a video is missing Cost or
// Views when it's LIVE". A WARNING, never a block (contrast with REQUIRED_METRICS above).
// Stages: the video is public from `live` onward, so `live` and `completed` count and `posting`
// does not — a deal still being posted has no numbers yet and flagging it would cry wolf.
const LIVE_STAGES = new Set(['live', 'completed']);

export function liveDataWarnings(e = {}, platform) {
  if (!LIVE_STAGES.has(String(e.stage || '').toLowerCase())) return [];
  const out = [];
  // "Cost" = total_cost, the same figure the Business block labels "Cost per video" and the one
  // CPM divides. It is a GENERATED column (payment + commission + ad spend + goodies + shipping +
  // return + ad rights, each COALESCEd), so it is never null — 0 means nothing has been costed.
  if (!num(e.total_cost)) out.push('Cost');
  // Views: unexplainedGaps is the shared "is it blank" definition and is checked first, but on a
  // LIVE deal it is not sufficient on its own.
  //
  // ⚠️ MEASURED 2026-09-04, and this is the whole reason the extra clause exists: of 202
  // live/completed deals, **0 have views NULL** and **18 sit at views = 0**. unexplainedGaps tests
  // for null, so on its own this warning could never fire even once — it would ship looking correct
  // and flag nothing. The real signal is the zero, not the null: a video that is publicly live with
  // no views recorded has not had its numbers entered.
  //
  // Deliberately NOT fixed by changing unexplainedGaps: a real 0 IS a filled value elsewhere (the
  // "why is this blank?" reason UI must not start demanding a reason for a genuine zero). The
  // stricter test belongs only here, where the stage already tells us the video is public.
  const viewsUnentered = isMetricApplicable('views', platform)
    && !num(e.views)
    && !(e.metric_gaps || {}).views;
  if (unexplainedGaps(e, platform).includes('views') || viewsUnentered) out.push('Views');
  return out;
}

// Afshaan 2026-09-04 — "Complete" is a DERIVED flag, not a stage. `live` stays the terminal stage
// (S214 ⑤) and nothing here writes anything: a deal is Complete when it is live AND the four
// numbers the deal is judged on have actually been entered. There is no `complete` column and the
// retired `completed` stage is NOT resurrected by this.
//
// ⚠️ Views uses `> 0`, not "not null" — the same trap liveDataWarnings documents above: of the live
// deals, **none has views NULL and 18 sit at views = 0**, so a null test would mark all 18 complete
// while their numbers have never been typed. `total_cost` is a GENERATED column and therefore never
// null, so it gets the same `> 0` treatment for the same reason. Likes and Followers gained take a
// plain null test: a genuine zero is a real, entered answer for both.
//
// Stage is `live` ONLY, deliberately narrower than liveDataWarnings' LIVE_STAGES (which also counts
// the retired `completed`). Measured 2026-09-04: 0 rows sit at `completed`, so the two agree on
// every real row today; if one ever appears it renders as not-live here, i.e. no pill, rather than
// a wrong claim.
const COMPLETENESS_CHECKS = [
  { label: 'Views',            test: (e) => num(e.views) > 0 },
  { label: 'Likes',            test: (e) => num(e.likes) != null },
  { label: 'Followers gained', test: (e) => num(e.followers_gained) != null },
  { label: 'Cost',             test: (e) => num(e.total_cost) > 0 },
];

/**
 * @param e engagement row
 * @returns { live, complete, missing[] } — `missing` in COMPLETENESS_CHECKS order, and populated
 *          even when the deal is not live so a caller can say what a not-yet-live deal still needs.
 *          `complete` is false unless the deal is live.
 */
export function metricsCompleteness(e = {}) {
  const live = String(e.stage || '').toLowerCase() === 'live';
  const missing = COMPLETENESS_CHECKS.filter(c => !c.test(e)).map(c => c.label);
  return { live, complete: live && missing.length === 0, missing };
}
