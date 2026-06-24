'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, fmtInt, inr, rangePresets } from '../../../lib/api.js';
import { RangePicker } from '../../../components/kit.js';

const numfmt = n => Number(n || 0).toLocaleString('en-IN');
const pctOf = (n, d) => (d > 0 ? (n / d * 100) : 0);

// Stepped conversion funnel: each stage's bar is sized to its share of Sessions, with the
// step-to-step conversion rate called out between stages. The drop-off is the story.
function Funnel({ steps }) {
  const top = steps[0]?.value || 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {steps.map((s, i) => {
        const share = top > 0 ? (s.value / top) * 100 : 0;
        const stepConv = i > 0 ? pctOf(s.value, steps[i - 1].value) : null;
        return (
          <div key={s.key}>
            {i > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 2px 4px' }}>
                <span style={{ color: 'var(--t3)', fontSize: 13 }}>↳</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: stepConv >= 50 ? 'var(--green)' : stepConv >= 20 ? 'var(--amber)' : 'var(--t2)' }}>
                  {stepConv.toFixed(1)}%
                </span>
                <span className="so-sub" style={{ fontSize: 11 }}>continue to {s.label.toLowerCase()}</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 96, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t2)', textAlign: 'right' }}>{s.label}</div>
              <div style={{ flex: 1, position: 'relative', height: 38, background: 'var(--surface2)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, transformOrigin: 'left', transform: `scaleX(${Math.max(share, 0) / 100})`, background: `linear-gradient(90deg, ${s.color}, color-mix(in srgb, ${s.color} 65%, transparent))`, borderRadius: 8, transition: 'transform .45s cubic-bezier(.22,1,.36,1)' }} />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 13px' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{numfmt(s.value)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{share.toFixed(0)}%</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function FunnelPage() {
  const { session } = useAuth();
  const d30 = rangePresets().find(p => p.key === '30d');
  const [from, setFrom] = useState(d30.from);
  const [to, setTo] = useState(d30.to);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setErr('');
    salesGet('getTraffic', { from, to }, session)
      .then(t => setRows(t?.rows || []))
      .catch(e => setErr(e.message || String(e)));
  }, [session, from, to]);

  const sum = k => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
  const sessions = sum('sessions'), atc = sum('add_to_carts'), checkouts = sum('checkouts'), purchases = sum('purchases'), revenue = sum('conv_value');
  const cr = pctOf(purchases, sessions);

  const steps = [
    { key: 'sessions',  label: 'Sessions',  value: sessions,  color: '#F2CD1A' },
    { key: 'atc',       label: 'Add to cart', value: atc,      color: '#F59E0B' },
    { key: 'checkouts', label: 'Checkout',  value: checkouts, color: '#FF7A1A' },
    { key: 'purchases', label: 'Purchase',  value: purchases, color: '#34D27B' },
  ];

  const topRows = [...(rows || [])].sort((a, b) => Number(b.sessions || 0) - Number(a.sessions || 0));

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<span className="so-sub">GA4 · Website</span>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          {/* funnel viz + headline conversion */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(220px,1fr)', gap: 14 }}>
            <div className="so-card">
              <div className="so-kpi-lbl" style={{ marginBottom: 16 }}>Conversion funnel</div>
              {sessions === 0
                ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '28px 0', textAlign: 'center' }}>No traffic in this range yet.</div>
                : <Funnel steps={steps} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                <div className="so-kpi-lbl">Overall conversion</div>
                <span className="so-kpi-val" style={{ fontSize: 34, color: 'var(--green)' }}>{cr.toFixed(2)}%</span>
                <span className="so-sub" style={{ fontSize: 11 }}>sessions → purchase</span>
              </div>
              <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                <div className="so-kpi-lbl">Revenue</div>
                <span className="so-kpi-val" style={{ fontSize: 26 }}>{inr(revenue)}</span>
                <span className="so-sub" style={{ fontSize: 11 }}>GA4 purchase value</span>
              </div>
            </div>
          </div>

          {/* by source */}
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>By traffic source</div>
            <table className="so-table" style={{ marginTop: 8 }}>
              <thead><tr>
                <th>Source</th><th className="so-num">Sessions</th><th className="so-num">Add to cart</th>
                <th className="so-num">Checkouts</th><th className="so-num">Purchases</th><th className="so-num">Conv. rate</th>
              </tr></thead>
              <tbody>
                {topRows.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 14 }}>No traffic in this range yet — connector may still be backfilling.</td></tr>}
                {topRows.map((r, i) => {
                  const s = Number(r.sessions || 0), pu = Number(r.purchases || 0);
                  return (<tr key={i}>
                    <td>{r.src_group || '—'}</td>
                    <td className="so-num">{numfmt(r.sessions)}</td>
                    <td className="so-num">{numfmt(r.add_to_carts)}</td>
                    <td className="so-num">{numfmt(r.checkouts)}</td>
                    <td className="so-num">{numfmt(r.purchases)}</td>
                    <td className="so-num">{s > 0 ? (pu / s * 100).toFixed(2) + '%' : '—'}</td>
                  </tr>);
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
