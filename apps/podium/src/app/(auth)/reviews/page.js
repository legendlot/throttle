'use client';
// Reviews — everyone's appraisal task list for the OPEN cycle(s) (S396):
//   1. your own self-appraisal (status + open/edit), and
//   2. the direct reports you must review — a task drops off the list once you submit it (a saved
//      draft keeps it on the list, marked "Continue")
//      (it stays reachable under "Submitted" and editable until HR shares the result).
// No open cycle → says so. HR's cycle admin stays on /appraisals.
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { ChevronRight, CheckCircle2, ClipboardList } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../lib/format.js';
import { card, cardLabel, btnPrimary, btnGhost } from '../../../components/ui.js';

export default function ReviewsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getMyAppraisals', {}, session).then(setD).catch(e => { setErr(e.message || 'Failed to load'); setD(false); });
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (d == null) return <Spinner />;
  if (d === false) return <Empty text={`Couldn't load your reviews — ${err}`} />;

  const cycles = d.active_cycles || [];
  if (!cycles.length) return <Empty text="No appraisal cycle open." />;

  const go = (id) => router.push(`/reviews/review/?id=${id}`);
  return (
    <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 22 }}>
      {cycles.map(c => (
        <CycleBlock key={c.id} c={c} linked={!!d.employee_id}
          mine={(d.appraisals || []).filter(a => a.cycle?.id === c.id)}
          reports={(d.to_review || []).filter(r => r.cycle?.id === c.id)}
          go={go} />
      ))}
    </div>
  );
}

function CycleBlock({ c, linked, mine, reports, go }) {
  const [showDone, setShowDone] = useState(false);
  const pending = reports.filter(r => !r.done);
  const done = reports.filter(r => r.done);
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>{c.name}</h2>
        <span style={{ fontSize: 12, color: 'var(--t3)' }}>
          {c.period_start && c.period_end ? `period ${fmtDate(c.period_start)} → ${fmtDate(c.period_end)}` : ''}
        </span>
      </div>

      {/* 1 — your own self-appraisal */}
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={cardLabel}>Your self-appraisal{c.self_review_due ? ` · due ${fmtDate(c.self_review_due)}` : ''}</div>
        {!linked && <Muted>Your login isn&apos;t linked to an employee profile yet — ask HR to set one up.</Muted>}
        {linked && !mine.length && <Muted>You aren&apos;t enrolled in this cycle.</Muted>}
        {mine.map(a => <SelfRow key={a.id} a={a} go={go} />)}
      </div>

      {/* 2 — the reports you review (only if you have any in this cycle) */}
      {reports.length > 0 && (
        <div style={card}>
          <div style={cardLabel}>
            Your team · {done.length} of {reports.length} submitted · {pending.length} pending{c.manager_review_due ? ` · due ${fmtDate(c.manager_review_due)}` : ''}
          </div>
          {pending.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--state-success-fg)' }}>
              <CheckCircle2 size={15} /> All {reports.length} manager review{reports.length === 1 ? '' : 's'} submitted.
            </div>
          )}
          {pending.map(r => (
            <Row key={r.id} onClick={() => go(r.id)}
              title={r.employee?.full_name} sub={r.employee?.job_title}
              note={`${r.self_submitted ? 'self-review in — ready for you' : r.self_waived ? 'self-review waived — you can submit' : 'self-review not in yet — you can save a draft'}${r.draft_saved_at ? ` · your draft saved ${fmtDate(r.draft_saved_at)}` : ''}`}
              noteColor={r.draft_saved_at ? 'var(--state-warning-fg)' : (r.self_submitted || r.self_waived) ? 'var(--state-success-fg)' : 'var(--t4)'}
              action={<span style={{ ...btnPrimary }}>{r.draft_saved_at ? 'Continue' : 'Review'} <ChevronRight size={13} /></span>} />
          ))}
          {done.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setShowDone(v => !v)} style={{ background: 'none', border: 'none', color: 'var(--t3)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                {showDone ? '▾' : '▸'} Submitted ({done.length}) — editable until HR shares the result
              </button>
              {showDone && done.map(r => (
                <Row key={r.id} onClick={() => go(r.id)} dim
                  title={r.employee?.full_name} sub={r.employee?.job_title}
                  note={`submitted ${fmtDate(r.manager_submitted_at)}${r.draft_saved_at ? ' · unsubmitted changes saved' : ''}`}
                  noteColor={r.draft_saved_at ? 'var(--state-warning-fg)' : 'var(--t4)'}
                  action={<span style={btnGhost}>Open</span>} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SelfRow({ a, go }) {
  const shared = a.status === 'shared' || a.status === 'acknowledged';
  const draft = !shared && a.self_draft_saved_at;
  const note = shared ? 'your result is ready'
    : a.self_submitted_at ? `submitted ${fmtDate(a.self_submitted_at)} — editable while the cycle is open${draft ? ' · unsubmitted changes saved' : ''}`
    : draft ? `draft saved ${fmtDate(a.self_draft_saved_at)} — not submitted yet`
    : 'not started';
  return (
    <Row onClick={() => go(a.id)} title="Self-review" sub={null} note={note}
      noteColor={draft ? 'var(--state-warning-fg)' : shared || a.self_submitted_at ? 'var(--state-success-fg)' : 'var(--state-warning-fg)'}
      action={<span style={a.self_submitted_at && !shared && !draft ? btnGhost : btnPrimary}>
        {shared ? 'View result' : draft ? 'Continue' : a.self_submitted_at ? 'Edit' : 'Start'} <ChevronRight size={13} />
      </span>} />
  );
}

function Row({ title, sub, note, noteColor, action, onClick, dim }) {
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)', cursor: 'pointer', opacity: dim ? 0.75 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{title}{sub && <span style={{ fontWeight: 400, color: 'var(--t3)', fontSize: 12 }}> · {sub}</span>}</div>
        <div style={{ fontSize: 12, color: noteColor }}>{note}</div>
      </div>
      {action}
    </div>
  );
}

function Muted({ children }) { return <div style={{ fontSize: 13, color: 'var(--t3)' }}>{children}</div>; }

function Empty({ text }) {
  return (
    <div style={{ ...card, maxWidth: 820, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--t2)', fontSize: 14 }}>
      <ClipboardList size={18} color="var(--t3)" /> {text}
    </div>
  );
}
