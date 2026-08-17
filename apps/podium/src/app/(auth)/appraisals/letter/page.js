'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Printer } from 'lucide-react';
import { podiumopsGet } from '../../../../lib/podiumopsFetch.js';
import { RATING_LABELS } from '../../../../lib/appraisals.js';
import { fmtDate } from '../../../../lib/format.js';
import { todayStr } from '@throttle/domain';

export default function Page() {
  return <Suspense fallback={<Spinner />}><LetterPage /></Suspense>;
}

function LetterPage() {
  const sp = useSearchParams();
  const id = sp.get('id');
  const type = sp.get('type') || 'appraisal';
  const { session } = useAuth();
  const [a, setA] = useState(null);

  useEffect(() => {
    if (!session || !id) return;
    podiumopsGet('getAppraisal', { id }, session).then(setA).catch(() => setA(false));
  }, [session, id]);

  if (a === false) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Could not load.</div>;
  if (!a) return <Spinner />;

  const name = a.employee?.full_name || '';
  const role = a.employee?.job_title || '';
  const dept = a.employee?.department?.name || '';
  const isIncrement = type === 'increment';

  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="noprint" style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        <button onClick={() => window.print()} style={btn}><Printer size={14} /> Print / Save as PDF</button>
      </div>

      <div className="letter">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.04em' }}>LEGEND OF TOYS</div>
          <div style={{ fontSize: 12, color: '#555' }}>{isIncrement ? 'Salary Revision Letter' : 'Performance Appraisal'}</div>
        </div>

        <p style={p}>Date: {fmtDate(a.shared_at) || fmtDate(todayStr())}</p>
        <p style={p}><b>{name}</b>{role ? `, ${role}` : ''}{dept ? ` — ${dept}` : ''}</p>

        {!isIncrement ? (
          <>
            <p style={p}>This letter summarises your performance appraisal for the period <b>{fmtDate(a.review_period_start)} to {fmtDate(a.review_period_end)}</b> ({a.cycle?.name}).</p>
            <p style={p}>Overall rating: <b>{a.final_rating} — {RATING_LABELS[a.final_rating]}</b>{a.outcome === 'pip' ? ' (Performance Improvement Plan to follow)' : ''}.</p>
            {a.manager_did_well && <Section t="What went well" v={a.manager_did_well} />}
            {a.manager_improve && <Section t="What could have gone better" v={a.manager_improve} />}
            {a.manager_focus && <Section t="Focus for the next period" v={a.manager_focus} />}
            {a.increment && <p style={p}>A salary revision of <b>{a.increment.increment_pct != null ? `${a.increment.increment_pct}%` : ''}</b>{a.increment.amount ? ` with a one-time bonus of ₹${a.increment.amount}` : ''} is effective <b>{fmtDate(a.increment.effective_date)}</b>.</p>}
          </>
        ) : (
          <>
            <p style={p}>Following your performance appraisal for {a.cycle?.name}, we are pleased to confirm the following revision, effective <b>{fmtDate(a.increment?.effective_date)}</b>:</p>
            <ul style={{ margin: '0 0 12px 18px' }}>
              {a.increment?.increment_pct != null && <li style={p}>Increment: <b>{a.increment.increment_pct}%</b></li>}
              {a.increment?.amount ? <li style={p}>One-time bonus: <b>₹{a.increment.amount}</b></li> : null}
            </ul>
            <p style={p}>This revision reflects your overall rating of <b>{a.final_rating} — {RATING_LABELS[a.final_rating]}</b> and will be reflected in your payroll from the effective month.</p>
          </>
        )}

        <p style={{ ...p, marginTop: 32 }}>With appreciation,</p>
        <p style={p}>Legend of Toys — People &amp; Performance</p>
      </div>
    </div>
  );
}

function Section({ t, v }) {
  return <div style={{ marginBottom: 10 }}><div style={{ fontWeight: 700, fontSize: 13 }}>{t}</div><div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{v}</div></div>;
}

const p = { fontSize: 13.5, lineHeight: 1.7, margin: '0 0 10px', color: '#111' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' };

const PRINT_CSS = `
.letter { background: #fff; color: #111; max-width: 720px; margin: 0 auto; padding: 48px 56px;
  border-radius: 6px; box-shadow: 0 0 0 1px var(--border); font-family: Georgia, 'Times New Roman', serif; }
@media print {
  .noprint { display: none !important; }
  /* Plain <style> tag: :global() is CSS-modules syntax and invalidates the whole rule,
     so the old aside/nav/header hide never applied. */
  aside, nav, header { display: none !important; }
  /* The root clip: globals.css sets html/body height:100%/overflow:hidden and the
     (auth) shell wrappers pin height:100dvh inline, so anything past page 1 is cut. */
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body div { height: auto !important; overflow: visible !important; }
  main { padding: 0 !important; }
  .letter { box-shadow: none; padding: 0; max-width: none; }
}
`;
