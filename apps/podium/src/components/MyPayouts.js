'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Wallet } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';
import { fmtINR, payoutTypeLabel, periodLabel } from '../lib/payouts.js';

// Own payouts only (getMyPayouts is parameter-less + self-scoped in the worker).
export default function MyPayouts() {
  const { session } = useAuth();
  const [d, setD] = useState(null);
  useEffect(() => { if (session) podiumopsGet('getMyPayouts', {}, session).then(setD).catch(() => setD(false)); }, [session]);
  if (!d || d === false || !d.payouts?.length) return null;
  return (
    <div style={card}>
      <div style={cardTitle}><Wallet size={14} /> My Payouts</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {d.payouts.map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <span>{payoutTypeLabel(p.payout_type)}{p.period_key ? ' · ' + periodLabel(p.period_key) : ''}{p.achievement_pct != null ? ` · ${p.achievement_pct}%` : ''}</span>
            <span className="num" style={{ color: 'var(--t1)' }}>{fmtINR(p.amount)}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>Only you and authorised Finance can see this.</p>
    </div>
  );
}
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
