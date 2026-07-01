'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, salesPost, istToday } from '../../../lib/api.js';
import { RangePicker, SegmentedToggle } from '../../../components/kit.js';

// P&L waterfall lines. kind: src=data-sourced · manual=editable · sub=computed subtotal. neg=subtracted.
const LINES = [
  { key: 'gmv',             label: 'GMV',            kind: 'src' },
  { key: 'rto',             label: 'RTO',            kind: 'manual', neg: true },
  { key: 'refund',          label: 'Refund',         kind: 'src',    neg: true },
  { key: 'taxes',           label: 'Taxes',          kind: 'src',    neg: true },
  { key: 'nmv',             label: 'NMV / Revenue',  kind: 'sub' },
  { key: 'cogs',            label: 'COGS',           kind: 'src',    neg: true },
  { key: 'gm',              label: 'Gross Margin',   kind: 'sub' },
  { key: 'logistics',       label: 'Logistics',      kind: 'manual', neg: true },
  { key: 'platform_fee',    label: 'Platform Fee',   kind: 'manual', neg: true },
  { key: 'cm1',             label: 'CM1',            kind: 'sub' },
  { key: 'cac',             label: 'CAC',            kind: 'src',    neg: true },
  { key: 'cm2',             label: 'CM2',            kind: 'sub' },
  { key: 'brand_marketing', label: 'Brand Marketing', kind: 'manual', neg: true },
  { key: 'sga',             label: 'SG&A',           kind: 'manual', neg: true },
  { key: 'ebitda',          label: 'EBITDA',         kind: 'sub' },
];
const CHANNEL_LINES = LINES.slice(0, LINES.findIndex(l => l.key === 'cm2') + 1);   // channels roll up to CM2

const rs = n => Math.round(Number(n) || 0).toLocaleString('en-IN');
const monLabel = m => { const d = new Date(m + 'T00:00:00Z'); return d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };
function withSubtotals(r) {
  const n = k => Number(r[k]) || 0;
  const v = { month: r.month, gmv: n('gmv'), rto: n('rto'), refund: n('refund'), taxes: n('taxes'), cogs: n('cogs'), logistics: n('logistics'), platform_fee: n('platform_fee'), cac: n('cac'), brand_marketing: n('brand_marketing'), sga: n('sga') };
  v.nmv = v.gmv - v.rto - v.refund - v.taxes;
  v.gm = v.nmv - v.cogs;
  v.cm1 = v.gm - v.logistics - v.platform_fee;
  v.cm2 = v.cm1 - v.cac;
  v.ebitda = v.cm2 - v.brand_marketing - v.sga;
  return v;
}

// One P&L table (master or a channel). editable = Set of manual line keys the user can edit here;
// autoLines = manual keys shown but auto-sourced (e.g. Amazon fees from settlement) → read-only.
function PnlTable({ title, subtitle, rows, months, lines, channelKey, editable, autoLines, session, isAdmin, onSaved, mode = 'abs', defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const [edit, setEdit] = useState(null);   // {month,key}
  const [val, setVal] = useState('');
  const cols = months.map(m => withSubtotals(rows.find(r => r.month === m) || { month: m }));
  const total = {}; for (const L of lines) total[L.key] = cols.reduce((a, c) => a + (Number(c[L.key]) || 0), 0);
  const pct = mode === 'pct';
  const nmvByCol = cols.map(c => Number(c.nmv) || 0);            // % base = each month's NMV
  const totalNmv = nmvByCol.reduce((a, b) => a + b, 0);
  const cellText = (v, base, isSub, canEdit) => {
    if (pct) return base ? `${(100 * v / base).toFixed(1)}%` : '—';
    if (v === 0 && !isSub) return canEdit ? '—' : '0';
    return rs(v);
  };
  const isMuted = (v, base, isSub) => (pct ? !base : (v === 0 && !isSub));
  const SUB_BG = 'color-mix(in srgb, var(--accent) 8%, transparent)';
  const save = async (m, key) => {
    setEdit(null);
    try { await salesPost('setPnlManual', { month: m.slice(0, 7), channel_key: channelKey, line_key: key, amount_inr: Math.round(Number(val) || 0) }, session); onSaved(); }
    catch (e) { /* surfaced by parent reload */ }
  };
  return (
    <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div className="so-kpi-lbl" style={{ margin: 0 }}>{title}{subtitle ? <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}> · {subtitle}</span> : null}</div>
        <span className="so-sub" style={{ fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table" style={{ minWidth: 620 }}>
            <thead><tr>
              <th style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>Line</th>
              {months.map(m => <th key={m} className="so-num">{monLabel(m)}</th>)}
              <th className="so-num" style={{ borderLeft: '1px solid var(--border)' }}>Total</th>
            </tr></thead>
            <tbody>
              {lines.map(L => {
                const isSub = L.kind === 'sub';
                const isAuto = autoLines && autoLines.has(L.key);
                const canEdit = !pct && isAdmin && L.kind === 'manual' && editable && editable.has(L.key) && !isAuto;
                return (
                  <tr key={L.key} style={isSub ? { background: SUB_BG, fontWeight: 700 } : undefined}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: isSub ? 'var(--surface2)' : 'var(--surface)', fontWeight: isSub ? 700 : 400, color: isSub ? 'var(--t1)' : 'var(--t2)', whiteSpace: 'nowrap' }}>
                      {L.neg && !isSub ? <span style={{ color: 'var(--t3)' }}>− </span> : null}{L.label}
                      {isAuto ? <span className="so-sub" style={{ marginLeft: 5, fontSize: 9 }}>auto</span> : null}
                    </td>
                    {cols.map((c, i) => {
                      const v = Number(c[L.key]) || 0, m = months[i];
                      const editing = canEdit && edit && edit.month === m && edit.key === L.key;
                      const color = isSub ? (v < 0 ? '#EC6A5E' : 'var(--green)') : 'var(--t1)';
                      return (
                        <td key={m} className="so-num" style={{ color, cursor: canEdit ? 'pointer' : 'default' }}
                          onClick={canEdit && !editing ? () => { setEdit({ month: m, key: L.key }); setVal(String(Math.round(v))); } : undefined}>
                          {editing ? (
                            <input autoFocus className="so-input" style={{ width: 92, padding: '2px 6px', fontSize: 12, textAlign: 'right' }}
                              value={val} onChange={e => setVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') save(m, L.key); if (e.key === 'Escape') setEdit(null); }}
                              onBlur={() => save(m, L.key)} />
                          ) : (isMuted(v, nmvByCol[i], isSub) ? <span style={{ color: 'var(--t3)' }}>{cellText(v, nmvByCol[i], isSub, canEdit)}</span> : cellText(v, nmvByCol[i], isSub, canEdit))}
                        </td>
                      );
                    })}
                    <td className="so-num" style={{ borderLeft: '1px solid var(--border)', fontWeight: isSub ? 700 : 400, color: isSub ? (total[L.key] < 0 ? '#EC6A5E' : 'var(--green)') : 'var(--t1)' }}>{cellText(total[L.key], totalNmv, isSub, false)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PnlPage() {
  const { session, perms } = useAuth();
  const isAdmin = !!(perms && perms.salesops_admin);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [costs, setCosts] = useState(null);
  const [showCosts, setShowCosts] = useState(false);
  const [mode, setMode] = useState('abs');   // abs (₹) | pct (% of NMV)
  const [err, setErr] = useState('');

  useEffect(() => {   // default: trailing 6 months (first-of-month 5 back → today)
    const t = istToday(); const [y, m] = t.split('-').map(Number);
    setFrom(new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10)); setTo(t);
  }, []);
  const load = () => { if (from && to) salesGet('getPnl', { from, to }, session).then(d => setData(d || {})).catch(e => setErr(e.message || String(e))); };
  useEffect(() => { if (session && from && to) { setData(null); setErr(''); load(); } }, [session, from, to]);
  useEffect(() => { if (session && isAdmin && showCosts && !costs) salesGet('getProductCosts', {}, session).then(r => setCosts(r?.rows || [])).catch(() => setCosts([])); }, [session, isAdmin, showCosts, costs]);

  const saveCost = async (product_code, v) => {
    try { await salesPost('setProductCost', { product_code, cogs_inr: Math.round(Number(v) || 0) }, session); setCosts(cs => (cs || []).map(c => c.product_code === product_code ? { ...c, cogs_inr: Math.round(Number(v) || 0) } : c)); load(); }
    catch (e) { setErr('Save failed: ' + (e.message || e)); }
  };
  const costedCount = (costs || []).filter(c => c.cogs_inr != null).length;

  const months = data?.months || [];
  const AMZ_AUTO = new Set(['rto', 'logistics', 'platform_fee']);

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<><SegmentedToggle options={[['abs', '₹'], ['pct', '% of NMV']]} value={mode} onChange={setMode} size="sm" /><span className="so-sub" style={{ marginLeft: 10 }}>Monthly · master + per channel</span></>} />
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!data ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <PnlTable title="Company P&amp;L" subtitle={mode === 'pct' ? 'all Odo channels · % of NMV' : 'all Odo channels · ₹ monthly'} rows={data.master || []} months={months}
            lines={LINES} channelKey="all" editable={new Set(['brand_marketing', 'sga'])} autoLines={new Set()}
            session={session} isAdmin={isAdmin} onSaved={load} mode={mode} />

          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
            GMV = booked value (tax-incl, net of discounts) · COGS = units × standard cost · CAC = performance ad spend. <b style={{ color: 'var(--t2)' }}>Amazon Platform Fee + Logistics auto-feed from settlement</b> (lag a few weeks); other channels are manual until their connectors land (Delhivery for D2C, marketplace reports). RTO / Logistics / Platform Fee here are channel rollups — edit them in the channel tables below. Brand Marketing = manual; SG&A wired to Podium salaries (0 until live). Numbers cover Odo-captured channels only.
          </div>

          <div className="so-kpi-lbl" style={{ marginTop: 4 }}>By channel <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· rolls up to CM2 (company overheads sit at company level)</span></div>
          {(data.families || []).map(f => (
            <PnlTable key={f.key} title={f.label} subtitle={mode === 'pct' ? '% of NMV' : '₹ monthly'} rows={(data.channels || {})[f.key] || []} months={months}
              lines={CHANNEL_LINES} channelKey={f.key}
              editable={f.key === 'amazon' ? new Set() : new Set(['rto', 'logistics', 'platform_fee'])}
              autoLines={f.key === 'amazon' ? AMZ_AUTO : new Set()}
              session={session} isAdmin={isAdmin} onSaved={load} mode={mode} defaultOpen={false} />
          ))}

          {isAdmin && (
            <div className="so-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setShowCosts(s => !s)}>
                <div className="so-kpi-lbl" style={{ margin: 0 }}>Product COGS {costs ? <span className="so-sub" style={{ fontSize: 10.5 }}>· {costedCount}/{costs.length} costed</span> : null}</div>
                <span className="so-sub" style={{ fontSize: 12 }}>{showCosts ? '▲ hide' : '▼ edit standard costs'}</span>
              </div>
              {showCosts && (!costs ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div> : (
                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                  {costs.map(c => (
                    <div key={c.product_code} style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--surface2)', paddingBottom: 6 }}>
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
