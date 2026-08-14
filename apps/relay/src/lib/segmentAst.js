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

export { blankRow, normalizeWithin, csvToArr, toRow, toLeaf, parseDef, itemsToDef, countConditions, groupKeyOf, GROUP_KEYS };
