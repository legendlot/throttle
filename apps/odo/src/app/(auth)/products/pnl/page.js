'use client';
// Products → P&L: per-product margin through Gross Margin (all channels), + the standard-cost editor.
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { useRouter } from 'next/navigation';
import { Spinner } from '@throttle/ui';
import { salesGet, salesPost, istToday } from '../../../../lib/api.js';
import { RangePicker, SegmentedToggle, useTableSort, SortHeader } from '../../../../components/kit.js';
import { PageHead, ScopeTab } from '../../../../components/prism.js';

const rs = n => Math.round(Number(n) || 0).toLocaleString('en-IN');

export default function ProductPnlPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const isAdmin = !!(perms && perms.salesops_admin);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [prod, setProd] = useState(null);
  const [costs, setCosts] = useState(null);
  const [showCosts, setShowCosts] = useState(false);
  const [mode, setMode] = useState('abs');
  const [err, setErr] = useState('');

  useEffect(() => { const t = istToday(); const [y, m] = t.split('-').map(Number); setFrom(new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10)); setTo(t); }, []);
  const load = () => { if (from && to) salesGet('getPnlByProduct', { from, to }, session).then(r => setProd(r?.rows || [])).catch(e => setErr(e.message || String(e))); };
  useEffect(() => { if (session && from && to) { setProd(null); setErr(''); load(); } }, [session, from, to]);
  useEffect(() => { if (session && isAdmin && showCosts && !costs) salesGet('getProductCosts', {}, session).then(r => setCosts(r?.rows || [])).catch(() => setCosts([])); }, [session, isAdmin, showCosts, costs]);

  const pctMode = mode === 'pct';
  const prodRows = (prod || []).map(r => {
    const gmv = +r.gmv || 0, ret = +r.returns_val || 0, tax = +r.taxes || 0, cogs = +r.cogs || 0, units = +r.units || 0;
    const nmv = gmv - ret - tax, gm = nmv - cogs;
    return { product: r.product, units, gmv, nmv, cogs, gm, gm_pct: nmv ? 100 * gm / nmv : 0, costed: cogs > 0 };
  });
  const prodSort = useTableSort(prodRows, { initialKey: 'gm' });
  const pcell = (v, nmv) => pctMode ? (nmv ? `${(100 * v / nmv).toFixed(1)}%` : '—') : rs(v);
  const saveCost = async (product_code, v) => {
    try { await salesPost('setProductCost', { product_code, cogs_inr: Math.round(Number(v) || 0) }, session); setCosts(cs => (cs || []).map(c => c.product_code === product_code ? { ...c, cogs_inr: Math.round(Number(v) || 0) } : c)); load(); }
    catch (e) { setErr('Save failed: ' + (e.message || e)); }
  };
  const costedCount = (costs || []).filter(c => c.cogs_inr != null).length;

  return (
    <div className="so-page">
      <PageHead title="Products · P&L" sub="Per-product margin through Gross Margin, across all channels." />

      {/* Products' children left the sidebar when the IA moved scope selection in-page — this
          strip is how /products/pnl stays reachable. Same routes as the old rail children. */}
      <div className="so-scopebar">
        <ScopeTab label="Cross-channel" onClick={() => router.push('/products/drr')} />
        <ScopeTab on label="P&L by product" onClick={() => {}} />
      </div>

      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<><SegmentedToggle options={[['abs', '₹'], ['pct', '% of NMV']]} value={mode} onChange={setMode} size="sm" /><span className="so-sub" style={{ marginLeft: 10 }}>Per product · through GM</span></>} />
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!prod ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>By product <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· margin through GM · all channels · {pctMode ? '% of NMV' : '₹'} for the range</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ marginTop: 8, minWidth: 620 }}>
                <thead><tr>
                  <SortHeader k="product" label="Product" sort={prodSort} />
                  <SortHeader k="units" label="Units" sort={prodSort} numeric />
                  <SortHeader k="gmv" label="GMV" sort={prodSort} numeric />
                  <SortHeader k="nmv" label="NMV" sort={prodSort} numeric />
                  <SortHeader k="cogs" label="COGS" sort={prodSort} numeric />
                  <SortHeader k="gm" label="GM" sort={prodSort} numeric />
                  <SortHeader k="gm_pct" label="GM %" sort={prodSort} numeric />
                </tr></thead>
                <tbody>
                  {prodSort.sorted.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--t3)', padding: 14 }}>No product sales in this range.</td></tr>}
                  {prodSort.sorted.map(r => (
                    <tr key={r.product}>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.product}{!r.costed && <span className="so-sub" title="No standard cost set — GM overstated" style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>no cost</span>}</td>
                      <td className="so-num">{rs(r.units)}</td>
                      <td className="so-num">{pcell(r.gmv, r.nmv)}</td>
                      <td className="so-num">{pcell(r.nmv, r.nmv)}</td>
                      <td className="so-num">{pcell(r.cogs, r.nmv)}</td>
                      <td className="so-num">{pcell(r.gm, r.nmv)}</td>
                      <td className="so-num" style={{ color: r.gm_pct < 0 ? 'var(--red)' : 'var(--green-fg)', fontWeight: 600 }}>{r.gm_pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>Product margin through Gross Margin (the cleanly product-attributable slice). Fees / CAC per product (→ CM) are Amazon-only — a later add. COGS = units × standard cost (below); products flagged <span style={{ color: 'var(--red)' }}>no cost</span> overstate GM.</div>

          {isAdmin && (
            <div className="so-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setShowCosts(s => !s)}>
                <div className="so-kpi-lbl" style={{ margin: 0 }}>Product COGS {costs ? <span className="so-sub" style={{ fontSize: 10.5 }}>· {costedCount}/{costs.length} costed</span> : null}</div>
                <span className="so-sub" style={{ fontSize: 12 }}>{showCosts ? '▲ hide' : '▼ edit standard costs'}</span>
              </div>
              {showCosts && (!costs ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div> : (
                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                  {costs.map(c => (
                    <div key={c.product_code} style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--row-border)', paddingBottom: 6 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.product_code}>
                        {[c.product, c.model, c.color].filter(Boolean).join(' ') || c.product_code}
                        <span className="so-sub" style={{ marginLeft: 6, fontSize: 10 }}>{c.product_code}</span>
                      </span>
                      <input className="so-input" style={{ width: 96, padding: '3px 7px', fontSize: 12, textAlign: 'right' }}
                        defaultValue={c.cogs_inr ?? ''} placeholder="₹ cost"
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        onBlur={e => { const v = e.target.value.trim(); if (v !== '' && Number(v) !== Number(c.cogs_inr)) saveCost(c.product_code, v); }} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
