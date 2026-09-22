'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Printer, Lock, Unlock } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { RATING_LABELS, ratingColor, APPRAISAL_STATUS, fmtMonths } from '../../../../lib/appraisals.js';
import { fmtDate, fmtMoney } from '../../../../lib/format.js';
import { RichTextEditor, RichTextView } from '../../../../components/RichText.js';
import { ScoreBar } from '../../../../components/OkrPanels.js';

export default function Page() {
  return <Suspense fallback={<Spinner />}><DetailPage mode="calibrate" /></Suspense>;
}

// mode 'review'   — /reviews/review: self + manager forms only, never the calibration tools
//                   (a super admin reviewing their own report is just their manager here).
// mode 'calibrate' — /appraisals/detail: adds calibration for super admins (reached from the cycle grid).
export function DetailPage({ mode = 'calibrate' }) {
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
  const calibrate = mode === 'calibrate' && a._can_calibrate;

  return (
    <div style={{ maxWidth: 820 }}>
      <button onClick={() => router.back()} style={back}>← Back</button>
      <header style={{ margin: '8px 0 16px' }}>
        <h1 style={h1}>{a.employee?.full_name || 'Appraisal'} <span style={badge}>{APPRAISAL_STATUS[a.status] || a.status}</span>{a.outcome === 'pip' && <span style={{ ...badge, color: 'var(--state-error-fg)' }}>PIP</span>}</h1>
        <p style={sub}>{a.cycle?.name} · period {fmtDate(a.review_period_start)} → {fmtDate(a.review_period_end)} · {fmtMonths(typeof a.review_period_months === 'number' ? a.review_period_months : null)}
          {a.employee?.department?.name ? ` · ${a.employee.department.name}` : ''}{a.manager?.full_name ? ` · manager ${a.manager.full_name}` : ''}</p>
        {calibrate && a._can_comp && <p style={{ ...sub, color: 'var(--text-1)', fontSize: 13 }}>Current CTC <strong>{a.current_ctc != null ? fmtMoney(a.current_ctc) : 'not on record'}</strong></p>}
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
          <ManagerForm a={a} prompts={prompts} session={session} editable={cycleActive && !shared && !!a._can_write_manager} onSaved={load} />
          {calibrate ? <HrTools a={a} session={session} onSaved={load} /> : (a.final_rating && <FinalBlock a={a} />)}
        </>
      )}

      {/* HR view */}
      {a._role === 'hr' && (
        <>
          <ReadBlock title="Self-review" overall={a.self_overall_rating} prompts={prompts} vals={[a.self_did_well, a.self_improve, a.self_focus]} submitted={a.self_submitted_at} />
          <ReadBlock title="Manager review" overall={a.manager_overall_rating} prompts={prompts} vals={[a.manager_did_well, a.manager_improve, a.manager_focus]} submitted={a.manager_submitted_at}
            extra={<Recommendation a={a} />} />
          {calibrate ? <HrTools a={a} session={session} onSaved={load} /> : <CalibrateLink id={a.id} />}
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

// HR calibration + increment + letters — shown on the HR view, and under the manager form when
// the reviewing manager is also HR (the worker never marks your OWN appraisal as HR/manager).
function HrTools({ a, session, onSaved }) {
  return (
    <>
      {!a.self_submitted_at && !a.manager_submitted_at && <WaiveSelf a={a} session={session} onSaved={onSaved} />}
      {/* keyed on their own saved values: a reload after another panel's save keeps unsaved input here */}
      <HrCalibrate key={`${a.final_rating}|${a.calibration_note}`} a={a} session={session} onSaved={onSaved} />
      {a._can_comp && <CompPanel key={`${a.calibrated_increment_pct}|${a.calibrated_bonus}|${a.comp_locked_at}`} a={a} session={session} onSaved={onSaved} />}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <a href={`/appraisals/letter/?id=${a.id}&type=appraisal`} target="_blank" rel="noreferrer" style={linkBtn}><Printer size={13} /> Appraisal letter</a>
        {a._can_comp && a.increment && <a href={`/appraisals/letter/?id=${a.id}&type=increment`} target="_blank" rel="noreferrer" style={linkBtn}><Printer size={13} /> Increment letter</a>}
      </div>
    </>
  );
}

// ── Subject self-review form ──
function SelfForm({ a, prompts, session, editable, onSaved }) {
  const { showToast } = useToast();
  const init = seedForm(a, 'self');
  const [ov, setOv] = useState(init.ov);
  const [v, setV] = useState(init.v);
  const [kpis, setKpis] = useState(init.kpis);
  const [busy, setBusy] = useState(false);
  async function save(draft) {
    setBusy(true);
    try {
      await podiumopsPost('submitSelfReview', { data: {
        appraisal_id: a.id, draft, self_overall_rating: ov ? Number(ov) : null,
        self_did_well: v[0], self_improve: v[1], self_focus: v[2],
        kpi_ratings: kpis.map(k => ({ id: k.id, rating: k.self_rating })),
      } }, session);
      showToast(draft ? 'Draft saved — only you can see it' : 'Self-review submitted', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  if (!editable) return <ReadBlock title="Your self-review" overall={a.self_overall_rating} prompts={prompts} vals={[a.self_did_well, a.self_improve, a.self_focus]} submitted={a.self_submitted_at} />;
  return (
    <div style={card}>
      <div style={cardHead}>Your self-review <DraftStatus submittedAt={a.self_submitted_at} draftAt={a.self_draft_saved_at} /></div>
      <div style={{ padding: 14 }}>
        <RatingPick label="Overall self-rating" value={ov} onChange={setOv} />
        {prompts.map((p, i) => (
          <div key={i} style={{ marginTop: 12 }}><span style={lbl}>{p}</span>
            <RichTextEditor value={v[i]} onChange={html => setV(x => x.map((y, j) => j === i ? html : y))} /></div>
        ))}
        {kpis.length > 0 && <KpiEditor kpis={kpis} setKpis={setKpis} side="self" />}
        <FormActions busy={busy} onDraft={() => save(true)} onSubmit={() => save(false)} submitLabel="Submit self-review"
          hint="A draft is visible only to you. Your manager sees the review once you submit." />
      </div>
    </div>
  );
}

// ── Manager review form ──
function ManagerForm({ a, prompts, session, editable, onSaved }) {
  const { showToast } = useToast();
  const init = seedForm(a, 'manager');
  const d = a.manager_draft;
  const pick = (dk, col) => (d ? (d[dk] ?? '') : (a[col] ?? ''));
  const [ov, setOv] = useState(init.ov);
  const [v, setV] = useState(init.v);
  const [kpis, setKpis] = useState(init.kpis);
  const [pct, setPct] = useState(pick('suggested_increment_pct', 'manager_suggested_increment_pct'));
  const [bonus, setBonus] = useState(pick('suggested_bonus', 'manager_suggested_bonus'));
  const [recNote, setRecNote] = useState(pick('recommendation_note', 'manager_recommendation_note'));
  const [comments, setComments] = useState(pick('comments', 'manager_comments'));
  const [busy, setBusy] = useState(false);
  // The manager reviews what the employee wrote: submit waits for the self-review unless a super
  // admin waived it; a draft is always allowed (worker enforces the same).
  const selfIn = !!a.self_submitted_at || !!a.self_review_waived_at;
  async function save(draft) {
    setBusy(true);
    try {
      await podiumopsPost('submitManagerReview', { data: {
        appraisal_id: a.id, draft, manager_overall_rating: ov ? Number(ov) : null,
        manager_did_well: v[0], manager_improve: v[1], manager_focus: v[2],
        manager_suggested_increment_pct: pct === '' ? null : Number(pct),
        manager_suggested_bonus: bonus === '' ? null : Number(bonus),
        manager_recommendation_note: recNote || null, manager_comments: comments || null,
        kpi_ratings: kpis.map(k => ({ id: k.id, rating: k.manager_rating })),
      } }, session);
      showToast(draft ? 'Draft saved — only you can see it' : 'Manager review submitted', 'success'); onSaved();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  if (!editable) return <ReadBlock title="Manager review" overall={a.manager_overall_rating} prompts={prompts} vals={[a.manager_did_well, a.manager_improve, a.manager_focus]} submitted={a.manager_submitted_at}
    extra={<Recommendation a={a} />} />;
  return (
    <div style={card}>
      <div style={cardHead}>Manager review <DraftStatus submittedAt={a.manager_submitted_at} draftAt={a.manager_draft_saved_at} /></div>
      <div style={{ padding: 14 }}>
        <RatingPick label="Overall rating" value={ov} onChange={setOv} />
        {prompts.map((p, i) => (
          <div key={i} style={{ marginTop: 12 }}><span style={lbl}>{p}</span>
            <RichTextEditor value={v[i]} onChange={html => setV(x => x.map((y, j) => j === i ? html : y))} /></div>
        ))}
        {kpis.length > 0 && <KpiEditor kpis={kpis} setKpis={setKpis} side="manager" />}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
          <span style={{ ...lbl, color: 'var(--text-2)' }}>Your recommendation · internal, never shown to the employee</span>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
            <div><span style={lbl}>Increment %</span>
              <input value={pct} onChange={e => setPct(e.target.value)} type="number" min="0" max="100" step="0.5" placeholder="e.g. 8" style={{ ...miniInput, width: 110 }} /></div>
            <div><span style={lbl}>One-time bonus (₹)</span>
              <input value={bonus} onChange={e => setBonus(e.target.value)} type="number" min="0" step="1000" placeholder="e.g. 25000" style={{ ...miniInput, width: 140 }} /></div>
          </div>
          <div style={{ marginTop: 10 }}><span style={lbl}>Recommendation comment — any adjustment beyond the increment + bonus</span>
            <RichTextEditor value={recNote} onChange={setRecNote} minHeight={60} placeholder="e.g. promote to Senior from Jan; revisit pay after the product launch" /></div>
          <div style={{ marginTop: 10 }}><span style={lbl}>Additional comments — for the calibration team only</span>
            <RichTextEditor value={comments} onChange={setComments} minHeight={60} placeholder="Context the calibration team should know" /></div>
        </div>
        <FormActions busy={busy} onDraft={() => save(true)} onSubmit={() => save(false)} submitLabel="Submit manager review"
          submitDisabled={!selfIn}
          hint={selfIn
            ? 'A draft is visible only to you. It goes to calibration once you submit.'
            : 'The self-review isn’t in yet — save a draft now; you can submit once they submit theirs.'} />
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
      <div style={cardHead}>Calibration (super admin · internal)</div>
      <div style={{ padding: 14 }}>
        <RatingMeter self={a.self_overall_rating} manager={a.manager_overall_rating} final={fr ? Number(fr) : null} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 14 }}>
          <RatingPick label="Final rating" value={fr} onChange={setFr} />
          <div style={{ flex: 1, minWidth: 220 }}><span style={lbl}>Calibration note (never shown to the employee)</span>
            <input value={note} onChange={e => setNote(e.target.value)} style={{ ...ta, height: 'auto', padding: '7px 10px' }} /></div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={{ ...btnS }} disabled={busy || locked || !!a.comp_locked_at} title={a.comp_locked_at ? 'Compensation is locked in — the final rating is fixed' : undefined} onClick={finalize}>{a.final_rating ? 'Update final' : 'Finalize'}</button>
          <button style={{ ...btnP }} disabled={busy || !a.final_rating || a.status === 'shared' || a.status === 'acknowledged'} onClick={share}>Share with employee</button>
        </div>
        {a.outcome === 'pip' && <p style={{ fontSize: 12, color: 'var(--state-error-fg)', marginTop: 8 }}>Final rating triggers a PIP.</p>}
      </div>
    </div>
  );
}

// ── Rating meter: self vs manager vs final on the 1–5 scale ──
function RatingMeter({ self, manager, final }) {
  const marks = [['Self', self, 'var(--text-3)'], ['Manager', manager, 'var(--state-warning-fg)'], ['Final', final, 'var(--podium-accent)']].filter(m => m[1]);
  const x = (r) => `${((r - 1) / 4) * 100}%`;
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={lbl}>Rating meter</span>
      <div style={{ position: 'relative', height: 44, margin: '0 14px' }}>
        <div style={{ position: 'absolute', top: 20, left: 0, right: 0, height: 4, borderRadius: 2, background: 'linear-gradient(90deg, var(--state-error-fg), var(--state-warning-fg), var(--state-success-fg))', opacity: 0.55 }} />
        {[1, 2, 3, 4, 5].map(n => <div key={n} style={{ position: 'absolute', top: 30, left: x(n), transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-3)' }}>{n}</div>)}
        {marks.map(([label, r, color], i) => (
          <div key={label} title={`${label}: ${r} ${RATING_LABELS[r] || ''}`} style={{ position: 'absolute', top: i === 2 ? 14 : 16, left: x(r), transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: i === 2 ? 16 : 12, height: i === 2 ? 16 : 12, borderRadius: '50%', background: color, border: '2px solid var(--surface)', boxShadow: '0 0 0 1px var(--border)' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--text-2)', flexWrap: 'wrap' }}>
        {[['Self', self, 'var(--text-3)'], ['Manager', manager, 'var(--state-warning-fg)'], ['Final', final, 'var(--podium-accent)']].map(([l, r, c]) => (
          <span key={l}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: c, marginRight: 5 }} />{l} {r ? `${r} · ${RATING_LABELS[r]}` : '—'}</span>
        ))}
      </div>
    </div>
  );
}

// ── Calibrated compensation: draft → accept/override → lock in (spec §2–3) ──
function CompPanel({ a, session, onSaved }) {
  const { showToast } = useToast();
  const [pct, setPct] = useState(a.calibrated_increment_pct ?? '');
  const [bonus, setBonus] = useState(a.calibrated_bonus ?? '');
  const [busy, setBusy] = useState(false);
  const locked = !!a.comp_locked_at;
  const recPct = a.manager_suggested_increment_pct, recBonus = a.manager_suggested_bonus;
  const hasRec = !!a.manager_submitted_at && (recPct != null || recBonus != null);
  const cur = a.current_ctc != null ? Number(a.current_ctc) : null;
  const newCtc = cur != null && pct !== '' && Number.isFinite(Number(pct)) ? Math.round(cur * (1 + Number(pct) / 100)) : cur;
  const dirty = String(pct) !== String(a.calibrated_increment_pct ?? '') || String(bonus) !== String(a.calibrated_bonus ?? '');
  async function run(action, data, msg) {
    setBusy(true);
    try { const r = await podiumopsPost(action, { data }, session); showToast(typeof msg === 'function' ? msg(r) : msg, 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  const save = () => run('saveCalibratedComp', { appraisal_id: a.id, calibrated_increment_pct: pct === '' ? null : Number(pct), calibrated_bonus: bonus === '' ? null : Number(bonus) }, 'Saved as draft');
  const accept = () => run('acceptManagerRecommendation', { appraisal_id: a.id }, 'Manager’s recommendation accepted');
  function lock() {
    if (dirty) { showToast('Save your changes first', 'error'); return; }
    const parts = [a.calibrated_increment_pct != null ? `${a.calibrated_increment_pct}% increment` : null, a.calibrated_bonus ? `${fmtMoney(a.calibrated_bonus)} one-time bonus` : null].filter(Boolean).join(' + ') || 'no change';
    if (!window.confirm(`Lock in ${parts} for ${a.employee?.full_name}? This writes it to their compensation record permanently.`)) return;
    run('lockAppraisalComp', { appraisal_id: a.id }, r => (r.locked ? 'Locked in' : `Not locked — ${r.skipped?.[0]?.reason || 'skipped'}`));
  }
  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={cardHead}>Increment + one-time bonus {locked ? <span style={{ color: 'var(--state-success-fg)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· locked {fmtDate(a.comp_locked_at)}</span> : <span style={{ color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· draft until locked in</span>}</div>
      <div style={{ padding: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 12 }}>
          <Stat label="Current CTC" value={cur != null ? fmtMoney(cur) : 'not on record'} />
          <Stat label="Manager recommends" value={hasRec ? [recPct != null ? `${recPct}%` : null, recBonus != null ? `${fmtMoney(recBonus)} OTB` : null].filter(Boolean).join(' + ') : (a.manager_submitted_at ? 'nothing' : 'review not submitted')} />
          <Stat label="New CTC" value={newCtc != null ? fmtMoney(newCtc) : '—'} accent={newCtc != null && cur != null && newCtc !== cur} />
        </div>
        {a.manager_recommendation_note && <div style={{ marginBottom: 12 }}><span style={lbl}>Manager’s recommendation comment</span><RichTextView value={a.manager_recommendation_note} title="Recommendation comment" clamp={90} /></div>}
        {locked ? (
          <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            Locked: {a.calibrated_increment_pct != null ? `${a.calibrated_increment_pct}%` : 'no increment'}{a.calibrated_bonus ? ` + ${fmtMoney(a.calibrated_bonus)} one-time bonus` : ''}
            {a.increment?.new_ctc != null ? ` · CTC ${fmtMoney(a.increment.old_ctc)} → ${fmtMoney(a.increment.new_ctc)}` : ''} · effective {fmtDate(a.increment?.effective_date || a.cycle?.appraisal_date)}.
            To change it now, add a correction on their compensation record.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div><span style={lbl}>Calibrated increment %</span><input value={pct} onChange={e => setPct(e.target.value)} type="number" min="0" max="100" step="0.5" style={{ ...miniInput, width: 110 }} /></div>
              <div><span style={lbl}>Calibrated one-time bonus (₹)</span><input value={bonus} onChange={e => setBonus(e.target.value)} type="number" min="0" step="1000" style={{ ...miniInput, width: 150 }} /></div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
                <button style={btnS} disabled={busy || !hasRec} onClick={accept} title="Copy the manager's increment + bonus into the calibrated values">Accept manager’s</button>
                <button style={btnS} disabled={busy || !dirty} onClick={save}>Save override</button>
                <button style={btnP} disabled={busy || dirty || !a.final_rating || (a.calibrated_increment_pct == null && a.calibrated_bonus == null)} onClick={lock}><Lock size={12} /> Lock in</button>
              </div>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
              Saved values stay a draft and feed the cycle budget. Lock in writes them to the compensation record, effective {fmtDate(a.cycle?.appraisal_date)}{!a.final_rating ? ' — set the final rating first' : ''}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return <div><span style={lbl}>{label}</span><div style={{ fontSize: 15, fontWeight: 700, color: accent ? 'var(--state-success-fg)' : 'var(--text-1)' }}>{value}</div></div>;
}

// A super admin can let the manager submit without the self-review (one appraisal).
function WaiveSelf({ a, session, onSaved }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const waived = !!a.self_review_waived_at;
  async function toggle() {
    if (!waived && !window.confirm(`Let ${a.manager?.full_name || 'the manager'} submit ${a.employee?.full_name}'s review without a self-review?`)) return;
    setBusy(true);
    try { await podiumopsPost('waiveSelfReview', { data: { appraisal_id: a.id, waived: !waived } }, session); showToast(waived ? 'Self-review required again' : 'Manager can now submit', 'success'); onSaved(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={{ ...card, marginBottom: 14, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-2)' }}>
        {waived ? `Self-review waived ${fmtDate(a.self_review_waived_at)} — the manager can submit without it.` : 'No self-review yet, so the manager can only save a draft.'}
      </span>
      <button style={btnS} disabled={busy} onClick={toggle}>{waived ? <><Lock size={12} /> Require self-review</> : <><Unlock size={12} /> Let manager submit</>}</button>
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
          <div key={t} style={{ marginBottom: 10 }}><div style={lbl}>{t}</div><RichTextView value={val} title={t} /></div>
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

function ReadBlock({ title, overall, prompts, vals, submitted, extra }) {
  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={cardHead}>{title} {submitted ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· {fmtDate(submitted)}</span> : <span style={{ fontSize: 11, color: 'var(--state-warning-fg)' }}>· not submitted</span>}</div>
      <div style={{ padding: 14 }}>
        <div style={{ marginBottom: 10 }}><span style={lbl}>Overall</span> <span style={{ fontWeight: 700, color: ratingColor(overall) }}>{overall || '—'} {overall ? RATING_LABELS[overall] : ''}</span></div>
        {(prompts || []).map((p, i) => vals[i] && <div key={i} style={{ marginBottom: 10 }}><div style={lbl}>{p}</div><RichTextView value={vals[i]} title={`${title} — ${p}`} /></div>)}
        {extra}
      </div>
    </div>
  );
}

// A saved draft seeds the form. Submitting clears the draft, so a draft that exists is always
// newer than the submitted review.
function seedForm(a, side) {
  const d = a[`${side}_draft`];
  const text = (k) => d ? (d[k] ?? '') : (a[`${side}_${k}`] || '');
  const col = `${side}_rating`;
  const kpis = (a.kpis || []).map(k => {
    const r = d?.kpi_ratings?.find(x => x.id === k.id);
    return r ? { ...k, [col]: r.rating } : k;
  });
  return { ov: d ? (d.overall_rating || '') : (a[`${side}_overall_rating`] || ''), v: [text('did_well'), text('improve'), text('focus')], kpis };
}

function DraftStatus({ submittedAt, draftAt }) {
  const parts = [];
  if (submittedAt) parts.push(<span key="s" style={{ color: 'var(--state-success-fg)' }}>submitted {fmtDate(submittedAt)} — editable while open</span>);
  if (draftAt) parts.push(<span key="d" style={{ color: 'var(--state-warning-fg)' }}>{submittedAt ? 'unsubmitted changes' : 'draft'} saved {fmtDate(draftAt)}</span>);
  if (!parts.length) return null;
  return <span style={{ fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{parts.reduce((acc, p, i) => i ? [...acc, ' · ', p] : [p], [])}</span>;
}

function FormActions({ busy, onDraft, onSubmit, submitLabel, hint, submitDisabled = false }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <span style={{ flex: 1, minWidth: 200, fontSize: 11.5, color: 'var(--text-3)' }}>{hint}</span>
      <button style={{ ...btnS, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={onDraft}>Save draft</button>
      <button style={{ ...btnP, opacity: busy || submitDisabled ? 0.5 : 1, cursor: submitDisabled ? 'not-allowed' : 'pointer' }} disabled={busy || submitDisabled} onClick={onSubmit}>{busy ? 'Saving…' : submitLabel}</button>
    </div>
  );
}

function CalibrateLink({ id }) {
  return <div style={{ marginTop: 12 }}><a href={`/appraisals/detail/?id=${id}`} style={linkBtn}>Calibration (super admin) →</a></div>;
}

// Manager's recommendation + internal comments. The worker nulls these for anyone but the
// reviewing manager and super admins, so absent fields simply don't render.
function Recommendation({ a }) {
  const has = a.manager_suggested_increment_pct != null || a.manager_suggested_bonus != null || a.manager_recommendation_note || a.manager_comments;
  if (!has) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ ...lbl, color: 'var(--text-2)' }}>Recommendation · internal</div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, marginBottom: 6 }}>
        <span>Increment <strong>{a.manager_suggested_increment_pct != null ? `${a.manager_suggested_increment_pct}%` : '—'}</strong></span>
        <span>One-time bonus <strong>{a.manager_suggested_bonus != null ? fmtMoney(a.manager_suggested_bonus) : '—'}</strong></span>
      </div>
      {a.manager_recommendation_note && <div style={{ marginBottom: 8 }}><div style={lbl}>Recommendation comment</div><RichTextView value={a.manager_recommendation_note} title="Recommendation comment" clamp={120} /></div>}
      {a.manager_comments && <div><div style={lbl}>Additional comments (calibration team only)</div><RichTextView value={a.manager_comments} title="Additional comments" clamp={120} /></div>}
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
