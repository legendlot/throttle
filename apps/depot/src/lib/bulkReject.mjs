// Parses a pasted reject list for Outpost › Receiving (Rahul, #bugs 1793603016.636369). One line per
// unit: the label, then what is wrong (comma or spreadsheet columns). A line with no reason takes the
// common one. Pure, so test/bulk-reject.test.mjs can reach it.
const CLEAN_RESULT = /^(q\.?c\.?\s*)?(pass(ed)?|ok(ay)?|good|fine|approved|accepted|clear(ed)?|nil|none|n\/?a|no\s+(issues?|defects?|problems?))(\s*q\.?c\.?)?\.?$/i;
const LOT_CODE = /LOT-?\d{8}/i;

export function parseRejectLines(raw, fallback = '') {
  const byCode = new Map();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+?)(?:[\s,]+(.*))?$/);
    if (m) byCode.set(m[1].toUpperCase(), (m[2] || '').trim() || String(fallback || '').trim());
  }
  return [...byCode].map(([code, reason]) => ({ code, reason, problem: reasonProblem(reason) }));
}

// Why a line cannot be sent. A QC sheet's result column reads as a reason, and a second label on the
// line would quarantine only the first and leave the other live, so both are refused here.
function reasonProblem(reason) {
  if (reason.length < 3) return 'no reason of 3 or more characters';
  if (reason.length > 300) return 'reason over 300 characters';
  // Any column can be the result one: a sheet with a model column reads as "Flare Race Grey\tPass".
  const clean = reason.split(/[\t,]/).map(c => c.trim().replace(/^["']|["']$/g, '')).find(c => CLEAN_RESULT.test(c));
  if (clean) return `"${clean}" says the unit passed`;
  if (LOT_CODE.test(reason)) return 'more than one label on the line';
  return null;
}

// Reasons with their counts, biggest first: "Pass: 1,376" is visible before anything moves.
export function groupReasons(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.reason, (m.get(l.reason) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}
