// Broadcast campaigns — approval lifecycle + Queue-throttled fan-out.
// Fan-out uses a seed/continuation pattern: each queue message paginates a small
// recipient chunk (SENDS_PER_MSG) and self-enqueues the next cursor, so a single
// consumer invocation stays well under the 50-subrequest limit at any audience size.
const A = require('./auth.js');
const { send } = require('./send.js');
const G = require('./gate.js');

const SENDS_PER_MSG = 4;   // recipients handled per consumer invocation (~8 subreq each → safe)
const nowIso = () => new Date().toISOString();

async function getCampaign(env, id) {
  const r = await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
async function setStatus(env, id, patch) {
  return A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(id)}`, env,
    { method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: nowIso() }) });
}
async function getSettings(env) {
  const r = await A.sbComms('/rest/v1/settings?id=eq.1&select=*&limit=1', env);
  return (r.ok && r.data?.[0]) || {};
}

// Does this campaign need an approver before it can send?
async function needsApproval(env, campaign, audienceCount) {
  const s = await getSettings(env);
  return campaign.purpose === 'marketing'
      && s.approval_required_marketing !== false
      && Number(audienceCount || 0) > Number(s.approval_audience_threshold ?? 500);
}

async function reachableCount(env, segmentId, channel, purpose) {
  // materialize first so the count reflects the live segment, then preview the definition
  await A.sbComms('/rest/v1/rpc/materialize_segment', env, { method: 'POST', body: JSON.stringify({ p_segment_id: segmentId }) });
  const seg = await A.sbComms(`/rest/v1/segments?id=eq.${A.enc(segmentId)}&select=definition&limit=1`, env);
  const def = (seg.ok && seg.data?.[0]?.definition) || {};
  const r = await A.sbComms('/rest/v1/rpc/preview_segment', env,
    { method: 'POST', body: JSON.stringify({ p_def: def, p_channel: channel, p_purpose: purpose }) });
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return { total: Number(row?.total || 0), reachable: Number(row?.reachable || 0) };
}

// Kick off a broadcast: snapshot, set sending, enqueue the first fan-out seed.
async function startCampaign(env, id, sentBy) {
  const camp = await getCampaign(env, id);
  if (!camp) return { ok: false, error: 'not_found' };
  if (!['approved', 'scheduled'].includes(camp.status))
    return { ok: false, error: `not_sendable_from_${camp.status}` };
  if (!camp.segment_id || !camp.template_id) return { ok: false, error: 'segment_and_template_required' };

  const { reachable } = await reachableCount(env, camp.segment_id, camp.channel, camp.purpose);

  // Approval was judged on the SUBMIT-time audience; a dynamic segment may have grown past the
  // threshold since. A human-approved campaign (approved_by set) stands; an auto-approved one
  // that outgrew the threshold goes back for eyes (review M2).
  if (!camp.approved_by && await needsApproval(env, camp, reachable)) {
    await setStatus(env, id, { status: 'pending_approval', audience_snapshot: reachable });
    return { ok: false, error: 'audience_grew_needs_approval' };
  }

  // Atomic claim (M9): flip approved/scheduled → sending ONLY if still approved/scheduled,
  // so the M9 scheduler sweep and a concurrent manual "Send now" can't both fan out the same
  // campaign. sbComms defaults to Prefer: return=representation → an empty array means another
  // actor already claimed it.
  const claim = await A.sbComms(
    `/rest/v1/campaigns?id=eq.${A.enc(id)}&status=in.(approved,scheduled)`, env,
    { method: 'PATCH', body: JSON.stringify({
        status: 'sending', audience_snapshot: reachable, sent_by: sentBy, updated_at: nowIso() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0)
    return { ok: false, error: 'already_claimed' };
  await env.BROADCAST_QUEUE.send({ campaignId: id, after: null });
  return { ok: true, audience: reachable };
}

// Consumer: process one fan-out message (paginate → send → continue or finish).
async function processQueueMessage(env, body) {
  const { campaignId, after } = body;
  const camp = await getCampaign(env, campaignId);
  if (!camp || camp.status !== 'sending') return;     // cancelled/finished → stop

  const r = await A.sbComms('/rest/v1/rpc/campaign_recipients', env, {
    method: 'POST',
    body: JSON.stringify({ p_segment_id: camp.segment_id, p_channel: camp.channel,
      p_purpose: camp.purpose, p_after: after, p_limit: SENDS_PER_MSG }),
  });
  // An RPC failure is NOT "fan-out complete" (review C2): throw → Queues redeliver this page →
  // after max retries it DLQs with an alert. Only a genuine short page may finish the campaign.
  if (!r.ok) throw new Error(`campaign_recipients_failed:${campaignId}:${r.status}`);
  const recs = Array.isArray(r.data) ? r.data : [];

  let pageErrors = 0;
  for (const rec of recs) {
    if (!rec.address) continue;
    try {
      await send(env, {
        channel: camp.channel, purpose: camp.purpose, profileId: rec.profile_id, to: rec.address,
        templateId: camp.template_id, constants: camp.vars || {},
        tracking: { campaign: camp.name, utm: camp.utm },
        source: `campaign:${campaignId}`, dedupKey: `campaign:${campaignId}:${rec.profile_id}`,
      });
    } catch (e) {
      // One bad recipient must not poison the page (review H3). The dedup row (Task 1) lets a
      // later manual replay retry this profile; the rest of the audience continues now.
      pageErrors++;
      console.log('campaign_recipient_error', campaignId, rec.profile_id, e?.message || String(e));
    }
  }
  if (pageErrors) console.log('campaign_page_errors', campaignId, pageErrors);

  // Page-progress heartbeat for the stall sweep (index.js runScheduled '1b' alerts on
  // campaigns.updated_at stale >30 min while status='sending'). startCampaign only stamps
  // updated_at at claim time, so a long-but-healthy broadcast (many pages, serial queue
  // continuation) would look identical to a dead chain and re-alert every 5-min tick. Bumping
  // it here means a campaign whose pages are still flowing never trips the sweep — only a
  // genuinely stuck chain does (which then keeps re-alerting each tick until resolved —
  // intended nagging for a real incident). Scoped to status=eq.sending so a campaign that
  // finished/was cancelled between the read above and here is never touched; best-effort —
  // must not throw (a missed bump only risks one alert, a throw would retry the whole page).
  await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}&status=eq.sending`, env,
    { method: 'PATCH', body: JSON.stringify({ updated_at: nowIso() }) }).catch((e) => {
      console.log('campaign_heartbeat_error', campaignId, e?.message || String(e));
    });

  if (recs.length === SENDS_PER_MSG) {
    // more remain → continue from the last profile_id
    await env.BROADCAST_QUEUE.send({ campaignId, after: recs[recs.length - 1].profile_id });
  } else {
    await setStatus(env, campaignId, { status: 'sent' });   // fan-out complete
  }
}

// ── Send test ────────────────────────────────────────────────────────────────
// Send the campaign's own template to a handful of named addresses, without a segment,
// an approval or a fan-out. What a marketer actually wants before pressing go: does this
// render, and does it look right on a real handset.
//
// Deliberate choices:
//  · source = 'campaign_test:<id>', NOT 'campaign:<id>'. campaign_stats_list joins on
//    exact `source = 'campaign:'||id`, so test sends stay OUT of the campaign's own
//    sent/delivered/read/cost figures. A test that quietly skewed the numbers it exists to
//    help you read would be worse than no test at all.
//  · NO dedup_key — you must be able to test the same campaign repeatedly. The broadcast
//    path keeps its dedup; this path is explicitly operator-driven and repeatable.
//  · The send gate is NOT bypassed. test_mode, suppression, consent, quiet hours and the
//    frequency cap all still apply, and a skip is reported with its reason. Bypassing would
//    make the test a poor rehearsal AND a way to message a suppressed customer.
//  · The recipient's PROFILE is resolved from the address where one exists, so variables
//    render against real data. Without it, any template with variables throws
//    `unresolved_variables` — so the profile lookup is what makes the test meaningful.
const MAX_TEST_RECIPIENTS = 5;   // a test, not a side-door broadcast

async function profileIdForAddress(env, channel, address) {
  const type = channel === 'whatsapp' ? 'phone' : 'email';
  const value = channel === 'whatsapp' ? String(address).replace(/[^\d+]/g, '') : String(address).trim().toLowerCase();
  const r = await A.sbComms(
    `/rest/v1/identifiers?type=eq.${type}&value=eq.${A.enc(value)}&select=profile_id&limit=1`, env);
  return (r.ok && r.data?.[0]?.profile_id) || null;
}

// `draft` carries the UNSAVED form state (vars / template_id / channel / purpose). The test must
// exercise what is ON SCREEN, not what was last saved — otherwise the preview and the test
// disagree, which is exactly how someone concludes their values "don't work" when they were
// simply never persisted. Anything the caller omits falls back to the stored campaign.
async function sendCampaignTest(env, { id, to, draft }) {
  const stored = await getCampaign(env, id);
  if (!stored) return { ok: false, error: 'not_found' };
  const d = draft || {};
  const camp = {
    ...stored,
    channel: d.channel || stored.channel,
    purpose: d.purpose || stored.purpose,
    template_id: d.template_id || stored.template_id,
    vars: d.vars && typeof d.vars === 'object' ? d.vars : stored.vars,
  };
  if (!camp.template_id) return { ok: false, error: 'template_required' };

  const list = (Array.isArray(to) ? to : String(to || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_TEST_RECIPIENTS);
  if (!list.length) return { ok: false, error: 'no_recipients' };

  const results = [];
  for (const addr of list) {
    // Test sends are hard-locked to the TEST union (test_mode_allow ∪ test_allowlist) —
    // Afshaan's S230 rule: a test reaches only the number entered AND only if it is a
    // test address; anything else surfaces as a per-recipient block the UI can offer to
    // allowlist. (Previously, with test_mode OFF, this path could reach ANY address.)
    if (!(await G.testRecipientAllowed(env, addr))) {
      results.push({ to: addr, profile_matched: false, status: 'blocked', reason: 'not_on_test_allowlist' });
      continue;
    }
    const profileId = await profileIdForAddress(env, camp.channel, addr);
    try {
      const r = await send(env, {
        channel: camp.channel, purpose: camp.purpose, isTest: true,
        profileId, to: addr,
        templateId: camp.template_id,
        constants: camp.vars || {},
        tracking: { campaign: `${camp.name} (test)`, utm: camp.utm },
        source: `campaign_test:${id}`,
      });
      results.push({ to: addr, profile_matched: !!profileId, status: r?.status || 'unknown', reason: r?.reason || null });
    } catch (e) {
      // Surface unresolved_variables verbatim — naming the missing tokens IS the useful
      // result here, not an incidental error.
      results.push({ to: addr, profile_matched: !!profileId, status: 'failed', reason: String(e?.message || e) });
    }
  }
  return { ok: true, results, capped: (Array.isArray(to) ? to.length : list.length) > MAX_TEST_RECIPIENTS };
}

module.exports = { getCampaign, setStatus, needsApproval, reachableCount, startCampaign, processQueueMessage, sendCampaignTest };
