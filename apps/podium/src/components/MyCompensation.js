'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Lock } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';

// Own-salary view. Calls getMyCompensation (parameter-less, self-scoped in the worker),
// so it can never show anyone else's pay. Renders nothing until loaded; hidden if the
// employee has no recorded compensation.
export default function MyCompensation() {
  const { session } = useAuth();
  const [d, setD] = useState(null);

  useEffect(() => {
    if (session) podiumopsGet('getMyCompensation', {}, session).then(setD).catch(() => setD(false));
  }, [session]);

  if (!d || d === false) return null;
  if (!d.events?.length && d.current_ctc == null) return null;

  const fmt = (n) => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'));
  return (
    <div style={card}>
      <div style={cardTitle}><Lock size={14} /> My Compensation</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--t3)' }}>Current CTC</span>
        <span className="num" style={{ fontSize: 20, fontWeight: 700, color: 'var(--t1)' }}>{fmt(d.current_ctc)}</span>
      </div>
      {d.events?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {d.events.map((e) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span>{e.event_type}{e.effective_date ? ' · ' + e.effective_date : ''}</span>
              <span className="num">{e.increment_pct != null ? '+' + e.increment_pct + '%' : ''} {e.new_ctc != null ? fmt(e.new_ctc) : (e.amount != null ? fmt(e.amount) : '')}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>Only you and authorised Finance can see this. Nobody else can view your salary.</p>
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
