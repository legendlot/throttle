// Pure segment-AST helpers, extracted from the segments page (2026-08-13) so the stored-AST
// round-trip can be unit-tested. This is the code that decides what a saved segment MEANS;
// a bug here silently rewrites live audiences on save, so it does not belong inline in a
// page component where nothing can reach it.
// Tests: apps/relay/test/segment-ast.test.js

// A row MUST carry every key its leaf type needs, from the moment it exists.
// Switching the type dropdown used to be a merge patch (`setLeaf(i,{type})`), so an
// attr row became {type:'consent', attr:'', op:'eq', value:''} — no channel/purpose/state.
// Those three <select>s then rendered with value={undefined}, went UNCONTROLLED, and
// displayed their first option while holding nothing; only a dropdown the author actually
// changed got committed. `eval_segment_node` filters `c.purpose = node->>'purpose'`, and a
// missing key makes that `= NULL` — never true — so the leaf silently matched ZERO profiles
// and the enclosing AND wiped out the whole segment. The badge then read "0 MEMBERS", which
// is indistinguishable from "no such customers". Cost: the "T-120 purchasers" segment read 0
// when the real audience was 4,193 (2026-08-09). Always REPLACE the row on a type change.
function blankRow(type) {
  if (type === 'event') return { type: 'event', event: '', count: 1, count_op: 'gte', within: '', whereProp: '', whereValue: '' };
  if (type === 'consent') return { type: 'consent', channel: 'email', purpose: 'marketing', state: 'opted_in' };
  return { type: 'attr', attr: '', op: 'eq', value: '' };
}

// The `within` value is cast straight to ::interval by eval_segment_node, and Postgres reads a
// BARE NUMBER as seconds — '120'::interval is 00:02:00, not 120 days. The field sits behind a
// label that reads "within [120]", so a bare number is the natural thing to type and it silently
// asked for "ordered in the last two minutes". Normalise it to days (the only unit a segment
// author means here); an explicit interval string like '6 hours' is passed through untouched.
function normalizeWithin(v) {
  const s = String(v || '').trim();
  return /^\d+$/.test(s) ? `${s} days` : s;
}

const csvToArr = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// ── Attribute types, and which operators can possibly work on them ─────────────
//
// ⚠️ WHY THIS EXISTS. `eval_segment_node`'s date operators carry a shape guard:
//     WHEN op='within_days' THEN comms._attr(p,k) ~ '^\d{4}-\d{2}-\d{2}' AND (...)::timestamptz >= ...
// That guard is CORRECT — without it a numeric attribute would blow up the cast. But its
// consequence is that a date operator on a non-date attribute matches ZERO profiles, silently.
//
// On 2026-08-15 Mishica built `Match NONE of [ lifetime_orders within last (days) 30 ]` and
// reported that the exclusion changed nothing. It didn't: `lifetime_orders` is a number, so the
// condition matched nobody, and "exclude nobody" is everyone. Measured through the live
// evaluator that morning — her rule and an EMPTY rule both returned 180,713 / 94,585 reachable,
// identical to the digit. She was one click from sending an Independence Day campaign to the
// entire list believing recent purchasers had been taken out.
//
// ⚠️ This is the FOURTH silent-zero in this builder (consent leaf S268, the event `where` filter,
// the dead `email_clicked` suggestion) but the FIRST that widens rather than narrows. The other
// three collapsed a segment to 0, which is loud — you see "0 MEMBERS" and stop. Inside a
// `Match NONE of`, the same fault inflates the audience to everyone and looks completely normal.
// A count that is too BIG has no tell. That asymmetry is the reason this is guarded at the form.
//
// ⚠️ The guard belongs HERE, not in the engine. `eval_segment_node` is re-run at send time by
// every live campaign, and it is explicitly fenced off in reference/decisions.md (2026-08-14).
// Raising there would turn a mis-picked operator into a mid-send failure. Fixing the input at
// the form is also the standing house rule.
//
// Types are MEASURED, not assumed — 2026-08-15, over all 180,713 comms.profiles rows:
//   key                     profiles  date-shaped  numeric-shaped
//   lifetime_orders           87,055        0         87,055
//   total_spent               87,052        0         87,052
//   lifetime_value             6,326        0          6,326
//   shopify_created_at        87,052   87,052              0
//   last_order_at             40,318   40,318              0
//   last_delivery_at           1,687    1,687              0
// Re-measure with the query in archive/ before editing this map; a wrong entry here bans a
// legitimate operator, which is a worse failure than the one it prevents.
const ATTR_TYPES = {
  lifetime_orders: 'number',
  total_spent: 'number',
  lifetime_value: 'number',
  last_order_at: 'date',
  shopify_created_at: 'date',
  last_delivery_at: 'date',
  accepts_email_marketing: 'bool',
  accepts_sms_marketing: 'bool',
  city: 'text',
  display_name: 'text',
  full_name: 'text',
  audience: 'text',
  employee_code: 'text',
  tags: 'text',
};

// Operators that can actually match on each type. An operator absent from this list is not
// "discouraged", it is INERT — it provably matches nobody, so offering it is offering a trap.
// `unknown` keeps every operator: attributes are free text and new ones arrive from Shopify
// without a code change, so an unrecognised name must never be blocked — only flagged.
const OPS_BY_TYPE = {
  number: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  date: ['before_days', 'within_days'],
  bool: ['eq', 'neq'],
  text: ['eq', 'neq', 'in'],
};
const DATE_OPS = ['before_days', 'within_days'];

// Attributes that exist in the picker but resolve to NULL on every profile — measured
// 2026-08-15. `first` was never a real attribute at all, and `locale` is a real column that
// is empty on all 180,713 rows. Both match nobody in any operator, exactly like the
// `email_clicked` event the header comment above records. Kept as a NAMED list rather than
// silently dropped, so the warning can say WHY instead of the row just looking fine.
const EMPTY_ATTRS = { first: 'is not a real attribute', locale: 'is empty on every profile' };

// ── ABSENT IS NOT ZERO, and on this data most profiles are absent ─────────────────────────────
//
// A "never bought" rule written the obvious way — `lifetime_orders is exactly 0` — returns a
// FRACTION of the people it means. On an anonymous browser the attribute is not `0`, it is not
// there at all, and `eval_segment_node` can only match rows that HAVE a value. Measured
// 2026-08-14 on 30d `collection_viewed`: `is exactly 0` matched **1,912** profiles against
// **21,319** for `Match NONE of [lifetime_orders at least 1]` — 11× the people. The bucket split
// of those 22,773 viewers is the whole story: **19,404 have no attribute**, 1,909 hold a real
// zero, 1,461 hold ≥1. Reported by Mishica (#bugs `1786723806.382959`).
//
// ⚠️ This is NOT the inert class. The condition is well-formed, the operator is legal for the
// type, and it matches real people — it just silently means "of the customers we happen to know
// an order count for" instead of "everyone who never bought". It reads as correct, which is why
// it needs saying at the form.
//
// Coverage MEASURED 2026-08-16 over all 186,867 comms.profiles:
//   SELECT k, count(*) FROM comms.profiles p,
//     LATERAL jsonb_object_keys(coalesce(p.attributes,'{}'::jsonb)) k GROUP BY k;
// Re-measure before editing — a wrong figure here either cries wolf or misses the case.
// Only `attributes` keys are listed; display_name/city/locale are promoted COLUMNS and are not
// resolved through this path.
const ATTR_COVERAGE = {
  lifetime_orders: 47.0,
  total_spent: 47.0,
  accepts_email_marketing: 47.0,
  accepts_sms_marketing: 47.0,
  shopify_created_at: 47.0,
  full_name: 30.0,
  last_order_at: 21.8,
  tags: 4.5,
  lifetime_value: 3.6,
  last_delivery_at: 1.0,
};
// Below this, "the ones we have a value for" is a materially different population from "everyone".
const SPARSE_BELOW_PCT = 95;

// Does this condition MEAN "none / never / zero"? Only those undercount in a way the author
// cannot see: `at least 1` also skips absent profiles, but nobody reads that as "everyone".
function meansNone(row) {
  // ⚠️ A BLANK VALUE IS NOT ZERO — `Number('')`, `Number('  ')` and `Number(null)` are all 0, so
  // without this an attr row warns the instant its attribute is typed and BEFORE any value is
  // entered (the default operator is `eq`, so every fresh row hits it). Caught in the S289
  // hostile review: a guard that fires on a half-written row is one authors learn to ignore,
  // which is the failure this whole warning exists to avoid.
  const raw = row?.value;
  if (raw === null || raw === undefined || String(raw).trim() === '') return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return false;
  if (row.op === 'eq' || row.op === 'lte') return n === 0;
  if (row.op === 'lt') return n <= 1;
  return false;
}

const attrType = (attr) => ATTR_TYPES[String(attr || '').trim()] || 'unknown';

// Which operators to offer for an attribute. Unknown attribute → everything.
function opsForAttr(attr, allOps) {
  const allowed = OPS_BY_TYPE[attrType(attr)];
  return allowed ? allOps.filter((o) => allowed.includes(o.id)) : allOps;
}

// Human explanation of why a condition can never match, or null when it is fine.
// Returned as prose because it is rendered straight to a marketer, not to a developer.
function conditionWarning(row) {
  if (!row || row.type !== 'attr') return null;
  const attr = String(row.attr || '').trim();
  if (!attr) return null;
  if (EMPTY_ATTRS[attr]) return `"${attr}" ${EMPTY_ATTRS[attr]} — this condition matches nobody.`;
  const t = attrType(attr);
  if (t === 'unknown') return null;
  const allowed = OPS_BY_TYPE[t] || [];
  if (allowed.includes(row.op)) return null;
  if (DATE_OPS.includes(row.op)) {
    return `"${attr}" holds a ${t === 'number' ? 'number' : t === 'bool' ? 'true/false' : 'word'}, not a date — a day-based operator matches nobody here. For "ordered in the last N days" use last_order_at.`;
  }
  if (t === 'date') return `"${attr}" is a date — use "within last (days)" or "older than (days)".`;
  return `"${attr}" is a ${t}, so this operator matches nobody.`;
}

// The undercount warning, kept SEPARATE from conditionWarning because it is a different claim.
// conditionWarning says "this matches nobody"; this says "this matches far fewer than you mean",
// and collapsing them would put the wrong sentence on the banner.
function coverageWarning(row) {
  if (!row || row.type !== 'attr') return null;
  const attr = String(row.attr || '').trim();
  if (!attr || !meansNone(row)) return null;
  const cov = ATTR_COVERAGE[attr];
  if (cov == null || cov >= SPARSE_BELOW_PCT) return null;
  const absent = Math.round(100 - cov);
  return `${absent}% of profiles have no "${attr}" at all, and absent is not zero — this condition `
    + `skips every one of them, so it means "of the customers we know a value for", not "everyone". `
    + `For a true "never" rule use Match NONE of [ ${attr} at least 1 ] instead.`;
}

// A default operator that is valid for the attribute, used when the attribute changes under an
// operator that no longer applies. Silently leaving the stale operator is what produced the
// inert rule in the first place.
function defaultOpFor(attr, currentOp) {
  const allowed = OPS_BY_TYPE[attrType(attr)];
  if (!allowed || allowed.includes(currentOp)) return currentOp;
  return allowed[0];
}

// stored leaf → editor row
function toRow(leaf) {
  if (leaf && leaf.event != null) return { type: 'event', event: leaf.event || '', count: leaf.count ?? 1,
    count_op: leaf.count_op || 'gte',   // absent === the legacy `>=`, matching eval_segment_node
    within: leaf.within || '',
    whereProp: leaf.where?.prop || '',
    whereValue: Array.isArray(leaf.where?.value) ? leaf.where.value.join(', ') : (leaf.where?.value || '') };
  if (leaf && 'consent' in leaf) return { type: 'consent', channel: leaf.channel || 'email', purpose: leaf.purpose || 'marketing', state: leaf.state || 'opted_in' };
  const v = leaf?.value;
  return { type: 'attr', attr: leaf?.attr || '', op: leaf?.op || 'eq', value: Array.isArray(v) ? v.join(', ') : (v ?? '') };
}
// editor row → stored leaf
function toLeaf(row) {
  if (row.type === 'event') {
    // ⚠️ NOT `Number(row.count) || 1` — that turns a deliberate 0 into 1, which silently
    // inverts "has never done this" into "has done this once". 0 is a legitimate count now
    // that `=` and `≤` exist.
    const n = Number(row.count);
    const o = { event: row.event, count: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1 };
    // Emit count_op ONLY when it is not the legacy default, so re-saving an untouched old
    // segment leaves its stored JSON byte-identical and `absent === gte` stays the one truth.
    if (row.count_op && row.count_op !== 'gte') o.count_op = row.count_op;
    if (row.within && row.within.trim()) o.within = normalizeWithin(row.within);
    // Emit `where` ONLY when both halves are filled. A half-written filter is rejected
    // outright by eval_segment_node (deliberately loud — silently ignoring it would mail an
    // unfiltered audience, silently zeroing it would hide a real one), so never send one.
    const wp = (row.whereProp || '').trim(), wv = (row.whereValue || '').trim();
    if (wp && wv) {
      const list = csvToArr(wv);
      o.where = { prop: wp, value: list.length > 1 ? list : wv };
    }
    return o;
  }
  // Defaults repeated here on purpose: blankRow() now guarantees these keys, but this is the
  // last gate before the AST is persisted, and a consent leaf missing purpose/state is the one
  // shape that fails SILENTLY (matches nobody) instead of erroring. Belt and braces.
  if (row.type === 'consent') return { consent: true, channel: row.channel || 'email', purpose: row.purpose || 'marketing', state: row.state || 'opted_in' };
  return { attr: row.attr, op: row.op, value: row.op === 'in' ? csvToArr(row.value) : String(row.value) };
}
const GROUP_KEYS = ['all', 'any', 'none'];
const groupKeyOf = (n) => (n && typeof n === 'object' ? GROUP_KEYS.find((g) => Array.isArray(n[g])) : undefined);

// stored AST → editor items. An item is either a condition row or a nested GROUP of rows.
//
// ⚠️ The engine has ALWAYS nested (eval_segment_node recurses through all/any/none), but the
// builder was flat, so in 3 months nobody could author a nested rule and not one of the 11 saved
// segments uses it. This exposes ONE level: the top-level group holds conditions and groups, and
// a nested group holds conditions only. That covers "(A and B) or C", which is what was asked for.
//
// ⚠️ `tooDeep` is load-bearing. A definition nested deeper than the builder renders MUST NOT be
// opened for editing, because parse -> edit -> save would silently DELETE the levels the editor
// cannot see. Nothing hand-written like that exists today, but the engine permits it, so the
// editor refuses rather than quietly destroying it.
function parseDef(def) {
  const top = groupKeyOf(def);
  if (top) {
    let tooDeep = false;
    const items = def[top].map((child) => {
      const inner = groupKeyOf(child);
      if (!inner) return toRow(child);
      if (child[inner].some((gc) => groupKeyOf(gc))) tooDeep = true;   // a group inside a group
      return { type: 'group', group: inner, rows: child[inner].map(toRow) };
    });
    return { group: top, items, tooDeep };
  }
  if (def && typeof def === 'object' && (def.attr || def.event != null || 'consent' in def)) {
    return { group: 'all', items: [toRow(def)], tooDeep: false };
  }
  return { group: 'all', items: [], tooDeep: false };
}

// editor items → stored AST. A group with no rows is DROPPED rather than emitted: an empty
// all/any would evaluate to something (everyone, or nobody) that the author never expressed.
function itemsToDef(group, items) {
  const nodes = items
    .map((it) => (it.type === 'group'
      ? (it.rows.length ? { [it.group]: it.rows.map(toLeaf) } : null)
      : toLeaf(it)))
    .filter(Boolean);
  return nodes.length ? { [group]: nodes } : {};
}

// How many LEAF conditions a parsed definition holds, flattening one level of groups.
//
// ⚠️ Lives here, not inline in the list page, because that is exactly where it broke. The
// nesting commit (2026-08-13) changed parseDef's return from `{group, rows}` to
// `{group, items, tooDeep}` and updated every reader but one: the segments LIST still did
// `p.rows.length`, which is `undefined.length` — so the page threw on the first DYNAMIC
// segment and white-screened before rendering anything. Reported by two people within the
// hour; the list is the section's front door, so the whole of Segments was unreachable.
// A count that lives in the tested module cannot be missed by the next rename.
//
// NB it counts leaves, not items: "(A and B) or C" is 3 conditions, not 2.
function countConditions(items) {
  return (items || []).reduce((n, it) => n + (it && it.type === 'group' ? (it.rows || []).length : 1), 0);
}

// Every leaf in a parsed definition, flattening one level of groups, tagged with the group it
// sits in. The group matters: an inert condition inside `none` WIDENS the audience, which is the
// case that has no visible tell (see the ATTR_TYPES header).
function flattenItems(group, items) {
  const out = [];
  (items || []).forEach((it) => {
    if (it && it.type === 'group') (it.rows || []).forEach((r) => out.push({ row: r, group: it.group }));
    else if (it) out.push({ row: it, group });
  });
  return out;
}

// ── Event leaves: the same inert-condition class, but it cannot be answered statically ────────
//
// An `attr` leaf is inert for a TYPE reason, so the map above settles it with no database. An
// EVENT leaf is different in kind: the event name can be perfectly real and correctly registered,
// and the leaf still matches nobody because no rows exist inside the chosen window. That is a DATA
// fact, and no amount of static analysis reaches it — the only honest answer is to count.
//
// ⚠️ Same asymmetry, same reason it matters. Under `all`/`any` an empty event leaf collapses the
// segment toward 0, which is loud. Under `Match NONE of` it excludes nobody and the audience
// becomes EVERYONE, with no tell on screen — a count that is too big looks exactly like success.
//
// The count is supplied by the caller (the page evaluates each leaf alone through previewSegment)
// rather than fetched here, so this module stays pure and unit-testable.
//
// ⚠️ ONLY a confirmed zero warns. An unchecked leaf, an in-flight check and a failed check all
// return no warning, deliberately: a banner that cries "matches nobody" while it is still counting
// would be wrong most of the time it appeared, and a guard people learn to dismiss is worse than
// no guard — this one exists precisely to be believed on the day it fires.
const eventLeafKey = (row) => (row && row.type === 'event' && String(row.event || '').trim()
  ? JSON.stringify(toLeaf(row)) : null);

function eventWarning(row, count) {
  if (!row || row.type !== 'event') return null;
  const ev = String(row.event || '').trim();
  if (!ev || count !== 0) return null;       // strict: undefined/null (unknown) never warns
  const win = String(row.within || '').trim();
  return `No profile matches "${ev}"${win ? ` within ${normalizeWithin(win)}` : ''}`
    + ' — this condition matches nobody.'
    + (win ? ' The event is registered but has no rows in that window; try a longer window.' : '');
}

// Every warning in the rule, worst first. `widening` marks the dangerous ones — an inert
// condition under `Match NONE of`, where the audience silently becomes everyone.
//
// `eventCounts` is an optional { leafKey: number } of per-leaf match counts; absent means the
// event checks simply contribute nothing, so every existing caller and test is unchanged.
function ruleWarnings(group, items, eventCounts) {
  return flattenItems(group, items)
    .flatMap(({ row, group: g }) => {
      const out = [];
      const inert = row && row.type === 'event'
        ? eventWarning(row, eventCounts?.[eventLeafKey(row)])
        : conditionWarning(row);
      if (inert) out.push({ text: inert, kind: 'inert', widening: g === 'none' });
      // Reported even when the row is also inert: they are different faults and fixing one does
      // not fix the other.
      const under = coverageWarning(row);
      if (under) out.push({ text: under, kind: 'undercount', widening: false });
      return out;
    })
    // Inert-and-widening first (silently everyone), then the rest of the inert ones (silently
    // nobody), then undercounts (quietly fewer than you meant).
    .sort((a, b) => (Number(b.widening) - Number(a.widening))
      || (Number(b.kind === 'inert') - Number(a.kind === 'inert')));
}

// Distinct event leaves in a rule, as [{ key, leaf }] — what the page needs to count. Distinct by
// key, because the same condition written twice is one question, not two round trips.
function eventLeaves(group, items) {
  const seen = new Map();
  flattenItems(group, items).forEach(({ row }) => {
    const key = eventLeafKey(row);
    if (key && !seen.has(key)) seen.set(key, { key, leaf: toLeaf(row) });
  });
  return [...seen.values()];
}

export { blankRow, normalizeWithin, csvToArr, toRow, toLeaf, parseDef, itemsToDef, countConditions, groupKeyOf, GROUP_KEYS,
  ATTR_TYPES, OPS_BY_TYPE, EMPTY_ATTRS, attrType, opsForAttr, conditionWarning, defaultOpFor, flattenItems, ruleWarnings,
  eventLeafKey, eventWarning, eventLeaves,
  ATTR_COVERAGE, SPARSE_BELOW_PCT, meansNone, coverageWarning };
