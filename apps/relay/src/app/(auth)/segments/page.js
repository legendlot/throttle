'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Trash2, Filter, RefreshCw, Eye } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';
import { useNewParam } from '@/lib/useNewParam.js';
import { loadEventDefs, eventComboOptions } from '@/lib/eventDefs.js';
import { blankRow, toLeaf, parseDef, itemsToDef, countConditions, normalizeWithin,
  opsForAttr, conditionWarning, defaultOpFor, ruleWarnings,
  eventLeafKey, eventWarning, eventLeaves } from '@/lib/segmentAst.js';

const GROUPS = [
  { id: 'all', label: 'Match ALL of', hint: 'every condition (AND)' },
  { id: 'any', label: 'Match ANY of', hint: 'at least one (OR)' },
  { id: 'none', label: 'Match NONE of', hint: 'exclude all (NOT)' },
];
const LEAF_TYPES = ['attr', 'event', 'consent'];
// Operator ids are the engine's AST vocabulary (eval_segment_node); the LABELS are what a
// marketer reads — "gte" invites mis-picks, "at least" doesn't. before/within_days are the
// migration-0022 relative-date ops (numeric days against a date attribute, e.g. last_order_at).
// ⚠️ "is exactly" / "is not exactly", NOT "is" / "is not" (2026-08-13). S232 renamed these from
// the raw ids to plain language, which was right, but "is" sitting in a list next to "at least"
// and "more than" does not READ as equality — it was understood as "no equality operator exists"
// and a request came in to add one that had been there since day one. The word "exactly" is the
// whole point: it is the only label in the list that cannot be misread as a range.
const OPS = [
  { id: 'eq', label: 'is exactly' },
  { id: 'neq', label: 'is not exactly' },
  { id: 'in', label: 'is any of' },
  { id: 'gt', label: 'more than' },
  { id: 'gte', label: 'at least' },
  { id: 'lt', label: 'less than' },
  { id: 'lte', label: 'at most' },
  { id: 'before_days', label: 'older than (days)' },
  { id: 'within_days', label: 'within last (days)' },
];
// Measured against live comms.profiles 2026-08-15 — profile counts in the labels, because
// "which attribute do I use" is really "which one is actually populated". The previous list was
// 7 names of which TWO matched nobody (`first` was never an attribute; `locale` is empty on all
// 180,713 rows) while omitting the four most-populated attributes in the system, `total_spent`
// and `shopify_created_at` among them at 87k each. Same failure as the `email_clicked` event
// suggestion recorded above: a picker is a promise that what it offers can match something.
const ATTR_SUGGEST = [
  ['lifetime_orders', 'number · 87,055'],
  ['total_spent', 'number · 87,052'],
  ['lifetime_value', 'number · 6,326'],
  ['last_order_at', 'date · 40,318'],
  ['shopify_created_at', 'date · 87,052'],
  ['last_delivery_at', 'date · 1,687'],
  ['accepts_email_marketing', 'true/false · 87,052'],
  ['accepts_sms_marketing', 'true/false · 87,052'],
  ['display_name', 'text · 70,601'],
  ['full_name', 'text · 55,356'],
  ['city', 'text · 49,552'],
  ['tags', 'text · 8,402'],
  ['audience', 'text · 55'],
];
// Event names come from the LIVE comms.event_definitions registry (see @/lib/eventDefs.js).
// The hardcoded EVENT_SUGGEST that used to live here listed 10 of 34 registered events and
// offered `email_clicked`, which S189 renamed to `link_clicked` — a condition that could
// never match. Registering an event now surfaces it here automatically.
const CHANNELS = ['email', 'sms', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATES = ['opted_in', 'opted_out', 'unknown'];

// ── One condition row ──────────────────────────────────────────────────────────
// Extracted from the flat list so the SAME editor renders a condition whether it sits at the
// top level or inside a nested group (2026-08-13). It takes callbacks rather than closing over
// an index, because a nested row's index is meaningless to the parent list.
function ConditionRow({ r, onPatch, onType, onRemove, disabled, canEdit, eventDefs, propOpts, eventCounts }) {
  return (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: 10 }}>
  <select className="f-inp" style={{ width: 110 }} value={r.type} onChange={(e) => onType(e.target.value)} disabled={disabled}>
    {LEAF_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
  </select>

  {r.type === 'attr' && <>
    {/* Changing the attribute also moves the OPERATOR when the old one cannot apply to the new
        type. Leaving it put is what produced the inert rule this guard exists for: the row was
        already on "within last (days)" from a date attribute, the attribute changed to a number,
        and the stale date operator silently matched nobody. */}
    <input className="f-inp mono" style={{ width: 160 }} list="attr-suggest" value={r.attr || ''}
      onChange={(e) => { const attr = e.target.value; onPatch({ attr, op: defaultOpFor(attr, r.op) }); }}
      placeholder="attribute" disabled={disabled} />
    {/* Only operators that can actually match this attribute's type. An unknown attribute keeps
        the full list — new attributes arrive from Shopify without a code change here, so an
        unrecognised name is flagged, never blocked. */}
    <select className="f-inp" style={{ width: 150 }} value={r.op} onChange={(e) => onPatch({ op: e.target.value })} disabled={disabled}>
      {opsForAttr(r.attr, OPS).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
    <input className="f-inp" style={{ flex: 1, minWidth: 140 }} value={r.value || ''} onChange={(e) => onPatch({ value: e.target.value })}
      placeholder={r.op === 'in' ? 'comma, separated, values'
        : (r.op === 'before_days' || r.op === 'within_days') ? 'number of days (e.g. 90)' : 'value'}
      disabled={disabled} />
    {/* Same idiom as the event-property coverage warning below — an inline ⚠ on the row that is
        wrong, rather than a modal on save. A saved segment is read back through this editor, so
        an older rule carrying an inert condition surfaces the moment anyone opens it. */}
    {(() => { const w = conditionWarning(r); return w
      ? <span style={{ fontSize: 11.5, color: 'var(--warn, #e0a33e)', flexBasis: '100%' }}>⚠ {w}</span>
      : null; })()}
  </>}

  {r.type === 'event' && <>
    {/* Combobox (not a datalist): a datalist filters against what is
        ALREADY in the input, so a pre-filled field collapsed to one row
        and read as empty/broken. Grouped by category — PATTERN-160. */}
    <div style={{ width: 240 }}>
      <Combobox
        value={r.event || ''}
        options={eventComboOptions(eventDefs)}
        onChange={(v) => onPatch({ event: v || '' })}
        placeholder="Search events…"
        disabled={disabled}
        allowClear={false}
        emptyLabel="No matching event — check it is registered in comms.event_definitions"
      />
    </div>
    {/* The count operator (2026-08-13). This was a STATIC `≥` glyph, so
        "ordered exactly once" could not be said on an event at all — the
        engine hardcoded `HAVING count(*) >= n` to match. `count_op` absent
        still means `≥`, so every segment saved before today is unchanged.
        NB min is 0, not 1: "= 0" and "≤ 0" are the useful "never did this"
        forms, and the engine handles zero by counting over ALL profiles
        rather than over event rows (a profile with no events has no row to
        group). Under `≥` a 0 is meaningless but harmless — it resolves to
        the legacy path, i.e. "has the event at all". */}
    <select className="f-inp mono" style={{ width: 62, textAlign: 'center' }}
      value={r.count_op || 'gte'} disabled={disabled}
      onChange={(e) => onPatch({ count_op: e.target.value })}>
      <option value="gte">≥</option>
      <option value="eq">=</option>
      <option value="lte">≤</option>
    </select>
    <input className="f-inp mono" style={{ width: 64 }} type="number" min="0" value={r.count} onChange={(e) => onPatch({ count: e.target.value })} disabled={disabled} />
    <span className="dim" style={{ fontSize: 12 }}>within last</span>
    <input className="f-inp mono" style={{ width: 120 }} value={r.within || ''} onChange={(e) => onPatch({ within: e.target.value })} placeholder="120 days (opt)" disabled={disabled} />
    {/* Echo what a bare number will actually be saved as — the old field read
        "within [120]" and silently meant 120 SECONDS. */}
    {/^\d+$/.test(String(r.within || '').trim()) && <span className="dim" style={{ fontSize: 11.5 }}>= {normalizeWithin(r.within)}</span>}

    {/* Narrow to a specific product (S268, Mishica). Both pickers are fed by
        live event data — a typed-in property name would resolve to NULL and
        match nobody, silently. Coverage is shown because it decides the answer:
        `sku` sits on ~60% of product_viewed events, `product_handle` on 100%. */}
    {r.event && <>
      <span className="dim" style={{ fontSize: 12 }}>where</span>
      <div style={{ width: 190 }}>
        <Combobox
          value={r.whereProp || ''}
          options={(propOpts[r.event] || []).map((o) => ({
            value: o.key,
            label: `${o.key} · ${o.coverage_pct}% of events`,
          }))}
          onChange={(v) => onPatch({ whereProp: v || '', whereValue: v ? r.whereValue : '' })}
          placeholder={propOpts[r.event] ? 'any (no filter)' : 'loading…'}
          disabled={disabled}
          emptyLabel="This event carries no filterable properties"
        />
      </div>
      {r.whereProp && <>
        <span className="dim" style={{ fontSize: 12 }}>is</span>
        <div style={{ width: 250 }}>
          <Combobox
            value={r.whereValue || ''}
            options={((propOpts[r.event] || []).find((o) => o.key === r.whereProp)?.top_values || [])
              .map((v) => ({ value: v, label: v }))}
            onChange={(v) => onPatch({ whereValue: v || '' })}
            placeholder="pick a value"
            disabled={disabled}
            allowClear={false}
            emptyLabel="No values seen in the last 90 days"
          />
        </div>
        {(() => {
          const cov = (propOpts[r.event] || []).find((o) => o.key === r.whereProp)?.coverage_pct;
          return cov != null && cov < 100
            ? <span className="dim" style={{ fontSize: 11.5 }}>⚠ only {cov}% of these events carry {r.whereProp}</span>
            : null;
        })()}
      </>}
    </>}
    {/* Same row-level ⚠ the attr branch carries, from a COUNTED zero rather than a type check —
        an event leaf can only be proved inert by evaluating it (see lib/segmentAst.js). Nothing
        renders while the count is unknown or in flight; only a confirmed 0 speaks. */}
    {(() => { const w = eventWarning(r, eventCounts?.[eventLeafKey(r)]); return w
      ? <span style={{ fontSize: 11.5, color: 'var(--warn, #e0a33e)', flexBasis: '100%' }}>⚠ {w}</span>
      : null; })()}
  </>}

  {r.type === 'consent' && <>
    <select className="f-inp" style={{ width: 120 }} value={r.channel} onChange={(e) => onPatch({ channel: e.target.value })} disabled={disabled}>
      {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
    <select className="f-inp" style={{ width: 130 }} value={r.purpose} onChange={(e) => onPatch({ purpose: e.target.value })} disabled={disabled}>
      {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
    <select className="f-inp" style={{ width: 120 }} value={r.state} onChange={(e) => onPatch({ state: e.target.value })} disabled={disabled}>
      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  </>}

  <span style={{ flex: 1 }} />
  {canEdit && <button className="dr-close" onClick={() => onRemove()} disabled={disabled} title="Remove"><Trash2 size={14} /></button>}
  </div>
  );
}

// ── A nested group of conditions ───────────────────────────────────────────────
// Renders as an indented, accented block so the eye can see where the bracket opens and closes.
// It reuses ConditionRow, so a condition behaves identically inside a group and outside one.
function GroupRow({ g, disabled, canEdit, eventDefs, propOpts, eventCounts, onPatch, onRemove }) {
  const patchRow = (j, patch) => onPatch({ rows: g.rows.map((r, k) => (k === j ? { ...r, ...patch } : r)) });
  // REPLACE on a type change, never merge — same reasoning as blankRow() above.
  const typeRow = (j, tp) => onPatch({ rows: g.rows.map((r, k) => (k === j ? blankRow(tp) : r)) });
  const dropRow = (j) => onPatch({ rows: g.rows.filter((_, k) => k !== j) });
  return (
    <div style={{ border: '1px solid var(--accent-bd)', background: 'var(--accent-soft)',
      borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="dim mono" style={{ fontSize: 11 }}>GROUP</span>
        <select className="f-inp" style={{ width: 'auto' }} value={g.group} disabled={disabled}
          onChange={(e) => onPatch({ group: e.target.value })}>
          {GROUPS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <span className="dim" style={{ fontSize: 12 }}>{GROUPS.find((x) => x.id === g.group)?.hint}</span>
        <span style={{ flex: 1 }} />
        {canEdit && <Btn kind="ghost" onClick={() => onPatch({ rows: [...g.rows, blankRow('attr')] })} disabled={disabled}>
          <Plus size={13} /> Condition
        </Btn>}
        {canEdit && <button className="dr-close" onClick={onRemove} disabled={disabled} title="Remove group"><Trash2 size={14} /></button>}
      </div>
      {g.rows.length === 0
        ? <div className="dim" style={{ fontSize: 12 }}>Empty group — add a condition, or remove it. An empty group is ignored when the rule is saved.</div>
        : g.rows.map((r, j) => (
            <ConditionRow key={j} r={r} disabled={disabled} canEdit={canEdit}
              eventDefs={eventDefs} propOpts={propOpts} eventCounts={eventCounts}
              onPatch={(patch) => patchRow(j, patch)}
              onType={(tp) => typeRow(j, tp)}
              onRemove={() => dropRow(j)} />
          ))}
    </div>
  );
}

function emptySeg() { return { id: null, name: '', kind: 'dynamic', group: 'all', items: [], tooDeep: false, member_count: null, materialized_at: null, updated_at: null, is_stale: false, savedDef: null }; }

// A dynamic segment's member_count is COUNT(segment_members) — so a segment nobody has ever
// refreshed counts 0, which rendered as a bare "0" and read as "this audience is empty".
// "Winback 90 — Email" showed 0 against a live rule matching 25,084. `materialized_at`
// (migration comms_segment_materialized_at_v1, NULL = never) is what separates the two.
// Static segments are the opposite case: membership is an explicit list, so 0 IS the answer.
// THREE states, not two. The third was added 2026-08-14 after it was reported as a data
// mismatch: a count that was correct when it ran, but whose RULE has been edited since.
//
// Mishica refreshed "T-90 purchasers" at 05:15:19 (1,820 members), edited the rule 75 seconds
// later at 05:16:34, and then read a badge saying 1,820 next to a Preview saying 6,086. Both
// numbers were right — Preview evaluates the CURRENT rule live, the badge reports the last
// materialize — but nothing on screen said the badge predated the edit, so the only available
// reading was "the two disagree". Comparing it against another segment then made it look worse
// still: T-90 appeared SMALLER than T-30, which for a 90-day-vs-30-day superset is impossible.
//
// ⚠️ Do not "fix" this by hiding the count or by auto-materializing on edit. Materializing a
// 25k segment is real work and must stay an explicit action (see the getSegments comment).
// Naming the staleness is the fix.
//
// ⚠️ S282 — `isStale` is the SERVER's verdict (segments_list), computed as
// `materialized_def IS DISTINCT FROM definition`: does the stored count describe the rule as it
// now stands? Do NOT reintroduce the timestamp comparison this replaced
// (`updated_at > materialized_at`). It was wrong in two ways a user reached within the hour:
// saveSegment stamps `updated_at` unconditionally, so re-saving an UNCHANGED rule turned a
// current count amber; and pressing "Refresh members" then "Save segment" — the obvious order,
// since Save is the primary button — always ended amber too. Both told Mishica her count was
// wrong when it was exactly right, which reads as "the sync is broken".
function memberState(kind, memberCount, materializedAt, isStale) {
  if (kind !== 'dynamic') return { text: memberCount != null ? Number(memberCount).toLocaleString('en-IN') : '—', stale: false };
  if (!materializedAt) {
    return { text: 'Not counted', stale: true,
      title: 'This rule has never been counted. The number of people it matches is unknown — it is NOT zero. Open the segment and press "Refresh members".' };
  }
  const n = Number(memberCount || 0).toLocaleString('en-IN');
  if (isStale) {
    return { text: `${n} (out of date)`, stale: true,
      title: `The rule has changed since this count was taken on ${fmtDateTime(materializedAt)} — so ${n} describes the OLD rule, not the one shown. Press "Refresh members" to recount. Sending is unaffected: a campaign re-counts the segment before it sends.` };
  }
  return { text: n, stale: false,
    title: `As of ${fmtDateTime(materializedAt)}. A dynamic rule is re-evaluated on every send, so the live audience may differ — press "Refresh members" to recount.` };
}

export default function SegmentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [seg, setSeg] = useState(emptySeg());
  const [saving, setSaving] = useState(false);

  // preview state
  const [pvChannel, setPvChannel] = useState('email');
  const [pvPurpose, setPvPurpose] = useState('marketing');
  const [pv, setPv] = useState(null);
  const [pvLoading, setPvLoading] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [eventDefs, setEventDefs] = useState([]);
  // Per-event-leaf match counts, keyed by the leaf's stored JSON. Persisted across edits by key
  // (never cleared wholesale) so editing one row does not re-query the others. See the event
  // section of lib/segmentAst.js for why this has to be counted rather than reasoned about.
  const [eventCounts, setEventCounts] = useState({});
  const eventCountsRef = useRef({});
  // S268 — per-event property options, cached by event name: { [event]: [{key,coverage_pct,top_values}] }.
  // Loaded on demand because it aggregates real event rows; only fetched for events actually used.
  const [propOpts, setPropOpts] = useState({});

  // static-segment membership (S263)
  const [members, setMembers] = useState({ total: 0, rows: [] });
  const [memLoading, setMemLoading] = useState(false);
  const [memInput, setMemInput] = useState('');
  const [memBusy, setMemBusy] = useState(false);
  const [addResult, setAddResult] = useState(null);

  // `tooDeep` hard-disables editing as well as showing the banner: a rule nested deeper than the
  // builder renders must be read-only, or a save would silently drop the levels it cannot see.
  const canEdit = (!perms || perms.segment_manage) && !seg.tooDeep;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      // Registry-backed event picker alongside the segment list. loadEventDefs never
      // rejects (it falls back internally), so it can share the page's try block without
      // a suggestion list ever being able to fail the load.
      const [r, ev] = await Promise.all([
        garageFetch('getSegments', {}, session),
        loadEventDefs(garageFetch, session),
      ]);
      setRows(Array.isArray(r) ? r : []);
      setEventDefs(ev);
    } catch (e) { showToast(e.message || 'Failed to load segments', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setSeg(emptySeg()); setPv(null); setView('form'); }
  // ⌘K "New segment" — cross-screen ?new=1 + same-screen relay:new event.
  useNewParam(canEdit, startNew);
  async function startEdit(r) {
    const parsed = parseDef(r.definition);
    // `savedDef` is the rule AS PERSISTED, kept so refreshMembers() can tell whether what is on
    // screen has drifted from what the server would count. Stored serialised for cheap compare.
    setSeg({ id: r.id, name: r.name || '', kind: r.kind || 'dynamic', group: parsed.group, items: parsed.items, tooDeep: parsed.tooDeep, member_count: null, materialized_at: r.materialized_at ?? null, updated_at: r.updated_at ?? null, is_stale: !!r.is_stale, savedDef: JSON.stringify(itemsToDef(parsed.group, parsed.items)) });
    setPv(null);
    setView('form');
    try {
      const d = await garageFetch('getSegment', { id: r.id }, session);
      if (d?.segment) setSeg((s) => ({ ...s, member_count: d.member_count ?? null, materialized_at: d.segment.materialized_at ?? null, updated_at: d.segment.updated_at ?? s.updated_at, is_stale: !!d.is_stale }));
    } catch { /* non-fatal */ }
  }
  // Fetch property options for every event named in the rule, once each. Failure is
  // non-fatal — the pickers just stay empty rather than blocking the builder.
  useEffect(() => {
    if (view !== 'form') return;
    // Flatten one level: a nested group's event rows need their property options loaded too,
    // otherwise the `where` picker inside a group comes up empty and reads as broken.
    const flat = seg.items.flatMap((it) => (it.type === 'group' ? it.rows : [it]));
    const wanted = [...new Set(flat.filter((r) => r.type === 'event' && r.event).map((r) => r.event))];
    const missing = wanted.filter((e) => !(e in propOpts));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (const ev of missing) {
        try {
          const r = await garageFetch('getEventPropertyOptions', { event: ev, days: 90 }, session);
          if (!cancelled) setPropOpts((p) => ({ ...p, [ev]: Array.isArray(r) ? r : [] }));
        } catch { if (!cancelled) setPropOpts((p) => ({ ...p, [ev]: [] })); }
      }
    })();
    return () => { cancelled = true; };
  }, [view, seg.items, propOpts, session]);

  function set(k, v) { setSeg((s) => ({ ...s, [k]: v })); }
  function addItem() { setSeg((s) => ({ ...s, items: [...s.items, blankRow('attr')] })); }
  // A nested group starts as OR, because the only reason to open a bracket inside the default
  // top-level AND is to say "any of these" within it. Starting it as AND would be a no-op group.
  function addGroup() { setSeg((s) => ({ ...s, items: [...s.items, { type: 'group', group: 'any', rows: [blankRow('attr')] }] })); }
  // REPLACE, never merge — see blankRow(). A merge patch left the new type's required keys
  // missing, the selects went uncontrolled, and the leaf silently matched zero profiles.
  function setItemType(i, type) { setSeg((s) => ({ ...s, items: s.items.map((r, j) => j === i ? blankRow(type) : r) })); }
  function patchItem(i, patch) { setSeg((s) => ({ ...s, items: s.items.map((r, j) => j === i ? { ...r, ...patch } : r) })); }
  function removeItem(i) { setSeg((s) => ({ ...s, items: s.items.filter((_, j) => j !== i) })); }

  function buildDef() {
    return itemsToDef(seg.group, seg.items);
  }

  async function preview() {
    setPvLoading(true); setPv(null);
    try {
      const r = await workerFetch('previewSegment', { definition: buildDef(), channel: pvChannel, purpose: pvPurpose }, session);
      setPv(r?.data || null);
    } catch (e) { showToast(e.message || 'Preview failed', 'error'); }
    finally { setPvLoading(false); }
  }

  // ── Count each EVENT leaf on its own, so an inert one can be named ────────────────────────
  //
  // The whole-rule Preview cannot do this job: it returns ONE number, and when that number is
  // wrong the number itself is the only evidence — it cannot say WHICH condition emptied the
  // rule, and under `Match NONE of` it does not even read as wrong (the audience just looks
  // big). So each event leaf is evaluated alone, as `{all:[leaf]}`, and a confirmed zero is
  // attributed to that exact row.
  //
  // ⚠️ Runs WITHOUT pressing Preview, on purpose. The attr guard warns the moment the row is
  // wrong; an event guard that only fired on a button press would be a guard the 15 Aug send
  // would have walked straight past, since the rule looked fine and Preview returned a large,
  // plausible number.
  //
  // Debounced, and cached by leaf key across edits — editing row 2 must not re-ask row 1's
  // question. Results are only ever ADDED to the map: a key that is already answered is never
  // re-fetched, and a failed check writes nothing (unknown ≠ zero, and only zero warns).
  const eventKeys = eventLeaves(seg.group, seg.items).map((l) => l.key).join('|');
  useEffect(() => {
    if (seg.kind !== 'dynamic') return undefined;
    const leaves = eventLeaves(seg.group, seg.items).filter((l) => !(l.key in eventCountsRef.current));
    if (!leaves.length) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const session = await getValidSession();
      if (!session || cancelled) return;
      // Sequential, not Promise.all: this is a background nicety running while someone types,
      // and it shares the evaluator with live campaign sends. A rule with six event leaves
      // must not fire six concurrent full-table evaluations to answer a hint.
      for (const l of leaves) {
        if (cancelled) return;
        try {
          // sample:false — previewSegment otherwise ALSO runs preview_segment_sample and returns
          // real customer rows. This check needs one integer; pulling PII to answer a hint nobody
          // asked for is both a second RPC per leaf and a surface with no reason to exist.
          const r = await workerFetch('previewSegment',
            { definition: { all: [l.leaf] }, channel: pvChannel, purpose: pvPurpose, sample: false }, session);
          const total = Number(r?.data?.total);
          if (cancelled || !Number.isFinite(total)) continue;
          eventCountsRef.current = { ...eventCountsRef.current, [l.key]: total };
          setEventCounts(eventCountsRef.current);
        } catch {
          // Swallowed by design — an unanswerable check must leave the leaf UNKNOWN, never 0.
          // Writing a 0 here would invent the exact warning this feature exists to make credible.
        }
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
    // Keyed on the leaf signature, never on `session` — a token refresh lands ~hourly and would
    // otherwise re-run this for no reason (CORE.md, the useAuth session-churn rule).
    // channel/purpose are deliberately NOT dependencies: previewSegment's `total` is the raw
    // match count and only `reachable` varies by them, so re-running on a channel change would
    // buy an identical answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventKeys, seg.kind]);

  // Returns the segment id on success, null on failure — refreshMembers() chains on it.
  async function save({ silent = false } = {}) {
    if (!seg.name.trim()) { showToast('Name required', 'error'); return null; }
    setSaving(true);
    try {
      const def = buildDef();
      const payload = { name: seg.name.trim(), kind: seg.kind, definition: def };
      if (seg.id) payload.id = seg.id;
      const r = await workerFetch('saveSegment', payload, session);
      const saved = r?.data;
      const id = saved?.id || seg.id;
      if (saved?.id && !seg.id) set('id', saved.id);
      setSeg((s) => ({ ...s, updated_at: saved?.updated_at || s.updated_at, savedDef: JSON.stringify(def) }));
      // Whether the stored count still describes this rule is the SERVER's call (it compares
      // materialized_def to definition), so ask it rather than assuming a save invalidates the
      // count. Assuming it did is exactly what turned a re-save of an UNCHANGED rule amber.
      try {
        const d = await garageFetch('getSegment', { id }, session);
        if (d?.segment) setSeg((s) => ({ ...s, is_stale: !!d.is_stale, member_count: d.member_count ?? s.member_count, materialized_at: d.segment.materialized_at ?? s.materialized_at }));
      } catch { /* non-fatal — the badge just keeps its last known state */ }
      if (!silent) showToast(seg.id ? 'Segment saved' : 'Segment created', 'success');
      load();
      return id;
    } catch (e) { showToast(e.message || 'Save failed', 'error'); return null; }
    finally { setSaving(false); }
  }

  // ── static-segment membership (S263) ──
  const loadMembers = useCallback(async (segId) => {
    if (!segId || !session) return;
    setMemLoading(true);
    try {
      const r = await garageFetch('getSegmentMembers', { id: segId, limit: 200 }, session);
      setMembers({ total: r?.total ?? 0, rows: Array.isArray(r?.rows) ? r.rows : [] });
    } catch (e) { showToast(e.message || 'Failed to load members', 'error'); }
    finally { setMemLoading(false); }
  }, [session, showToast]);

  // Only static segments manage members by hand; a dynamic one's list comes from its rule.
  useEffect(() => {
    if (view === 'form' && seg.kind === 'static' && seg.id) loadMembers(seg.id);
    else setMembers({ total: 0, rows: [] });
  }, [view, seg.kind, seg.id, loadMembers]);

  async function addMembers() {
    if (!seg.id || !memInput.trim()) return;
    setMemBusy(true); setAddResult(null);
    try {
      const r = await workerFetch('addSegmentMembers', { id: seg.id, values: memInput }, session);
      const d = r?.data || {};
      setAddResult(d);
      // Keep whatever could not be matched in the box — it is the retry list, and clearing
      // it would hide typos behind a count.
      setMemInput(Array.isArray(d.unmatched) ? d.unmatched.join('\n') : '');
      set('member_count', typeof d.total === 'number' ? d.total : seg.member_count);
      await loadMembers(seg.id);
      showToast(`${d.added || 0} added`, 'success');
      load();
    } catch (e) { showToast(e.message || 'Add failed', 'error'); }
    finally { setMemBusy(false); }
  }

  async function removeMember(m) {
    if (!seg.id) return;
    const who = m.email || m.phone || m.display_name || 'this contact';
    if (!window.confirm(`Remove ${who} from "${seg.name}"?`)) return;
    setMemBusy(true);
    try {
      const r = await workerFetch('removeSegmentMember', { id: seg.id, profile_id: m.profile_id }, session);
      set('member_count', typeof r?.data?.total === 'number' ? r.data.total : seg.member_count);
      await loadMembers(seg.id);
      load();
    } catch (e) { showToast(e.message || 'Remove failed', 'error'); }
    finally { setMemBusy(false); }
  }

  async function refreshMembers() {
    if (!seg.id) { showToast('Save the segment first', 'error'); return; }
    // ⚠️ materialize_segment reads the definition FROM THE DB — it is passed an id, never a
    // rule. So refreshing a form with unsaved edits counts the PREVIOUSLY SAVED rule and then
    // reports "Members refreshed — N" as though N described what is on screen. That is a
    // confidently wrong number, and it is the natural thing to do: build the rule, press
    // Refresh to see how many it catches. Persist first when the two differ.
    // Exploring without committing is what Preview is for — it evaluates the on-screen rule live.
    const dirty = JSON.stringify(buildDef()) !== seg.savedDef;
    let id = seg.id;
    if (dirty) { id = await save({ silent: true }); if (!id) return; }
    setMaterializing(true);
    try {
      const r = await workerFetch('materializeSegment', { id }, session);
      const n = r?.data?.members;
      // Stamp locally too, so the badge flips immediately. The RPC is the authority (it sets
      // materialized_at + materialized_def server-side); this just avoids a reload. is_stale is
      // false by construction here: the count was just taken against the stored definition.
      setSeg((s) => ({ ...s, member_count: typeof n === 'number' ? n : s.member_count, materialized_at: new Date().toISOString(), is_stale: false }));
      showToast(`${dirty ? 'Saved and refreshed' : 'Members refreshed'}${typeof n === 'number' ? ` — ${n}` : ''}`, 'success');
      load();
    } catch (e) { showToast(e.message || 'Refresh failed', 'error'); }
    finally { setMaterializing(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  if (view === 'form') {
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to segments</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{seg.id ? (seg.name || 'Segment') : 'New Segment'}</span>
            {/* Never show a bare "0 members" for a rule nobody has counted — see memberState().
                And never show a bare count for a rule edited SINCE that count: this is the badge
                that was read as a data mismatch on 2026-08-14, because it sat next to a live
                Preview of the new rule with nothing to say it described the old one. */}
            {seg.kind === 'dynamic' && seg.id && !seg.materialized_at
              ? <Badge label="Not counted" tone="gray" dot />
              : (seg.member_count != null && (() => {
                  const ms = memberState(seg.kind, seg.member_count, seg.materialized_at, seg.is_stale);
                  return <Badge label={ms.stale ? `${seg.member_count} members — out of date` : `${seg.member_count} members`}
                                tone={ms.stale ? 'orange' : 'blue'} dot title={ms.title} />;
                })())}
          </div>
          <div className="po-head-r">
            {seg.id && seg.kind === 'dynamic' && canEdit && <Btn onClick={refreshMembers} disabled={materializing}><RefreshCw size={14} /> {materializing ? 'Refreshing…' : 'Refresh members'}</Btn>}
            {canEdit && <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save segment'}</Btn>}
          </div>
        </div>

        <Panel title="Details" pad>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Name</div>
              <input className="f-inp" value={seg.name} onChange={(e) => set('name', e.target.value)} placeholder="Lapsed buyers · 90 days" disabled={saving || !canEdit} />
            </div>
            <div className="ff"><div className="kv-k">Kind</div>
              <select className="f-inp" value={seg.kind} onChange={(e) => set('kind', e.target.value)} disabled={saving || !canEdit}>
                <option value="dynamic">dynamic — live rule</option>
                <option value="static">static — fixed list</option>
              </select>
            </div>
          </div>
          {seg.kind === 'static' && (
            <div className="tw-note" style={{ marginTop: 12 }}>Static membership is a fixed list you manage here — no rule, and nothing re-evaluates it. Save the segment, then add people below.</div>
          )}
        </Panel>

        {seg.kind === 'static' && (
          <Panel title="Members" pad>
            {!seg.id ? (
              <div className="dim" style={{ fontSize: 12.5 }}>Save the segment first, then add people to it.</div>
            ) : (
              <>
                {canEdit && (
                  <div style={{ marginBottom: 14 }}>
                    <textarea className="f-inp" rows={4} value={memInput} onChange={(e) => setMemInput(e.target.value)}
                      placeholder={'Paste emails or phone numbers — one per line, or comma separated\nhello@legendoftoys.com\n+91 70191 03926'}
                      disabled={memBusy} style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12.5 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                      <Btn kind="primary" onClick={addMembers} disabled={memBusy || !memInput.trim()}>
                        <Plus size={14} /> {memBusy ? 'Adding…' : 'Add to list'}
                      </Btn>
                      <span className="dim" style={{ fontSize: 12 }}>
                        Only people already known to Relay can be added — a pasted contact we have never seen is reported back, not created.
                      </span>
                    </div>
                  </div>
                )}

                {addResult && (
                  <div className="tw-note" style={{ marginBottom: 14 }}>
                    <div><strong>{addResult.added}</strong> added{addResult.already > 0 ? ` · ${addResult.already} already on the list` : ''} · <strong>{addResult.total}</strong> total.</div>
                    {Array.isArray(addResult.unmatched) && addResult.unmatched.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ color: 'var(--warn-fg, var(--text-2))' }}>
                          {addResult.unmatched.length} not found in Relay and skipped:
                        </div>
                        <div className="mono" style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
                          {addResult.unmatched.slice(0, 50).join(', ')}{addResult.unmatched.length > 50 ? ` … +${addResult.unmatched.length - 50} more` : ''}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {memLoading ? <Spinner /> : (members.rows.length === 0
                  ? <EmptyState title="No members yet" hint="Paste emails or phone numbers above to build the list." />
                  : (
                    <>
                      <div className="table-scroll">
                      <table className="dt">
                        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Added</th>{canEdit && <th />}</tr></thead>
                        <tbody>
                          {members.rows.map((m) => (
                            <tr key={m.profile_id}>
                              <td>{m.display_name || <span className="dim">—</span>}</td>
                              <td className="mono">{m.email || <span className="dim">—</span>}</td>
                              <td className="mono">{m.phone || <span className="dim">—</span>}</td>
                              <td className="dim">{fmtDateTime(m.added_at)}</td>
                              {canEdit && (
                                <td style={{ textAlign: 'right' }}>
                                  <Btn onClick={() => removeMember(m)} disabled={memBusy}>
                                    <Trash2 size={13} /> Remove
                                  </Btn>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                      {members.total > members.rows.length && (
                        <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>
                          Showing {members.rows.length} of {members.total} — newest first.
                        </div>
                      )}
                    </>
                  ))}
              </>
            )}
          </Panel>
        )}

        {seg.kind === 'dynamic' && (
          <Panel title="Audience rule" pad>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <select className="f-inp" style={{ width: 'auto' }} value={seg.group} onChange={(e) => set('group', e.target.value)} disabled={saving || !canEdit}>
                {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
              <span className="dim" style={{ fontSize: 12 }}>{GROUPS.find((g) => g.id === seg.group)?.hint}</span>
              <span style={{ flex: 1 }} />
              {canEdit && <Btn onClick={addItem}><Plus size={14} /> Add condition</Btn>}
              {/* A group is a bracket: everything inside it resolves first, then joins the list
                  above under the top-level mode. That is the whole feature, and it is why the
                  button sits beside "Add condition" rather than inside a menu. */}
              {canEdit && <Btn onClick={addGroup}><Plus size={14} /> Add group</Btn>}
            </div>

            {/* Refuse to edit a rule deeper than this builder renders. Parsing it, editing, and
                saving would silently delete the levels the editor cannot show. */}
            {seg.tooDeep && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 7,
                border: '1px solid var(--red-bd, #7a2b2b)', background: 'var(--red-soft, rgba(220,80,80,.12))', fontSize: 12.5 }}>
                <strong>This rule has groups inside groups, which this builder cannot show.</strong> It is
                displayed read-only so editing cannot flatten it. It still evaluates correctly, and it can
                be changed by someone who can edit the rule directly.
              </div>
            )}

            {/* An inert condition under `Match NONE of` excludes nobody, so the audience silently
                becomes EVERYONE — and unlike the narrowing failures, a too-big count has no tell
                on screen. That is the case worth a banner rather than only the row-level ⚠.
                See the ATTR_TYPES header in lib/segmentAst.js for the incident. */}
            {(() => {
              const warns = ruleWarnings(seg.group, seg.items, eventCounts);
              if (!warns.length) return null;
              const widening = warns.some((w) => w.widening);
              return (
                <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 7,
                  border: `1px solid ${widening ? 'var(--red-bd, #7a2b2b)' : 'var(--warn-bd, #6b5320)'}`,
                  background: widening ? 'var(--red-soft, rgba(220,80,80,.12))' : 'var(--warn-soft, rgba(224,163,62,.10))',
                  fontSize: 12.5 }}>
                  <strong>
                    {widening
                      ? 'This rule excludes nobody — the audience is currently everyone.'
                      : 'One condition in this rule matches nobody.'}
                  </strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {warns.map((w, i) => <li key={i}>{w.text}</li>)}
                  </ul>
                </div>
              );
            })()}

            {seg.items.length === 0
              ? <div style={{ padding: '6px 2px', color: 'var(--text-4)', fontSize: 12.5 }}>No conditions — this matches <strong>everyone</strong>. Add a condition to narrow the audience.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {seg.items.map((it, i) => it.type === 'group' ? (
                    <GroupRow key={i} g={it} idx={i} disabled={saving || !canEdit} canEdit={canEdit}
                      eventDefs={eventDefs} propOpts={propOpts} eventCounts={eventCounts}
                      onPatch={(patch) => patchItem(i, patch)}
                      onRemove={() => removeItem(i)} />
                  ) : (
                    <ConditionRow key={i} r={it} disabled={saving || !canEdit} canEdit={canEdit}
                      eventDefs={eventDefs} propOpts={propOpts} eventCounts={eventCounts}
                      onPatch={(patch) => patchItem(i, patch)}
                      onType={(tp) => setItemType(i, tp)}
                      onRemove={() => removeItem(i)} />
                  ))}
                </div>
              )}
            <datalist id="attr-suggest">{ATTR_SUGGEST.map(([a, hint]) => <option key={a} value={a} label={hint} />)}</datalist>
          </Panel>
        )}

        {seg.kind === 'dynamic' && (
          <Panel title="Preview audience" pad>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="kv-k" style={{ margin: 0 }}>Reachable on</span>
              <select className="f-inp" style={{ width: 'auto' }} value={pvChannel} onChange={(e) => setPvChannel(e.target.value)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="f-inp" style={{ width: 'auto' }} value={pvPurpose} onChange={(e) => setPvPurpose(e.target.value)}>
                {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <Btn onClick={preview} disabled={pvLoading}><Eye size={14} /> {pvLoading ? 'Counting…' : 'Preview'}</Btn>
              {pv && (
                <span style={{ display: 'inline-flex', gap: 16, marginLeft: 8 }}>
                  <span><span className="role-pcount mono">{pv.total ?? 0}</span> <span className="role-plabel">matched</span></span>
                  <span><span className="role-pcount mono" style={{ color: 'var(--green-fg, #5fe08a)' }}>{pv.reachable ?? 0}</span> <span className="role-plabel">reachable</span></span>
                </span>
              )}
            </div>
            <div className="tw-note" style={{ marginBottom: 0 }}>Reachable = matched, minus suppressions, and (for marketing) only those opted-in on the channel.</div>
            {/* Eye-ball sample — numbers say "how many", these rows say "who": a rule that
                counts plausibly but matches the wrong PEOPLE is caught here, before a send. */}
            {pv && Array.isArray(pv.sample) && pv.sample.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="kv-k" style={{ marginBottom: 6 }}>Sample of matched customers</div>
                <div className="table-scroll">
                <table className="dt">
                  <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Orders</th><th>Last order</th></tr></thead>
                  <tbody>
                    {pv.sample.map((s) => (
                      <tr key={s.id}>
                        <td style={{ fontWeight: 600 }}>{s.display_name || <span className="dim">—</span>}</td>
                        <td className="mono dim" style={{ fontSize: 12 }}>{s.email || '—'}</td>
                        <td className="mono dim" style={{ fontSize: 12 }}>{s.phone || '—'}</td>
                        <td className="mono">{s.lifetime_orders ?? '—'}</td>
                        <td className="mono dim" style={{ fontSize: 12 }}>{s.last_order_at ? String(s.last_order_at).slice(0, 10) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
            {pv && Array.isArray(pv.sample) && pv.sample.length === 0 && (pv.total ?? 0) > 0 && (
              <div className="tw-note" style={{ marginTop: 10, marginBottom: 0 }}>Sample unavailable for this rule.</div>
            )}
          </Panel>
        )}
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Segments" sub="Audiences built from a live rule (dynamic) or a fixed list (static)."
        actions={canEdit ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New segment</Btn> : null} />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="users" title="No segments yet" hint="Build your first audience to target a campaign." /></Panel>
          : (
            <Panel title="Segments" count={rows.length}>
              {/* Members column backed by the S231 §9 read extension (getSegments returns
                  member_count from comms.segment_members). For DYNAMIC segments it counts
                  the last materialized set (PATTERN-176) — a rule edited since the last
                  refresh isn't recounted until "Refresh members" runs.
                  S268: it used to print a bare 0 when a segment had NEVER been materialized,
                  which reads as "this audience is empty" rather than "nobody has counted it"
                  — Winback 90 showed 0 against a live 25,084. memberState() splits the two
                  on materialized_at. Do NOT collapse it back to a plain number. */}
              <div className="table-scroll">
              <table className="dt">
                <thead><tr><th>Name</th><th>Kind</th><th>Conditions</th><th className="num">Members</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const p = parseDef(r.definition);
                    // Leaf count, flattening groups — see countConditions(). This line read
                    // `p.rows.length` until 2026-08-14 and threw on every dynamic segment.
                    const nConds = countConditions(p.items);
                    return (
                      <tr key={r.id} className="row-click" onClick={() => startEdit(r)}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                            <Filter size={15} style={{ color: 'var(--t4)', flexShrink: 0 }} />
                            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.name}</span>
                          </span>
                        </td>
                        <td><Badge label={r.kind} tone={r.kind === 'dynamic' ? 'blue' : 'gray'} /></td>
                        <td className="dim">{r.kind === 'static' ? '—' : (nConds === 0 ? 'everyone' : `${nConds} · match ${p.group}`)}</td>
                        {(() => {
                          const ms = memberState(r.kind, r.member_count, r.materialized_at, r.is_stale);
                          return (
                            <td className={ms.stale ? 'num dim' : 'num mono'} title={ms.title}>
                              {ms.text}
                            </td>
                          );
                        })()}
                        <td className="mono dim">{fmtDateTime(r.updated_at)}</td>
                        <td><Btn onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Pencil size={14} /> {canEdit ? 'Edit' : 'View'}</Btn></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </Panel>
          )}
    </div>
  );
}
