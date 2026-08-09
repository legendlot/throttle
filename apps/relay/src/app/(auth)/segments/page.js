'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Trash2, Filter, RefreshCw, Eye } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';
import { useNewParam } from '@/lib/useNewParam.js';
import { loadEventDefs, eventComboOptions } from '@/lib/eventDefs.js';

const GROUPS = [
  { id: 'all', label: 'Match ALL of', hint: 'every condition (AND)' },
  { id: 'any', label: 'Match ANY of', hint: 'at least one (OR)' },
  { id: 'none', label: 'Match NONE of', hint: 'exclude all (NOT)' },
];
const LEAF_TYPES = ['attr', 'event', 'consent'];
// Operator ids are the engine's AST vocabulary (eval_segment_node); the LABELS are what a
// marketer reads — "gte" invites mis-picks, "at least" doesn't. before/within_days are the
// migration-0022 relative-date ops (numeric days against a date attribute, e.g. last_order_at).
const OPS = [
  { id: 'eq', label: 'is' },
  { id: 'neq', label: 'is not' },
  { id: 'in', label: 'is any of' },
  { id: 'gt', label: 'more than' },
  { id: 'gte', label: 'at least' },
  { id: 'lt', label: 'less than' },
  { id: 'lte', label: 'at most' },
  { id: 'before_days', label: 'older than (days)' },
  { id: 'within_days', label: 'within last (days)' },
];
const ATTR_SUGGEST = ['lifetime_orders', 'lifetime_value', 'last_order_at', 'city', 'locale', 'display_name', 'first'];
// Event names come from the LIVE comms.event_definitions registry (see @/lib/eventDefs.js).
// The hardcoded EVENT_SUGGEST that used to live here listed 10 of 34 registered events and
// offered `email_clicked`, which S189 renamed to `link_clicked` — a condition that could
// never match. Registering an event now surfaces it here automatically.
const CHANNELS = ['email', 'sms', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATES = ['opted_in', 'opted_out', 'unknown'];

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
  if (type === 'event') return { type: 'event', event: '', count: 1, within: '' };
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
  if (leaf && leaf.event != null) return { type: 'event', event: leaf.event || '', count: leaf.count ?? 1, within: leaf.within || '' };
  if (leaf && 'consent' in leaf) return { type: 'consent', channel: leaf.channel || 'email', purpose: leaf.purpose || 'marketing', state: leaf.state || 'opted_in' };
  const v = leaf?.value;
  return { type: 'attr', attr: leaf?.attr || '', op: leaf?.op || 'eq', value: Array.isArray(v) ? v.join(', ') : (v ?? '') };
}
// editor row → stored leaf
function toLeaf(row) {
  if (row.type === 'event') {
    const o = { event: row.event, count: Number(row.count) || 1 };
    if (row.within && row.within.trim()) o.within = normalizeWithin(row.within);
    return o;
  }
  // Defaults repeated here on purpose: blankRow() now guarantees these keys, but this is the
  // last gate before the AST is persisted, and a consent leaf missing purpose/state is the one
  // shape that fails SILENTLY (matches nobody) instead of erroring. Belt and braces.
  if (row.type === 'consent') return { consent: true, channel: row.channel || 'email', purpose: row.purpose || 'marketing', state: row.state || 'opted_in' };
  return { attr: row.attr, op: row.op, value: row.op === 'in' ? csvToArr(row.value) : String(row.value) };
}
function parseDef(def) {
  if (def && typeof def === 'object') {
    for (const g of ['all', 'any', 'none']) if (Array.isArray(def[g])) return { group: g, rows: def[g].map(toRow) };
    if (def.attr || def.event != null || 'consent' in def) return { group: 'all', rows: [toRow(def)] };
  }
  return { group: 'all', rows: [] };
}

function emptySeg() { return { id: null, name: '', kind: 'dynamic', group: 'all', rows: [], member_count: null }; }

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

  // static-segment membership (S263)
  const [members, setMembers] = useState({ total: 0, rows: [] });
  const [memLoading, setMemLoading] = useState(false);
  const [memInput, setMemInput] = useState('');
  const [memBusy, setMemBusy] = useState(false);
  const [addResult, setAddResult] = useState(null);

  const canEdit = !perms || perms.segment_manage;

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
    setSeg({ id: r.id, name: r.name || '', kind: r.kind || 'dynamic', group: parsed.group, rows: parsed.rows, member_count: null });
    setPv(null);
    setView('form');
    try {
      const d = await garageFetch('getSegment', { id: r.id }, session);
      if (d?.segment) setSeg((s) => ({ ...s, member_count: d.member_count ?? null }));
    } catch { /* non-fatal */ }
  }
  function set(k, v) { setSeg((s) => ({ ...s, [k]: v })); }
  function addLeaf() { setSeg((s) => ({ ...s, rows: [...s.rows, blankRow('attr')] })); }
  // REPLACE, never merge — see blankRow(). The old `setLeaf(i,{type})` left the new type's
  // fields undefined, which is what made the selects uncontrolled and the leaf match nobody.
  function setLeafType(i, type) { setSeg((s) => ({ ...s, rows: s.rows.map((r, j) => j === i ? blankRow(type) : r) })); }
  function setLeaf(i, patch) { setSeg((s) => ({ ...s, rows: s.rows.map((r, j) => j === i ? { ...r, ...patch } : r) })); }
  function removeLeaf(i) { setSeg((s) => ({ ...s, rows: s.rows.filter((_, j) => j !== i) })); }

  function buildDef() {
    if (seg.rows.length === 0) return {};
    return { [seg.group]: seg.rows.map(toLeaf) };
  }

  async function preview() {
    setPvLoading(true); setPv(null);
    try {
      const r = await workerFetch('previewSegment', { definition: buildDef(), channel: pvChannel, purpose: pvPurpose }, session);
      setPv(r?.data || null);
    } catch (e) { showToast(e.message || 'Preview failed', 'error'); }
    finally { setPvLoading(false); }
  }

  async function save() {
    if (!seg.name.trim()) { showToast('Name required', 'error'); return; }
    setSaving(true);
    try {
      const payload = { name: seg.name.trim(), kind: seg.kind, definition: buildDef() };
      if (seg.id) payload.id = seg.id;
      const r = await workerFetch('saveSegment', payload, session);
      const saved = r?.data;
      if (saved?.id && !seg.id) set('id', saved.id);
      showToast(seg.id ? 'Segment saved' : 'Segment created', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
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
    setMaterializing(true);
    try {
      const r = await workerFetch('materializeSegment', { id: seg.id }, session);
      const n = r?.data?.members;
      set('member_count', typeof n === 'number' ? n : seg.member_count);
      showToast(`Members refreshed${typeof n === 'number' ? ` — ${n}` : ''}`, 'success');
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
            {seg.member_count != null && <Badge label={`${seg.member_count} members`} tone="blue" dot />}
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
              {canEdit && <Btn onClick={addLeaf}><Plus size={14} /> Add condition</Btn>}
            </div>

            {seg.rows.length === 0
              ? <div style={{ padding: '6px 2px', color: 'var(--text-4)', fontSize: 12.5 }}>No conditions — this matches <strong>everyone</strong>. Add a condition to narrow the audience.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {seg.rows.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, padding: 10 }}>
                      <select className="f-inp" style={{ width: 110 }} value={r.type} onChange={(e) => setLeafType(i, e.target.value)} disabled={saving || !canEdit}>
                        {LEAF_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                      </select>

                      {r.type === 'attr' && <>
                        <input className="f-inp mono" style={{ width: 160 }} list="attr-suggest" value={r.attr || ''} onChange={(e) => setLeaf(i, { attr: e.target.value })} placeholder="attribute" disabled={saving || !canEdit} />
                        <select className="f-inp" style={{ width: 150 }} value={r.op} onChange={(e) => setLeaf(i, { op: e.target.value })} disabled={saving || !canEdit}>
                          {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                        <input className="f-inp" style={{ flex: 1, minWidth: 140 }} value={r.value || ''} onChange={(e) => setLeaf(i, { value: e.target.value })}
                          placeholder={r.op === 'in' ? 'comma, separated, values'
                            : (r.op === 'before_days' || r.op === 'within_days') ? 'number of days (e.g. 90)' : 'value'}
                          disabled={saving || !canEdit} />
                      </>}

                      {r.type === 'event' && <>
                        {/* Combobox (not a datalist): a datalist filters against what is
                            ALREADY in the input, so a pre-filled field collapsed to one row
                            and read as empty/broken. Grouped by category — PATTERN-160. */}
                        <div style={{ width: 240 }}>
                          <Combobox
                            value={r.event || ''}
                            options={eventComboOptions(eventDefs)}
                            onChange={(v) => setLeaf(i, { event: v || '' })}
                            placeholder="Search events…"
                            disabled={saving || !canEdit}
                            allowClear={false}
                            emptyLabel="No matching event — check it is registered in comms.event_definitions"
                          />
                        </div>
                        <span className="dim" style={{ fontSize: 12 }}>≥</span>
                        <input className="f-inp mono" style={{ width: 64 }} type="number" min="1" value={r.count} onChange={(e) => setLeaf(i, { count: e.target.value })} disabled={saving || !canEdit} />
                        <span className="dim" style={{ fontSize: 12 }}>within last</span>
                        <input className="f-inp mono" style={{ width: 120 }} value={r.within || ''} onChange={(e) => setLeaf(i, { within: e.target.value })} placeholder="120 days (opt)" disabled={saving || !canEdit} />
                        {/* Echo what a bare number will actually be saved as — the old field read
                            "within [120]" and silently meant 120 SECONDS. */}
                        {/^\d+$/.test(String(r.within || '').trim()) && <span className="dim" style={{ fontSize: 11.5 }}>= {normalizeWithin(r.within)}</span>}
                      </>}

                      {r.type === 'consent' && <>
                        <select className="f-inp" style={{ width: 120 }} value={r.channel} onChange={(e) => setLeaf(i, { channel: e.target.value })} disabled={saving || !canEdit}>
                          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select className="f-inp" style={{ width: 130 }} value={r.purpose} onChange={(e) => setLeaf(i, { purpose: e.target.value })} disabled={saving || !canEdit}>
                          {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <select className="f-inp" style={{ width: 120 }} value={r.state} onChange={(e) => setLeaf(i, { state: e.target.value })} disabled={saving || !canEdit}>
                          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </>}

                      <span style={{ flex: 1 }} />
                      {canEdit && <button className="dr-close" onClick={() => removeLeaf(i)} disabled={saving} title="Remove"><Trash2 size={14} /></button>}
                    </div>
                  ))}
                </div>
              )}
            <datalist id="attr-suggest">{ATTR_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
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
              {/* Members column backed by the S231 §9 read extension (getSegments now
                  returns member_count from comms.segment_members). For DYNAMIC segments
                  it counts the last materialized set (PATTERN-176) — a rule edited since
                  the last refresh isn't recounted until "Refresh members" runs, hence
                  the as-of-last-refresh tooltip. */}
              <table className="dt">
                <thead><tr><th>Name</th><th>Kind</th><th>Conditions</th><th className="num">Members</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const p = parseDef(r.definition);
                    return (
                      <tr key={r.id} className="row-click" onClick={() => startEdit(r)}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                            <Filter size={15} style={{ color: 'var(--t4)', flexShrink: 0 }} />
                            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.name}</span>
                          </span>
                        </td>
                        <td><Badge label={r.kind} tone={r.kind === 'dynamic' ? 'blue' : 'gray'} /></td>
                        <td className="dim">{r.kind === 'static' ? '—' : (p.rows.length === 0 ? 'everyone' : `${p.rows.length} · match ${p.group}`)}</td>
                        <td className="num mono"
                          title={r.kind === 'dynamic' ? 'As of the last refresh — open the segment and Refresh members to recount' : undefined}>
                          {r.member_count != null ? Number(r.member_count).toLocaleString('en-IN') : '—'}
                        </td>
                        <td className="mono dim">{fmtDateTime(r.updated_at)}</td>
                        <td><Btn onClick={(e) => { e.stopPropagation(); startEdit(r); }}><Pencil size={14} /> {canEdit ? 'Edit' : 'View'}</Btn></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
