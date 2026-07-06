'use client';
import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';
import { fmtINR, payoutTypeLabel, periodLabel } from '../lib/payouts.js';

// A person's full payout history. Self-hides unless the caller is comp (worker 403s).
export default function PayoutsPanel({ employeeId, session }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (session && employeeId) podiumopsGet('getPayouts', { employee_id: employeeId }, session).then(setD).catch(() => setD(false));
  }, [session, employeeId]);
  if (d === false || d === null) return null;
  const rows = d.payouts || [];
  return (
    <div style={card}>
      <div style={cardTitle}><Wallet size={14} /> Payouts</div>
      {rows.length === 0 ? <div style={{ color: 'var(--t3)', fontSize: 13 }}>No payouts recorded.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span>{payoutTypeLabel(p.payout_type)}{p.period_key ? ' · ' + periodLabel(p.period_key) : ''}{p.achievement_pct != null ? ` · ${p.achievement_pct}%` : ''}{p.paid_on ? ` · paid ${p.paid_on}` : ''}</span>
              <span className="num" style={{ color: 'var(--t1)' }}>{fmtINR(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
