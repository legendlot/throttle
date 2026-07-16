// Stub auth/alerts so runSegmentEntry can be driven without network.
const Module = require('module');
const path = require('path').join(__dirname, '..', 'src') + '/';
const state = { journeys: [], segments: {}, scans: [], scanReply: {}, alerts: [] };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './auth.js') return {
    enc: (s) => encodeURIComponent(s),
    sbComms: async (url, env, opts) => {
      if (url.startsWith('/rest/v1/journeys')) return { ok: true, data: state.journeys };
      if (url.startsWith('/rest/v1/settings')) return { ok: true, data: [{ segment_entry_max_per_tick: 2 }] };
      if (url.startsWith('/rest/v1/segments')) {
        const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]);
        return { ok: true, data: state.segments[id] ? [state.segments[id]] : [] };
      }
      if (url === '/rest/v1/rpc/segment_entry_scan') {
        const b = JSON.parse(opts.body);
        state.scans.push(b);
        return { ok: true, data: state.scanReply[b.p_segment_id] || {} };
      }
      return { ok: false };
    },
  };
  if (req === './alerts.js') return { alert: async (env, m) => { state.alerts.push(m); } };
  return orig.apply(this, arguments);
};
const SE = require(path + 'segment-entry.js');
Module._load = orig;

let fail = 0; const ok = (c, l) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + l); if (!c) fail++; };
const sent = [];
const env = { BROADCAST_QUEUE: { send: async (m) => sent.push(m) } };
const reset = () => { state.scans = []; state.alerts = []; sent.length = 0; };

(async () => {
  // 1. no entry journeys → no scans at all
  state.journeys = [{ id: 'j0', name: 'Ev', trigger: { type: 'event', name: 'x' } }];
  reset(); let r = await SE.runSegmentEntry(env);
  ok(state.scans.length === 0 && r.segments === 0, 'event-only journeys → no segment scans');

  // 2. never baselined → baseline mode (emit=false), NOBODY enrolled
  state.journeys = [{ id: 'j1', name: 'Winback', trigger: { type: 'segment_entry', segment_id: 's1' } }];
  state.segments = { s1: { id: 's1', name: 'winback60+', entry_tracking_since: null } };
  state.scanReply = { s1: { mode: 'baseline', baselined: 14020, entered: [], remaining: 0 } };
  reset(); r = await SE.runSegmentEntry(env);
  ok(state.scans[0].p_emit === false, 'first run scans in BASELINE mode');
  ok(sent.length === 0, 'baseline enrols NOBODY (14,020 not blasted)');
  ok(r.baselined === 14020 && /baselined/.test(state.alerts[0] || ''), 'baseline alerts with the count');

  // 3. baselined → emit mode, enrol each entrant
  state.segments = { s1: { id: 's1', name: 'winback60+', entry_tracking_since: '2026-07-16T00:00:00Z' } };
  state.scanReply = { s1: { mode: 'emit', entered: ['p1', 'p2'], entered_count: 2, remaining: 0 } };
  reset(); r = await SE.runSegmentEntry(env);
  ok(state.scans[0].p_emit === true, 'subsequent runs scan in EMIT mode');
  ok(sent.length === 2 && sent.every((m) => m.kind === 'enrol' && m.journeyId === 'j1'), 'one enrol per entrant');
  ok(sent.map((m) => m.profileId).join() === 'p1,p2', 'enrols the right profiles');
  ok(state.scans[0].p_limit === 2, 'cap read from settings');

  // 4. two journeys on ONE segment → one scan, enrol per journey
  state.journeys = [
    { id: 'j1', name: 'A', trigger: { type: 'segment_entry', segment_id: 's1' } },
    { id: 'j2', name: 'B', trigger: { type: 'segment_entry', segment_id: 's1' } },
  ];
  reset(); await SE.runSegmentEntry(env);
  ok(state.scans.length === 1, 'segment scanned ONCE even with 2 journeys on it');
  ok(sent.length === 4, '2 entrants x 2 journeys = 4 enrols');

  // 5. capped → alert, nothing dropped
  state.journeys = [{ id: 'j1', name: 'A', trigger: { type: 'segment_entry', segment_id: 's1' } }];
  state.scanReply = { s1: { mode: 'emit', entered: ['p1', 'p2'], entered_count: 2, remaining: 4998 } };
  reset(); await SE.runSegmentEntry(env);
  ok(state.alerts.some((a) => /capped/.test(a) && /4998/.test(a)), 'cap alerts loudly with the deferred count');

  // 6. malformed trigger (no segment_id) → ignored, no crash
  state.journeys = [{ id: 'jx', name: 'Bad', trigger: { type: 'segment_entry' } }];
  reset(); r = await SE.runSegmentEntry(env);
  ok(state.scans.length === 0 && r.segments === 0, 'trigger with no segment_id is skipped');

  // 7. scan error → recorded, no throw
  state.journeys = [{ id: 'j1', name: 'A', trigger: { type: 'segment_entry', segment_id: 'nope' } }];
  state.segments = {};
  reset(); r = await SE.runSegmentEntry(env);
  ok(r.errors.length === 1 && sent.length === 0, 'missing segment → error recorded, no enrol, no throw');

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail);
})();
