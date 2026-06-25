// Broadcast campaigns — approval lifecycle + Queue-throttled fan-out.
// Fan-out uses a seed/continuation pattern: each queue message paginates a small
// recipient chunk (SENDS_PER_MSG) and self-enqueues the next cursor, so a single
// consumer invocation stays well under the 50-subrequest limit at any audience size.
const A = require('./auth.js');
const { send } = require('./send.js');

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
  await setStatus(env, id, { status: 'sending', audience_snapshot: reachable, sent_by: sentBy });
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
  const recs = (r.ok && Array.isArray(r.data)) ? r.data : [];

  for (const rec of recs) {
    if (!rec.address) continue;
    await send(env, {
      channel: camp.channel, purpose: camp.purpose, profileId: rec.profile_id, to: rec.address,
      templateId: camp.template_id, constants: camp.vars || {},
      source: `campaign:${campaignId}`, dedupKey: `campaign:${campaignId}:${rec.profile_id}`,
    });
  }

  if (recs.length === SENDS_PER_MSG) {
    // more remain → continue from the last profile_id
    await env.BROADCAST_QUEUE.send({ campaignId, after: recs[recs.length - 1].profile_id });
  } else {
    await setStatus(env, campaignId, { status: 'sent' });   // fan-out complete
  }
}

module.exports = { getCampaign, setStatus, needsApproval, reachableCount, startCampaign, processQueueMessage };
