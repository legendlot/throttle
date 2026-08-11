// Deterministic A/B arm assignment (S272). Pure: no DB, no network, no clock.
//
// Assignment is a hash, not a stored table, so it is stateless, replay-safe (a re-run assigns
// identically and dedup_key suppresses the send anyway), and — the property that matters most —
// INDEPENDENT of the keyset pagination order. That is what keeps a cancelled or stalled campaign's
// sent prefix correctly split and therefore still analysable. Do not "improve" this into a
// pre-assigned table.

// FNV-1a, 32-bit. Chosen over crypto.subtle because it is synchronous and trivially testable;
// cryptographic strength is irrelevant for bucketing.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;   // unsigned
}

// ⚠️ The `${campaignId}:` salt is load-bearing. Hash profile_id alone and the same people land in
// arm A of EVERY campaign forever — one cohort would only ever see one style of copy and every
// future test would inherit that bias.
//
// Modulo bias from `% total` is real and negligible: with a 32-bit hash and a total of 100, 96 of
// the 100 buckets receive one extra hash value out of ~42.9 million each — a relative bias of
// ~2.3e-8, i.e. an expected distortion of ~0.001 recipients on a campaign of tens of thousands.
// Do not "fix" it with rejection sampling.
//
// Measured 2026-08-11 rather than assumed, on the real module: 50k random v4 uuids split
// 50.27/49.73; 80/20 gave chi2 0.88 (crit 3.84); 50/30/20 gave chi2 0.71 (crit 5.99); and across
// 1,000 different campaign salts the per-campaign split had stdev 1.135% against a theoretical
// binomial 1.118% — so the spread between campaigns is sampling noise, not hash skew.
function pickVariant(campaignId, profileId, variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const arms = variants
    .filter((v) => v && Number(v.weight) > 0)
    // ⚠️ SORT BY id, DO NOT TRUST THE CALLER'S ORDER. The cumulative walk below is
    // order-sensitive, so if arms arrived in a different sequence — a changed `sort_order`, a
    // reordered UI list, a query without an ORDER BY — every recipient's arm would flip while
    // still looking perfectly deterministic. Sorting on the immutable id makes assignment a
    // function of (campaign, profile, set-of-arms) rather than of array order.
    .slice()
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0];

  const total = arms.reduce((s, v) => s + Number(v.weight), 0);
  let bucket = fnv1a(`${campaignId}:${profileId}`) % total;
  for (const v of arms) {
    bucket -= Number(v.weight);
    if (bucket < 0) return v;
  }
  return arms[arms.length - 1];   // unreachable; guards against float/NaN weights
}

module.exports = { fnv1a, pickVariant };
