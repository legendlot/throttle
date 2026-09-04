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
  if (grain !== 'week') return istDateStr.slice(0, 7);
  const t = Date.parse(`${istDateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7;          // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
