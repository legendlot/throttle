'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, istToday, istDaysAgo } from '../../../lib/api.js';

const numfmt = n => Number(n || 0).toLocaleString('en-IN');
const inr = n => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');

export default function FunnelPage() {
  const { session } = useAuth();
  const [from, setFrom] = useState(istDaysAgo(30));
  const [to, setTo] = useState(istToday());
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
  const sessions = sum('sessions'), atc = sum('add_to_carts'), checkouts = sum('checkouts'), purchases = sum('purchases');
  const cr = sessions > 0 ? (purchases / sessions * 100) : 0;

  const KPIS = [
    { lbl: 'Sessions', val: numfmt(sessions) },
    { lbl: 'Add to cart', val: numfmt(atc) },
    { lbl: 'Checkouts', val: numfmt(checkouts) },
    { lbl: 'Purchases', val: numfmt(purchases) },
    { lbl: 'Conv. rate', val: cr.toFixed(2) + '%' },
    { lbl: 'Revenue', val: inr(sum('conv_value')) },
  ];

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="so-input" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <input className="so-input" type="date" value={to} min={from} max={istToday()} onChange={e => setTo(e.target.value)} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>GA4 · Website</span>
      </div>

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      {!rows ? <Spinner /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
            {KPIS.map((k, i) => (
              <div key={i} className="so-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="so-kpi-lbl">{k.lbl}</div>
                <span className="so-kpi-val">{k.val}</span>
              </div>
            ))}
          </div>

          <div className="so-card">
            <div className="so-kpi-lbl">By traffic source</div>
            <table className="so-table" style={{ marginTop: 10 }}>
              <thead><tr>
                <th>Source</th><th className="so-num">Sessions</th><th className="so-num">Add to cart</th>
                <th className="so-num">Checkouts</th><th className="so-num">Purchases</th><th className="so-num">Conv. rate</th>
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 14 }}>No traffic in this range yet — connector may still be backfilling.</td></tr>}
                {rows.map((r, i) => {
                  const s = Number(r.sessions || 0), p = Number(r.purchases || 0);
                  return (<tr key={i}>
                    <td>{r.src_group || '—'}</td>
                    <td className="so-num">{numfmt(r.sessions)}</td>
                    <td className="so-num">{numfmt(r.add_to_carts)}</td>
                    <td className="so-num">{numfmt(r.checkouts)}</td>
                    <td className="so-num">{numfmt(r.purchases)}</td>
                    <td className="so-num">{s > 0 ? (p / s * 100).toFixed(2) + '%' : '—'}</td>
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
