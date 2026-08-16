// Broadcast campaigns — approval lifecycle + Queue-throttled fan-out.
// Fan-out uses a seed/continuation pattern: each queue message paginates a small
// recipient chunk (SENDS_PER_MSG) and self-enqueues the next cursor, so a single
// consumer invocation stays well under the subrequest limit at any audience size.
const A = require('./auth.js');
const { send } = require('./send.js');
const G = require('./gate.js');
const { pickVariant } = require('./variants.js');
const AL = require('./alerts.js');   // build-completion park alert (§9.14) — nobody is at a button there

// Recipients handled per consumer invocation (~8 subrequests each). Raised 12 → 36 → 75 on 2026-08-15,
// alongside SEND_CONCURRENCY 5 → 12 (see the long note at the pool below for why that moved).
//
// ⚠️ PAGE SIZE ALONE IS NOT THE DIAL, AND THAT PART OF THE HISTORY STILL STANDS. Raising it 4 → 12
// on 2026-08-14 mid-flight moved the rate 796 → 858/hour, i.e. not at all. It was believed to hold
// "~20× headroom" for months and it does not. It sat at 4 because it was sized against the
// **Cloudflare FREE-plan 50-subrequest ceiling** (4 × 8 = 32, "safely under 50"); LOT is on Paid
// where the ceiling is 10,000, so that reasoning was obsolete — but removing a false limit is not
// the same as finding the real one, which is the mistake this comment exists to prevent.
//
// ⚠️ WHAT IT DOES DO, now that a concurrency pool exists: amortise the QUEUE HOP. Each page costs
// one ~5s hop. With page size == concurrency the pool runs a single round and the hop dominates the
// invocation; at 36 with 12 concurrent it runs three rounds per hop, so the fixed cost is spread
// over 3× the work. Page size is a multiplier on concurrency, never a substitute for it — that is
// why both moved together, and why raising this one alone will disappoint again.
//
// ⚠️ TWO OLDER MEASUREMENTS IN THIS FILE'S HISTORY WERE WRONG; do not resurrect either.
//   · "~4.02s serial per recipient / 796–858 per hour" was read MID-FLIGHT during that broadcast's
//     first hour, while Cloudflare Queues was still autoscaling its consumer count. Across the
//     complete run the same campaign did 642 → 2,795 → 3,211 → 1,323 attempts/hour.
//   · "sends are serial" is contradicted by the timestamps: median inter-send gap 0.133s, minimum
//     0.000s, 2,106 consecutive pairs under 0.05s apart. They were already parallel. The mean gap
//     of 1.439s against that median is the real story — the pipeline was BURSTY AND IDLE, not slow.
// Peak sustained was 3,211/hour ≈ 1.12s/send. Re-measure across a COMPLETE run, never a live
// sample, or you will describe the ramp and call it the ceiling.
const SENDS_PER_MSG = 75;

// How many INDEPENDENT fan-out chains a broadcast runs. This is the throughput dial; in-page
// concurrency is not (measured 2026-08-15: 5 → 25 concurrent moved per-message latency 3.57s →
// 16.06s and throughput by 1.1×, because the ceiling is per-INVOCATION and the database was idle
// throughout). Each shard is its own cursor over a hash-partitioned slice, so N chains ≈ N× the
// sends per hour.
//
// ⚠️ Capped at 6. This is not timidity about our own infrastructure — it is Meta's 100k/24h tier,
// which at 6 chains is already within reach of being spent in a few hours, and a live customer
// send is the wrong place to discover the next ceiling. Raise it only with a measurement.
// ⚠️ A single-shard campaign takes the byte-identical path it always did (shard 0 of 1).
const MAX_SHARDS = 6;
const shardsFor = (n) => Math.min(MAX_SHARDS, Math.max(1, Math.ceil(Number(n || 0) / 10000)));
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

// Today's marketing send budget, WITHOUT consuming a unit. `remaining: null` = no cap configured.
// Never let a read failure block a send — a 500 here must not become a phantom "budget hit", the
// same reasoning as the `gate_error:budget` branch in gate.js.
async function sendBudget(env) {
  const r = await A.sbComms('/rest/v1/rpc/send_budget_status', env, { method: 'POST', body: '{}' });
  if (!r.ok) return { unreadable: true, remaining: null };
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!row) return { unreadable: true, remaining: null };
  const remaining = row.remaining == null ? null : Number(row.remaining);
  return { unreadable: false, budget: Number(row.budget), used: Number(row.used), remaining };
}

// ── Will this campaign actually FINISH before the channel goes quiet? ──────────
//
// A quiet-hours skip on a campaign is TERMINAL. `gate.js` returns `quiet_hours` per message and
// the campaign path records it as a skip — only JOURNEYS park and resume (journey-workflow.js).
// So a broadcast queued too late messages whoever it reaches by the cutoff and permanently drops
// the rest, while the campaign still reads `sent`. Identical in shape to the `budget_exhausted`
// stranding of S269, on the clock instead of the counter, and the budget check cannot see it —
// that one compares volume against a counter, this one against the hours left.
//
// ⚠️ MEASURED, not assumed — and PER CHAIN, because sharding made whole-campaign throughput a
// function of shard count. Re-measured 2026-08-16 (S287) from the COMPLETE `Freedom to Play
// Sale_15Aug` broadcast (48,189 attempts), which ran both shapes in one day at the current
// SEND_CONCURRENCY=25 / SENDS_PER_MSG=75:
//   · single chain (pre-restart, 15:00–15:40 IST): 10-min windows at 4,350–4,500/hr
//   · 5 shards (16:20 restart onward): 12 consecutive 10-min windows at 21,018–22,740/hr —
//     sustained mean 21,577/hr across two full hours, i.e. ~4,315/hr per chain. Linear in N,
//     exactly as the MAX_SHARDS comment above predicts.
// 4,300 is the floor of both readings — sustained, not peak, because the per-chain figure gets
// MULTIPLIED now and a peak×N estimate compounds optimism. The two errors are still asymmetric:
// too LOW over-refuses (one extra confirm click on the partial-send override); too HIGH
// under-refuses (strands customers who are never retried). The old 3,211 was the same guard's
// single-chain peak at the OLD concurrency (5/12). Re-measure from per-hour attempt counts across
// a COMPLETE broadcast, never a mid-flight sample — this figure's own first cut died that way.
const THROUGHPUT_PER_HOUR_PER_CHAIN = 4300;

// Refuse rather than cut it fine. A send predicted to land within this margin of the cutoff is
// treated as not finishing: the estimate carries ramp-up error, and being wrong costs real
// customers who are never retried.
const QUIET_MARGIN_MINUTES = 45;

// Minutes from now until `channel` goes quiet. null = never quiet (email), so no clock limit.
async function minutesUntilQuiet(env, channel) {
  const settings = await getSettings(env);
  const cqh = await G.getChannelQuietHours(env);
  // ⚠️ Unreadable table → NO estimate, not a fallback window. gate.js fails CLOSED there because a
  // wrong window sends at 3am; here the same unknown must fail OPEN, because refusing every
  // campaign on a transient read error is its own outage. The per-message gate still protects the
  // customer either way, so this degrades to today's behaviour rather than to harm.
  if (!cqh.ok) return null;
  const win = G.resolveQuietWindow(cqh.rows, channel, settings || {});
  if (!win) return null;                                    // channel exempt (email)
  const now = G.istMinutes();
  if (G.inQuietWindow(win.startMin, win.endMin, now)) return 0;   // already quiet
  const until = win.startMin - now;
  return until > 0 ? until : until + 1440;                  // wraps midnight
}

// Kick off a broadcast: snapshot, set sending, enqueue the first fan-out seed.
//
// `allowPartial` deliberately sends a campaign KNOWN not to fit — larger than today's remaining
// budget, or unable to finish before quiet hours. It exists because the blocks below would
// otherwise be a dead end on a legitimately huge audience, and a guard nobody can get past gets
// removed rather than respected.
//
// ⚠️ It comes from EITHER the caller (a human pressing Send, who just answered a dialog) OR the
// campaign row (`allow_partial`, set at schedule time). The row matters because the SCHEDULER has
// nobody to ask: it calls this with no options, so without a persisted decision a large scheduled
// broadcast is refused, alerts, stays scheduled and re-refuses every five minutes — silently never
// sending. That is the guards reproducing the very failure they exist to prevent.
async function startCampaign(env, id, sentBy, opts = {}) {
  const camp = await getCampaign(env, id);
  if (!camp) return { ok: false, error: 'not_found' };
  // 'stopped' is RESUMABLE (S282) — a stopped broadcast restarts through this same path rather
  // than needing separate resume machinery, because send.js's dedup already gives exactly the
  // right semantics: a prior sent-like row dedups (nobody is messaged twice) while a prior
  // skipped/failed row is ADOPTED (the tail actually gets retried). Without this, Stop would be
  // terminal and would recreate, one step earlier, the very gap it was built to close — a
  // part-sent campaign nobody can finish.
  // ⚠️ Resume re-fans from the START of the recipient list (after: null), so an audience that is
  // half done pays a fast dedup no-op for everyone already reached. Correct, just not free.
  // ⚠️ `sent` IS RESUMABLE (2026-08-15), and without it a quiet-hours tail was unrecoverable.
  //
  // The pieces to recover one already existed and did not meet. send.js dedups ON SUCCESS, not on
  // attempt — a `sent`-like row dedups, while a skipped/failed row FREES its dedup key and is
  // adopted on a later pass (send.js §dedup reserve, and the `dedup_key: res.status === 'sent' ?
  // … : null` write). So a campaign that ran into quiet hours leaves every skipped recipient
  // perfectly retryable. But the fan-out then flips the campaign to `sent` on its final page, and
  // `sent` was not in this list, so the only door to that retry was a hand-written DB PATCH.
  //
  // That is the exact shape S282 fixed for `stopped` ("the mechanism always existed but nothing
  // could set that status"), reappearing one status along. A 57k send that cannot finish before
  // 22:00 does not trickle — after the cutoff every remaining recipient skips fast with no
  // provider call, so it burns through the rest in minutes and locks itself as `sent`.
  //
  // Safe because dedup makes it self-limiting: resuming a campaign that genuinely reached everyone
  // is a no-op that re-walks the audience and sends nothing. The cost of allowing it is one wasted
  // pass; the cost of forbidding it was tens of thousands of customers nobody could reach again.
  if (!['approved', 'scheduled', 'stopped', 'sent', 'stalled'].includes(camp.status))
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

  // What the guards below should be judged on. For a FRESH send it is the live estimate. For a
  // roster-RESUME it is the REMAINING work — recon.never_attempted — because `sendable` describes
  // the whole live audience (found on this verification pass: resuming a 48k campaign with 297
  // left was judged as a 48k send, so budget/clock/approval could refuse a resume that would
  // actually send a few hundred). ⚠️ An UNDERCOUNT by design: freed failed/skipped rows also
  // retry on resume. These guards are advisory pre-checks; the per-message gate stays
  // authoritative, so under-guarding slightly is the correct direction (fail-open, like the
  // guards' own unreadable-state branches). Recon unreadable → keep the conservative estimate.
  let guardCount = sendable;
  if (camp.roster_built_at) {
    const rc = await A.sbComms('/rest/v1/rpc/campaign_recon', env,
      { method: 'POST', body: JSON.stringify({ p_campaign_id: id }) });
    const row = rc.ok ? (Array.isArray(rc.data) ? rc.data[0] : rc.data) : null;
    if (row) guardCount = Number(row.never_attempted || 0);
  }

  // Caller's answer OR the campaign's own persisted decision. Either is a human saying "I accept
  // a partial send"; the row is simply the one that survives until an unattended scheduler run.
  const allowPartial = opts.allowPartial === true || camp.allow_partial === true;

  // Approval was judged on the SUBMIT-time audience; a dynamic segment may have grown past the
  // threshold since. A human-approved campaign (approved_by set) stands; an auto-approved one
  // that outgrew the threshold goes back for eyes (review M2).
  if (!camp.approved_by && await needsApproval(env, camp, guardCount)) {
    await setStatus(env, id, { status: 'pending_approval', audience_snapshot: guardCount });
    return { ok: false, error: 'audience_grew_needs_approval' };
  }

  // ⚠️ REFUSE a send that cannot finish today, rather than half-completing it silently.
  //
  // The budget is enforced per-message in gate.js, which is the right place to enforce it and the
  // wrong place to DISCOVER it: by then the campaign is already fanning out, and every recipient
  // past the cap is stamped `budget_exhausted` and never retried while the campaign still reads
  // `sent`. That is what stranded 4,228 recipients across both Roxie campaigns on 2026-08-10
  // (S269) with nothing visible in the app. Checking here converts a silent partial send into a
  // decision made before anything goes out.
  //
  // Marketing only — transactional/utility bypass the budget entirely in gate.js, so blocking them
  // here would invent a limit that does not exist. Kept in step with `isMarketing` there.
  //
  // ⚠️ Advisory numbers, not a reservation. Journeys and other campaigns draw on the same counter
  // while this one runs, so `remaining` is a snapshot — this catches the "94k audience, 15k
  // budget" case it is built for, not a race down to the last few units. Do NOT harden it into a
  // reservation: holding budget across a fan-out that can be stopped or resumed would leak units
  // and starve transactional traffic on a failure.
  if (String(camp.purpose || 'marketing') === 'marketing' && !allowPartial) {
    const b = await sendBudget(env);
    if (b.remaining != null && guardCount > b.remaining) {
      return { ok: false, error: 'audience_exceeds_budget',
        sendable: guardCount, remaining: b.remaining, budget: b.budget, used: b.used };
    }
  }

  // ⚠️ And the same question against the CLOCK. Sized on throughput, refused for the same reason:
  // a tail that quiet hours kills is never retried and is invisible in the campaign's own status.
  // Applies to every purpose, not just marketing — quiet hours are a channel rule, not a budget
  // one, so a utility broadcast strands its tail exactly the same way.
  if (!allowPartial) {
    const mins = await minutesUntilQuiet(env, camp.channel);
    if (mins != null) {
      // The rate is per CHAIN; the campaign's real rate is chains × that. Mirror the claim
      // below EXACTLY: a fresh send gets shardsFor(sendable), while a build-resume or
      // roster-resume keeps the STORED shard_count its existing rows were hashed with (§9.9) —
      // judging a stored-5-shard resume by shardsFor(a few hundred remaining) would divide the
      // rate by 5 and refuse a resume that finishes in minutes.
      const shards = (camp.build_cursor || camp.roster_built_at)
        ? Math.max(1, Number(camp.shard_count || 1))
        : shardsFor(sendable);
      const ratePerHour = THROUGHPUT_PER_HOUR_PER_CHAIN * shards;
      const needMins = Math.ceil((guardCount / ratePerHour) * 60);
      if (needMins > Math.max(mins - QUIET_MARGIN_MINUTES, 0)) {
        return { ok: false, error: 'wont_finish_before_quiet_hours',
          sendable: guardCount, needMinutes: needMins, minutesUntilQuiet: mins,
          reachableBeforeQuiet: Math.max(Math.floor((mins / 60) * ratePerHour), 0),
          throughputPerHour: ratePerHour };
      }
    }
  }

  // Atomic claim (M9): flip approved/scheduled/stopped → sending ONLY if still in one of those,
  // so the M9 scheduler sweep and a concurrent manual "Send now" can't both fan out the same
  // campaign. sbComms defaults to Prefer: return=representation → an empty array means another
  // actor already claimed it.
  // ⚠️ Keep this list in step with the guard above — they are the same gate written twice, and a
  // status accepted there but missing here fails as the misleading 'already_claimed'.
  // ── Build vs resume (roster Task 4) ─────────────────────────────────────────────────────
  if (!camp.roster_built_at) {
    // Fresh send, OR a build-resume — a stop/stall mid-build leaves build_cursor set and
    // roster_built_at NULL, and the build continues from the cursor rather than rescanning.
    //
    // ⚠️ shard_count is FIXED HERE, at claim time, from the press-time estimate — NOT at build
    // completion from roster_size (the plan's original wording). Roster rows are hashed with this
    // N as they are inserted, so assignment-N and walk-N must be the same N; a "more accurate"
    // recompute at the end would orphan rows into shards nobody walks (§9.9). Estimate-vs-final
    // drift only moves parallelism granularity — hash % N partitions completely for ANY N.
    // A build-RESUME must therefore keep the STORED value: earlier chunks already used it.
    const shardCount = camp.build_cursor
      ? Math.max(1, Number(camp.shard_count || 1))
      : shardsFor(sendable);
    const claim = await A.sbComms(
      `/rest/v1/campaigns?id=eq.${A.enc(id)}&status=in.(approved,scheduled,stopped,sent,stalled)`, env,
      { method: 'PATCH', body: JSON.stringify({
          status: 'building_roster', sent_by: sentBy, shard_count: shardCount,
          updated_at: nowIso() }) });
    if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0)
      return { ok: false, error: 'already_claimed' };
    await env.BROADCAST_QUEUE.send({ kind: 'build_roster', campaignId: id, after: camp.build_cursor || null });
    // The HTTP response returns before the roster exists (§9.14) — guards + dialogs already ran
    // above against the estimate; the post-build approval re-check parks + alerts if it outgrew.
    return { ok: true, building: true, estimated: sendable, shards: shardCount };
  }

  // Roster resume (stopped / sent-with-tail): walk the FROZEN roster with the STORED shard_count
  // (§9.9 — never shardsFor(), whose input has drifted since the build). `shards_done` MUST be
  // reset — a leftover count would let the first chain to finish flip the whole campaign to
  // 'sent' while the others are still sending. Dedup makes the re-walk self-limiting.
  const shardCount = Math.max(1, Number(camp.shard_count || 1));
  const claim = await A.sbComms(
    `/rest/v1/campaigns?id=eq.${A.enc(id)}&status=in.(approved,scheduled,stopped,sent,stalled)`, env,
    { method: 'PATCH', body: JSON.stringify({
        status: 'sending', audience_snapshot: camp.roster_size ?? sendable, sent_by: sentBy,
        shards_done: 0, updated_at: nowIso() }) });
  if (!claim.ok || !Array.isArray(claim.data) || claim.data.length === 0)
    return { ok: false, error: 'already_claimed' };
  for (let i = 0; i < shardCount; i++)
    await env.BROADCAST_QUEUE.send({ campaignId: id, after: null, shard: i, shardCount });
  return { ok: true, audience: camp.roster_size ?? sendable, shards: shardCount };
}

// Mark a campaign STALLED — called by the DLQ consumer when a build chunk or a fan-out page
// exhausts its retries (§9.15). This is what closes the dead-chain hole the 15 Aug send fell
// into: the chain died at 15:38, the campaign read `sending` for 41 minutes, and nothing
// anywhere said so. Conditional on the two in-flight statuses so a campaign that legitimately
// finished (or was stopped) between the failure and the DLQ write is left alone.
// Resume is startCampaign: stalled with no roster_built_at resumes the BUILD from build_cursor;
// with a roster it re-walks the shards, dedup making the re-walk self-limiting.
async function stallCampaign(env, campaignId) {
  const r = await A.sbComms(
    `/rest/v1/campaigns?id=eq.${A.enc(campaignId)}&status=in.(building_roster,sending)`, env,
    { method: 'PATCH', body: JSON.stringify({ status: 'stalled', updated_at: nowIso() }) });
  return r.ok && Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null;
}

// Consumer: one roster-build chunk (scan-bounded — §9.12/§9.13). Walks the member slice via the
// build_roster_chunk RPC, persists the cursor, self-enqueues the next slice; the FINAL chunk
// stamps roster_built_at, re-checks approval against the real roster size, and seeds the chains.
async function processBuildChunk(env, body) {
  const { campaignId, after } = body;
  const camp = await getCampaign(env, campaignId);
  // Stop mid-build is honoured HERE: stopCampaign flips the status, and the in-flight chunk
  // message finds it changed and acks silently. build_cursor stays, so resume continues the walk.
  if (!camp || camp.status !== 'building_roster') return;
  const r = await A.sbComms('/rest/v1/rpc/build_roster_chunk', env,
    { method: 'POST', body: JSON.stringify({ p_campaign_id: campaignId, p_after: after ?? null }) });
  // A failed chunk THROWS: Queues redelivers, and after max_retries the DLQ records it (and, from
  // Task 5, stalls the campaign visibly). Soft-continuing would finish a TRUNCATED roster that
  // reports itself complete — the §9.1 failure this whole build shape exists to prevent.
  if (!r.ok) throw new Error(`build_roster_chunk_failed:${campaignId}:${r.status}`);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!row) throw new Error(`build_roster_chunk_empty:${campaignId}`);

  if (!row.done) {
    await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}`, env,
      { method: 'PATCH', body: JSON.stringify({ build_cursor: row.next_cursor, updated_at: nowIso() }) });
    await env.BROADCAST_QUEUE.send({ kind: 'build_roster', campaignId, after: row.next_cursor });
    return;
  }

  const total = Number(row.roster_total || 0);
  // Approval re-check against the REAL roster, with nobody at a button (§9.14): a human-approved
  // campaign stands; an auto-approved one that outgrew the threshold parks LOUDLY. The park stamps
  // roster_built_at — the roster is complete and reusable; only the send needs eyes.
  if (!camp.approved_by && await needsApproval(env, camp, total)) {
    await setStatus(env, campaignId, { status: 'pending_approval', audience_snapshot: total,
      roster_built_at: nowIso(), roster_size: total, build_cursor: null });
    await AL.alert(env, `⏸️ *Relay — campaign parked for approval after roster build*\n"${camp.name}" `
      + `built a roster of ${total}, above the approval threshold. Nothing was sent. `
      + `Approve it and press Send — the roster is kept.`);
    return;
  }

  // Atomic finalize, conditional on still-building — a Stop pressed in the same instant wins and
  // the empty representation tells us not to seed. shard_count is read back from the PATCHed row.
  const fin = await A.sbComms(`/rest/v1/campaigns?id=eq.${A.enc(campaignId)}&status=eq.building_roster`, env,
    { method: 'PATCH', body: JSON.stringify({ status: 'sending', roster_built_at: nowIso(),
        roster_size: total, audience_snapshot: total, shards_done: 0, build_cursor: null,
        updated_at: nowIso() }) });
  if (!fin.ok) throw new Error(`build_finalize_failed:${campaignId}:${fin.status}`);
  if (!Array.isArray(fin.data) || fin.data.length === 0) return;   // stopped concurrently
  const shardCount = Math.max(1, Number(fin.data[0].shard_count || 1));
  for (let i = 0; i < shardCount; i++)
    await env.BROADCAST_QUEUE.send({ campaignId, after: null, shard: i, shardCount });
}

// Consumer: process one fan-out message (paginate → send → continue or finish).
async function processQueueMessage(env, body) {
  // shard/shardCount absent === the old single-chain shape, so an in-flight message enqueued
  // before this deploy keeps working exactly as it did.
  const { campaignId, after, shard = 0, shardCount = 1 } = body;
  const camp = await getCampaign(env, campaignId);
  if (!camp || camp.status !== 'sending') return;     // cancelled/finished → stop
  const variants = await loadVariants(env, campaignId);

  // Exclusions are re-evaluated on EVERY page, not snapshotted at start (S276). A fan-out runs
  // for hours at ~1,200/hr, so a snapshot would happily message someone another campaign reached
  // while this one was still going — which is the case the feature exists for. The predicate also
  // counts a fresh 'queued' row as contacted, so two campaigns running CONCURRENTLY exclude each
  // other rather than racing between reserve and send.
  // ── Page source (roster Task 6): the FROZEN roster when one exists, else the live query. ──
  // The roster is the audience decided at build time; eligibility stays LIVE — the gate per
  // message, the exclusion batch per page. The fallback keeps any campaign that was already
  // in flight when the roster deploy landed walking its original path (§7: never strand a
  // broadcast across a deploy). A page read failure THROWS either way — "no page" must never be
  // read as "campaign finished" (review C2); Queues redelivers, then DLQ → stalled (Task 5).
  let recs;
  if (camp.roster_built_at) {
    const q = `/rest/v1/campaign_roster?campaign_id=eq.${A.enc(campaignId)}&shard=eq.${Number(shard) || 0}`
      + (after ? `&profile_id=gt.${A.enc(after)}` : '')
      + `&order=profile_id.asc&limit=${SENDS_PER_MSG}&select=profile_id,address`;
    const r = await A.sbComms(q, env);
    if (!r.ok) throw new Error(`campaign_roster_page_failed:${campaignId}:${r.status}`);
    recs = Array.isArray(r.data) ? r.data : [];
  } else {
    const r = await A.sbComms('/rest/v1/rpc/campaign_recipients', env, {
      method: 'POST',
      body: JSON.stringify({ p_segment_id: camp.segment_id, p_channel: camp.channel,
        p_purpose: camp.purpose, p_after: after, p_limit: SENDS_PER_MSG,
        p_shard: shard, p_shard_count: shardCount,
        ...exclusionArgs(camp) }),
    });
    if (!r.ok) throw new Error(`campaign_recipients_failed:${campaignId}:${r.status}`);
    recs = Array.isArray(r.data) ? r.data : [];
  }

  // ── Per-page exclusion re-check, VISIBLE (§9.21, roster Task 2) ───────────────────────────
  // Today campaign_recipients already filters exclusions out of the page, so this batch usually
  // returns empty and only catches the between-fetch-and-send race. It exists because Task 6
  // switches pages to the frozen roster, at which point THIS becomes the sole send-time
  // enforcement of the S276 concurrent-exclusion guarantee — same page-freshness as today, but an
  // excluded profile now leaves a `skipped/excluded_recent_contact` row instead of silently
  // vanishing from a query result. Wired ahead of Task 6 so that diff changes only where pages
  // come from, never two behaviours at once.
  //
  // ⚠️ Both failure modes THROW (page retries), never soft-continue. Soft-continuing past a failed
  // batch check sends to people the exclusion should have held back — inside the exact
  // concurrency window S276 exists for. Soft-continuing past a failed skip-write reproduces the
  // silent-absence shape this whole feature is built to kill. On a retried page the skip rows can
  // duplicate (they carry no dedup key, deliberately — a resume may legitimately retry these
  // people); reconciliation counts distinct profiles, so duplicates are rare-path stats noise,
  // not a correctness problem.
  const exArgs = exclusionArgs(camp);
  const hasExclusions = exArgs.p_exclude_segments.length > 0 || exArgs.p_exclude_campaigns.length > 0
    || (exArgs.p_exclude_contacted_hours != null && exArgs.p_exclude_contacted_hours > 0);
  let excluded = new Set();
  if (hasExclusions && recs.length) {
    const bx = await A.sbComms('/rest/v1/rpc/campaign_excluded_batch', env, {
      method: 'POST',
      body: JSON.stringify({ p_profile_ids: recs.map((x) => x.profile_id), p_channel: camp.channel,
        p_exclude_segments: exArgs.p_exclude_segments, p_exclude_campaigns: exArgs.p_exclude_campaigns,
        p_exclude_contacted_hours: exArgs.p_exclude_contacted_hours }),
    });
    if (!bx.ok) throw new Error(`campaign_excluded_batch_failed:${campaignId}:${bx.status}`);
    excluded = new Set(Array.isArray(bx.data) ? bx.data : []);
    if (excluded.size) {
      // One array insert for the whole page. variant_id is stamped for the same reason finalize
      // stamps it on every outcome: a skipped message still belongs to an arm, and ab-stats'
      // per-arm failure-asymmetry check reads those rows.
      const rows = recs.filter((x) => excluded.has(x.profile_id)).map((x) => ({
        profile_id: x.profile_id, channel: camp.channel, purpose: camp.purpose,
        status: 'skipped', reason: 'excluded_recent_contact',
        source: `campaign:${campaignId}`, to_address: x.address || null,
        variant_id: pickVariant(campaignId, x.profile_id, variants)?.id || null,
      }));
      const ins = await A.sbComms('/rest/v1/messages', env,
        { method: 'POST', body: JSON.stringify(rows) });
      if (!ins.ok) throw new Error(`exclusion_skip_write_failed:${campaignId}:${ins.status}`);
    }
  }

  // ── Holdout arms leave EVIDENCE (roster §9.17) ──────────────────────────────────────────
  // A holdout must receive NOTHING (S272) — but writing nothing at all made every holdout
  // recipient indistinguishable from a missed one: roster-minus-messages would report the whole
  // holdout group as never-attempted and bury the real misses. One array insert of
  // skipped/holdout rows per page. ✅ Verified safe for A/B stats before building (2026-08-15):
  // campaign_variant_stats counts `sent` from sent_at and ab-stats' primary metric is read÷sent
  // with zTest nulling on a zero denominator — these rows inflate only `assigned` and the
  // labelled diagnostics. Excluded-and-holdout resolves to excluded (already evidenced above).
  // Arm assignment is computed ONCE here (pure hash) and reused by the pool below.
  const armOf = new Map();
  for (const x of recs) armOf.set(x.profile_id, pickVariant(campaignId, x.profile_id, variants));
  const isHoldout = (pid) => { const a = armOf.get(pid); return !!(a && !a.template_id); };
  const holdouts = recs.filter((x) => x.address && isHoldout(x.profile_id) && !excluded.has(x.profile_id));
  if (holdouts.length) {
    const rows = holdouts.map((x) => ({
      profile_id: x.profile_id, channel: camp.channel, purpose: camp.purpose,
      status: 'skipped', reason: 'holdout',
      source: `campaign:${campaignId}`, to_address: x.address,
      variant_id: armOf.get(x.profile_id).id,
    }));
    const ins = await A.sbComms('/rest/v1/messages', env,
      { method: 'POST', body: JSON.stringify(rows) });
    if (!ins.ok) throw new Error(`holdout_skip_write_failed:${campaignId}:${ins.status}`);
  }

  // ── Bounded-concurrency send pool (S282) ──────────────────────────────────────────────────
  // The page used to run `for … await send`, one recipient fully completing before the next
  // began, which measured a near-constant 4.02s per recipient = 796–858/hour whatever
  // SENDS_PER_MSG was set to. THIS is the throughput lever; the page size is not (see the
  // SENDS_PER_MSG comment). A pool rather than chunked Promise.all so one slow send does not
  // hold up four finished ones.
  //
  // ⚠️ RAISED 5 → 12 → 25 ON 2026-08-15, because the reason it was 5 does not hold up.
  //
  // The old note read "CAPPED AT 5 BY META… the tier is 100k/24h ≈ 4,166/hour sustained". That
  // division is a PLANNING convenience, not a constraint. **Meta's messaging limit is a VOLUME cap
  // on business-initiated conversations in a rolling 24h — it is not an hourly rate limit.** It
  // stops you at 100,000 conversations in a day; it does not throttle you at 4,166 in an hour.
  // What actually caps the rate is the per-number THROUGHPUT level, and ours reads STANDARD on all
  // five senders.
  //
  // Measured before changing it: **we have never once been rate-limited.** Zero `131048`
  // (spam-rate) and zero `130429` (throughput) in the entire message history — every failure we
  // have ever had is per-recipient (131049), undeliverable (131026), media, or opt-out. And the
  // 14 Aug run already burst to ~7.5 sends/second (median inter-send gap 0.133s, 2,106 pairs under
  // 0.05s apart) with no rejection of any kind. We were running at ~0.89/s on average against
  // that, i.e. the pipeline sat idle between bursts rather than pushing anything to its limit.
  //
  // ⚠️ The genuine risks are NOT throughput, and they do not scale with this number the way the
  // old comment implied: a quality-rating drop comes from recipient BLOCKS AND REPORTS, which are
  // a function of who you message and how often, not how fast. Sending the same audience the same
  // message over 3 hours instead of 9 does not make them likelier to block you.
  //
  // ⚠️ Still bounded on purpose. 12 concurrent × 36 per page ≈ 288 subrequests per invocation
  // (ceiling 10,000) and finishes a page FASTER, so the 30s CPU budget gets easier, not harder.
  // Do not take this as licence to remove the bound — an unbounded pool would put the whole page
  // in flight at once and the first thing to break would be a live customer send.
  //
  // ⚠️ SUPABASE CAPACITY CHECKED BEFORE GOING TO 25 (2026-08-15) — the DB, not Meta, is the real
  // exposure here, because this pressure is shared with Pitstop, journeys and the scanner.
  // Measured: the 14 Aug broadcast peaked at **137,783 API requests/hour with ZERO 5xx**, and there
  // were **zero Postgres ERROR/FATAL/WARNING rows across the whole 6-hour window**. `max_connections`
  // is 120 with 21 in use and PostgREST holding 7. At ~7 Supabase calls per send, 25 concurrent
  // projects to ~105k req/hour from the campaign plus a ~25k baseline — i.e. right at a peak the
  // database has already carried cleanly.
  //
  // ⚠️ The likely failure mode of over-raising this is NOT an outage, it is DIMINISHING RETURNS:
  // the worker's concurrent requests multiplex onto PostgREST's own pool, so past that pool size
  // they queue rather than fail. If raising this stops making it faster, that is the ceiling —
  // do not keep climbing, and do not read the flat line as a bug.
  //
  // ⚠️ Auth is pinned at 10 DB connections (advisor `auth_db_connections_absolute`), separately
  // from this path. Heavy load here can therefore make team LOGINS sluggish without touching the
  // send. Symptom to recognise, not a reason to hold back the send.
  //
  // ⚠️ If a rate rejection EVER appears (131048/130429), drop this back to 5 and redeploy — that
  // is a ~30 second revert, and those two codes are the only signal that this number is too high.
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
  const SEND_CONCURRENCY = 8;
  let pageErrors = 0;
  // ⚠️ The pool works a FILTERED COPY; `recs` itself must stay untouched — the continuation
  // cursor below is recs[recs.length-1] and the completion test is recs.length === SENDS_PER_MSG,
  // both positional. Excluding here (not from recs) also means a page consisting ENTIRELY of
  // excluded profiles still advances the cursor and continues the chain.
  const queue = recs.filter((r) => r.address && !excluded.has(r.profile_id) && !isHoldout(r.profile_id));
  let nextIdx = 0;
  const runOne = async (rec) => {
    try {
      // Per-recipient assignment INSIDE the page — never "all of A then all of B". The fan-out
      // runs for hours, so batching by arm would push B later in the day and the test would
      // measure time-of-day rather than copy.
      const arm = armOf.get(rec.profile_id) ?? null;   // precomputed once per page (§9.17)
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
    // more remain in THIS shard → continue from the last profile_id, staying on the same chain
    await env.BROADCAST_QUEUE.send({ campaignId, after: recs[recs.length - 1].profile_id, shard, shardCount });
  } else {
    // This chain has drained its shard. The campaign is only finished when EVERY chain has —
    // flipping it here would strand the other shards mid-flight while the UI reported success.
    // The increment is atomic in the RPC and returns true for exactly one caller, so a read-then-
    // write race (two chains finishing together, both seeing n-1, neither completing) cannot happen.
    const done = await A.sbComms('/rest/v1/rpc/finish_campaign_shard', env,
      { method: 'POST', body: JSON.stringify({ p_campaign_id: campaignId }) });
    if (!done.ok) throw new Error(`finish_shard_failed:${campaignId}:${done.status}`);
    if (done.data === true) await setStatus(env, campaignId, { status: 'sent' });
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

module.exports = { getCampaign, setStatus, needsApproval, reachableCount, sendBudget, minutesUntilQuiet, THROUGHPUT_PER_HOUR_PER_CHAIN, QUIET_MARGIN_MINUTES, startCampaign, processBuildChunk, stallCampaign, processQueueMessage, sendCampaignTest,
  // Exported for the fan-out tests ONLY. The continuation test is `recs.length === SENDS_PER_MSG`,
  // so a test that wants to exercise "a FULL page was processed" has to build a page of exactly
  // this size. It used to hardcode 4 next to a `// == SENDS_PER_MSG` comment, which silently
  // stopped being true the moment the constant moved (5 → 75) — the test then exercised the
  // drain-the-shard branch while still claiming to test the continuation. Derive, never restate.
  SENDS_PER_MSG,
  // S276 exclusions — exported for unit tests
  exclusionArgs, materializeExclusions };
