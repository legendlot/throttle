'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, fmtInt, inr, rangePresets } from '../../../lib/api.js';
import { RangePicker } from '../../../components/kit.js';

const numfmt = n => Number(n || 0).toLocaleString('en-IN');
const pctOf = (n, d) => (d > 0 ? (n / d * 100) : 0);
const fmtPct = n => `${+Number(n || 0).toFixed(2)}%`;   // up to 2 decimals, no trailing zeros

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
                  {fmtPct(stepConv)}
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
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{fmtPct(share)}</span>
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
  const mtd = rangePresets().find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [rows, setRows] = useState(null);
  const [pay, setPay] = useState(null);   // { funnel, recon } — checkout payment funnel (Razorpay)
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setPay(null); setErr('');
    salesGet('getTraffic', { from, to }, session)
      .then(t => setRows(t?.rows || []))
      .catch(e => setErr(e.message || String(e)));
    salesGet('getPaymentFunnel', { from, to }, session)
      .then(p => setPay(p || {}))
      .catch(() => setPay({}));   // soft — payment section just shows empty if it fails
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

          {/* ── Checkout & payment funnel (Razorpay) ── */}
          {(() => {
            const f = (pay && pay.funnel) || {}, rc = (pay && pay.recon) || {};
            const attempts = Number(f.attempts || 0), captured = Number(f.captured || 0), failed = Number(f.failed || 0);
            const sr = Number(f.success_rate || 0), capAmt = Number(f.captured_amount || 0), cod = Number(f.cod_orders || 0);
            const byMethod = f.by_method || {}, byReason = f.by_failure_reason || {};
            const methods = Object.entries(byMethod).sort((a, b) => (Number(b[1].attempts) || 0) - (Number(a[1].attempts) || 0));
            const reasons = Object.entries(byReason).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
            const maxM = Math.max(...methods.map(m => Number(m[1].attempts) || 0), 1);
            const maxR = Math.max(...reasons.map(r => Number(r[1]) || 0), 1);
            const stat = (lbl, val, sub, color) => (
              <div className="so-card" style={{ flex: 1, minWidth: 120, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="so-kpi-lbl">{lbl}</div>
                <span className="so-kpi-val" style={{ fontSize: 22, color: color || 'var(--t1)' }}>{val}</span>
                {sub ? <span className="so-sub" style={{ fontSize: 11 }}>{sub}</span> : null}
              </div>
            );
            return (
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 12 }}>Checkout &amp; payment · <span style={{ color: 'var(--t3)' }}>Razorpay</span></div>
                {!pay ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
                  : (attempts === 0 && cod === 0) ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12, padding: '8px 0' }}>No payment data in this range yet — connector backfilling / webhook warming up.</div>
                    : (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                          {stat('Prepaid attempts', numfmt(attempts))}
                          {stat('Captured', numfmt(captured), `${sr.toFixed(1)}% success`, 'var(--green)')}
                          {stat('Failed', numfmt(failed), failed ? `${(100 * failed / Math.max(attempts, 1)).toFixed(1)}% of attempts` : null, '#EC6A5E')}
                          {stat('COD orders', numfmt(cod), 'captured on delivery', 'var(--t2)')}
                          {stat('Captured value', inr(capAmt))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18 }}>
                          <div>
                            <div className="so-sub" style={{ marginBottom: 8 }}>Why payments fail</div>
                            {reasons.length === 0 ? <div style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>No failures in range.</div>
                              : reasons.map(([reason, c]) => (
                                <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                  <div style={{ width: 130, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reason}</div>
                                  <div style={{ flex: 1, height: 13, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${(Number(c) / maxR) * 100}%`, height: '100%', background: '#EC6A5E', opacity: 0.8 }} />
                                  </div>
                                  <div style={{ width: 40, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>{numfmt(c)}</div>
                                </div>
                              ))}
                          </div>
                          <div>
                            <div className="so-sub" style={{ marginBottom: 8 }}>By payment method (captured / attempts)</div>
                            {methods.map(([m, o]) => {
                              const a = Number(o.attempts) || 0, cap = Number(o.captured) || 0;
                              return (
                                <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                                  <div style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{m}</div>
                                  <div style={{ flex: 1, height: 13, background: 'var(--surface2)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${(a / maxM) * 100}%`, height: '100%', background: '#F2CD1A', opacity: 0.85 }} />
                                  </div>
                                  <div style={{ width: 72, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>{numfmt(cap)}/{numfmt(a)}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--surface2)' }}>
                          <div className="so-sub" style={{ marginBottom: 8 }}>Reconciliation · {from} → {to}</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
                            <span>GA4 purchases <b style={{ color: 'var(--t1)' }}>{numfmt(rc.ga4_purchases)}</b></span>
                            <span style={{ color: 'var(--t3)' }}>·</span>
                            <span>Shopify orders <b style={{ color: 'var(--t1)' }}>{numfmt(rc.shopify_orders)}</b></span>
                            <span style={{ color: 'var(--t3)' }}>·</span>
                            <span>Razorpay captured <b style={{ color: 'var(--t1)' }}>{numfmt(rc.razorpay_captured)}</b> <span style={{ color: 'var(--t3)' }}>({inr(rc.razorpay_captured_amount)})</span></span>
                          </div>
                          <div className="so-sub" style={{ fontSize: 10.5, marginTop: 6 }}>Prepaid captures come from Razorpay; COD orders have no online capture (they appear in Shopify orders, not here). GA4 typically over-counts slightly.</div>
                        </div>
                      </>
                    )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
