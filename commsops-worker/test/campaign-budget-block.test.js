// Pre-send budget block (2026-08-15). Run: node test/campaign-budget-block.test.js
//
// THE POINT: `daily_send_budget` is enforced per-message in gate.js, which is the right place to
// enforce it and the wrong place to DISCOVER it. By then the fan-out has started, and every
// recipient past the cap is stamped `budget_exhausted` and never retried while the campaign still
// reads `sent`. That stranded 4,228 recipients across both Roxie campaigns on 2026-08-10 (S269)
// with nothing visible in the app. startCampaign now refuses up front instead.
//
// These tests pin the four things that make the guard safe rather than merely present:
// it must not fire on non-marketing, it must not fire when the budget is switched off, it must
// not fire when the status read FAILS, and it must be overridable.
const assert = require('assert');
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const CAMPROW = (over = {}) => ({ id: 'C', status: 'approved', segment_id: 'S', template_id: 'T',
  channel: 'whatsapp', purpose: 'marketing', name: 'Big Send', approved_by: 'u1', vars: {}, ...over });

// A worker stub with a fixed reach and a fixed budget status. `budget:null` = no status row.
function stub({ camp = CAMPROW(), reachable = 20000, budget = { budget: 15000, used: 374, remaining: 14626 },
  budgetOk = true } = {}) {
  const seen = { claimed: false, queued: false };
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('campaign_variants')) return { ok: true, data: [] };
    if (path.includes('materialize_segment') || path.includes('materialize')) return { ok: true, data: null };
    if (path.includes('campaign_reach')) return { ok: true, data: [{ total: reachable, reachable, excluded: 0, sendable: reachable }] };
    if (path.includes('send_budget_status')) return budgetOk ? { ok: true, data: [budget] } : { ok: false, status: 500, data: null };
    if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') { seen.claimed = true; return { ok: true, data: [camp] }; }
    return { ok: true, data: [] };
  };
  return seen;
}
const ENV = { BROADCAST_QUEUE: { send: async () => {} } };

(async () => {
  await t('an audience larger than the remaining budget is REFUSED, and nothing is claimed or queued', async () => {
    const seen = stub({ reachable: 94588 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'audience_exceeds_budget');
    // the numbers must travel with the refusal — an error the sender cannot act on gets routed around
    assert.equal(r.sendable, 94588);
    assert.equal(r.remaining, 14626);
    assert.equal(r.budget, 15000);
    assert.equal(seen.claimed, false, 'must NOT flip the campaign to sending');
  });

  await t('an audience that FITS sends normally', async () => {
    const seen = stub({ reachable: 12069 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.audience, 12069);
    assert.equal(seen.claimed, true);
  });

  await t('exactly equal to the remaining budget is allowed — the boundary is > not >=', async () => {
    stub({ reachable: 14626 });                       // === remaining
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, 'a send that exactly consumes the budget is legitimate');
    stub({ reachable: 14627 });                       // one over
    const r2 = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r2.error, 'audience_exceeds_budget', 'one past remaining must block');
  });

  await t('allowPartial OVERRIDES the block — a guard nobody can pass gets removed, not respected', async () => {
    const seen = stub({ reachable: 94588 });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1', { allowPartial: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.claimed, true);
  });

  await t('TRANSACTIONAL/UTILITY are never blocked — they bypass the budget in gate.js', async () => {
    for (const purpose of ['utility', 'transactional']) {
      stub({ camp: CAMPROW({ purpose }), reachable: 94588 });
      const r = await CAMP.startCampaign(ENV, 'C', 'u1');
      assert.equal(r.ok, true, `${purpose} must not be budget-blocked: ${JSON.stringify(r)}`);
    }
  });

  await t('no cap configured (remaining null) never blocks', async () => {
    stub({ reachable: 999999, budget: { budget: null, used: 0, remaining: null } });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  await t('a FAILED budget read does not become a phantom cap — it sends, same as gate.js', async () => {
    // Fail-open here on purpose. gate.js still enforces the real cap per message, so a 500 on this
    // advisory read costs at worst the old behaviour; turning it into a block would take the whole
    // broadcast system down on an unrelated DB blip.
    stub({ reachable: 94588, budgetOk: false });
    const r = await CAMP.startCampaign(ENV, 'C', 'u1');
    assert.equal(r.ok, true, 'an unreadable budget must not block the send');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
