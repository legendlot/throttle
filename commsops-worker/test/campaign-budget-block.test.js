// Pre-send guards (2026-08-15). Run: node test/campaign-budget-block.test.js
//
// TWO guards, one reason. A campaign's tail can be silently killed either by the BUDGET counter or
// by the QUIET-HOURS clock, and in both cases the skip is terminal, never retried, and invisible —
// the campaign still reads `sent`. S269 lost 4,228 recipients that way on the counter; the clock
// version was found on 2026-08-15 while sizing the Independence Day send. Both are now refused up
// front by startCampaign instead of discovered halfway through a fan-out.
//
// ⚠️ THESE TESTS MUST NOT DEPEND ON THE WALL CLOCK. The clock guard reads real IST time, so every
// quiet-hours window below is expressed RELATIVE to now via winStartingIn(). A fixed "21:00" here
// would pass all afternoon and fail the moment CI ran in the evening — and a suite that fails by
// time of day gets muted rather than fixed.
const assert = require('assert');
const A = require('../src/auth.js');
const G = require('../src/gate.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const CAMPROW = (over = {}) => ({ id: 'C', status: 'approved', segment_id: 'S', template_id: 'T',
  channel: 'whatsapp', purpose: 'marketing', name: 'Big Send', approved_by: 'u1', vars: {}, ...over });

const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String((m % 1440) % 60).padStart(2, '0')}`;
// A 2-hour quiet window opening `mins` from now. Caller keeps mins in (0, 1200) so "now" is never
// inside it and the window never wraps past midnight into the present.
const winStartingIn = (mins) => {
  const s = (G.istMinutes() + mins) % 1440;
  return [{ channel: 'whatsapp', enabled: true, start_time: hhmm(s), end_time: hhmm(s + 120) }];
};
const EXEMPT = [{ channel: 'whatsapp', enabled: false, start_time: '22:00', end_time: '08:00' }];

// `quiet` defaults to EXEMPT so the BUDGET tests are unaffected by the clock — each guard is
// tested in isolation, and a budget assertion must never fail because of the time of day.
function stub({ camp = CAMPROW(), reachable = 20000, quiet = EXEMPT,
  budget = { budget: 15000, used: 374, remaining: 14626 }, budgetOk = true, quietOk = true } = {}) {
  const seen = { claimed: false };
  // ⚠️ REQUIRED. getChannelQuietHours memoizes for SETTINGS_TTL_MS, so without this every test
  // after the first reads the first test's window and the guard appears not to fire — which is
  // how the first cut of this suite "passed" the exempt case and "failed" the blocked one, i.e.
  // exactly backwards. This is what gate.js exports _clearSettingsCache for.
  G._clearSettingsCache();
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('campaign_variants')) return { ok: true, data: [] };
    if (path.includes('channel_quiet_hours')) return quietOk ? { ok: true, data: quiet } : { ok: false, data: null };
    if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{ quiet_hours_start: 22, quiet_hours_end: 8 }] };
    if (path.includes('materialize_segment')) return { ok: true, data: null };
    if (path.includes('campaign_reach')) return { ok: true, data: [{ total: reachable, reachable, excluded: 0, sendable: reachable }] };
    if (path.includes('send_budget_status')) return budgetOk ? { ok: true, data: [budget] } : { ok: false, status: 500, data: null };
    if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') { seen.claimed = true; return { ok: true, data: [camp] }; }
    return { ok: true, data: [] };
  };
  return seen;
}
const ENV = { BROADCAST_QUEUE: { send: async () => {} } };
const RATE = CAMP.THROUGHPUT_PER_HOUR;

(async () => {
  // ── budget guard ────────────────────────────────────────────────────────────
  await t('audience larger than the remaining budget is REFUSED, nothing claimed', async () => {
    const seen = stub({ reachable: 94588 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.error, 'audience_exceeds_budget');
    assert.equal(r.sendable, 94588);
    assert.equal(r.remaining, 14626);          // the numbers must travel with the refusal
    assert.equal(seen.claimed, false, 'must NOT flip the campaign to sending');
  });

  await t('an audience that FITS sends normally', async () => {
    const seen = stub({ reachable: 12069 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.claimed, true);
  });

  await t('exactly equal to the remaining budget is allowed — the boundary is > not >=', async () => {
    stub({ reachable: 14626 });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1')).ok, true);
    stub({ reachable: 14627 });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1')).error, 'audience_exceeds_budget');
  });

  await t('allowPartial overrides the budget block', async () => {
    stub({ reachable: 94588 });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1', { allowPartial: true })).ok, true);
  });

  await t('transactional/utility are never BUDGET-blocked — they bypass the budget in gate.js', async () => {
    for (const purpose of ['utility', 'transactional']) {
      stub({ camp: CAMPROW({ purpose }), reachable: 94588 });
      const r = await CAMP.startCampaign(ENV, 'C', 'u1');
      assert.equal(r.ok, true, `${purpose}: ${JSON.stringify(r)}`);
    }
  });

  await t('no cap configured never blocks; an unreadable budget fails OPEN', async () => {
    stub({ reachable: 999999, budget: { budget: null, used: 0, remaining: null } });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1')).ok, true, 'null budget = no cap');
    stub({ reachable: 94588, budgetOk: false });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1')).ok, true,
      'a 500 must not become a phantom cap — gate.js still enforces the real one');
  });

  // ── quiet-hours clock guard ─────────────────────────────────────────────────
  await t('a send that cannot finish before quiet hours is REFUSED, with the numbers', async () => {
    // 1 hour of runway, an audience needing ~6 hours
    const seen = stub({ reachable: RATE * 6, quiet: winStartingIn(60),
      budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.error, 'wont_finish_before_quiet_hours', JSON.stringify(r));
    assert.equal(r.needMinutes, 360);
    assert.ok(r.minutesUntilQuiet >= 59 && r.minutesUntilQuiet <= 61, `got ${r.minutesUntilQuiet}`);
    // it must say how many WOULD be reached, or the sender cannot resize the audience
    assert.ok(r.reachableBeforeQuiet > 0 && r.reachableBeforeQuiet < RATE * 6);
    assert.equal(seen.claimed, false);
  });

  await t('a send with ample runway is allowed', async () => {
    const seen = stub({ reachable: RATE, quiet: winStartingIn(600),
      budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.claimed, true);
  });

  await t('the safety MARGIN is real — a send that only just fits is still refused', async () => {
    // needs 60 min, 80 min of runway: fits on paper, inside the 45-min margin, so refused.
    stub({ reachable: RATE, quiet: winStartingIn(80), budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.error, 'wont_finish_before_quiet_hours',
      'the estimate carries ramp-up error; being wrong costs customers who are never retried');
  });

  await t('the clock guard applies to UTILITY too — quiet hours are a channel rule, not a budget one', async () => {
    stub({ camp: CAMPROW({ purpose: 'utility' }), reachable: RATE * 6, quiet: winStartingIn(60) });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.error, 'wont_finish_before_quiet_hours', JSON.stringify(r));
  });

  await t('an EXEMPT channel (email) has no clock limit at any size', async () => {
    stub({ camp: CAMPROW({ channel: 'email', purpose: 'marketing' }), reachable: 500000,
      quiet: [{ channel: 'email', enabled: false, start_time: '22:00', end_time: '08:00' }],
      budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, 'email is exempt from quiet hours — it must never be clock-blocked');
  });

  await t('an unreadable quiet-hours table fails OPEN — refusing every campaign is its own outage', async () => {
    // Deliberately the OPPOSITE of gate.js, which fails closed there. gate.js is protecting the
    // customer from a 3am message; this is only an estimate, and the per-message gate still runs.
    stub({ reachable: RATE * 6, quietOk: false, budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  await t('allowPartial overrides the clock block too', async () => {
    stub({ reachable: RATE * 6, quiet: winStartingIn(60), budget: { budget: 999999, used: 0, remaining: 999999 } });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1', { allowPartial: true })).ok, true);
  });

  await t('BUDGET is judged before the clock — the cheaper, more certain refusal wins', async () => {
    // both guards would fire; the budget one is exact where the clock one is an estimate, so it is
    // the more useful thing to put in front of a sender.
    stub({ reachable: 94588, quiet: winStartingIn(60) });
    assert.equal((await CAMP.startCampaign(ENV, 'C', 'u1')).error, 'audience_exceeds_budget');
  });

  // ── the persisted override (for scheduled sends) ────────────────────────────
  await t('campaign.allow_partial overrides BOTH guards — the scheduler has nobody to ask', async () => {
    // Without this a large SCHEDULED broadcast is refused, alerts, stays scheduled and re-refuses
    // every five minutes: the guards reproducing the exact silent-non-send they exist to prevent.
    stub({ camp: CAMPROW({ allow_partial: true }), reachable: 94588, quiet: winStartingIn(60) });
    const r = await CAMP.startCampaign(ENV, 'C', 'scheduler');   // note: NO opts, like the cron
    assert.equal(r.ok, true, `persisted override must work without opts: ${JSON.stringify(r)}`);
  });

  await t('allow_partial must be strictly true — junk is never consent to a partial send', async () => {
    for (const v of ['true', 1, {}, 'yes']) {
      stub({ camp: CAMPROW({ allow_partial: v }), reachable: 94588 });
      const r = await CAMP.startCampaign(ENV, 'C', 'scheduler');
      assert.equal(r.error, 'audience_exceeds_budget', `${JSON.stringify(v)} must not override`);
    }
  });

  // ── resume after a quiet-hours tail ─────────────────────────────────────────
  await t('a SENT campaign is resumable — that is the only recovery for a quiet-hours tail', async () => {
    // send.js dedups on SUCCESS: a skipped row frees its dedup key and is retried on a later pass.
    // So the recipients a cutoff skipped are perfectly recoverable — but the fan-out flips the
    // campaign to `sent` on its final page, and until 2026-08-15 `sent` was not resumable, so the
    // only door to that retry was a hand-written DB PATCH.
    const seen = stub({ camp: CAMPROW({ status: 'sent' }), reachable: 12069 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, `a sent campaign must be resumable: ${JSON.stringify(r)}`);
    assert.equal(seen.claimed, true, 'and the atomic claim must accept `sent` too, or it fails as already_claimed');
  });

  await t('genuinely terminal statuses stay unsendable', async () => {
    for (const status of ['draft', 'pending_approval', 'sending']) {
      stub({ camp: CAMPROW({ status }), reachable: 100 });
      const r = await CAMP.startCampaign(ENV, 'C', 'u1');
      assert.equal(r.ok, false, `${status} must not be sendable`);
      assert.match(r.error, /not_sendable_from_/, `${status}: ${JSON.stringify(r)}`);
    }
  });

  // ── fan-out sharding (Task 4 reshaped: a FRESH send builds its roster first; the per-shard
  //     chain seeding now happens at build completion and is pinned in campaign-roster-build) ──
  await t('a big audience fixes its shard count at claim and enqueues the BUILD, not chains', async () => {
    const sent = [];
    stub({ reachable: 48481, budget: { budget: 999999, used: 0, remaining: 999999 } });
    const ENV2 = { BROADCAST_QUEUE: { send: async (m) => sent.push(m) } };
    const r = await CAMP.startCampaign(ENV2, 'C', 'u1', { allowPartial: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.building, true);
    assert.equal(r.shards, 5, '48,481 → ceil(48481/10000) = 5, fixed at claim time (§9.9)');
    assert.deepEqual(sent, [{ kind: 'build_roster', campaignId: 'C', after: null }]);
  });

  await t('a small audience gets shard_count 1 and the same single build seed', async () => {
    const sent = [];
    stub({ reachable: 400, budget: { budget: 999999, used: 0, remaining: 999999 } });
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async (m) => sent.push(m) } }, 'C', 'u1');
    assert.equal(r.shards, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'build_roster');
  });

  await t('shard count is CAPPED — a huge audience does not spawn unbounded chains', async () => {
    stub({ reachable: 5000000, budget: { budget: 9999999, used: 0, remaining: 9999999 } });
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async () => {} } }, 'C', 'u1', { allowPartial: true });
    assert.equal(r.shards, 6, 'capped at MAX_SHARDS, not audience/10000');
  });

  await t('a roster-resume RESETS shards_done and keeps the STORED shard_count', async () => {
    // Without the reset, a re-seeded campaign inherits the previous run's counter and the FIRST
    // chain to drain flips the whole thing to 'sent' while others are still sending. And the
    // resume must NEVER rewrite shard_count — roster rows are hashed with the stored value (§9.9).
    let patched = null; const sent = [];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW({ status: 'sent', shards_done: 5, shard_count: 5, allow_partial: true,
          roster_built_at: '2026-08-15T20:00:00Z', roster_size: 48167 })] };
      if (path.includes('campaign_variants')) return { ok: true, data: [] };
      if (path.includes('channel_quiet_hours')) return { ok: true, data: EXEMPT };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{}] };
      if (path.includes('materialize_segment')) return { ok: true, data: null };
      if (path.includes('campaign_reach')) return { ok: true, data: [{ total: 48481, reachable: 48481, excluded: 0, sendable: 48481 }] };
      if (path.includes('send_budget_status')) return { ok: true, data: [{ budget: 999999, used: 0, remaining: 999999 }] };
      if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') {
        patched = JSON.parse(opts.body); return { ok: true, data: [CAMPROW()] };
      }
      return { ok: true, data: [] };
    };
    G._clearSettingsCache();
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async (m) => sent.push(m) } }, 'C', 'u1');
    assert.equal(patched.shards_done, 0, 'must reset');
    assert.ok(!('shard_count' in patched), 'stored shard_count untouched on resume');
    assert.equal(r.audience, 48167, 'audience from the frozen roster');
    assert.equal(sent.length, 5, 'chains seeded from the STORED count');
  });

  await t('a roster-RESUME is guarded on the REMAINING work, not the live audience', async () => {
    // Found on the final verification pass: resuming a 48k campaign with 297 never-attempted was
    // judged as a 48k send — budget/clock/approval all read the wrong number and could refuse a
    // resume that would actually send a few hundred. The guards now read recon.never_attempted
    // when a roster exists (an undercount by design — freed failed/skipped rows also retry; the
    // per-message gate stays authoritative).
    const sent = [];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW({ status: 'sent', shard_count: 5, allow_partial: false,
          roster_built_at: '2026-08-15T20:00:00Z', roster_size: 48167 })] };
      if (path.includes('campaign_variants')) return { ok: true, data: [] };
      if (path.includes('channel_quiet_hours')) return { ok: true, data: EXEMPT };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{}] };
      if (path.includes('materialize_segment')) return { ok: true, data: null };
      if (path.includes('campaign_reach')) return { ok: true, data: [{ total: 48481, reachable: 48481, excluded: 0, sendable: 48481 }] };
      if (path.includes('campaign_recon')) return { ok: true, data: [{ roster_size: 48167, attempted: 47870, never_attempted: 297 }] };
      if (path.includes('send_budget_status')) return { ok: true, data: [{ budget: 65000, used: 64500, remaining: 500 }] };
      if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') return { ok: true, data: [CAMPROW()] };
      return { ok: true, data: [] };
    };
    G._clearSettingsCache();
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async (m) => sent.push(m) } }, 'C', 'u1');
    assert.equal(r.ok, true, `297 remaining must fit a 500 budget that 48,481 would fail: ${JSON.stringify(r)}`);
    assert.equal(sent.length, 5, 'chains seeded');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
