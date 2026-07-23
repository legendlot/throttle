'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil, Trash2, Filter, RefreshCw, Eye } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';
import { useNewParam } from '@/lib/useNewParam.js';

const GROUPS = [
  { id: 'all', label: 'Match ALL of', hint: 'every condition (AND)' },
  { id: 'any', label: 'Match ANY of', hint: 'at least one (OR)' },
  { id: 'none', label: 'Match NONE of', hint: 'exclude all (NOT)' },
];
const LEAF_TYPES = ['attr', 'event', 'consent'];
const OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'];
const ATTR_SUGGEST = ['lifetime_orders', 'lifetime_value', 'last_order_at', 'city', 'locale', 'display_name', 'first'];
const EVENT_SUGGEST = ['order_placed', 'order_fulfilled', 'order_delivered', 'add_to_cart', 'checkout_started',
  'checkout_abandoned', 'return_created', 'email_delivered', 'email_opened', 'email_clicked'];
const CHANNELS = ['email', 'sms', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATES = ['opted_in', 'opted_out', 'unknown'];

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
    if (row.within && row.within.trim()) o.within = row.within.trim();
    return o;
  }
  if (row.type === 'consent') return { consent: true, channel: row.channel, purpose: row.purpose, state: row.state };
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

  const canEdit = !perms || perms.segment_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getSegments', {}, session);
      setRows(Array.isArray(r) ? r : []);
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
  function addLeaf() { setSeg((s) => ({ ...s, rows: [...s.rows, { type: 'attr', attr: '', op: 'eq', value: '' }] })); }
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
            <div className="tw-note" style={{ marginTop: 12 }}>Static membership is managed by ingestion / API, not by a rule. Save the segment, then add members programmatically.</div>
          )}
        </Panel>

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
                      <select className="f-inp" style={{ width: 110 }} value={r.type} onChange={(e) => setLeaf(i, { type: e.target.value })} disabled={saving || !canEdit}>
                        {LEAF_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                      </select>

                      {r.type === 'attr' && <>
                        <input className="f-inp mono" style={{ width: 160 }} list="attr-suggest" value={r.attr || ''} onChange={(e) => setLeaf(i, { attr: e.target.value })} placeholder="attribute" disabled={saving || !canEdit} />
                        <select className="f-inp" style={{ width: 80 }} value={r.op} onChange={(e) => setLeaf(i, { op: e.target.value })} disabled={saving || !canEdit}>
                          {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <input className="f-inp" style={{ flex: 1, minWidth: 140 }} value={r.value || ''} onChange={(e) => setLeaf(i, { value: e.target.value })} placeholder={r.op === 'in' ? 'comma, separated, values' : 'value'} disabled={saving || !canEdit} />
                      </>}

                      {r.type === 'event' && <>
                        <input className="f-inp mono" style={{ width: 180 }} list="event-suggest" value={r.event || ''} onChange={(e) => setLeaf(i, { event: e.target.value })} placeholder="event name" disabled={saving || !canEdit} />
                        <span className="dim" style={{ fontSize: 12 }}>≥</span>
                        <input className="f-inp mono" style={{ width: 64 }} type="number" min="1" value={r.count} onChange={(e) => setLeaf(i, { count: e.target.value })} disabled={saving || !canEdit} />
                        <span className="dim" style={{ fontSize: 12 }}>within</span>
                        <input className="f-inp mono" style={{ width: 120 }} value={r.within || ''} onChange={(e) => setLeaf(i, { within: e.target.value })} placeholder="30 days (opt)" disabled={saving || !canEdit} />
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
            <datalist id="event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
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
              <table className="dt">
                <thead><tr><th>Name</th><th>Kind</th><th>Conditions</th><th>Updated</th><th></th></tr></thead>
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
                        <td className="mono dim">{fmtDate(r.updated_at)}</td>
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
