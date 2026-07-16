// Segment-entry trigger runner (BiteSpeed parity — the "Winback WA" journey triggers on
// `enters "winback90"`). Driven by the existing */5 cron in scheduled().
//
// Shape:  journeys{status=active, trigger:{type:'segment_entry', segment_id}}
//           → distinct segments
//           → comms.segment_entry_scan(segment, cap, emit)
//           → enqueue {kind:'enrol'} per (new entrant × journey on that segment)
//
// The engine below the queue is untouched: enrol() already owns the re-enrolment policy
// and starts the Workflow, exactly as the ingest event path does. This module only decides
// WHO newly entered.
//
// Two safety properties, both enforced in SQL (see migration 0021):
//   1. BASELINE — the first scan of a segment adopts its current members silently. Turning
//      on an entry journey for a 14,020-member segment must not enrol 14,020 people.
//   2. CAP — a widened definition can make thousands qualify at once; we admit at most
//      settings.segment_entry_max_per_tick per run. The remainder is not dropped (no
//      membership row is written for them, so the next tick re-detects them) and we alert
//      rather than truncate silently.

const A = require('./auth.js');
const AL = require('./alerts.js');

const DEFAULT_CAP = 500;

// Active journeys whose trigger is a segment entry, grouped by segment id.
async function activeEntryJourneys(env) {
  const r = await A.sbComms('/rest/v1/journeys?status=eq.active&select=id,name,trigger', env);
  const bySegment = new Map();
  for (const j of (r.ok && r.data) || []) {
    const t = j.trigger || {};
    if (t.type !== 'segment_entry') continue;
    const sid = t.segment_id;
    if (!sid) continue;                       // malformed trigger — nothing to watch
    if (!bySegment.has(sid)) bySegment.set(sid, []);
    bySegment.get(sid).push(j);
  }
  return bySegment;
}

async function scan(env, segmentId, limit, emit) {
  const r = await A.sbComms('/rest/v1/rpc/segment_entry_scan', env, {
    method: 'POST',
    body: JSON.stringify({ p_segment_id: segmentId, p_limit: limit, p_emit: emit }),
  });
  if (!r.ok) return { error: `scan_failed:${JSON.stringify(r.data)}` };
  return r.data || {};
}

// runSegmentEntry(env) → summary. Never throws: a scan failure on one segment must not
// break the cron's other duties (due-campaign sweep, deliverability watch).
async function runSegmentEntry(env) {
  const out = { segments: 0, baselined: 0, entered: 0, enrolled: 0, errors: [] };
  let bySegment;
  try { bySegment = await activeEntryJourneys(env); }
  catch (e) { out.errors.push(`journeys:${e?.message || e}`); return out; }
  if (!bySegment.size) return out;

  let cap = DEFAULT_CAP;
  try {
    const s = await A.sbComms('/rest/v1/settings?id=eq.1&select=segment_entry_max_per_tick&limit=1', env);
    const v = s.ok && s.data?.[0]?.segment_entry_max_per_tick;
    if (Number.isFinite(Number(v)) && Number(v) > 0) cap = Number(v);
  } catch { /* default cap */ }

  for (const [segmentId, journeys] of bySegment) {
    out.segments++;
    try {
      // Never baselined → adopt silently this tick; entries start from the NEXT one.
      const seg = await A.sbComms(
        `/rest/v1/segments?id=eq.${A.enc(segmentId)}&select=id,name,entry_tracking_since&limit=1`, env);
      const row = seg.ok && seg.data?.[0];
      if (!row) { out.errors.push(`segment_missing:${segmentId}`); continue; }

      if (!row.entry_tracking_since) {
        const b = await scan(env, segmentId, cap, false);
        if (b.error) { out.errors.push(`${row.name}:${b.error}`); continue; }
        out.baselined += Number(b.baselined || 0);
        await AL.alert(env, `🎯 *Relay segment-entry armed* — "${row.name}": ${b.baselined || 0} existing `
          + `members baselined (NOT enrolled). Only profiles entering from now on will trigger `
          + `${journeys.map((j) => `"${j.name}"`).join(', ')}.`);
        continue;
      }

      const r = await scan(env, segmentId, cap, true);
      if (r.error) { out.errors.push(`${row.name}:${r.error}`); continue; }
      const entered = Array.isArray(r.entered) ? r.entered : [];
      out.entered += entered.length;
      if (!entered.length) continue;

      // One enrol message per (entrant × journey). The queue is the drain — enrol() is
      // idempotent-ish via the re-enrolment policy, and the Workflow instance id is the
      // enrolment id, so a duplicate delivery can't double-run a journey.
      for (const profileId of entered) {
        for (const j of journeys) {
          await env.BROADCAST_QUEUE.send({ kind: 'enrol', journeyId: j.id, profileId });
          out.enrolled++;
        }
      }

      // No silent caps: say what was deferred.
      if (Number(r.remaining || 0) > 0) {
        await AL.alert(env, `⚠️ *Relay segment-entry capped* — "${row.name}": admitted ${entered.length} `
          + `(cap ${cap}), ${r.remaining} still queued and will drain on the next ticks. A sudden `
          + `surge usually means the segment definition was widened.`);
      }
    } catch (e) {
      out.errors.push(`${segmentId}:${e?.message || e}`);
    }
  }
  return out;
}

module.exports = { runSegmentEntry, activeEntryJourneys };
