'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, fmtInt, inr, rangePresets } from '../../../lib/api.js';
import { RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../components/kit.js';

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

// Daily conversion-rate trend over the snapshot history — the shape of when conversion moved.
// The input-stream annotations (website changes, stock in/out) overlay this chart in later phases.
function DailyTrend({ rows, changes = [] }) {
  if (!rows || rows.length < 2) return <div className="so-sub" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', padding: '20px 0' }}>Not enough days in this range yet — widen it.</div>;
  const W = 1000, H = 210, pad = 30;
  const vals = rows.map(r => Number(r.purchase_cr) || 0);
  const max = Math.max(...vals, 0.1);
  const x = i => pad + (i / (rows.length - 1)) * (W - pad * 2);
  const y = v => H - pad - (v / max) * (H - pad * 2);
  const line = rows.map((r, i) => `${x(i)},${y(vals[i])}`).join(' ');
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const idxByDate = {}; rows.forEach((r, i) => { idxByDate[r.the_date] = i; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={210} preserveAspectRatio="none" style={{ display: 'block' }}>
      {[0.25, 0.5, 0.75, 1].map(f => <line key={f} x1={pad} x2={W - pad} y1={y(max * f)} y2={y(max * f)} stroke="var(--surface2)" strokeWidth="1" />)}
      <line x1={pad} x2={W - pad} y1={y(avg)} y2={y(avg)} stroke="var(--t3)" strokeWidth="1" strokeDasharray="5,5" />
      <polygon points={`${pad},${H - pad} ${line} ${W - pad},${H - pad}`} fill="var(--green)" fillOpacity="0.08" />
      <polyline points={line} fill="none" stroke="var(--green)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {/* website-change markers — when a change shipped, on the conversion timeline */}
      {(changes || []).map((c, k) => {
        const i = idxByDate[c.the_date]; if (i == null) return null;
        const cx = x(i);
        return (
          <g key={c.id || k}>
            <line x1={cx} x2={cx} y1={pad - 8} y2={H - pad} stroke="var(--accent)" strokeWidth="1" strokeDasharray="3,3" opacity="0.55" />
            <circle cx={cx} cy={pad - 8} r="4" fill="var(--accent)">
              <title>{c.the_date} · {c.title}{c.hypothesis ? ` — ${c.hypothesis}` : ''}{c.result && c.result !== 'pending' ? ` (${c.result})` : ''}</title>
            </circle>
          </g>
        );
      })}
      <text x={pad} y={y(max) - 4} fill="var(--t3)" fontSize="11" fontFamily="var(--mono)">{max.toFixed(2)}%</text>
      <text x={W - pad} y={y(avg) - 4} fill="var(--t3)" fontSize="11" fontFamily="var(--mono)" textAnchor="end">avg {avg.toFixed(2)}%</text>
    </svg>
  );
}

export default function FunnelPage() {
  const { session } = useAuth();
  const mtd = rangePresets().find(p => p.key === 'mtd');
  const [from, setFrom] = useState(mtd.from);
  const [to, setTo] = useState(mtd.to);
  const [rows, setRows] = useState(null);
  const [pay, setPay] = useState(null);   // { funnel, recon } — checkout payment funnel (Razorpay)
  const [hist, setHist] = useState(null);  // daily conversion-history snapshot rows
  const [changes, setChanges] = useState([]);  // website-change events (timeline annotations)
  const [view, setView] = useState('overview');  // overview | history
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!session) return;
    setRows(null); setPay(null); setHist(null); setChanges([]); setErr('');
    salesGet('getTraffic', { from, to }, session)
      .then(t => setRows(t?.rows || []))
      .catch(e => setErr(e.message || String(e)));
    salesGet('getPaymentFunnel', { from, to }, session)
      .then(p => setPay(p || {}))
      .catch(() => setPay({}));   // soft — payment section just shows empty if it fails
    salesGet('getConversionHistory', { from, to }, session)
      .then(h => setHist(h?.rows || []))
      .catch(() => setHist([]));
    salesGet('getChangeEvents', { from, to }, session)
      .then(c => setChanges(c?.rows || []))
      .catch(() => setChanges([]));
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

  const srcSort = useTableSort(rows, { initialKey: 'sessions', valueOf: (r, k) => k === 'conv' ? (Number(r.sessions) > 0 ? Number(r.purchases) / Number(r.sessions) : 0) : k === 'src_group' ? (r.src_group || '') : r[k] });
  const histSort = useTableSort(hist, { initialKey: 'the_date', initialDir: 'desc' });

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<><SegmentedToggle options={[['overview', 'Overview'], ['history', 'Daily history']]} value={view} onChange={setView} size="sm" /><span className="so-sub" style={{ marginLeft: 10 }}>GA4 · Website</span></>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {view === 'history' ? (
        !hist ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(220px,1fr)', gap: 14 }}>
              <div className="so-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <div className="so-kpi-lbl" style={{ margin: 0 }}>Daily conversion rate · sessions → purchase</div>
                  {changes.length > 0 && <span className="so-sub" style={{ fontSize: 10.5 }}><span className="so-dot" style={{ background: 'var(--accent)', marginRight: 5 }} />{changes.length} website change{changes.length > 1 ? 's' : ''}</span>}
                </div>
                <DailyTrend rows={hist} changes={changes} />
              </div>
              {(() => {
                const wd = (hist || []).filter(r => Number(r.sessions) > 0);
                const v = wd.map(r => Number(r.purchase_cr) || 0);
                const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
                const best = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) > Number(m.purchase_cr) ? r : m) : null;
                const worst = wd.length ? wd.reduce((m, r) => Number(r.purchase_cr) < Number(m.purchase_cr) ? r : m) : null;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div className="so-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                      <div className="so-kpi-lbl">Avg daily conversion</div>
                      <span className="so-kpi-val" style={{ fontSize: 30, color: 'var(--green)' }}>{avg.toFixed(2)}%</span>
                      <span className="so-sub" style={{ fontSize: 11 }}>{wd.length} days in range</span>
                    </div>
                    <div className="so-card" style={{ flex: 1 }}>
                      <div className="so-kpi-lbl">Best / worst day</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
                        <div style={{ color: 'var(--green)' }}>▲ {best?.the_date} · {Number(best?.purchase_cr || 0).toFixed(2)}%</div>
                        <div style={{ color: '#EC6A5E' }}>▼ {worst?.the_date} · {Number(worst?.purchase_cr || 0).toFixed(2)}%</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>Daily funnel</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="so-table" style={{ marginTop: 8 }}>
                  <thead><tr>
                    <SortHeader k="the_date" label="Date" sort={histSort} />
                    <SortHeader k="sessions" label="Sessions" sort={histSort} numeric />
                    <SortHeader k="add_to_carts" label="ATC" sort={histSort} numeric />
                    <SortHeader k="checkouts" label="Checkout" sort={histSort} numeric />
                    <SortHeader k="purchases" label="Purchases" sort={histSort} numeric />
                    <SortHeader k="atc_rate" label="ATC %" sort={histSort} numeric />
                    <SortHeader k="purchase_cr" label="Conv. rate" sort={histSort} numeric />
                  </tr></thead>
                  <tbody>
                    {histSort.sorted.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--t3)', padding: 14 }}>No snapshot days in this range yet.</td></tr>}
                    {histSort.sorted.map(r => (
                      <tr key={r.the_date}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.the_date}</td>
                        <td className="so-num">{numfmt(r.sessions)}</td>
                        <td className="so-num">{numfmt(r.add_to_carts)}</td>
                        <td className="so-num">{numfmt(r.checkouts)}</td>
                        <td className="so-num">{numfmt(r.purchases)}</td>
                        <td className="so-num">{fmtPct(r.atc_rate)}</td>
                        <td className="so-num" style={{ color: 'var(--green)' }}>{fmtPct(r.purchase_cr)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {changes.length > 0 && (
              <div className="so-card">
                <div className="so-kpi-lbl" style={{ marginBottom: 10 }}>Website changes in range · <span style={{ color: 'var(--t3)' }}>what shipped</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {changes.slice().sort((a, b) => (a.the_date < b.the_date ? 1 : -1)).map(c => (
                    <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', borderBottom: '1px solid var(--surface2)', paddingBottom: 8 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2)', width: 88, flexShrink: 0 }}>{c.the_date}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--t1)' }}>{c.title}
                          {c.workstream && <span className="so-sub" style={{ marginLeft: 8, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{c.workstream}{c.surface ? ` · ${c.surface}` : ''}</span>}
                        </div>
                        {c.hypothesis && <div className="so-sub" style={{ fontSize: 11.5, marginTop: 2 }}>{c.hypothesis}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        {c.status && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: c.status === 'reverted' ? '#EC6A5E' : 'var(--t3)' }}>{c.status}</span>}
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: c.result && c.result !== 'pending' ? 'var(--green)' : 'var(--t3)' }}>{c.result || '—'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>Frozen daily snapshot of the GA4 website funnel — recent days refresh as GA4 finalises, older days lock. Markers = website changes (pulled from the Website repo&apos;s change-log); stock in/out lands next.</div>
          </>
        )
      ) : (
      !rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
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
                <SortHeader k="src_group" label="Source" sort={srcSort} /><SortHeader k="sessions" label="Sessions" sort={srcSort} numeric /><SortHeader k="add_to_carts" label="Add to cart" sort={srcSort} numeric />
                <SortHeader k="checkouts" label="Checkouts" sort={srcSort} numeric /><SortHeader k="purchases" label="Purchases" sort={srcSort} numeric /><SortHeader k="conv" label="Conv. rate" sort={srcSort} numeric />
              </tr></thead>
              <tbody>
                {srcSort.sorted.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 14 }}>No traffic in this range yet — connector may still be backfilling.</td></tr>}
                {srcSort.sorted.map((r, i) => {
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
      ))}
    </div>
  );
}
