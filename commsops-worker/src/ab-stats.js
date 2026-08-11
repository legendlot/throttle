// A/B statistics + refusal states (S272). Pure: no DB, no network. Spec §6/§7.
//
// PRIMARY METRIC IS read ÷ sent (intention-to-treat). NOT read ÷ delivered.
// Delivery happens AFTER the treatment is applied, so conditioning on it is post-treatment
// conditioning: if the copy affects whether Meta delivers (wa_131049 block rates run 26–39%
// across templates), comparing read-rates among the delivered compares two differently-filtered
// populations and can invent a winner. Random assignment equalises bad numbers across arms in
// expectation, so read÷sent is unbiased by construction. read÷delivered is kept as a labelled
// diagnostic only.

const Z_CRIT = 1.96;          // two-sided 95%
const Z_POWER = 2.8;          // 1.96 + 0.84 → 80% power
const MATURITY_HOURS = 4;     // p80 of WA marketing read latency is 3.6h; round up

// Minimum detectable effect, in PERCENTAGE POINTS, for n per arm at baseline rate p.
//
// ⚠️ KNOWN LIMIT, measured by simulation 2026-08-11 — this uses the standard single-SE
// simplification (SE under H1 ≈ SE under H0), so the 80% power it promises is only accurate near
// the baseline it was validated at. Measured actual power when the true effect equals mde():
//     p=0.40 (the real campaign baseline)  n=2000 → 79.4%   n=5000 → 79.8%   n=500 → 79.4%
//     p=0.20                               n=2000 → 77.5%
//     p=0.10                               n=3000 → 76.0%
// So it is honest at the p≈0.40 we actually see, and MILDLY OPTIMISTIC (~4pp of power) on a
// low-engagement segment. If read rates on some future audience settle nearer 0.10–0.20, replace
// this with a two-term (Fleiss-style) formula rather than quietly accepting the shortfall.
function mde(p, n) {
  if (!(n > 0) || !(p > 0) || !(p < 1)) return null;
  return Z_POWER * Math.sqrt((2 * p * (1 - p)) / n) * 100;
}

// Pooled two-proportion z-test. Returns null when either arm has no denominator.
function zTest(r1, n1, r2, n2) {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = r1 / n1, p2 = r2 / n2;
  const pooled = (r1 + r2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!(se > 0)) return null;
  return (p1 - p2) / se;
}

const num = (v) => Number(v || 0);

function verdict(rawArms, ctx = {}) {
  const arms = (rawArms || []).map((a) => {
    const assigned = num(a.assigned), sent = num(a.sent), delivered = num(a.delivered);
    const read = num(a.read ?? a.read_count);
    const preSendFailed = num(a.preSendFailed ?? a.pre_send_failed);
    const providerFailed = num(a.providerFailed ?? a.provider_failed);
    return {
      label: a.label, assigned, sent, delivered, read, preSendFailed, providerFailed,
      readRate: sent > 0 ? read / sent : null,                       // PRIMARY (ITT)
      readRateOfDelivered: delivered > 0 ? read / delivered : null,  // diagnostic only
      // Denominator is ASSIGNED, not sent+failed. A pre-send failure never entered `sent`, so
      // `sent + failed` double-counts nothing but describes a different population per arm.
      preSendFailRate: assigned > 0 ? preSendFailed / assigned : null,
    };
  });

  const base = { arms, winner: null, z: null, mde: null,
                 deliveryDiffers: false, providerFailuresDiffer: false };
  if (arms.length < 2) {
    return { ...base, state: 'not_a_test',
      reason: 'This campaign sent a single version, so there is nothing to compare.' };
  }
  // ⚠️ The model takes N arms (spec §2) but this compares exactly two. Say so loudly rather than
  // silently comparing the first two and presenting it as the answer — a 3-arm test created
  // through the API would otherwise get a confident verdict about two-thirds of itself.
  if (arms.length > 2) {
    return { ...base, state: 'too_many_arms',
      reason: `This campaign has ${arms.length} versions. The result readout compares two at a `
        + 'time and cannot yet call a winner across more — compare them in the experiment log, or '
        + 'rerun with two versions.' };
  }

  const [a, b] = arms;
  const z = zTest(a.read, a.sent, b.read, b.sent);
  const pooled = (a.read + b.read) / Math.max(1, a.sent + b.sent);
  const nPerArm = Math.min(a.sent, b.sent);
  const detectable = mde(pooled || 0.4, nPerArm);
  const gapPp = Math.abs((a.readRate || 0) - (b.readRate || 0)) * 100;
  const out = { ...base, z, mde: detectable };

  // Is the DELIVERY rate itself different between arms? If so read÷delivered is confounded.
  // REPORTED, NEVER A REFUSAL — under ITT a delivery difference is part of the effect, and this
  // is also the clean evidence about whether content moves wa_131049 (spec §6).
  const zDeliv = zTest(a.delivered, a.sent, b.delivered, b.sent);
  out.deliveryDiffers = zDeliv !== null && Math.abs(zDeliv) > Z_CRIT;

  // Same for post-send provider failures (131049 and friends): they live INSIDE `sent` and
  // contribute zero reads, so ITT already counts them correctly. Surfacing them explains WHY an
  // arm lost; refusing on them would refuse exactly when the answer is real.
  const zProv = zTest(a.providerFailed, a.sent, b.providerFailed, b.sent);
  out.providerFailuresDiffer = zProv !== null && Math.abs(zProv) > Z_CRIT;

  // ⚠️ ONLY PRE-SEND failures trigger a refusal, and the distinction is the whole point.
  // A render failure (unresolved_variables) happens BEFORE the send, so those people never enter
  // `sent` — and they are not a random subset, they are precisely the profiles missing the field
  // that arm's template referenced. That silently changes who each arm was measured over.
  // Measured 2026-08-11: render failures 57 rows / 0 with sent_at; wa_131049 1,905 rows / all
  // with sent_at. Refusing on the latter would have been wrong.
  // Order matters: a biased sample must be caught BEFORE a significance test is quoted off it.
  const zFail = zTest(a.preSendFailed, a.assigned, b.preSendFailed, b.assigned);
  if (zFail !== null && Math.abs(zFail) > Z_CRIT) {
    return { ...out, state: 'asymmetric_failures',
      reason: 'The two versions failed BEFORE sending at different rates — usually one template '
        + 'referencing a variable the other does not, so it failed for everyone missing that '
        + 'field. The people each version actually reached are therefore different groups. This '
        + 'is a biased result, not merely a small one — do not act on it. The per-version failure '
        + 'reasons below will name the variable.' };
  }

  // hoursSinceSent is derived from the RPC's last_sent_at (the last ACTUAL send), never from
  // campaigns.updated_at — that column is bumped by the fan-out heartbeat and by any later edit,
  // so using it would reset a mature result to "still maturing" every time someone touched the
  // campaign.
  if (num(ctx.hoursSinceSent) < MATURITY_HOURS) {
    return { ...out, state: 'immature',
      reason: `Still arriving. Half of all reads land within about 30 minutes but 20% take more `
        + `than 3.6 hours, so give it ${MATURITY_HOURS} hours from the end of the send before `
        + `reading this.` };
  }

  if (z === null) {
    return { ...out, state: 'too_close', reason: 'Not enough data yet to compare the two versions.' };
  }

  if (Math.abs(z) > Z_CRIT) {
    return { ...out, state: 'winner', winner: (a.readRate > b.readRate ? a.label : b.label),
      reason: `${a.readRate > b.readRate ? a.label : b.label} did better, and the gap is larger `
        + `than chance would produce (p < 0.05).` };
  }

  // ⚠️ ORDER AND THE 0.5pp FLOOR BOTH MATTER. Without the floor, two arms that performed
  // IDENTICALLY (gap = 0) fall into 'underpowered' and the marketer is told "the difference is
  // 0.0 points but you can only detect 4.3" — technically true, useless, and it implies there is
  // a real difference being hidden by sample size. 'underpowered' means "there is a visible gap
  // your sample cannot support"; a nil gap means "they performed the same", which is too_close.
  if (detectable !== null && gapPp > 0.5 && gapPp < detectable) {
    return { ...out, state: 'underpowered',
      reason: `The difference is ${gapPp.toFixed(1)} points, but this audience can only reliably `
        + `detect about ${detectable.toFixed(1)}. You would need a bigger send to tell these two `
        + `apart — treat them as equal.` };
  }

  return { ...out, state: 'too_close',
    reason: 'The two versions are within the range chance alone would produce. Treat them as equal.' };
}

module.exports = { mde, zTest, verdict, MATURITY_HOURS, Z_CRIT, Z_POWER };
