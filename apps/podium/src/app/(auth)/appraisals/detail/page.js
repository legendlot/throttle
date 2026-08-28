'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Printer } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { RATING_LABELS, ratingColor, APPRAISAL_STATUS, fmtMonths } from '../../../../lib/appraisals.js';
import { fmtDate } from '../../../../lib/format.js';
import { ScoreBar } from '../../../../components/OkrPanels.js';

export default function Page() {
  return <Suspense fallback={<Spinner />}><DetailPage /></Suspense>;
}

function DetailPage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const router = useRouter();
  const { session } = useAuth();
  const { showToast } = useToast();
  const [a, setA] = useState(null);
  const [cfg, setCfg] = useState({ appraisal_prompts: ['What went well', 'What could have gone better', 'Focus for the next period'] });

  const load = useCallback(async () => {
    if (!session || !id) return;
    const [r, c] = await Promise.all([
      podiumopsGet('getAppraisal', { id }, session),
      podiumopsGet('getAppraisalConfig', {}, session).catch(() => null),
    ]);
    setA(r); if (c) setCfg(c);
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  if (!a) return <Spinner />;
  const prompts = cfg.appraisal_prompts || [];
  const cycleActive = a.cycle?.status === 'active';
  const shared = a.status === 'shared' || a.status === 'acknowledged';

  return (
    <div style={{ maxWidth: 820 }}>
      <button onClick={() => router.back()} style={back}>← Back</button>
      <header style={{ margin: '8px 0 16px' }}>
        <h1 style={h1}>{a.employee?.full_name || 'Appraisal'} <span style={badge}>{APPRAISAL_STATUS[a.status] || a.status}</span>{a.outcome === 'pip' && <span style={{ ...badge, color: 'var(--state-error-fg)' }}>PIP</span>}</h1>
        <p style={sub}>{a.cycle?.name} · period {fmtDate(a.review_period_start)} → {fmtDate(a.review_period_end)} · {fmtMonths(typeof a.review_period_months === 'number' ? a.review_period_months : null)}</p>
      </header>

      {/* SUBJECT view */}
      {a._role === 'subject' && (
        <>
          <SelfForm a={a} prompts={prompts} session={session} editable={cycleActive && !shared} onSaved={load} />
          {shared && <SharedResult a={a} session={session} onSaved={load} canAck />}
        </>
      )}

      {/* MANAGER view */}
      {a._role === 'manager' && (
        <>
          <ReadBlock title="Self-review" overall={a.self_overall_rating} prompts={prompts}
            vals={[a.self_did_well, a.self_improve, a.self_focus]} submitted={a.self_submitted_at} />
          <ManagerForm a={a} prompts={prompts} session={session} editable={cycleActive && !shared} onSaved={load} />
          {a.final_rating && <FinalBlock a={a} />}
        </>
      )}

      {/* HR view */}
      {a._role === 'hr' && (
        <>
          <ReadBlock title="Self-review" overall={a.self_overall_rating} prompts={prompts} vals={[a.self_did_well, a.self_improve, a.self_focus]} submitted={a.self_submitted_at} />
          <ReadBlock title="Manager review" overall={a.manager_overall_rating} prompts={prompts} vals={[a.manager_did_well, a.manager_improve, a.manager_focus]} submitted={a.manager_submitted_at} />
          <HrCalibrate a={a} session={session} onSaved={load} />
          {a._can_comp && <IncrementPanel a={a} session={session} onSaved={load} />}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <a href={`/appraisals/letter/?id=${a.id}&type=appraisal`} target="_blank" rel="noreferrer" style={linkBtn}><Printer size={13} /> Appraisal letter</a>
            {a._can_comp && a.increment && <a href={`/appraisals/letter/?id=${a.id}&type=increment`} target="_blank" rel="noreferrer" style={linkBtn}><Printer size={13} /> Increment letter</a>}
          </div>
        </>
      )}

      <OkrsReadonly okrs={a.okrs} />
    </div>
  );
}

// ── OKRs for the period (read-only context; never weighted into the rating) ──
function OkrsReadonly({ okrs }) {
  if (!okrs || okrs.length === 0) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '15px 18px', marginTop: 16 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t2)', marginBottom: 4 }}>OKRs this period</div>
      <div style={{ fontSize: 11.5, color: 'var(--t4)', marginBottom: 10 }}>For context only — not part of the rating.</div>
      {okrs.map(o => (
        <div key={o.id} style={{ padding: '10px 0', borderTop: '1px solid var(--hairline)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{o.title}{o.final_score != null && <span style={{ color: 'var(--yellow)', fontSize: 11, marginLeft: 6 }}>graded</span>}</span>
            <div style={{ width: 140 }}><ScoreBar score={o.displayed_score} /></div>
          </div>
          {o.reflection_note && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{o.reflection_note}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Subject self-review form ──
function SelfForm({ a, prompts, session, editable, onSaved }) {
  const { showToast } = useToast();
  const [ov, setOv] = useState(a.self_overall_rating || '');
  const [v, setV] = useState([a.self_did_well || '', a.self_improve || '', a.self_focus || '']);
  const [kpis, setKpis] = useState(a.kpis || []);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await podiumopsPost('submitSelfReview', { data: {
        appraisal_id: a.id, self_overall_rating: ov ? Number(ov) : null,
        self_did_well: v[0], self_improve: v[1], self_focus: v[2],
        kpi_ratings: kpis.map(k => ({ id: k.id, rating: k.self_rating })),
      } }, session);
      showToast('Self-review submitted', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  if (!editable) return <ReadBlock title="Your self-review" overall={a.self_overall_rating} prompts={prompts} vals={[a.self_did_well, a.self_improve, a.self_focus]} submitted={a.self_submitted_at} />;
  return (
    <div style={card}>
      <div style={cardHead}>Your self-review {a.self_submitted_at && <span style={{ fontSize: 11, color: 'var(--state-success-fg)' }}>submitted — editable while open</span>}</div>
      <div style={{ padding: 14 }}>
        <RatingPick label="Overall self-rating" value={ov} onChange={setOv} />
        {prompts.map((p, i) => (
          <div key={i} style={{ marginTop: 12 }}><span style={lbl}>{p}</span>
            <textarea value={v[i]} onChange={e => setV(x => x.map((y, j) => j === i ? e.target.value : y))} rows={3} style={ta} /></div>
        ))}
        {kpis.length > 0 && <KpiEditor kpis={kpis} setKpis={setKpis} side="self" />}
        <div style={{ marginTop: 14, textAlign: 'right' }}><button style={{ ...btnP, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Submit self-review'}</button></div>
      </div>
    </div>
  );
}

// ── Manager review form ──
function ManagerForm({ a, prompts, session, editable, onSaved }) {
  const { showToast } = useToast();
  const [ov, setOv] = useState(a.manager_overall_rating || '');
  const [v, setV] = useState([a.manager_did_well || '', a.manager_improve || '', a.manager_focus || '']);
  const [kpis, setKpis] = useState(a.kpis || []);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await podiumopsPost('submitManagerReview', { data: {
        appraisal_id: a.id, manager_overall_rating: ov ? Number(ov) : null,
        manager_did_well: v[0], manager_improve: v[1], manager_focus: v[2],
        kpi_ratings: kpis.map(k => ({ id: k.id, rating: k.manager_rating })),
      } }, session);
      showToast('Manager review submitted', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  if (!editable) return <ReadBlock title="Manager review" overall={a.manager_overall_rating} prompts={prompts} vals={[a.manager_did_well, a.manager_improve, a.manager_focus]} submitted={a.manager_submitted_at} />;
  return (
    <div style={card}>
      <div style={cardHead}>Manager review {a.manager_submitted_at && <span style={{ fontSize: 11, color: 'var(--state-success-fg)' }}>submitted — editable while open</span>}</div>
      <div style={{ padding: 14 }}>
        <RatingPick label="Overall rating" value={ov} onChange={setOv} />
        {prompts.map((p, i) => (
          <div key={i} style={{ marginTop: 12 }}><span style={lbl}>{p}</span>
            <textarea value={v[i]} onChange={e => setV(x => x.map((y, j) => j === i ? e.target.value : y))} rows={3} style={ta} /></div>
        ))}
        {kpis.length > 0 && <KpiEditor kpis={kpis} setKpis={setKpis} side="manager" />}
        <div style={{ marginTop: 14, textAlign: 'right' }}><button style={{ ...btnP, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Submit manager review'}</button></div>
      </div>
    </div>
  );
}

// ── HR calibration ──
function HrCalibrate({ a, session, onSaved }) {
  const { showToast } = useToast();
  const [fr, setFr] = useState(a.final_rating || '');
  const [note, setNote] = useState(a.calibration_note || '');
  const [busy, setBusy] = useState(false);
  const locked = a.cycle?.status === 'closed';
  async function finalize() {
    if (!fr) { showToast('Set a final rating', 'error'); return; }
    setBusy(true);
    try { await podiumopsPost('finalizeAppraisal', { data: { appraisal_id: a.id, final_rating: Number(fr), calibration_note: note || null } }, session); showToast('Finalized', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  async function share() {
    setBusy(true);
    try { await podiumopsPost('shareAppraisal', { data: { appraisal_id: a.id } }, session); showToast('Shared', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={card}>
      <div style={cardHead}>Calibration (HR-internal)</div>
      <div style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <RatingPick label="Final rating" value={fr} onChange={setFr} />
          <div style={{ flex: 1, minWidth: 220 }}><span style={lbl}>Calibration note (never shown to the employee)</span>
            <input value={note} onChange={e => setNote(e.target.value)} style={{ ...ta, height: 'auto', padding: '7px 10px' }} /></div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={{ ...btnS }} disabled={busy || locked} onClick={finalize}>{a.final_rating ? 'Update final' : 'Finalize'}</button>
          <button style={{ ...btnP }} disabled={busy || !a.final_rating || a.status === 'shared' || a.status === 'acknowledged'} onClick={share}>Share with employee</button>
        </div>
        {a.outcome === 'pip' && <p style={{ fontSize: 12, color: 'var(--state-error-fg)', marginTop: 8 }}>Final rating triggers a PIP.</p>}
      </div>
    </div>
  );
}

// ── Comp increment ──
function IncrementPanel({ a, session, onSaved }) {
  const { showToast } = useToast();
  const [pct, setPct] = useState(a.increment?.increment_pct ?? '');
  const [bonus, setBonus] = useState(a.increment?.amount ?? '');
  const [busy, setBusy] = useState(false);
  async function apply() {
    setBusy(true);
    try { await podiumopsPost('applyIncrement', { data: { appraisal_id: a.id, increment_pct: pct === '' ? null : Number(pct), bonus_amount: bonus === '' ? null : Number(bonus) } }, session);
      showToast('Increment recorded', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={card}>
      <div style={cardHead}>Increment (compensation)</div>
      <div style={{ padding: 14 }}>
        {a.increment && <p style={{ fontSize: 12, color: 'var(--state-success-fg)', marginBottom: 8 }}>Recorded: {a.increment.increment_pct != null ? `${a.increment.increment_pct}%` : ''} {a.increment.amount ? `+ ₹${a.increment.amount} bonus` : ''} · effective {fmtDate(a.increment.effective_date)}</p>}
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><span style={lbl}>Increment %</span><input value={pct} onChange={e => setPct(e.target.value)} type="number" style={{ ...miniInput, width: 100 }} /></div>
          <div><span style={lbl}>One-time bonus (₹)</span><input value={bonus} onChange={e => setBonus(e.target.value)} type="number" style={{ ...miniInput, width: 130 }} /></div>
          <button style={{ ...btnP }} disabled={busy} onClick={apply}>{a.increment ? 'Record again' : 'Record increment'}</button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>Effective date defaults to the cycle anchor. Absolute CTC is gated off (vault). The suggested % is on the calibration grid.</p>
      </div>
    </div>
  );
}

// ── Shared result (subject) ──
function SharedResult({ a, session, onSaved, canAck }) {
  const { showToast } = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function ack() {
    setBusy(true);
    try { await podiumopsPost('acknowledgeAppraisal', { data: { appraisal_id: a.id, ack_note: note || null } }, session); showToast('Acknowledged', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={cardHead}>Your result</div>
      <div style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: ratingColor(a.final_rating) }}>{a.final_rating}</span>
          <span style={{ color: 'var(--text-2)' }}>{RATING_LABELS[a.final_rating]}</span>
        </div>
        {[['What went well', a.manager_did_well], ['What could have gone better', a.manager_improve], ['Focus for next period', a.manager_focus]].map(([t, val]) => val && (
          <div key={t} style={{ marginBottom: 10 }}><div style={lbl}>{t}</div><div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>{val}</div></div>
        ))}
        {a.increment && <p style={{ fontSize: 13, color: 'var(--state-success-fg)' }}>Increment: {a.increment.increment_pct != null ? `${a.increment.increment_pct}%` : ''} {a.increment.amount ? `+ ₹${a.increment.amount} bonus` : ''} · effective {fmtDate(a.increment.effective_date)}</p>}
        <div style={{ marginTop: 10 }}><a href={`/appraisals/letter/?id=${a.id}&type=appraisal`} target="_blank" rel="noreferrer" style={linkBtn}><Printer size={13} /> View letter</a></div>
        {canAck && a.status === 'shared' && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span style={lbl}>Acknowledge (optional note)</span>
            <input value={note} onChange={e => setNote(e.target.value)} style={{ ...miniInput, width: '100%', marginBottom: 8 }} />
            <button style={btnP} disabled={busy} onClick={ack}>Acknowledge</button>
          </div>
        )}
        {a.status === 'acknowledged' && <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>Acknowledged {fmtDate(a.acknowledged_at)}.</p>}
      </div>
    </div>
  );
}

function FinalBlock({ a }) {
  return <div style={{ ...card, marginTop: 14 }}><div style={cardHead}>Final</div><div style={{ padding: 14, display: 'flex', alignItems: 'baseline', gap: 10 }}><span style={{ fontSize: 26, fontWeight: 800, color: ratingColor(a.final_rating) }}>{a.final_rating}</span><span style={{ color: 'var(--text-2)' }}>{RATING_LABELS[a.final_rating]}{a.outcome === 'pip' ? ' · PIP' : ''}</span></div></div>;
}

function ReadBlock({ title, overall, prompts, vals, submitted }) {
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={cardHead}>{title} {submitted ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {fmtDate(submitted)}</span> : <span style={{ fontSize: 11, color: 'var(--state-warning-fg)' }}>· not submitted</span>}</div>
      <div style={{ padding: 14 }}>
        <div style={{ marginBottom: 10 }}><span style={lbl}>Overall</span> <span style={{ fontWeight: 700, color: ratingColor(overall) }}>{overall || '—'} {overall ? RATING_LABELS[overall] : ''}</span></div>
        {(prompts || []).map((p, i) => vals[i] && <div key={i} style={{ marginBottom: 8 }}><div style={lbl}>{p}</div><div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{vals[i]}</div></div>)}
      </div>
    </div>
  );
}

function RatingPick({ label, value, onChange }) {
  return (
    <div><span style={lbl}>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" onClick={() => onChange(String(n))}
            style={{ width: 38, height: 34, borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontWeight: 700,
              background: String(value) === String(n) ? 'var(--podium-accent)' : 'var(--surface-2)',
              color: String(value) === String(n) ? '#1f1f1f' : 'var(--text-2)',
              border: `1px solid ${String(value) === String(n) ? 'var(--podium-accent)' : 'var(--border)'}` }}>{n}</button>
        ))}
        <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--text-3)', marginLeft: 6 }}>{value ? RATING_LABELS[value] : ''}</span>
      </div>
    </div>
  );
}

function KpiEditor({ kpis, setKpis, side }) {
  const col = side === 'manager' ? 'manager_rating' : 'self_rating';
  return (
    <div style={{ marginTop: 14 }}>
      <span style={lbl}>Per-KPI ratings (optional)</span>
      {kpis.map((k, i) => (
        <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <span style={{ flex: 1, fontSize: 13 }}>{k.kpi_name}{k.weight ? <span style={{ color: 'var(--text-3)', fontSize: 11 }}> · w{k.weight}</span> : ''}</span>
          <select value={k[col] || ''} onChange={e => setKpis(prev => prev.map((x, j) => j === i ? { ...x, [col]: e.target.value ? Number(e.target.value) : null } : x))} style={miniInput}>
            <option value="">—</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 };
const sub = { fontSize: 12, color: 'var(--text-3)', marginTop: 4 };
// ⚠️ `badge` is used in the <h1> status pill at the top of this page and was NEVER defined,
// so DetailPage threw ReferenceError on EVERY render — the page did not work at all (S322).
// Modelled on badgeGray in admin/roles/page.js to match the app's pill styling. The PIP
// variant spreads this and overrides only the colour, so keep it a plain object.
const badge = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px', textTransform: 'uppercase' };

const back = { background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 12 };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const cardHead = { padding: '9px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-2)' };
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontWeight: 700 };
const ta = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit' };
const miniInput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 13, outline: 'none' };
const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--podium-accent)', textDecoration: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' };
const btnBase = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };
const btnP = { ...btnBase, background: 'var(--podium-accent)', color: '#1f1f1f', border: '1px solid var(--podium-accent)' };
const btnS = { ...btnBase, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)' };
