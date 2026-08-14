// Broadcast campaigns — approval lifecycle + Queue-throttled fan-out.
// Fan-out uses a seed/continuation pattern: each queue message paginates a small
// recipient chunk (SENDS_PER_MSG) and self-enqueues the next cursor, so a single
// consumer invocation stays well under the subrequest limit at any audience size.
const A = require('./auth.js');
const { send } = require('./send.js');
const G = require('./gate.js');
const { pickVariant } = require('./variants.js');

// Recipients handled per consumer invocation (~8 subrequests each).
//
// ⚠️ THIS IS NOT THE THROUGHPUT DIAL. Raising it 4 → 12 on 2026-08-14, mid-flight on a live
// broadcast, moved the rate from 796/hour to 858 — i.e. not at all. Do not reach for it again
// expecting more sends; it was believed to carry "~20× headroom" for months and it does not.
//
// It sat at 4 because it was sized against the **Cloudflare FREE-plan 50-subrequest ceiling**
// (4 × 8 = 32, "safely under 50"). LOT is on Paid, where the ceiling is 10,000, so that
// reasoning was obsolete — but removing a false limit is not the same as finding the real one,
// and that is the mistake this comment exists to stop the next person repeating. The old
// comment said "→ safe" without naming what it was safe against, which is how it survived.
//
// WHAT ACTUALLY BINDS, measured off per-send timestamps: sends are spaced a near-constant
// ~4.02s, with a ~5.4s gap every SENDS_PER_MSG sends (the page boundary). So the queue hop
// costs ~5s ONCE PER PAGE against 12 × 4.02 ≈ 48s of work — it is noise. The constraint is
// ~4 SECONDS OF SERIAL WORK PER RECIPIENT: the loop below is `for … await send`, one recipient
// fully completing before the next starts, each ~8 sequential subrequests (render → gate →
// dedup reserve → provider → status write) at roughly 500ms apiece. The arithmetic closes both
// ways: 4 × 4.02 + hop ≈ 17s per 4 = 14/min; 12 × 4.02 + hop ≈ 53s per 12 = 14/min.
//
// The real lever is CONCURRENCY INSIDE THE PAGE (parallel batches), which scales near-linearly.
// ⚠️ Cap it at 4–6 concurrent, NOT at the page size: Meta's tier (100k/24h ≈ 4,166/hour) binds
// there, and overshooting hammers a provider on live customer sends. Not built — BACKLOG [relay].
const SENDS_PER_MSG = 12;
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

// ⚠️ THROWS on a read failure — never returns [] as a fallback.
// A soft failure here is silently catastrophic: `[]` means "no variants", which sends
// campaigns.template_id — i.e. ARM A FOR EVERYONE. A transient 5xx thirty minutes into a fan-out
// would produce a campaign that is half a clean A/B and half all-A, with nothing in the data
// marking the boundary, and a verdict computed off it that looks perfectly fine.
// Throwing lets Queues redeliver the page and eventually DLQ with an alert — the same rule and
// the same reasoning as the campaign_recipients guard below (review C2).
async function loadVariants(env, campaignId) {
  const r = await A.sbComms(
    `/rest/v1/campaign_variants?campaign_id=eq.${A.enc(campaignId)}`
    + `&select=id,label,template_id,weight,sort_order&order=sort_order.asc,label.asc`, env);
  if (!r.ok) throw new Error(`campaign_variants_failed:${campaignId}:${r.status}`);
  return Array.isArray(r.data) ? r.data : [];
}

// Does this campaign need an approver before it can send?
async function needsApproval(env, campaign, audienceCount) {
  const s = await getSettings(env);
  return campaign.purpose === 'marketing'
      && s.approval_required_marketing !== false
      && Number(audienceCount || 0) > Number(s.approval_audience_threshold ?? 500);
}

// The three audience-exclusion rules a campaign may carry (S276). Read straight off the row so
// every caller (submit, send, fan-out, reach preview) uses the same values — a campaign that is
// past draft is immutable, so these are frozen from submit onward exactly like segment/template.
function exclusionArgs(camp) {
  return {
    p_exclude_segments: Array.isArray(camp.exclude_segment_ids) ? camp.exclude_segment_ids : [],
    p_exclude_campaigns: Array.isArray(camp.exclude_campaign_ids) ? camp.exclude_campaign_ids : [],
    p_exclude_contacted_hours: camp.exclude_contacted_hours ?? null,
  };
}

// ⚠️ Exclusion segments are read from comms.segment_members, which is materialized DELETE+INSERT
// (PATTERN-176) — a segment nobody has rebuilt lately holds a STALE member set. For the TARGET
// segment that only mis-sizes the audience; for an EXCLUSION segment it silently lets through
// people it was supposed to hold back. So materialize every one of them before we count or send.
// Best-effort per segment: one unmaterializable exclusion must not block the whole campaign, and
// the send-time predicate still applies against whatever members it does have.
async function materializeExclusions(env, camp) {
  const ids = Array.isArray(camp.exclude_segment_ids) ? camp.exclude_segment_ids.filter(Boolean) : [];
  for (const id of ids) {
    const r = await A.sbComms('/rest/v1/rpc/materialize_segment', env,
      { method: 'POST', body: JSON.stringify({ p_segment_id: id }) });
    if (!r.ok) console.log('exclusion_segment_materialize_failed', camp.id, id, r.status);
  }
}

// total / reachable / excluded / sendable for a campaign's audience.
// `sendable` (reachable MINUS the exclusion rules) is the number that will actually receive a
// message, and is therefore what audience_snapshot and the approval threshold are judged on —
// approving "25,067" for a send that reaches 2,571 is approving a number that does not exist.
// The count and the fan-out share ONE predicate (comms.campaign_excluded) so they cannot drift.
async function reachableCount(env, camp) {
  const segmentId = camp.segment_id;
  // materialize first so the counts reflect the live segments, target + exclusions
  await A.sbComms('/rest/v1/rpc/materialize_segment', env, { method: 'POST', body: JSON.stringify({ p_segment_id: segmentId }) });
  await materializeExclusions(env, camp);
  const r = await A.sbComms('/rest/v1/rpc/campaign_reach', env, {
    method: 'POST',
    body: JSON.stringify({ p_segment_id: segmentId, p_channel: camp.channel, p_purpose: camp.purpose,
      ...exclusionArgs(camp) }),
  });
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  const reachable = Number(row?.reachable || 0);
  const excluded = Number(row?.excluded || 0);
  return { total: Number(row?.total || 0), reachable, excluded,
    sendable: Number(row?.sendable ?? Math.max(reachable - excluded, 0)) };
}

// Kick off a broadcast: snapshot, set sending, enqueue the first fan-out seed.
async function startCampaign(env, id, sentBy) {
  const camp = await getCampaign(env, id);
  if (!camp) return { ok: false, error: 'not_found' };
  // 'stopped' is RESUMABLE (S279) — a stopped broadcast restarts through this same path rather
  // than needing separate resume machinery, because send.js's dedup already gives exactly the
  // right semantics: a prior sent-like row dedups (nobody is messaged twice) while a prior
  // skipped/failed row is ADOPTED (the tail actually gets retried). Without this, Stop would be
  // terminal and would recreate, one step earlier, the very gap it was built to close — a
  // part-sent campaign nobody can finish.
  // ⚠️ Resume re-fans from the START of the recipient list (after: null), so an audience that is
  // half done pays a fast dedup no-op for everyone already reached. Correct, just not free.
  if (!['approved', 'scheduled', 'stopped'].includes(camp.status))
    return { ok: false, error: `not_sendable_from_${camp.status}` };
  if (!camp.segment_id || !camp.template_id) return { ok: false, error: 'segment_and_template_required' };

  // Every arm must be sendable BEFORE a single message goes out. Discovering an unapproved
  // template mid-fan-out leaves a half-run experiment that can never be completed or compared.
  //
  // ⚠️ loadVariants THROWS by design (it must, in the fan-out). Here that would surface as an
  // unhandled 500 on a button press, so catch it and return a normal error result.
  let variants;
  try { variants = await loadVariants(env, id); }
  catch { return { ok: false, error: 'variants_unreadable' }; }

  if (variants.length >= 1) {
    const ids = variants.map((v) => v.template_id).filter(Boolean);
    // ⚠️ An all-holdout set leaves ids empty, and `id=in.()` is a malformed PostgREST filter.
    if (ids.length === 0) return { ok: false, error: 'no_sendable_arm' };
    const tr = await A.sbComms(
      `/rest/v1/templates?id=in.(${ids.map(A.enc).join(',')})&select=id,name,approval_status`, env);
    if (!tr.ok) return { ok: false, error: 'variant_templates_unreadable' };
    const byId = new Map((tr.data || []).map((t) => [t.id, t]));
    for (const v of variants) {
      if (!v.template_id) continue;                      // holdout arm — nothing to approve
      const t = byId.get(v.template_id);
      if (!t) return { ok: false, error: `variant_${v.label}_template_missing` };
      if (camp.channel === 'whatsapp' && String(t.approval_status || '').toUpperCase() !== 'APPROVED')
        return { ok: false, error: `variant_${v.label}_template_not_approved` };
    }
  }

  const { sendable } = await reachableCount(env, camp);

  // Approval was judged on the SUBMIT-time audience; a dynamic segment may have grown past the
  // threshold since. A human-approved campaign (approved_by set) stands; an auto-approved one
  // that outgrew the threshold goes back for eyes (review M2).
  if (!camp.approved_by && await needsApproval(env, camp, sendable)) {
    await setStatus(env, id, { status: 'pending_approval', audience_snapshot: sendable });
    return { ok: false, error: 'audience_grew_needs_approval' };
  }

  // Atomic claim (M9): flip approved/scheduled/stopped → sending ONLY if still in one of those,
  // so the M9 scheduler sweep and a concurrent manual "Send now" can't both fan out the same
  // campaign. sbComms defaults to Prefer: return=representation → an empty array means another
  // actor already claimed it.
  // ⚠️ Keep this list in step with the guard above — they are the same gate written twice, and a
  // status accepted there but missing here fails as the misleading 'already_claimed'.
  const claim = await A.sbComms(
    `/rest/v1/campaigns?id=eq.${A.enc(id)}&status=in.(approved,scheduled,stopped)`, env,
    { method: 'PATCH', body: JSON.stringify({
        status: 'sending', audience_snapshot: sendable, sent_by: sentBy, updated_at: nowIso() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0)
    return { ok: false, error: 'already_claimed' };
  await env.BROADCAST_QUEUE.send({ campaignId: id, after: null });
  return { ok: true, audience: sendable };
}

// Consumer: process one fan-out message (paginate → send → continue or finish).
async function processQueueMessage(env, body) {
  const { campaignId, after } = body;
  const camp = await getCampaign(env, campaignId);
  if (!camp || camp.status !== 'sending') return;     // cancelled/finished → stop
  const variants = await loadVariants(env, campaignId);

  // Exclusions are re-evaluated on EVERY page, not snapshotted at start (S276). A fan-out runs
  // for hours at ~1,200/hr, so a snapshot would happily message someone another campaign reached
  // while this one was still going — which is the case the feature exists for. The predicate also
  // counts a fresh 'queued' row as contacted, so two campaigns running CONCURRENTLY exclude each
  // other rather than racing between reserve and send.
  const r = await A.sbComms('/rest/v1/rpc/campaign_recipients', env, {
    method: 'POST',
    body: JSON.stringify({ p_segment_id: camp.segment_id, p_channel: camp.channel,
      p_purpose: camp.purpose, p_after: after, p_limit: SENDS_PER_MSG,
      ...exclusionArgs(camp) }),
  });
  // An RPC failure is NOT "fan-out complete" (review C2): throw → Queues redeliver this page →
  // after max retries it DLQs with an alert. Only a genuine short page may finish the campaign.
  if (!r.ok) throw new Error(`campaign_recipients_failed:${campaignId}:${r.status}`);
  const recs = Array.isArray(r.data) ? r.data : [];

  // ── Bounded-concurrency send pool (S279) ──────────────────────────────────────────────────
  // The page used to run `for … await send`, one recipient fully completing before the next
  // began, which measured a near-constant 4.02s per recipient = 796–858/hour whatever
  // SENDS_PER_MSG was set to. THIS is the throughput lever; the page size is not (see the
  // SENDS_PER_MSG comment). A pool rather than chunked Promise.all so one slow send does not
  // hold up four finished ones.
  //
  // ⚠️ CAPPED AT 5 BY META, NOT BY US. The tier is 100k/24h ≈ 4,166/hour sustained; 5 concurrent
  // at ~4s/send lands near 3,000/hour, safely under. Do NOT raise this to "go faster" without
  // re-reading that tier — the failure mode is hammering a provider on live customer sends, and
  // a quality-rating drop throttles every LOT number, not just this campaign.
  //
  // ⚠️ `recs` MUST NOT BE REORDERED. The continuation cursor below is recs[recs.length-1] and
  // the completion test is recs.length === SENDS_PER_MSG — both are positional, so the pool
  // indexes into a filtered COPY and leaves `recs` untouched. Completion order is irrelevant.
  //
  // Safe to parallelise, checked rather than assumed: recipients within a page are distinct
  // profiles (campaign_recipients is keyset-paginated by profile_id), so no two concurrent sends
  // touch the same profile's frequency cap; the send budget is an atomic consume_send_budget()
  // RPC per send, so the cap still holds exactly; gate.js's two module-level caches are
  // read-mostly with a TTL, so the worst case is a few duplicate settings fetches on a cold
  // cache; and send() keeps all per-send state on its own opts object.
  const SEND_CONCURRENCY = 5;
  let pageErrors = 0;
  const queue = recs.filter((r) => r.address);
  let nextIdx = 0;
  const runOne = async (rec) => {
    try {
      // Per-recipient assignment INSIDE the page — never "all of A then all of B". The fan-out
      // runs for hours, so batching by arm would push B later in the day and the test would
      // measure time-of-day rather than copy.
      const arm = pickVariant(campaignId, rec.profile_id, variants);
      // ⚠️ THREE states here, not two, and collapsing them sends real messages to people who
      // were meant to receive nothing:
      //   arm === null            → no variants at all → normal campaign, use camp.template_id
      //   arm.template_id == null → a HOLDOUT arm      → send NOTHING, deliberately
      //   otherwise               → a real arm         → use its template
      // `arm?.template_id || camp.template_id` collapsed the middle case into the first.
      if (arm && !arm.template_id) return;     // holdout — no message, by design
      await send(env, {
        channel: camp.channel, purpose: camp.purpose, profileId: rec.profile_id, to: rec.address,
        templateId: arm?.template_id || camp.template_id,
        variantId: arm?.id || null,
        constants: camp.vars || {},
        tracking: { campaign: camp.name, utm: camp.utm },
        source: `campaign:${campaignId}`, dedupKey: `campaign:${campaignId}:${rec.profile_id}`,
      });
    } catch (e) {
      // One bad recipient must not poison the page (review H3). The dedup row (Task 1) lets a
      // later manual replay retry this profile; the rest of the audience continues now.
      pageErrors++;
      console.log('campaign_recipient_error', campaignId, rec.profile_id, e?.message || String(e));
    }
  };
  // Pull-from-shared-index pool. `nextIdx++` needs no lock — JS is single-threaded, and the
  // increment cannot be interleaved because there is no await between read and write.
  const worker = async () => {
    for (let i = nextIdx++; i < queue.length; i = nextIdx++) await runOne(queue[i]);
  };
  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));

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
async function sendCampaignTest(env, { id, to, draft, variantId }) {
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

  // Which ARM is being previewed. Without this the test send always shows arm A.
  let templateId = camp.template_id;
  if (variantId) {
    const vr = await A.sbComms(
      `/rest/v1/campaign_variants?id=eq.${A.enc(variantId)}&campaign_id=eq.${A.enc(id)}`
      + `&select=id,label,template_id&limit=1`, env);
    const v = vr.ok && vr.data?.[0];
    if (!v) return { ok: false, error: 'variant_not_found' };
    if (!v.template_id) return { ok: false, error: 'holdout_arm_has_nothing_to_send' };
    templateId = v.template_id;
  }

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
        templateId,
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

module.exports = { getCampaign, setStatus, needsApproval, reachableCount, startCampaign, processQueueMessage, sendCampaignTest,
  // S276 exclusions — exported for unit tests
  exclusionArgs, materializeExclusions };
