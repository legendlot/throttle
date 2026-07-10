'use client';
// Reusable OKR UI pieces (Phase 4). Presentation + light local state only; all data
// fetching + mutation live in the pages that compose these.
import { useState } from 'react';
import { TrendingUp, TrendingDown, Flag, AlertTriangle, Pencil, Trash2 } from 'lucide-react';
import { podiumopsPost } from '../lib/podiumopsFetch.js';
import {
  LEVELS, CONFIDENCE, CONFIDENCE_COLOR, DIRECTIONS, scorePct, scoreColor, fmtKrValue, metricLabel,
} from '../lib/okrs.js';

// ── Score bar (0..1) ──────────────────────────────────────────────────────────
export function ScoreBar({ score, height = 7, showPct = true }) {
  const pct = scorePct(score);
  const col = scoreColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height, background: 'var(--bg-2)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: col, borderRadius: 99, transition: 'width .3s' }} />
      </div>
      {showPct && <span className="num" style={{ fontSize: 12, fontWeight: 600, color: col, minWidth: 34, textAlign: 'right' }}>{pct == null ? '—' : pct + '%'}</span>}
    </div>
  );
}

export function ConfidenceDot({ c, withLabel = false }) {
  if (!c) return null;
  const col = CONFIDENCE_COLOR[c] || 'var(--t4)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--t2)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: col, flex: 'none' }} />
      {withLabel && CONFIDENCE[c]}
    </span>
  );
}

export function StaleBadge() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: 'var(--state-warning-fg)', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 6, padding: '2px 7px' }}>
      <AlertTriangle size={11} /> Needs check-in
    </span>
  );
}

export function LevelPill({ level }) {
  return (
    <span style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{LEVELS[level] || level}</span>
  );
}

// ── One KR row (read + inline check-in + edit/delete) ─────────────────────────
export function KrRow({ kr, canEdit, session, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'checkin' | 'edit'
  const [value, setValue] = useState(kr.current_value ?? kr.start_value ?? 0);
  const [confidence, setConfidence] = useState(kr.latest_checkin?.confidence || 'on_track');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const dirIcon = kr.direction === 'decrease' ? <TrendingDown size={12} /> : <TrendingUp size={12} />;

  async function submitCheckin() {
    setBusy(true);
    try {
      await podiumopsPost('recordCheckin', { data: { key_result_id: kr.id, value: Number(value), confidence, note: note || null } }, session);
      setMode(null); setNote('');
      onChanged?.();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Delete key result “${kr.title}”? This removes its check-ins too.`)) return;
    setBusy(true);
    try { await podiumopsPost('deleteKeyResult', { data: { id: kr.id } }, session); onChanged?.(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: '11px 0', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {kr.metric_type === 'milestone' ? <Flag size={12} color="var(--t3)" /> : <span style={{ color: 'var(--t4)' }}>{dirIcon}</span>}
            {kr.title}
            {kr.stale && <StaleBadge />}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 3 }}>
            {fmtKrValue(kr, kr.current_value)} <span style={{ color: 'var(--t4)' }}>/ {fmtKrValue(kr, kr.target_value)}</span>
            {kr.latest_checkin && <span style={{ marginLeft: 8 }}><ConfidenceDot c={kr.latest_checkin.confidence} /></span>}
            <span style={{ color: 'var(--t4)', marginLeft: 8 }}>· {metricLabel(kr.metric_type)} · w{Number(kr.weight)}{kr.status === 'closed' ? ' · closed' : ''}</span>
          </div>
        </div>
        <div style={{ width: 130 }}><ScoreBar score={kr.kr_score} /></div>
        {canEdit && <>
          <button onClick={() => setMode(m => m === 'checkin' ? null : 'checkin')} style={miniBtn}>{mode === 'checkin' ? 'Cancel' : 'Check in'}</button>
          <button title="Edit KR" onClick={() => setMode(m => m === 'edit' ? null : 'edit')} style={iconMini}><Pencil size={13} /></button>
          <button title="Delete KR" disabled={busy} onClick={remove} style={iconMini}><Trash2 size={13} /></button>
        </>}
      </div>
      {mode === 'checkin' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
          <Field label={kr.metric_type === 'milestone' ? 'Done? (0/1)' : 'Current value'} w={120}>
            <input type="number" value={value} onChange={e => setValue(e.target.value)} style={inp} />
          </Field>
          <Field label="Confidence" w={130}>
            <select value={confidence} onChange={e => setConfidence(e.target.value)} style={inp}>
              {Object.entries(CONFIDENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Note (optional)" w={260}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="What moved?" style={inp} />
          </Field>
          <button disabled={busy} onClick={submitCheckin} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Save'}</button>
        </div>
      )}
      {mode === 'edit' && <EditKrForm kr={kr} session={session} onDone={() => { setMode(null); onChanged?.(); }} />}
    </div>
  );
}

function EditKrForm({ kr, session, onDone }) {
  const [f, setF] = useState({
    title: kr.title, start_value: kr.start_value, target_value: kr.target_value,
    unit: kr.unit || '', direction: kr.direction, weight: kr.weight, status: kr.status || 'active',
  });
  const [busy, setBusy] = useState(false);
  const isMilestone = kr.metric_type === 'milestone';
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function save() {
    if (!f.title.trim()) return alert('Title required');
    setBusy(true);
    try { await podiumopsPost('updateKeyResult', { data: { id: kr.id, ...f } }, session); onDone(); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'flex-end', background: 'var(--bg-2)', borderRadius: 9, padding: 11 }}>
      <Field label="Key result" w={240}><input value={f.title} onChange={e => set('title', e.target.value)} style={inp} /></Field>
      {!isMilestone && <>
        <Field label="Start" w={80}><input type="number" value={f.start_value} onChange={e => set('start_value', e.target.value)} style={inp} /></Field>
        <Field label="Target" w={80}><input type="number" value={f.target_value} onChange={e => set('target_value', e.target.value)} style={inp} /></Field>
        <Field label="Unit" w={80}><input value={f.unit} onChange={e => set('unit', e.target.value)} style={inp} /></Field>
        <Field label="Direction" w={140}><select value={f.direction} onChange={e => set('direction', e.target.value)} style={inp}>{DIRECTIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select></Field>
      </>}
      <Field label="Weight" w={80}><input type="number" value={f.weight} onChange={e => set('weight', e.target.value)} style={inp} /></Field>
      <Field label="Status" w={120}><select value={f.status} onChange={e => set('status', e.target.value)} style={inp}><option value="active">Active</option><option value="closed">Closed</option></select></Field>
      <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Save'}</button>
    </div>
  );
}

export function Field({ label, w, children }) {
  return (
    <label style={{ display: 'block', flex: w ? `0 0 ${w}px` : '1 1 auto' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 5 }}>{label}</div>
      {children}
    </label>
  );
}

export const inp = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7,
  padding: '8px 10px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none',
};
export const miniBtn = {
  display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px', background: 'var(--surface-2)',
  color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 7, fontFamily: 'var(--font-display)',
  fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer', flex: 'none',
};
export const iconMini = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flex: 'none',
  background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer',
};

// ── Objective summary card (used in trees + lists; click to open detail) ───────
export function ObjectiveCard({ obj, onOpen, compact = false }) {
  const ds = obj.displayed_score;
  return (
    <div onClick={onOpen} className="pd-grid-row" style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: compact ? '11px 13px' : '13px 15px', cursor: onOpen ? 'pointer' : 'default',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <LevelPill level={obj.level} />
            <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{obj.title}</span>
            {obj.any_stale && <StaleBadge />}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4 }}>
            {obj.owner?.full_name && <>Owner: {obj.owner.full_name} · </>}
            {obj.department?.name && <>{obj.department.name} · </>}
            {(obj.key_results || []).length} KR{(obj.key_results || []).length === 1 ? '' : 's'}
            {obj.final_score != null && <span style={{ color: 'var(--yellow)', marginLeft: 6 }}>· graded</span>}
          </div>
        </div>
        <div style={{ width: 150 }}><ScoreBar score={ds} /></div>
      </div>
    </div>
  );
}
