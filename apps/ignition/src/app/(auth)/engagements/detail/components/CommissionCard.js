'use client';
import { monthLabel, reasonRequired } from '../../../../../lib/commission.js';
import { CommissionBadge } from '../../../../../components/CommissionBadge.js';
import { Card } from './shared.js';

// Monthly affiliate commission on this deal (Reann #3, S3) — affiliate / paid + affiliate deals only.
// The page loads getCommissionStatements?engagement_id= once and shares it with the Payments card
// (which labels commission requests by month). `commission` = { statements } | { error } | null (loading).
const inr = n => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const istDay = d => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function CommissionCard({ commission, rate, onRetry }) {
  const statements = commission?.statements || [];
  return (
    <Card title="Commission">
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, paddingBottom: 6 }}>
        {rate != null ? `${Number(rate)}% of the code's sales each month. ` : ''}
        The code&apos;s &ldquo;commission&rdquo; figure elsewhere is a running total; the month D2C verifies is what is paid.
      </div>
      {commission?.error ? (
        <div style={{ fontSize: 13, color: 'var(--state-error-fg)', padding: '4px 0' }}>
          Could not load commission: {commission.error}{' '}
          <button type="button" className="ig-card-action" onClick={onRetry} style={{ color: 'var(--accent-hi)', fontSize: 13 }}>Retry</button>
        </div>
      ) : !commission ? (
        <div style={{ fontSize: 13, color: 'var(--text-4)', padding: '4px 0' }}>Loading…</div>
      ) : statements.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-4)', padding: '4px 0 8px', lineHeight: 1.5 }}>
          No commission months yet. Ignition works out each month&apos;s commission from the code&apos;s sales, net of returns and GST.
        </div>
      ) : statements.map(s => {
        const verified = s.state === 'verified';
        const diff = verified && reasonRequired(s.verified_amount, s.estimate);
        return (
          <div key={s.id} style={{ padding: '8px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
            <div style={rowLine}>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{monthLabel(s.month)}{s.month_open ? <span style={{ color: 'var(--text-4)', fontWeight: 400 }}> · so far</span> : null}</span>
              <CommissionBadge statement={s} />
            </div>
            <div style={detail}>
              {s.orders} order{s.orders === 1 ? '' : 's'} · net sales {inr(s.net_sales)} · Ignition estimate <span style={mono}>{inr(s.estimate)}</span>
            </div>
            {verified && (
              <div style={detail}>
                D2C verified <span style={{ ...mono, fontWeight: 700, color: diff ? 'var(--state-warning-fg)' : 'var(--text-1)' }}>{inr(s.verified_amount)}</span>
                {' '}· {s.verified_by_name || '—'}{s.verified_at ? `, ${istDay(s.verified_at)}` : ''}
              </div>
            )}
            {verified && s.difference_reason && <div style={detail}>Reason: {s.difference_reason}</div>}
          </div>
        );
      })}
    </Card>
  );
}

const rowLine = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' };
const detail = { fontSize: 12, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5, overflowWrap: 'anywhere' };
const mono = { fontFamily: 'var(--font-mono)' };
