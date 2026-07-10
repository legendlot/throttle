'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { ChevronLeft, Plus } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { CONFIDENCE, METRIC_TYPES, DIRECTIONS, displayedScore, scorePct } from '../../../../lib/okrs.js';
import { KrRow, ScoreBar, LevelPill, ConfidenceDot, Field, inp, miniBtn } from '../../../../components/OkrPanels.js';
import { fmtDate } from '../../../../lib/format.js';

function DetailInner() {
  const { session } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const [grading, setGrading] = useState(false);

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getObjective', { id }, session).then(setD).catch(() => setD(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  if (!id) return <EmptyState title="No objective selected" />;
  if (d == null) return <Spinner />;
  if (d === false) return <EmptyState title="Not found or no access" subtitle="This objective may be private to its owner and their managers." />;

  const o = d.objective;
  const krs = o.key_results || [];
  const cycleStatus = o.cycle?.status;
  const canEdit = d._can_edit;
  const canGrade = d._can_grade;

  return (
    <div style={{ maxWidth: 820 }}>
      <div onClick={() => router.back()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--t3)', cursor: 'pointer', marginBottom: 14 }}>
        <ChevronLeft size={14} /> Back
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <LevelPill level={o.level} />
          {o.owner?.full_name && <span style={{ fontSize: 12, color: 'var(--t3)' }}>{o.owner.full_name}</span>}
          {o.department?.name && <span style={{ fontSize: 12, color: 'var(--t3)' }}>· {o.department.name}</span>}
          {o.cycle?.name && <span style={{ fontSize: 12, color: 'var(--t4)' }}>· {o.cycle.name}</span>}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>{o.title}</div>
        {o.description && <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 12, whiteSpace: 'pre-wrap' }}>{o.description}</div>}
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginTop: 6 }}>
          <div style={{ flex: 1, maxWidth: 320 }}>
            <div style={{ fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>{o.final_score != null ? 'Final grade' : 'Auto progress'}</div>
            <ScoreBar score={displayedScore(o)} height={9} />
          </div>
          {o.final_score != null && o.auto_score != null && (
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>auto was {scorePct(o.auto_score)}%</div>
          )}
          {o.final_confidence && <ConfidenceDot c={o.final_confidence} withLabel />}
        </div>
        {o.reflection_note && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--t2)', background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px' }}>
            <span style={{ color: 'var(--t4)' }}>Reflection: </span>{o.reflection_note}
          </div>
        )}
      </div>

      {/* Key results */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '15px 18px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t2)' }}>Key results · {krs.length}</div>
          <div style={{ flex: 1 }} />
          {canEdit && cycleStatus !== 'closed' && <button onClick={() => setAdding(a => !a)} style={miniBtn}><Plus size={13} /> Add KR</button>}
        </div>
        {krs.length === 0 && !adding && <div style={{ fontSize: 13, color: 'var(--t3)', padding: '10px 0' }}>No key results yet.</div>}
        {krs.map(kr => <KrRow key={kr.id} kr={kr} canEdit={canEdit && cycleStatus !== 'closed'} session={session} onChanged={load} />)}
        {adding && <AddKrForm objectiveId={o.id} session={session} onDone={() => { setAdding(false); load(); }} />}
      </div>

      {/* Grade panel */}
      {canGrade && <GradePanel obj={o} session={session} onDone={load} open={grading} setOpen={setGrading} />}

      {/* Check-in history */}
      {(d.checkins || []).length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '15px 18px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 8 }}>Check-in history</div>
          {d.checkins.map(c => {
            const krTitle = krs.find(k => k.id === c.key_result_id)?.title || 'KR';
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--hairline)', fontSize: 12.5 }}>
                <ConfidenceDot c={c.confidence} />
                <span className="num" style={{ color: 'var(--t1)', minWidth: 60 }}>{Number(c.value).toLocaleString('en-IN')}</span>
                <span style={{ color: 'var(--t2)', flex: 1, minWidth: 0 }}>{krTitle}{c.note ? ` — ${c.note}` : ''}</span>
                <span style={{ color: 'var(--t4)', fontSize: 11 }}>{c.author?.full_name || ''} · {fmtDate(c.checked_in_on)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddKrForm({ objectiveId, session, onDone }) {
  const [f, setF] = useState({ title: '', metric_type: 'number', start_value: 0, target_value: 100, current_value: 0, unit: '', direction: 'increase', weight: 1 });
  const [busy, setBusy] = useState(false);
  const isMilestone = f.metric_type === 'milestone';
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function save() {
    if (!f.title.trim()) return alert('Title required');
    setBusy(true);
    try {
      await podiumopsPost('createKeyResult', { data: { objective_id: objectiveId, ...f } }, session);
      onDone();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 12, padding: '13px', background: 'var(--bg-2)', borderRadius: 9, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
      <Field label="Key result" w={260}><input value={f.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Reach 500 dispatches/day" style={inp} /></Field>
      <Field label="Metric" w={150}><select value={f.metric_type} onChange={e => set('metric_type', e.target.value)} style={inp}>{METRIC_TYPES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></Field>
      {!isMilestone && <>
        <Field label="Start" w={90}><input type="number" value={f.start_value} onChange={e => set('start_value', e.target.value)} style={inp} /></Field>
        <Field label="Target" w={90}><input type="number" value={f.target_value} onChange={e => set('target_value', e.target.value)} style={inp} /></Field>
        <Field label="Unit" w={90}><input value={f.unit} onChange={e => set('unit', e.target.value)} placeholder="units" style={inp} /></Field>
        <Field label="Direction" w={150}><select value={f.direction} onChange={e => set('direction', e.target.value)} style={inp}>{DIRECTIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}</select></Field>
      </>}
      <Field label="Weight" w={80}><input type="number" value={f.weight} onChange={e => set('weight', e.target.value)} style={inp} /></Field>
      <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Add'}</button>
    </div>
  );
}

function GradePanel({ obj, session, onDone, open, setOpen }) {
  const [pct, setPct] = useState(obj.final_score != null ? Math.round(obj.final_score * 100) : (obj.auto_score != null ? Math.round(obj.auto_score * 100) : 70));
  const [confidence, setConfidence] = useState(obj.final_confidence || 'on_track');
  const [note, setNote] = useState(obj.reflection_note || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await podiumopsPost('gradeObjective', { data: { id: obj.id, final_score: Math.max(0, Math.min(100, Number(pct))) / 100, final_confidence: confidence, reflection_note: note || null } }, session);
      setOpen(false); onDone();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ background: 'rgba(242,205,26,0.06)', border: '1px solid var(--yellow)', borderRadius: 12, padding: '15px 18px', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t1)' }}>Final grade</div>
        <div style={{ flex: 1 }} />
        {!open && <button onClick={() => setOpen(true)} style={miniBtn}>{obj.final_score != null ? 'Edit grade' : 'Grade this objective'}</button>}
      </div>
      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Final score %" w={120}><input type="number" min={0} max={100} value={pct} onChange={e => setPct(e.target.value)} style={inp} /></Field>
          <Field label="Confidence" w={140}><select value={confidence} onChange={e => setConfidence(e.target.value)} style={inp}>{Object.entries(CONFIDENCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Reflection" w={320}><input value={note} onChange={e => setNote(e.target.value)} placeholder="What did we learn?" style={inp} /></Field>
          <button disabled={busy} onClick={save} style={{ ...miniBtn, background: 'var(--yellow)', color: '#1b1b1e', border: 'none', height: 34 }}>{busy ? '…' : 'Save grade'}</button>
        </div>
      )}
    </div>
  );
}

export default function ObjectiveDetailPage() {
  return <Suspense fallback={<Spinner />}><DetailInner /></Suspense>;
}
