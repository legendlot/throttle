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
    const body = (n?.body || '').trim();
    if (!body) continue;
    const when = n.created_at
      ? new Date(new Date(n.created_at).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' IST'
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
