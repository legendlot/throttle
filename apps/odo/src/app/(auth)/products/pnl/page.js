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
  // Super-admin: getProductCosts / setProductCost are both canSuperAdmin since S307.
  const isAdmin = !!(perms && perms.salesops_super_admin);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [prod, setProd] = useState(null);
  const [costs, setCosts] = useState(null);
  const [showCosts, setShowCosts] = useState(false);
  const [mode, setMode] = useState('abs');
  const [fam, setFam] = useState('all');
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { const t = istToday(); const [y, m] = t.split('-').map(Number); setFrom(new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10)); setTo(t); }, []);
  const load = () => { if (from && to) salesGet('getPnlByProduct', { from, to, family: fam }, session).then(r => { setProd(r?.rows || []); setMeta(r || null); }).catch(e => setErr(e.message || String(e))); };
  useEffect(() => { if (session && from && to) { setProd(null); setErr(''); load(); } }, [session, from, to, fam]);
  useEffect(() => { if (session && isAdmin && showCosts && !costs) salesGet('getProductCosts', {}, session).then(r => setCosts(r?.rows || [])).catch(() => setCosts([])); }, [session, isAdmin, showCosts, costs]);

  const pctMode = mode === 'pct';
  const hasCm = !!(meta && meta.has_cm);
  const prodRows = (prod || []).map(r => {
    const gmv = +r.gmv || 0, ret = +r.returns_val || 0, tax = +r.taxes || 0, cogs = +r.cogs || 0, units = +r.units || 0;
    const logi = +r.logistics || 0, plat = +r.platform_fee || 0, cac = +r.cac || 0;
    const nmv = gmv - ret - tax, gm = nmv - cogs, cm1 = gm - logi - plat, cm2 = cm1 - cac;
    return { product: r.product, units, gmv, nmv, cogs, gm, gm_pct: nmv ? 100 * gm / nmv : 0,
      logi, plat, cac, cm1, cm2, cm2_pct: nmv ? 100 * cm2 / nmv : 0,
      // The residual row carries fees/CAC that pin to no SKU. It has no GMV, so a "no cost"
      // flag on it would be meaningless — and its margin % has no denominator.
      resid: !!r.is_residual, costed: cogs > 0 || !!r.is_residual };
  });
  // The residual is a RECONCILING row, not a product — it must never sort among them, or it
  // reads as a product line with a huge negative fee. Held out of the sort and pinned last.
  const residRows = prodRows.filter(r => r.resid);
  const prodSort = useTableSort(prodRows.filter(r => !r.resid), { initialKey: 'gm' });
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
        right={<>
          <select className="so-input" style={{ padding: '3px 7px', fontSize: 12, marginRight: 10 }} value={fam} onChange={e => setFam(e.target.value)}>
            <option value="all">All channels</option>
            {(meta?.families || []).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <SegmentedToggle options={[['abs', '₹'], ['pct', '% of NMV']]} value={mode} onChange={setMode} size="sm" />
          <span className="so-sub" style={{ marginLeft: 10 }}>Per product · through {hasCm ? 'CM2' : 'GM'}</span>
        </>} />
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!prod ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>By product <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· margin through {hasCm ? 'CM2' : 'GM'} · {fam === 'all' ? 'all channels' : ((meta?.families || []).find(f => f.key === fam)?.label || fam)} · {pctMode ? '% of NMV' : '₹'} for the range</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ marginTop: 8, minWidth: hasCm ? 1020 : 620 }}>
                <thead><tr>
                  <SortHeader k="product" label="Product" sort={prodSort} />
                  <SortHeader k="units" label="Units" sort={prodSort} numeric />
                  <SortHeader k="gmv" label="GMV" sort={prodSort} numeric />
                  <SortHeader k="nmv" label="NMV" sort={prodSort} numeric />
                  <SortHeader k="cogs" label="COGS" sort={prodSort} numeric />
                  <SortHeader k="gm" label="GM" sort={prodSort} numeric />
                  <SortHeader k="gm_pct" label="GM %" sort={prodSort} numeric />
                  {hasCm && <>
                    <SortHeader k="logi" label="Logistics" sort={prodSort} numeric />
                    <SortHeader k="plat" label="Platform fee" sort={prodSort} numeric />
                    <SortHeader k="cm1" label="CM1" sort={prodSort} numeric />
                    <SortHeader k="cac" label="CAC" sort={prodSort} numeric />
                    <SortHeader k="cm2" label="CM2" sort={prodSort} numeric />
                    <SortHeader k="cm2_pct" label="CM2 %" sort={prodSort} numeric />
                  </>}
                </tr></thead>
                <tbody>
                  {prodSort.sorted.length === 0 && <tr><td colSpan={hasCm ? 13 : 7} style={{ color: 'var(--t3)', padding: 14 }}>No product sales in this range.</td></tr>}
                  {[...prodSort.sorted, ...residRows].map(r => (
                    <tr key={r.product} style={r.resid ? { background: 'var(--row-alt, rgba(127,127,127,.06))', borderTop: '2px solid var(--row-border)' } : undefined}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.resid ? <span title="Fees and ad spend that pin to no SKU — shown so the table reconciles to the channel P&L. Never pro-rated across products." style={{ fontStyle: 'italic', color: 'var(--t3)' }}>{r.product}</span> : r.product}
                        {!r.costed && <span className="so-sub" title="No standard cost set — GM overstated" style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>no cost</span>}
                      </td>
                      <td className="so-num">{r.resid ? '—' : rs(r.units)}</td>
                      <td className="so-num">{r.resid ? '—' : pcell(r.gmv, r.nmv)}</td>
                      <td className="so-num">{r.resid ? '—' : pcell(r.nmv, r.nmv)}</td>
                      <td className="so-num">{r.resid ? '—' : pcell(r.cogs, r.nmv)}</td>
                      <td className="so-num">{r.resid ? '—' : pcell(r.gm, r.nmv)}</td>
                      <td className="so-num" style={{ color: r.gm_pct < 0 ? 'var(--red)' : 'var(--green-fg)', fontWeight: 600 }}>{r.resid ? '—' : `${r.gm_pct.toFixed(1)}%`}</td>
                      {hasCm && <>
                        <td className="so-num">{pcell(r.logi, r.nmv)}</td>
                        <td className="so-num">{pcell(r.plat, r.nmv)}</td>
                        <td className="so-num">{r.resid ? '—' : pcell(r.cm1, r.nmv)}</td>
                        <td className="so-num">{pcell(r.cac, r.nmv)}</td>
                        <td className="so-num">{r.resid ? '—' : pcell(r.cm2, r.nmv)}</td>
                        <td className="so-num" style={{ color: r.cm2_pct < 0 ? 'var(--red)' : 'var(--green-fg)', fontWeight: 600 }}>{r.resid ? '—' : `${r.cm2_pct.toFixed(1)}%`}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
            {hasCm
              ? <>Through <b>CM2</b> for this channel. Fees are settlement-dated while sales are sale-dated (same basis as <code>/pnl</code>), so a month&rsquo;s fees can trail its revenue. The <i>Account-level (unattributable)</i> row holds fees and ad spend that pin to no SKU — it exists so the columns still sum to the channel P&amp;L, and is deliberately <b>never</b> pro-rated across products. Amazon ad spend is taken from per-product spend, not the settlement <code>fee_advertising</code> line, which would double-count it.</>
              : <>Product margin through <b>Gross Margin</b> (the cleanly product-attributable slice) across all channels. <b>Pick a channel above to go through CM2</b> — fees and CAC only mean anything once scoped, and today only Amazon has per-SKU fee data.</>}
            {' '}COGS = units × standard cost (below); products flagged <span style={{ color: 'var(--red)' }}>no cost</span> overstate GM.
          </div>

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
