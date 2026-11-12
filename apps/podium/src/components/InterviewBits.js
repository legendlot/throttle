'use client';
// Hiring O2 — interview rounds + feedback: the shared pieces for the opening (round plan), the candidate
// (per-application interviews) and My interviews. Presentation only; every gate is the worker's.
// Times are shown and entered in IST (fmtDateTime / istLocalToIso).
import { useState } from 'react';
import { useToast, Combobox } from '@throttle/ui';
import { Plus, Pencil, Save, X, ArrowUp, ArrowDown, CalendarClock, Bell, Ban, UserX, Gavel, Trash2 } from 'lucide-react';
import { podiumopsPost } from '../lib/podiumopsFetch.js';
import { Card, F, Row, Note, ToneBadge, ListBadge, inp, comboInp, primaryBtn, ghostBtn, dangerBtn, iconBtn, muted } from './HiringBits.js';
import { OUTCOME_REASONS, hiringError, labelFrom, fmtDateTime } from '../lib/hiring.js';
import {
  INTERVIEW_MODES, INTERVIEW_STATUSES, VERDICTS, RECOMMENDATIONS, FEEDBACK_STATES, MAX_CRITERIA, MAX_PANEL, DURATIONS,
  istLocalToIso, isoToIstLocal,
} from '../lib/interviews.js';

const smallBtn = { ...ghostBtn, padding: '3px 9px', fontSize: 11 };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 120, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px', overflow: 'auto' };
const modal = { width: 'min(560px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px', color: 'var(--text-1)' };
const subTitle = { fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const box = { marginTop: 8, padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' };

export function FeedbackStateBadge({ state }) { return <ListBadge list={FEEDBACK_STATES} status={state} />; }
export function InterviewStatusBadge({ status }) { return <ListBadge list={INTERVIEW_STATUSES} status={status} />; }
export function VerdictBadge({ verdict }) { return verdict ? <ListBadge list={VERDICTS} status={verdict} /> : null; }

function Dialog({ title, icon: Ic, onClose, children, footer }) {
  return (
    <div style={overlay}>
      <div style={modal} role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
          {Ic && <Ic size={16} />} {title}
          <span style={{ flex: 1 }} /><button onClick={onClose} style={{ ...smallBtn, border: 'none' }} aria-label="Close"><X size={14} /></button>
        </div>
        {children}
        {footer && <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 12 }}>{footer}</div>}
      </div>
    </div>
  );
}

// "12 Nov 2026, 03:30 pm · 60 min · Video · Room 2"
export function interviewWhen(iv) {
  return [fmtDateTime(iv.scheduled_at) + ' IST', iv.duration_min ? `${iv.duration_min} min` : null,
    labelFrom(INTERVIEW_MODES, iv.mode), iv.location || null].filter(Boolean).join(' · ');
}

// ── Pickers ─────────────────────────────────────────────────────────────────

// Interviewers: active employees with a login (getHiringLookups' can_interview). `locked` ids cannot be removed.
export function PanelPicker({ value, onChange, emps, locked = [], max = MAX_PANEL, disabled }) {
  const ids = value || [];
  const byId = Object.fromEntries((emps || []).map(e => [e.id, e]));
  const opts = (emps || []).filter(e => e.can_interview !== false && !ids.includes(e.id))
    .map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }));
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: ids.length ? 6 : 0 }}>
        {ids.map(id => (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '3px 8px', borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            {byId[id]?.full_name || 'Unknown'}
            {!locked.includes(id) && !disabled && (
              <button type="button" onClick={() => onChange(ids.filter(x => x !== id))} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0 }} aria-label="Remove"><X size={12} /></button>
            )}
          </span>
        ))}
      </div>
      {ids.length < max && !disabled && (
        <Combobox value="" onChange={v => v && onChange([...ids, v])} inputStyle={comboInp} placeholder="Add interviewer…" options={opts} />
      )}
    </div>
  );
}

function ScorePicker({ value, onChange, disabled }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" disabled={disabled} onClick={() => onChange(n)}
          style={{ ...smallBtn, minWidth: 30, justifyContent: 'center', ...(value === n ? { background: 'var(--podium-accent)', color: '#1f1f1f', borderColor: 'var(--podium-accent)', fontWeight: 700 } : {}) }}>{n}</button>
      ))}
    </span>
  );
}

// ── Feedback display + the submit form ──────────────────────────────────────

export function FeedbackView({ feedback, scorecard }) {
  if (!feedback) return null;
  const card = scorecard || [];
  return (
    <div style={{ fontSize: 12.5, marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Overall <b className="num">{feedback.rating}/5</b></span>
        <ListBadge list={RECOMMENDATIONS} status={feedback.recommendation} />
      </div>
      {card.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '2px 12px', marginTop: 4, color: 'var(--text-2)' }}>
          {card.map(c => <span key={c.key}>{c.label}: <b className="num">{feedback.scores?.[c.key] ?? '-'}</b></span>)}
        </div>
      )}
      {feedback.notes && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4, color: 'var(--text-1)' }}>{feedback.notes}</div>}
    </div>
  );
}

// Submit-once (D3): a confirm step, then it locks.
export function FeedbackForm({ interviewId, scorecard, session, onSubmitted }) {
  const { showToast } = useToast();
  const card = scorecard || [];
  const [rating, setRating] = useState(null);
  const [rec, setRec] = useState('');
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = !rating || !rec || card.some(c => !scores[c.key]);

  async function submit() {
    if (missing) { showToast('Give an overall rating, a recommendation and a score for every criterion', 'error'); return; }
    if (!window.confirm('Submit your feedback? It cannot be edited afterwards. You will then see the other interviewers\' feedback.')) return;
    setBusy(true);
    try {
      await podiumopsPost('submitInterviewFeedback', { interview_id: interviewId, rating, recommendation: rec, scores, notes: notes.trim() || null }, session);
      showToast('Feedback submitted', 'success'); onSubmitted && onSubmitted();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {card.map(c => (
        <div key={c.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13 }}>{c.label}</span>
          <ScorePicker value={scores[c.key] || null} disabled={busy} onChange={n => setScores(s => ({ ...s, [c.key]: n }))} />
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Overall rating</span>
        <ScorePicker value={rating} disabled={busy} onChange={setRating} />
      </div>
      <F label="Recommendation">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {RECOMMENDATIONS.map(r => (
            <button key={r.id} type="button" disabled={busy} onClick={() => setRec(r.id)}
              style={{ ...smallBtn, ...(rec === r.id ? { background: 'var(--podium-accent)', color: '#1f1f1f', borderColor: 'var(--podium-accent)', fontWeight: 700 } : {}) }}>{r.label}</button>
          ))}
        </div>
      </F>
      <F label="Notes (the hiring team and the other interviewers see these)">
        <textarea rows={5} maxLength={5000} style={{ ...inp, resize: 'vertical', fontFamily: 'var(--font-ui)' }} value={notes} onChange={e => setNotes(e.target.value)} disabled={busy} />
      </F>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={submit} disabled={busy} style={{ ...primaryBtn, opacity: missing || busy ? 0.6 : 1 }}><Save size={13} /> {busy ? 'Submitting…' : 'Submit feedback'}</button>
      </div>
    </div>
  );
}

// ── Opening: the round plan (D1) ────────────────────────────────────────────

export function RoundsCard({ openingId, rounds, emps, canEdit, session, onChanged }) {
  const { showToast } = useToast();
  const [edit, setEdit] = useState(null);     // { id?, name, default_interviewer_ids, scorecard: [{key?, label}] }
  const [busy, setBusy] = useState(false);
  const list = rounds || [];
  const nameOf = (id) => (emps || []).find(e => e.id === id)?.full_name || null;

  async function save() {
    if (!edit.name.trim()) { showToast('Name the round', 'error'); return; }
    const scorecard = edit.scorecard.map(c => ({ ...(c.key ? { key: c.key } : {}), label: c.label.trim() })).filter(c => c.label);
    setBusy(true);
    try {
      await podiumopsPost('saveOpeningRound', { opening_id: openingId, id: edit.id || undefined, name: edit.name.trim(),
        default_interviewer_ids: edit.default_interviewer_ids, scorecard }, session);
      showToast('Round saved', 'success'); setEdit(null); onChanged();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function setActive(r, active) {
    try { await podiumopsPost('setOpeningRoundActive', { id: r.id, active }, session); showToast(active ? 'Round reactivated' : 'Round deactivated', 'success'); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
  }
  async function move(i, dir) {
    const ids = list.map(r => r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await podiumopsPost('reorderOpeningRounds', { opening_id: openingId, ids }, session); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
  }

  return (
    <Card title={`Interview rounds (${list.filter(r => r.active).length})`}
      right={canEdit && <button onClick={() => setEdit({ name: '', default_interviewer_ids: [], scorecard: [] })} style={ghostBtn}><Plus size={13} /> Add round</button>}>
      {list.length === 0 ? <div style={muted}>No round plan. Interviews can still be scheduled with a round name typed in.</div> : list.map((r, i) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', opacity: r.active ? 1 : 0.55 }}>
          <span className="num" style={{ ...muted, width: 18, paddingTop: 2 }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center' }}>{r.name}{!r.active && <ToneBadge tone="neutral" label="Inactive" />}</div>
            <div style={{ ...muted, fontSize: 11.5 }}>
              {(r.default_interviewer_ids || []).length ? (r.default_interviewer_ids || []).map(id => nameOf(id) || 'Unknown').join(', ') : 'No default interviewers'}
              {' · '}{(r.scorecard || []).length ? (r.scorecard || []).map(c => c.label).join(', ') : 'No scorecard'}
            </div>
          </div>
          {canEdit && (
            <span style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...iconBtn, opacity: i === 0 ? 0.4 : 1 }} title="Move up"><ArrowUp size={13} /></button>
              <button onClick={() => move(i, 1)} disabled={i === list.length - 1} style={{ ...iconBtn, opacity: i === list.length - 1 ? 0.4 : 1 }} title="Move down"><ArrowDown size={13} /></button>
              <button onClick={() => setEdit({ id: r.id, name: r.name, default_interviewer_ids: r.default_interviewer_ids || [], scorecard: (r.scorecard || []).map(c => ({ ...c })) })} style={iconBtn} title="Edit"><Pencil size={13} /></button>
              <button onClick={() => setActive(r, !r.active)} style={smallBtn}>{r.active ? 'Deactivate' : 'Reactivate'}</button>
            </span>
          )}
        </div>
      ))}

      {edit && (
        <Dialog title={edit.id ? 'Edit round' : 'Add round'} icon={CalendarClock} onClose={() => !busy && setEdit(null)}
          footer={<>
            <button onClick={() => setEdit(null)} style={ghostBtn} disabled={busy}>Cancel</button>
            <button onClick={save} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Saving…' : 'Save round'}</button>
          </>}>
          <F label="Round name *"><input style={inp} maxLength={80} value={edit.name} onChange={e => setEdit(s => ({ ...s, name: e.target.value }))} placeholder="e.g. Technical, Culture, Founder" /></F>
          <F label="Default interviewers (pre-filled when scheduling)">
            <PanelPicker value={edit.default_interviewer_ids} onChange={v => setEdit(s => ({ ...s, default_interviewer_ids: v }))} emps={emps} />
          </F>
          <div style={{ ...subTitle, margin: '6px 0' }}>Scorecard (each criterion scored 1 to 5)</div>
          {edit.scorecard.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input style={inp} maxLength={80} value={c.label} onChange={e => setEdit(s => ({ ...s, scorecard: s.scorecard.map((x, j) => j === i ? { ...x, label: e.target.value } : x) }))} placeholder="Criterion" />
              <button onClick={() => setEdit(s => ({ ...s, scorecard: s.scorecard.filter((_, j) => j !== i) }))} style={iconBtn} title="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
          {edit.scorecard.length < MAX_CRITERIA && (
            <button onClick={() => setEdit(s => ({ ...s, scorecard: [...s.scorecard, { label: '' }] }))} style={smallBtn}><Plus size={12} /> Add criterion</button>
          )}
          <div style={{ ...muted, marginTop: 8 }}>Changes apply to interviews scheduled from now on. Interviews already scheduled keep the scorecard they were scheduled with.</div>
        </Dialog>
      )}
    </Card>
  );
}

// ── Candidate: one application's interviews (D2 / D6 / D7) ──────────────────

export function InterviewsBlock({ a, emps, session, onChanged }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(null);       // schedule / edit
  const [verdict, setVerdict] = useState(null); // the interview being decided
  const [busy, setBusy] = useState(false);
  const ivs = a.interviews || [];
  const canManage = a.can_manage !== false;
  if (!ivs.length && !a.can_schedule) return null;

  async function cancel(iv) {
    const reason = window.prompt("Why is this interview cancelled? (Only the opening's salary chain sees the reason.)");
    if (reason == null) return;
    if (!reason.trim()) { showToast('A reason is required', 'error'); return; }
    setBusy(true);
    try { await podiumopsPost('cancelInterview', { id: iv.id, reason: reason.trim() }, session); showToast('Interview cancelled', 'success'); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function noShow(iv) {
    if (!window.confirm('Mark this interview as a no-show? The candidate stays where they are, and the round can be scheduled again.')) return;
    setBusy(true);
    try { await podiumopsPost('markInterviewNoShow', { id: iv.id }, session); showToast('Marked as no-show', 'success'); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function remind(p) {
    if (!window.confirm(`Email ${p.name || 'this interviewer'} a reminder from your work mailbox?`)) return;
    setBusy(true);
    try { await podiumopsPost('remindPanelist', { panel_id: p.id }, session); showToast('Reminder sent', 'success'); onChanged(); }
    catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: ivs.length ? 6 : 0 }}>
        <span style={{ ...subTitle, flex: 1 }}>Interviews</span>
        {a.can_schedule && <button onClick={() => setForm({ mode: 'new' })} style={{ ...ghostBtn, padding: '4px 10px' }}><CalendarClock size={13} /> Schedule interview</button>}
      </div>
      {ivs.map(iv => (
        <div key={iv.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)', opacity: iv.status === 'cancelled' ? 0.6 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{iv.round_name}</span>
            <InterviewStatusBadge status={iv.status} />
            <VerdictBadge verdict={iv.verdict} />
            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>{interviewWhen(iv)}</span>
            {iv.jd_version != null && <span style={muted}>JD v{iv.jd_version}</span>}
            <span style={{ flex: 1 }} />
            {canManage && iv.can_edit && <button disabled={busy} onClick={() => setForm({ mode: 'edit', iv })} style={iconBtn} title="Edit"><Pencil size={13} /></button>}
            {canManage && iv.can_no_show && <button disabled={busy} onClick={() => noShow(iv)} style={smallBtn}><UserX size={12} /> No-show</button>}
            {canManage && iv.can_cancel && <button disabled={busy} onClick={() => cancel(iv)} style={smallBtn}><Ban size={12} /> Cancel</button>}
            {canManage && iv.can_verdict && <button disabled={busy} onClick={() => setVerdict(iv)} style={{ ...smallBtn, color: 'var(--text-1)' }}><Gavel size={12} /> Verdict</button>}
          </div>
          {iv.verdict && (
            <div style={{ ...muted, marginTop: 2 }}>
              Verdict {labelFrom(VERDICTS, iv.verdict).toLowerCase()}{iv.verdict_by_name ? ` by ${iv.verdict_by_name}` : ''} · {fmtDateTime(iv.verdict_at)}
              {iv.verdict_reason && ` · ${labelFrom(OUTCOME_REASONS, iv.verdict_reason)}`}
              {iv.verdict_note && <> · &ldquo;{iv.verdict_note}&rdquo;</>}
            </div>
          )}
          {iv.status === 'cancelled' && iv.cancel_reason && <div style={{ ...muted, marginTop: 2 }}>Cancelled: &ldquo;{iv.cancel_reason}&rdquo;</div>}
          {iv.feedback_hidden && <div style={{ ...muted, marginTop: 4, color: 'var(--warn-fg)' }}>You are on this panel. The other interviewers&apos; feedback shows once you submit yours in My interviews.</div>}
          <div style={{ marginTop: 4 }}>
            {(iv.panel || []).map(p => (
              <div key={p.id} style={{ padding: '4px 0 4px 10px', borderLeft: '2px solid var(--border)', marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
                  <span>{p.name || 'Interviewer'}{p.is_me ? ' (you)' : ''}</span>
                  <FeedbackStateBadge state={p.state} />
                  {p.state !== 'submitted' && p.state !== 'not_needed' && <span style={muted}>due {fmtDateTime(p.due_at)}</span>}
                  {p.submitted_at && <span style={muted}>submitted {fmtDateTime(p.submitted_at)}</span>}
                  {p.remind_count > 0 && !p.submitted_at && <span style={muted}>reminded {p.remind_count}x</span>}
                  {p.can_remind && <button disabled={busy} onClick={() => remind(p)} style={smallBtn}><Bell size={12} /> Remind</button>}
                </div>
                <FeedbackView feedback={p.feedback} scorecard={iv.scorecard} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {form && <ScheduleDialog a={a} emps={emps} edit={form.mode === 'edit' ? form.iv : null} session={session}
        onClose={() => setForm(null)} onSaved={() => { setForm(null); onChanged(); }} />}
      {verdict && <VerdictDialog iv={verdict} session={session} onClose={() => setVerdict(null)} onSaved={() => { setVerdict(null); onChanged(); }} />}
    </div>
  );
}

function ScheduleDialog({ a, emps, edit, session, onClose, onSaved }) {
  const { showToast } = useToast();
  const rounds = (a.rounds || []).filter(r => r.active !== false);
  const usable = new Set((emps || []).filter(e => e.can_interview !== false).map(e => e.id));
  const defaultsOf = (r) => (r?.default_interviewer_ids || []).filter(id => usable.has(id));
  const first = rounds[0] || null;
  const [f, setF] = useState(() => edit ? {
    round_id: edit.round_id || '', round_name: edit.round_name, at: isoToIstLocal(edit.scheduled_at), duration_min: edit.duration_min,
    mode: edit.mode, location: edit.location || '', panel: (edit.panel || []).map(p => p.employee_id),
  } : {
    round_id: first?.id || '', round_name: '', at: '', duration_min: 60, mode: 'in_person', location: '', panel: defaultsOf(first),
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const locked = edit ? (edit.panel || []).filter(p => p.submitted_at).map(p => p.employee_id) : [];

  function pickRound(id) {
    const r = rounds.find(x => x.id === id);
    setF(s => ({ ...s, round_id: id, panel: defaultsOf(r) }));
  }
  async function save() {
    const iso = istLocalToIso(f.at);
    if (!iso) { showToast('Pick the interview date and time', 'error'); return; }
    if (!f.panel.length) { showToast('Add at least one interviewer', 'error'); return; }
    setBusy(true);
    try {
      if (edit) {
        const before = (edit.panel || []).map(p => p.employee_id);
        await podiumopsPost('updateInterview', {
          id: edit.id, scheduled_at: iso, duration_min: Number(f.duration_min), mode: f.mode, location: f.location.trim() || null,
          add_panel: f.panel.filter(id => !before.includes(id)), remove_panel: before.filter(id => !f.panel.includes(id)),
        }, session);
        showToast('Interview updated', 'success');
      } else {
        if (!rounds.length && !f.round_name.trim()) { showToast('Name the round', 'error'); setBusy(false); return; }
        await podiumopsPost('scheduleInterview', {
          application_id: a.id, ...(rounds.length ? { round_id: f.round_id } : { round_name: f.round_name.trim() }),
          scheduled_at: iso, duration_min: Number(f.duration_min), mode: f.mode, location: f.location.trim() || null, panel: f.panel,
        }, session);
        showToast(['new', 'screening'].includes(a.status) ? 'Interview scheduled. The candidate moved to Interviewing' : 'Interview scheduled', 'success');
      }
      onSaved();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Dialog title={edit ? `Edit interview: ${edit.round_name}` : 'Schedule interview'} icon={CalendarClock} onClose={() => !busy && onClose()}
      footer={<>
        <button onClick={onClose} style={ghostBtn} disabled={busy}>Cancel</button>
        <button onClick={save} style={primaryBtn} disabled={busy}><Save size={13} /> {busy ? 'Saving…' : edit ? 'Save' : 'Schedule'}</button>
      </>}>
      {!edit && (rounds.length ? (
        <F label="Round">
          <select style={inp} value={f.round_id} onChange={e => pickRound(e.target.value)}>
            {rounds.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </F>
      ) : (
        <F label="Round name * (this opening has no round plan)"><input style={inp} maxLength={80} value={f.round_name} onChange={e => set('round_name', e.target.value)} placeholder="e.g. First round" /></F>
      ))}
      <Row>
        <F label="Date and time (IST) *"><input type="datetime-local" style={inp} value={f.at} onChange={e => set('at', e.target.value)} /></F>
        <F label="Duration" style={{ maxWidth: 130 }}>
          <select style={inp} value={f.duration_min} onChange={e => set('duration_min', e.target.value)}>
            {[...new Set([...DURATIONS, Number(f.duration_min)])].sort((x, y) => x - y).map(m => <option key={m} value={m}>{m} min</option>)}
          </select>
        </F>
      </Row>
      <Row>
        <F label="Mode" style={{ maxWidth: 160 }}>
          <select style={inp} value={f.mode} onChange={e => set('mode', e.target.value)}>
            {INTERVIEW_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </F>
        <F label={f.mode === 'video' ? 'Meeting link' : f.mode === 'phone' ? 'Who calls whom' : 'Room / place'}>
          <input style={inp} maxLength={500} value={f.location} onChange={e => set('location', e.target.value)} />
        </F>
      </Row>
      <F label="Interviewers *">
        <PanelPicker value={f.panel} onChange={v => set('panel', v)} emps={emps} locked={locked} />
      </F>
      {edit && locked.length > 0 && <div style={muted}>Interviewers who have submitted feedback stay on the panel.</div>}
      {edit && <div style={{ ...muted, marginTop: 4 }}>Moving the time moves pending feedback due dates to 24 hours after the new time.</div>}
      {!edit && <div style={{ ...muted, marginTop: 4 }}>Feedback is due 24 hours after the interview. Each interviewer sees the others&apos; feedback only after submitting their own.</div>}
    </Dialog>
  );
}

function VerdictDialog({ iv, session, onClose, onSaved }) {
  const { showToast } = useToast();
  const [v, setV] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = (iv.panel || []).filter(p => !p.submitted_at && p.state !== 'not_needed').length;

  async function save() {
    if (!v) { showToast('Pick a verdict', 'error'); return; }
    if (v === 'reject' && !reason) { showToast('Pick a reason', 'error'); return; }
    setBusy(true);
    try {
      await podiumopsPost('recordInterviewVerdict', { id: iv.id, verdict: v, reason: v === 'reject' ? reason : null, note: note.trim() || null }, session);
      showToast(v === 'reject' ? 'Rejected' : v === 'hold' ? 'Put on hold' : 'Advanced', 'success'); onSaved();
    } catch (e) { showToast(hiringError(e), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Dialog title={`Verdict: ${iv.round_name}`} icon={Gavel} onClose={() => !busy && onClose()}
      footer={<>
        <button onClick={onClose} style={ghostBtn} disabled={busy}>Cancel</button>
        <button onClick={save} style={v === 'reject' ? dangerBtn : primaryBtn} disabled={busy}>{busy ? 'Saving…' : 'Record verdict'}</button>
      </>}>
      {pending > 0 && <Note>{pending} interviewer{pending > 1 ? 's have' : ' has'} not submitted feedback yet.</Note>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {VERDICTS.map(x => (
          <button key={x.id} type="button" onClick={() => setV(x.id)}
            style={{ ...ghostBtn, ...(v === x.id ? { background: 'var(--podium-accent)', color: '#1f1f1f', borderColor: 'var(--podium-accent)', fontWeight: 700 } : {}) }}>{x.label}</button>
        ))}
      </div>
      <div style={{ ...muted, marginBottom: 10 }}>
        {v === 'advance' && 'The candidate stays where they are. Schedule the next round, or start the offer.'}
        {v === 'hold' && 'The candidate moves to On Hold.'}
        {v === 'reject' && 'The candidate moves to Rejected.'}
      </div>
      {v === 'reject' && (
        <F label="Reason *">
          <select style={inp} value={reason} onChange={e => setReason(e.target.value)}>
            <option value="">Pick…</option>
            {OUTCOME_REASONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </F>
      )}
      <F label="Note (optional, only the opening's salary chain sees it)">
        <input style={{ ...inp, fontFamily: 'var(--font-ui)' }} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} />
      </F>
    </Dialog>
  );
}

// Interviews line on the opening's candidate rows (getOpening's interviews_summary).
export function InterviewSummaryLine({ s }) {
  if (!s || !s.count) return null;
  return (
    <span style={{ fontSize: 10.5, color: s.pending_feedback ? 'var(--warn-fg)' : 'var(--text-3)' }}>
      {s.count} interview{s.count > 1 ? 's' : ''}{s.next_at ? ` · next ${fmtDateTime(s.next_at)}` : ''}{s.pending_feedback ? ` · ${s.pending_feedback} feedback owed` : ''}
    </span>
  );
}
