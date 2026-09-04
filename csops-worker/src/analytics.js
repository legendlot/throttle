// Support Analytics — the pure derivations behind /analytics.
//
// Extracted from index.js 2026-09-04 (S344) so they can be unit-tested: index.js is a
// Worker module with a default export and top-level bindings, so a test cannot import it.
// This is the same reasoning that left `toE164` MIRRORED in phone.test.mjs — but these
// have 2 call sites each, not 10, so extracting was cheap and the mirror (which drifts
// silently) was not needed. Prefer this shape for any new pure helper.

export const SUPPORT_CHANNEL_LABELS = {
  whatsapp: 'WhatsApp', email: 'Email', instagram: 'Instagram', messenger: 'Messenger',
  web: 'Web', sheet: 'Imported', other: 'Other',
};
// The five filterable dimensions, each derived ONCE here and used for both the option
// lists and the filtering. Two of them (product line, support channel) are derived, not
// columns, so a PostgREST-side filter could not express them — and deriving the option
// list separately from the filter is exactly how a measurement and its implementation end
// up defining the same set differently. One function, both callers.
export function analyticsDims(r, lineOf) {
  return {
    product:         r.product || '—',
    issue_category:  r.issue_category || 'Uncategorised',
    product_line:    lineOf[r.product] || 'Unclassified',
    sale_channel:    r.platform || 'Unknown',
    support_channel: r.auto_created || r.intake_channel === 'phone' || r.intake_channel === 'call'
      ? 'Calls'
      : (SUPPORT_CHANNEL_LABELS[r.intake_channel] || (r.intake_channel ? r.intake_channel : 'Unknown')),
    // The agent a complaint is ATTRIBUTED to, not who resolved it — this is ticket-grain, and a
    // ticket carries one assignee. Unassigned is a real and interesting bucket here (it is where
    // complaints go to be forgotten), so it gets a label rather than being dropped from the list.
    agent: r.assigned_agent_name || '— unassigned —',
  };
}
export const ANALYTICS_DIM_KEYS = ['product', 'issue_category', 'product_line', 'sale_channel', 'support_channel', 'agent'];

// Trend bucket for an IST date string (YYYY-MM-DD). Month -> 'YYYY-MM'; week -> the
// week-commencing MONDAY as 'YYYY-MM-DD'. Monday because the floor's week runs Mon–Sat
// (RULE-ATT-001 working days) and a Sunday-start week would split every working week.
// ⚠️ Parsed as UTC on purpose: `cd` is ALREADY an IST calendar date, so re-interpreting it
// in any other zone would shift the day and drop calls into the wrong week.
export function trendBucket(istDateStr, grain) {
  if (!istDateStr) return null;
  // 'day' is the whole IST date — Pruthvi's daily view (S347). It sorts as a string like the
  // other two, so nothing downstream has to know which grain it is looking at.
  if (grain === 'day') return istDateStr;
  if (grain !== 'week') return istDateStr.slice(0, 7);
  const t = Date.parse(`${istDateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7;          // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// rollingAverage — the smoothed complaint-rate series (S347, Pruthvi #bugs 1787733817).
//
// Input is the SAME bucket series the trend charts render, so the smoothed line can never
// disagree with the bars it sits over. Output is one row per input bucket:
//   { bucket, count, avg }   avg = trailing mean of `count` over the last `window` buckets.
//
// ⚠️ The mean is over the buckets PRESENT, not over `window` — an early bucket averages the
// 1..n it actually has. Dividing by `window` before the series is `window` long would print a
// rising ramp at the left edge that looks like a real trend and is pure arithmetic.
//
// ⚠️ Gaps are NOT filled. A day with zero complaints produces no bucket upstream, so it is
// absent rather than zero, and the mean therefore skips it. That is the honest reading of
// "average over the last 7 points we have"; filling zeros would be a different metric and
// would quietly depress every average across a quiet stretch.
export function rollingAverage(series, window) {
  if (!Array.isArray(series) || !series.length) return [];
  const w = Math.max(1, Number(window) || 1);
  return series.map((row, i) => {
    const slice = series.slice(Math.max(0, i - w + 1), i + 1);
    const sum = slice.reduce((a, r) => a + (Number(r.total) || 0), 0);
    return {
      bucket: row.bucket,
      count: Number(row.total) || 0,
      avg: +(sum / slice.length).toFixed(2),
      window: slice.length,
    };
  });
}

// ── Row-level export helpers (S349, Pruthvi #bugs 1787733817 2026-09-04) ──────────────────

// Internal ticket notes flattened into ONE cell: "[YYYY-MM-DD HH:MM IST, Name] body" joined by
// " | ". One cell because the export is one row per complaint and a note count varies; a
// spreadsheet with a ragged tail of note columns is what people mis-sort. Empty bodies are
// dropped; a ticket with no notes yields '' (never 'null'). Timestamp rendered in IST because
// the team reads the file in IST and a UTC stamp puts a 23:30 note on the wrong day.
export function formatTicketNotes(notes = []) {
  const out = [];
  for (const n of notes) {
    // Hardened (S349 review): a non-string body or an unparseable timestamp must cost ONE cell,
    // never the whole export — the module is exported and the next caller will not know the
    // column types. Same reasoning as splitMulti's guard in multiselect.js.
    const body = String(n?.body ?? '').trim();
    if (!body) continue;
    const t = n.created_at ? new Date(n.created_at).getTime() : NaN;
    const when = Number.isFinite(t)
      ? new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' IST'
      : '';
    const who = n.created_by_name ? `, ${n.created_by_name}` : '';
    out.push(`[${when}${who}] ${body.replace(/\s*\r?\n\s*/g, ' / ')}`);
  }
  return out.join(' | ');
}

// Same mask the Queue export applies (queue/page.js maskPhone): keep everything but the last
// three digits. A row-level export leaves the building, so the two files must not disagree
// about how much of a number they show.
export function maskPhoneForExport(phone) {
  if (!phone) return '';
  const s = String(phone);
  return s.length < 4 ? s : s.slice(0, -3) + '***';
}

// ── Agent + conversation DAILY trend (S349b, Pruthvi #bugs 1787733817 — "trend-based graphs for
// Agent Performance, Conversation Performance … a daily performance view") ────────────────────
//
// The series is the EXISTING agent report evaluated once per IST day (see getAgentConversationDaily
// in index.js), so every daily figure carries exactly the definition and date basis the Agents tab
// already documents — queries/answered/first-reply/resolution are raised-dated, handled is
// reply-dated, resolved/closed are closure-dated. This module only RESHAPES: N day-reports in,
// one team series + one series per agent out. It never computes a metric itself.

export const DAILY_METRICS = [
  { key: 'queries',            label: 'Queries',         kind: 'count' },
  { key: 'answered',           label: 'Answered',        kind: 'count' },
  { key: 'unanswered',         label: 'Never answered',  kind: 'count' },
  { key: 'avg_frt_min',        label: 'Avg first reply', kind: 'minutes' },
  { key: 'avg_resolution_min', label: 'Avg resolution',  kind: 'minutes' },
  { key: 'resolve_rate',       label: 'Resolve rate',    kind: 'pct' },
  { key: 'handled',            label: 'Handled',         kind: 'count' },
  { key: 'resolved',           label: 'Resolved',        kind: 'count' },
  { key: 'assigned',           label: 'Assigned',        kind: 'count' },
];
const DAILY_KEYS = DAILY_METRICS.map(m => m.key);
const isCount = (k) => DAILY_METRICS.find(m => m.key === k)?.kind === 'count';

// One metrics object from a report row (totals or a by_agent row). Counts default to 0 — an agent
// absent from a day's report did nothing that day, and 0 is the true figure. Averages and rates
// default to null — "no conversations to average" is not "0 minutes", and a 0 would drag every
// rolling reading down.
function pick(row) {
  const out = {};
  for (const k of DAILY_KEYS) {
    const v = row?.[k];
    out[k] = v == null ? (isCount(k) ? 0 : null) : Number(v);
  }
  return out;
}

/**
 * @param dayReports [{ day:'YYYY-MM-DD', report:{ totals, by_agent } }] in any order
 * @returns { days:[{ day, …metrics }], by_agent:[{ agent_id, name, handled_total, days:[{ day, …metrics }] }] }
 *          `days` sorted ascending; every agent has a row for EVERY day (zeros/nulls where absent) so a
 *          chart can plot them on one axis without gaps; agents sorted by handled_total desc, then name.
 */
export function dailySeries(dayReports = []) {
  const sorted = [...dayReports].sort((a, b) => a.day.localeCompare(b.day));
  const days = sorted.map(({ day, report }) => ({ day, ...pick(report?.totals) }));

  // Agents are keyed the way the report keys its rows: agent_id, falling back to name for the
  // unassigned bucket (which has no id and is a real, interesting line).
  const agents = new Map();
  for (const { day, report } of sorted) {
    for (const r of (report?.by_agent || [])) {
      const key = r.agent_id || r.name;
      const a = agents.get(key) || { agent_id: r.agent_id || null, name: r.name, byDay: {} };
      a.byDay[day] = pick(r);
      agents.set(key, a);
    }
  }
  const by_agent = [...agents.values()].map(a => {
    const rows = sorted.map(({ day }) => ({ day, ...(a.byDay[day] || pick(null)) }));
    return {
      agent_id: a.agent_id, name: a.name,
      handled_total: rows.reduce((s, r) => s + r.handled, 0),
      days: rows,
    };
  }).sort((a, b) => b.handled_total - a.handled_total || a.name.localeCompare(b.name));

  return { days, by_agent };
}

// istDayRange — the IST calendar days a [from, to] instant range touches, validated BEFORE any
// enumeration (S349b hostile review): the count is arithmetic, so an absurd `to` (9999-12-31 typed
// into a date box) is refused as a 400 in O(1) rather than materialising 2.9 M strings and OOMing
// the isolate. Also refuses unparsable instants and from > to at the INSTANT level — a same-day
// from > to used to pass a date-string guard and return a silent all-zero series.
// Returns { ok:true, days:[...] } or { ok:false, reason:'invalid'|'too_long', count }.
export function istDayRange(fromIso, toIso, maxDays = 62) {
  const fromMs = Date.parse(fromIso), toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return { ok: false, reason: 'invalid' };
  const IST = 5.5 * 3600 * 1000, DAY = 86400000;
  const firstDay = Math.floor((fromMs + IST) / DAY), lastDay = Math.floor((toMs + IST) / DAY);
  const count = lastDay - firstDay + 1;
  if (count > maxDays) return { ok: false, reason: 'too_long', count };
  const days = [];
  for (let d = firstDay; d <= lastDay; d++) days.push(new Date(d * DAY).toISOString().slice(0, 10));
  return { ok: true, days };
}

// istBucketRange — the IST buckets (day / Monday-start week / calendar month) a [from, to] range
// touches, each CLIPPED to the range so a bucket's RPC window never reaches outside what the user
// asked for (S349c: weekly + monthly grains for the agent trend). Same validation rules as
// istDayRange, which is now the 'day' case. Returns { ok:true, buckets:[{ bucket, from, to }] }
// (`bucket` = the IST start date 'YYYY-MM-DD'; from/to = ISO instants) or { ok:false, reason, count }.
export function istBucketRange(fromIso, toIso, grain = 'day', maxBuckets = 62) {
  const fromMs = Date.parse(fromIso), toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return { ok: false, reason: 'invalid' };
  const IST = 5.5 * 3600 * 1000, DAY = 86400000;
  const firstDay = Math.floor((fromMs + IST) / DAY), lastDay = Math.floor((toMs + IST) / DAY);
  const ymd = (dayNo) => new Date(dayNo * DAY).toISOString().slice(0, 10);
  // Bucket start for a day number, and the next bucket's start — the count is derived from the
  // starts arithmetically before anything is enumerated (an absurd `to` must cost O(1)).
  const startOf = (dayNo) => {
    if (grain === 'month') { const d = new Date(dayNo * DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY; }
    if (grain === 'week')  { const dow = (new Date(dayNo * DAY).getUTCDay() + 6) % 7; return dayNo - dow; }
    return dayNo;
  };
  const nextStart = (startNo) => {
    if (grain === 'month') { const d = new Date(startNo * DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY; }
    return startNo + (grain === 'week' ? 7 : 1);
  };
  const first = startOf(firstDay), last = startOf(lastDay);
  let count;
  if (grain === 'month') {
    const a = new Date(first * DAY), b = new Date(last * DAY);
    count = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
  } else count = Math.floor((last - first) / (grain === 'week' ? 7 : 1)) + 1;
  if (!Number.isFinite(count)) return { ok: false, reason: 'invalid' };   // beyond Date's range → NaN
  if (count > maxBuckets) return { ok: false, reason: 'too_long', count };
  const buckets = [];
  for (let s = first; s <= last; s = nextStart(s)) {
    const nx = nextStart(s);
    if (!Number.isFinite(nx)) return { ok: false, reason: 'invalid' };    // past Date's range (review S349c)
    const bStart = s * DAY - IST, bEnd = nx * DAY - IST - 1;              // IST midnight → instant
    buckets.push({ bucket: ymd(s), from: new Date(Math.max(bStart, fromMs)).toISOString(), to: new Date(Math.min(bEnd, toMs)).toISOString() });
  }
  return { ok: true, buckets };
}
