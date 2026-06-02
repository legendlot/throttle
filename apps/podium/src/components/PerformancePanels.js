'use client';
import { useEffect, useState, useCallback } from 'react';
import { useToast } from '@throttle/ui';
import { Plus, Pencil, Trash2, Lock, Check } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtDate } from '../lib/format.js';
import { SENTIMENTS, VISIBILITIES, sentimentMeta, visibilityMeta, parseTags, joinTags } from '../lib/performance.js';

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── shared atoms ──────────────────────────────────────────────────────────────

function SentimentChip({ id }) {
  const m = sentimentMeta(id);
  return <span style={{ ...chip, color: m.color, background: m.bg }}>{m.label}</span>;
}
function Tags({ tags }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
      {tags.map((t, i) => <span key={i} style={tagPill}>{t}</span>)}
    </div>
  );
}
function RowActions({ canEdit, canDelete, onEdit, onDelete }) {
  return (
    <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
      {canEdit && <button onClick={onEdit} style={iconBtn} title="Edit"><Pencil size={13} /></button>}
      {canDelete && <button onClick={onDelete} style={iconBtn} title="Delete"><Trash2 size={13} /></button>}
    </div>
  );
}
function Empty({ children }) {
  return <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '8px 0' }}>{children}</div>;
}
function AddBtn({ open, onClick, label }) {
  return (
    <button onClick={onClick} style={{ ...addBtn, ...(open ? { opacity: 0.6 } : {}) }}>
      <Plus size={14} /> {label}
    </button>
  );
}

// ── Observations ────────────────────────────────────────────────────────────

export function ObservationsPanel({ employeeId, session }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // { id?, body, sentiment, visibility, tags, observed_on }

  const load = useCallback(() => {
    if (!session || !employeeId) return;
    podiumopsGet('getObservations', { employee_id: employeeId }, session)
      .then(setData).catch(() => setData({ observations: [], can_add: false }));
  }, [session, employeeId]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setForm({ body: '', sentiment: 'positive', visibility: 'shared_with_managers', tags: '', observed_on: todayStr() }); }
  function openEdit(o) { setForm({ id: o.id, body: o.body, sentiment: o.sentiment, visibility: o.visibility, tags: joinTags(o.tags), observed_on: o.observed_on }); }

  async function save() {
    if (!form.body.trim()) return showToast('Write something first', 'error');
    try {
      const payload = { body: form.body.trim(), sentiment: form.sentiment, visibility: form.visibility, tags: parseTags(form.tags), observed_on: form.observed_on };
      if (form.id) await podiumopsPost('updateObservation', { id: form.id, patch: payload }, session);
      else await podiumopsPost('createObservation', { subject_employee_id: employeeId, ...payload }, session);
      showToast('Saved', 'success'); setForm(null); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
  }
  async function del(o) {
    if (!confirm('Delete this observation?')) return;
    try { await podiumopsPost('deleteObservation', { id: o.id }, session); showToast('Deleted', 'success'); load(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div>
      {data.can_add && !form && <AddBtn onClick={openNew} label="Log observation" />}
      {form && (
        <div style={formCard}>
          <textarea autoFocus value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="What did you observe?" style={ta} />
          <div style={formRow}>
            <select value={form.sentiment} onChange={e => setForm(f => ({ ...f, sentiment: e.target.value }))} style={inp(150)}>
              {SENTIMENTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <select value={form.visibility} onChange={e => setForm(f => ({ ...f, visibility: e.target.value }))} style={inp(200)} title={visibilityMeta(form.visibility).hint}>
              {VISIBILITIES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <input type="date" value={form.observed_on} onChange={e => setForm(f => ({ ...f, observed_on: e.target.value }))} style={inp(150)} />
            <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="tags, comma, separated" style={inp(220)} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '2px 0 8px' }}>{visibilityMeta(form.visibility).hint}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={saveBtn}>Save</button>
            <button onClick={() => setForm(null)} style={cancelBtn}>Cancel</button>
          </div>
        </div>
      )}
      {data.observations.length === 0 ? <Empty>No observations yet.</Empty> :
        data.observations.map(o => (
          <div key={o.id} style={entry}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SentimentChip id={o.sentiment} />
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{fmtDate(o.observed_on)}</span>
              {o.author?.full_name && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {o.author.full_name}</span>}
              <span style={{ ...visTag }}>{visibilityMeta(o.visibility).label}</span>
              <span style={{ flex: 1 }} />
              <RowActions canEdit={o._can_edit} canDelete={o._can_delete} onEdit={() => openEdit(o)} onDelete={() => del(o)} />
            </div>
            <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{o.body}</div>
            <Tags tags={o.tags} />
          </div>
        ))}
    </div>
  );
}

// ── Wins ──────────────────────────────────────────────────────────────────────

export function WinsPanel({ employeeId, session }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);

  const load = useCallback(() => {
    if (!session || !employeeId) return;
    podiumopsGet('getAccomplishments', { employee_id: employeeId }, session)
      .then(setData).catch(() => setData({ accomplishments: [], can_add: false }));
  }, [session, employeeId]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setForm({ title: '', description: '', tags: '', achieved_on: todayStr() }); }
  function openEdit(w) { setForm({ id: w.id, title: w.title, description: w.description || '', tags: joinTags(w.tags), achieved_on: w.achieved_on }); }

  async function save() {
    if (!form.title.trim()) return showToast('Give it a title', 'error');
    try {
      const payload = { title: form.title.trim(), description: form.description.trim(), tags: parseTags(form.tags), achieved_on: form.achieved_on };
      if (form.id) await podiumopsPost('updateAccomplishment', { id: form.id, patch: payload }, session);
      else await podiumopsPost('createAccomplishment', payload, session);
      showToast('Saved', 'success'); setForm(null); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
  }
  async function del(w) {
    if (!confirm('Delete this win?')) return;
    try { await podiumopsPost('deleteAccomplishment', { id: w.id }, session); showToast('Deleted', 'success'); load(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }

  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div>
      {data.can_add && !form && <AddBtn onClick={openNew} label="Add win" />}
      {form && (
        <div style={formCard}>
          <input autoFocus value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="What did you accomplish?" style={{ ...inp('100%'), marginBottom: 8 }} />
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Details (optional)" style={ta} />
          <div style={formRow}>
            <input type="date" value={form.achieved_on} onChange={e => setForm(f => ({ ...f, achieved_on: e.target.value }))} style={inp(150)} />
            <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="tags, comma, separated" style={inp(220)} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={save} style={saveBtn}>Save</button>
            <button onClick={() => setForm(null)} style={cancelBtn}>Cancel</button>
          </div>
        </div>
      )}
      {data.accomplishments.length === 0 ? <Empty>No wins recorded yet.</Empty> :
        data.accomplishments.map(w => (
          <div key={w.id} style={entry}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{w.title}</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {fmtDate(w.achieved_on)}</span>
              <span style={{ flex: 1 }} />
              <RowActions canEdit={w._can_edit} canDelete={w._can_delete} onEdit={() => openEdit(w)} onDelete={() => del(w)} />
            </div>
            {w.description && <div style={{ fontSize: 13, marginTop: 5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{w.description}</div>}
            <Tags tags={w.tags} />
          </div>
        ))}
    </div>
  );
}

// ── 1:1 notes ───────────────────────────────────────────────────────────────

export function OneOnOnesPanel({ employeeId, session }) {
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);

  const load = useCallback(() => {
    if (!session || !employeeId) return;
    podiumopsGet('getOneOnOnes', { employee_id: employeeId }, session)
      .then(setData).catch(() => setData({ one_on_ones: [], can_add: false }));
  }, [session, employeeId]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setForm({ met_on: todayStr(), shared_notes: '', private_notes: '', action_items: [] }); }
  function openEdit(o) { setForm({ id: o.id, met_on: o.met_on, shared_notes: o.shared_notes || '', private_notes: o.private_notes || '', action_items: Array.isArray(o.action_items) ? o.action_items.map(a => ({ ...a })) : [] }); }

  function setItem(i, patch) { setForm(f => ({ ...f, action_items: f.action_items.map((a, idx) => idx === i ? { ...a, ...patch } : a) })); }
  function addItem() { setForm(f => ({ ...f, action_items: [...f.action_items, { text: '', done: false }] })); }
  function removeItem(i) { setForm(f => ({ ...f, action_items: f.action_items.filter((_, idx) => idx !== i) })); }

  async function save() {
    try {
      const items = (form.action_items || []).filter(a => a.text && a.text.trim()).map(a => ({ text: a.text.trim(), done: !!a.done }));
      const payload = { met_on: form.met_on, shared_notes: form.shared_notes, private_notes: form.private_notes, action_items: items };
      if (form.id) await podiumopsPost('updateOneOnOne', { id: form.id, patch: payload }, session);
      else await podiumopsPost('createOneOnOne', { report_employee_id: employeeId, ...payload }, session);
      showToast('Saved', 'success'); setForm(null); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
  }
  async function del(o) {
    if (!confirm('Delete this 1:1?')) return;
    try { await podiumopsPost('deleteOneOnOne', { id: o.id }, session); showToast('Deleted', 'success'); load(); }
    catch (e) { showToast(e.message || 'Delete failed', 'error'); }
  }
  // Toggle an action item's done-state on a saved 1:1 (author only).
  async function toggleItem(o, idx) {
    const items = (o.action_items || []).map((a, i) => i === idx ? { ...a, done: !a.done } : a);
    try { await podiumopsPost('updateOneOnOne', { id: o.id, patch: { action_items: items } }, session); load(); }
    catch (e) { showToast(e.message || 'Update failed', 'error'); }
  }

  if (!data) return <Empty>Loading…</Empty>;
  return (
    <div>
      {data.can_add && !form && <AddBtn onClick={openNew} label="Log 1:1" />}
      {form && (
        <div style={formCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Met on</span>
            <input type="date" value={form.met_on} onChange={e => setForm(f => ({ ...f, met_on: e.target.value }))} style={inp(150)} />
          </div>
          <label style={lbl}>Shared notes <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· visible to the report</span></label>
          <textarea value={form.shared_notes} onChange={e => setForm(f => ({ ...f, shared_notes: e.target.value }))} placeholder="Discussion the report can see" style={ta} />
          <label style={lbl}><Lock size={11} /> Private notes <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· only you and HR</span></label>
          <textarea value={form.private_notes} onChange={e => setForm(f => ({ ...f, private_notes: e.target.value }))} placeholder="Manager-only notes" style={{ ...ta, borderColor: 'var(--brand-orange)' }} />
          <label style={lbl}>Action items</label>
          {form.action_items.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={!!a.done} onChange={e => setItem(i, { done: e.target.checked })} />
              <input value={a.text} onChange={e => setItem(i, { text: e.target.value })} placeholder="Action item" style={inp('100%')} />
              <button onClick={() => removeItem(i)} style={iconBtn} title="Remove"><Trash2 size={12} /></button>
            </div>
          ))}
          <button onClick={addItem} style={{ ...cancelBtn, marginBottom: 8 }}><Plus size={12} /> Add item</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={saveBtn}>Save</button>
            <button onClick={() => setForm(null)} style={cancelBtn}>Cancel</button>
          </div>
        </div>
      )}
      {data.one_on_ones.length === 0 ? <Empty>No 1:1s logged yet.</Empty> :
        data.one_on_ones.map(o => (
          <div key={o.id} style={entry}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtDate(o.met_on)}</span>
              {o.manager?.full_name && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>· {o.manager.full_name}</span>}
              <span style={{ flex: 1 }} />
              <RowActions canEdit={o._can_edit} canDelete={o._can_delete} onEdit={() => openEdit(o)} onDelete={() => del(o)} />
            </div>
            {o.shared_notes && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{o.shared_notes}</div>}
            {(o.action_items || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                {o.action_items.map((a, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, padding: '2px 0' }}>
                    <button
                      onClick={() => o._can_edit && toggleItem(o, i)}
                      style={{ ...checkBox, ...(a.done ? checkBoxOn : {}), cursor: o._can_edit ? 'pointer' : 'default' }}
                      title={o._can_edit ? 'Toggle' : ''}
                    >{a.done && <Check size={11} />}</button>
                    <span style={{ textDecoration: a.done ? 'line-through' : 'none', color: a.done ? 'var(--text-3)' : 'var(--text-1)' }}>{a.text}</span>
                  </div>
                ))}
              </div>
            )}
            {o._private_hidden ? (
              <div style={privNote}><Lock size={11} /> Private manager notes hidden</div>
            ) : o.private_notes ? (
              <div style={{ ...privBox }}>
                <div style={{ fontSize: 11, color: 'var(--brand-orange)', fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><Lock size={11} /> Private notes</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{o.private_notes}</div>
              </div>
            ) : null}
          </div>
        ))}
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────

const entry = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', marginBottom: 10 };
const formCard = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 12 };
const formRow = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 };
const chip = { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--radius-full)', letterSpacing: '0.02em' };
const tagPill = { fontSize: 11, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)', padding: '1px 8px' };
const visTag = { fontSize: 10, color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const lbl = { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '8px 0 4px' };
const inp = (w) => ({ background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 9px', fontSize: 13, width: w, boxSizing: 'border-box' });
const ta = { width: '100%', minHeight: 64, background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' };
const addBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginBottom: 12 };
const saveBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const cancelBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontSize: 12, cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const checkBox = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--surface)', color: '#1f1f1f', flex: '0 0 auto' };
const checkBoxOn = { background: 'var(--podium-accent)', borderColor: 'var(--podium-accent)' };
const privBox = { marginTop: 8, background: 'var(--state-warning-bg)', border: '1px solid var(--brand-orange)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' };
const privNote = { marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-3)' };
