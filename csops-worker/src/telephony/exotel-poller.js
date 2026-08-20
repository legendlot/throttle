// ── Exotel reconcile poller ──────────────────────────────────────────────────
//
// The COMPLETENESS GUARANTEE for the call log. Webhooks give speed; this gives
// certainty, and the two are not interchangeable:
//
//   · A webhook-only design is INCOMPLETE. A caller who hangs up during the greeting
//     dials no agent, holds no conversation and hits no no-answer branch — so nothing
//     fires. That is precisely the ~30% short-call population we most need to see
//     (79% of them are repeat callers failing to get through).
//   · A poller-only design is TOO SLOW for a screen-pop, which is why Phase 4 adds
//     webhooks on top rather than instead.
//
// Nothing downstream may assume a webhook fired. Every path writes through the same
// idempotent upsert on UNIQUE (provider, provider_call_sid), so the poller and the
// webhooks may both write the same call in any order without duplication.

import { makeExotelClient, exotelConfigured } from './exotel-client.js';
import {
  exotelToNormalised, exotelCallPatch, isSettled, agentCandidates, matchAgent,
} from './exotel-adapter.js';

// Overlapping window: we re-read more than one tick's worth every time. The upsert is
// idempotent so overlap is free, and it means a single failed tick self-heals on the
// next one instead of leaving a permanent hole.
const RECONCILE_WINDOW_MIN = 30;

// Exotel finalises Duration / Price / EndTime / RecordingUrl ~2 minutes AFTER a call
// ends, so rows land incomplete. Sweep recent unsettled rows and top them up.
const SETTLE_LOOKBACK_HOURS = 24;
const SETTLE_BATCH = 100;          // Sid= accepts at most 100 per request

const MAX_PAGES = 40;              // 4,000 calls — a decade of headroom at ~250/day

/**
 * The Pitstop-user <-> Exotel-identity roster, loaded ONCE per poll run.
 *
 * ⚠️ Once per RUN, not once per row. Six rows joined against every call in the window
 * is the per-row await CLAUDE.md forbids, and it would triple the DB traffic of a
 * poll for data that changes about twice a year.
 */
async function loadAgentRoster(env, sb) {
  const r = await sb(`/rest/v1/cs_telephony_agents?is_active=is.true`
    + `&select=user_id,sip_id,agent_phone&limit=500`, env);
  const bySip = new Map(), byPhone = new Map();
  for (const a of r.data || []) {
    const entry = { id: a.user_id, sip_id: a.sip_id || null };
    if (a.sip_id) bySip.set(String(a.sip_id).toLowerCase(), entry);
    if (a.agent_phone) byPhone.set(a.agent_phone, entry);
  }
  return { bySip, byPhone, size: (r.data || []).length };
}

/** Resolve the display name for a matched agent, cached across the run. */
async function nameFor(userId, env, sb, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const r = await sb(`/rest/v1/users_profile?id=eq.${userId}&select=full_name&limit=1`, env);
  const n = r.data?.[0]?.full_name || null;
  cache.set(userId, n);
  return n;
}

/**
 * Walk a date window and upsert every call Exotel has.
 *
 * @param opts.since / opts.until  Date bounds (defaults to the rolling window)
 * @param opts.createTickets       false for the historic backfill — see below
 */
export async function reconcileExotelCalls(env, pipeline, opts = {}) {
  if (!exotelConfigured(env)) return { skipped: 'exotel not configured' };

  const client = makeExotelClient(env);
  const until = opts.until || new Date();
  const since = opts.since || new Date(until.getTime() - RECONCILE_WINDOW_MIN * 60 * 1000);
  const createTickets = opts.createTickets !== false;

  const stats = { seen: 0, written: 0, ticketed: 0, coalesced: 0, attributed: 0, failed: 0, pages: 0 };
  let cursor = null;

  const { sb, toE164 } = pipeline.deps;
  const roster = await loadAgentRoster(env, sb);
  const nameCache = new Map();

  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await client.listCalls({
      fromDate: since, toDate: until, pageSize: 100, after: cursor,
      sortAsc: true, details: true,
    });
    if (!r.ok) {
      // Surfaced, never swallowed: a silently failing poller looks exactly like a
      // quiet day, and that is how a blind window goes unnoticed for a week.
      console.error(`[exotel:poll] list failed status=${r.status} ${r.error}`);
      return { ...stats, error: r.error, status: r.status };
    }
    stats.pages++;
    if (!r.calls.length) break;

    // ⚠️ Concurrency is deliberate and asymmetric — do not "tidy" it into one shape.
    //
    // The live cron handles ~5 calls a tick, so it runs SEQUENTIALLY: ticket creation
    // must stay serialised or RULE-PITSTOP-018 coalescing races itself. Two calls from
    // the same phone processed in parallel would both look for an open ticket, both
    // find none, and both create one — defeating the whole rule.
    //
    // The backfill creates no tickets (createTickets:false) and its upserts are
    // idempotent on (provider, provider_call_sid), so it fans out safely. Without this
    // a day of calls is ~500 serialised round-trips — the per-row await that CLAUDE.md
    // forbids, and enough wall-clock to time out the caller mid-run.
    const batchSize = createTickets ? 1 : 10;

    for (let i = 0; i < r.calls.length; i += batchSize) {
      const batch = r.calls.slice(i, i + batchSize);
      await Promise.all(batch.map(raw => processOne(raw)));
    }

    async function processOne(raw) {
      stats.seen++;
      try {
        const norm = exotelToNormalised(raw, { departmentId: opts.departmentId || null });
        if (!norm.provider_call_sid) { stats.failed++; return; }

        await pipeline.upsertCall(norm, exotelCallPatch(norm));
        stats.written++;

        // ⚠️ EVERY call gets a ticket (spec §5.1) — a suppression policy was proposed
        // and rejected: 79% of "nobody spoke" calls are repeat callers who could not
        // get through, and a third of the rest later host a WhatsApp conversation on
        // that same ticket. The cost of a trivial ticket is paid at the CLOSE, which
        // is one click, not by never creating it.
        //
        // The historic backfill passes createTickets:false — retro-firing creation
        // over days of calls would spray hundreds of tickets into a live queue and
        // reset every SLA clock.
        if (createTickets) {
          const t = await pipeline.ensureTicket(norm);
          if (t.coalesced_into) stats.coalesced++;
          else if (t.created)   stats.ticketed++;
          else if (!t.ok)       console.error(`[exotel:poll] ticket failed sid=${norm.provider_call_sid} ${t.error}`);
        }

        // Agent attribution. Without this every Exotel call reads "unassigned" — it
        // was 0% against MyOperator's 65% until this landed, which also empties the
        // My Calls tab and the agent report for anything after the cutover.
        //
        // Matched against the roster rather than a documented field name; see
        // agentCandidates(). A miss is logged with what we DID see, so the real leg
        // shape becomes evident from the logs instead of guesswork.
        const cands = agentCandidates(raw, norm.direction);
        const hit = matchAgent(cands, roster, toE164);
        if (hit) {
          const name = await nameFor(hit.id, env, sb, nameCache);
          await pipeline.attributeAgent(
            { ...norm, agent_ref: { sip_id: hit.matched_on === 'sip' ? hit.matched_value : null } },
            { agent: { id: hit.id, name } },
          );
          stats.attributed++;
        } else if (norm.status === 'answered' && cands.length) {
          console.log(`[exotel:poll] no agent matched sid=${norm.provider_call_sid} `
            + `candidates=${JSON.stringify(cands).slice(0, 200)}`);
        }
      } catch (e) {
        // One malformed call must not abort the whole window.
        stats.failed++;
        console.error(`[exotel:poll] row failed sid=${raw?.Sid} ${e?.message || String(e)}`);
      }
    }

    cursor = r.nextCursor;
    if (!cursor) break;
    if (page === MAX_PAGES - 1) {
      // No silent caps: if coverage was bounded, say so (CORE.md).
      console.error(`[exotel:poll] hit MAX_PAGES=${MAX_PAGES} — window ${since.toISOString()}..${until.toISOString()} NOT fully walked`);
    }
  }
  return stats;
}

/**
 * Second pass: top up rows Exotel had not finished settling when we first saw them.
 * Batched by Sid, never a per-row loop.
 */
export async function settleExotelCalls(env, pipeline, sb) {
  if (!exotelConfigured(env)) return { skipped: 'exotel not configured' };

  const sinceIso = new Date(Date.now() - SETTLE_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  // Unsettled = still in flight, or a connected call whose durations Exotel has not
  // finalised yet.
  //
  // ⚠️ Scoped to statuses that CAN still settle. A missed call legitimately has no
  // talk time and no recording and never will, so a naive "talk_duration_seconds is
  // null OR recording_url is null" predicate matches every missed call forever: the
  // batch fills with rows that can never settle, the genuinely-pending ones never get
  // looked at, and the pass burns the shared 200/min budget every 10 minutes doing
  // nothing. Ordered oldest-first so a backlog drains deterministically instead of
  // re-reading an arbitrary 100.
  const q = `/rest/v1/cs_calls?provider=eq.exotel`
    + `&created_at=gte.${encodeURIComponent(sinceIso)}`
    + `&status=in.(in_progress,answered,abandoned)`
    + `&or=(status.eq.in_progress,talk_duration_seconds.is.null,duration_seconds.is.null)`
    + `&select=provider_call_sid&order=created_at.asc&limit=${SETTLE_BATCH}`;
  const pending = await sb(q, env);
  const sids = (pending.data || []).map(r => r.provider_call_sid).filter(Boolean);
  if (!sids.length) return { pending: 0, settled: 0 };

  const client = makeExotelClient(env);
  const r = await client.getCallsBySid(sids);
  if (!r.ok) {
    console.error(`[exotel:settle] lookup failed status=${r.status} ${r.error}`);
    return { pending: sids.length, settled: 0, error: r.error };
  }

  let settled = 0, stillOpen = 0;
  for (const raw of r.calls) {
    const norm = exotelToNormalised(raw);
    await pipeline.upsertCall(norm, exotelCallPatch(norm));
    if (isSettled(norm)) settled++; else stillOpen++;
  }
  return { pending: sids.length, settled, stillOpen };
}

/**
 * One-shot historic backfill — recovers the blind window since the 2026-08-19 cutover.
 * Exotel serves 6 months but only ONE MONTH per request, so the range is walked in
 * monthly slices.
 *
 * ⚠️ createTickets is false by design (see reconcileExotelCalls).
 * ⚠️ Snapshot store.safety_cs_calls_<date> before running this.
 */
export async function backfillExotelCalls(env, pipeline, { since, until = new Date() } = {}) {
  if (!since) return { error: 'since required' };
  const out = { slices: [], seen: 0, written: 0 };
  let cursorDate = new Date(since);

  while (cursorDate < until) {
    const sliceEnd = new Date(Math.min(
      until.getTime(),
      cursorDate.getTime() + 30 * 24 * 3600 * 1000,
    ));
    const s = await reconcileExotelCalls(env, pipeline, {
      since: cursorDate, until: sliceEnd, createTickets: false,
    });
    out.slices.push({ from: cursorDate.toISOString(), to: sliceEnd.toISOString(), ...s });
    out.seen += s.seen || 0;
    out.written += s.written || 0;
    if (s.error) { out.error = s.error; break; }
    cursorDate = sliceEnd;
  }
  return out;
}
