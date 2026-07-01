'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, salesPost, istToday } from '../../../lib/api.js';
import { RangePicker } from '../../../components/kit.js';

// P&L waterfall rows. kind: src = data-sourced base line · manual = editable manual line ·
// sub = computed subtotal. neg = subtracted from the running subtotal.
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
const MANUAL_KEYS = new Set(['rto', 'logistics', 'platform_fee', 'brand_marketing', 'sga']);

const rs = n => Math.round(Number(n) || 0).toLocaleString('en-IN');
const monLabel = m => { const d = new Date(m + 'T00:00:00Z'); return d.toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }); };
// derive the 5 subtotals for one month's base-line object
function withSubtotals(r) {
  const v = { ...r };
  v.nmv = v.gmv - v.rto - v.refund - v.taxes;
  v.gm  = v.nmv - v.cogs;
  v.cm1 = v.gm - v.logistics - v.platform_fee;
  v.cm2 = v.cm1 - v.cac;
  v.ebitda = v.cm2 - v.brand_marketing - v.sga;
  return v;
}

export default function PnlPage() {
  const { session, perms } = useAuth();
  const isAdmin = !!(perms && perms.salesops_admin);
  // default: trailing 6 months → first of month, 5 months back
  const def = useMemo(() => {
    const t = istToday(); const [y, m] = t.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10);
    return { from, to: t };
  }, []);
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [rows, setRows] = useState(null);
  const [costs, setCosts] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(null);   // { month, key } currently editing
  const [editVal, setEditVal] = useState('');
  const [showCosts, setShowCosts] = useState(false);

  const load = () => {
    salesGet('getPnl', { from, to }, session).then(r => setRows(r?.rows || [])).catch(e => setErr(e.message || String(e)));
  };
  useEffect(() => { if (!session) return; setRows(null); setErr(''); load(); }, [session, from, to]);
  useEffect(() => { if (session && isAdmin && showCosts && !costs) salesGet('getProductCosts', {}, session).then(r => setCosts(r?.rows || [])).catch(() => setCosts([])); }, [session, isAdmin, showCosts, costs]);

  const cols = useMemo(() => (rows || []).map(withSubtotals), [rows]);
  const total = useMemo(() => {
    const t = {}; for (const L of LINES) t[L.key] = 0;
    for (const c of cols) for (const L of LINES) t[L.key] += Number(c[L.key]) || 0;
    return t;
  }, [cols]);
  const months = (rows || []).map(r => r.month);
  const costedCount = (costs || []).filter(c => c.cogs_inr != null).length;

  const saveManual = async (month, key, val) => {
    const amount = Math.round(Number(val) || 0);
    setEdit(null);
    try { await salesPost('setPnlManual', { month: month.slice(0, 7), line_key: key, amount_inr: amount }, session); load(); }
    catch (e) { setErr('Save failed: ' + (e.message || e)); }
  };
  const saveCost = async (product_code, val) => {
    const cogs_inr = Math.round(Number(val) || 0);
    try { await salesPost('setProductCost', { product_code, cogs_inr }, session); setCosts(cs => (cs || []).map(c => c.product_code === product_code ? { ...c, cogs_inr } : c)); load(); }
    catch (e) { setErr('Save failed: ' + (e.message || e)); }
  };

  const SUB_BG = 'color-mix(in srgb, var(--accent) 8%, transparent)';

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<span className="so-sub">Monthly · all Odo channels</span>} />

      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!rows ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="so-kpi-lbl" style={{ padding: '16px 18px 0' }}>Profit &amp; loss <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· ₹, monthly{isAdmin ? ' · click a manual line cell to edit' : ''}</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table" style={{ marginTop: 8, minWidth: 640 }}>
                <thead><tr>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>Line</th>
                  {months.map(m => <th key={m} className="so-num">{monLabel(m)}</th>)}
                  <th className="so-num" style={{ borderLeft: '1px solid var(--border)' }}>Total</th>
                </tr></thead>
                <tbody>
                  {LINES.map(L => {
                    const isSub = L.kind === 'sub';
                    const editable = isAdmin && L.kind === 'manual';
                    return (
                      <tr key={L.key} style={isSub ? { background: SUB_BG, fontWeight: 700 } : undefined}>
                        <td style={{ position: 'sticky', left: 0, zIndex: 1, background: isSub ? 'var(--surface2)' : 'var(--surface)', fontWeight: isSub ? 700 : 400, color: isSub ? 'var(--t1)' : 'var(--t2)' }}>
                          {L.neg && !isSub ? <span style={{ color: 'var(--t3)' }}>− </span> : null}{L.label}
                        </td>
                        {cols.map((c, i) => {
                          const val = Number(c[L.key]) || 0;
                          const m = months[i];
                          const editing = editable && edit && edit.month === m && edit.key === L.key;
                          const color = isSub ? (val < 0 ? '#EC6A5E' : 'var(--green)') : 'var(--t1)';
                          return (
                            <td key={m} className="so-num" style={{ color, cursor: editable ? 'pointer' : 'default' }}
                              onClick={editable && !editing ? () => { setEdit({ month: m, key: L.key }); setEditVal(String(Math.round(val))); } : undefined}>
                              {editing ? (
                                <input autoFocus className="so-input" style={{ width: 96, padding: '2px 6px', fontSize: 12, textAlign: 'right' }}
                                  value={editVal} onChange={e => setEditVal(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveManual(m, L.key, editVal); if (e.key === 'Escape') setEdit(null); }}
                                  onBlur={() => saveManual(m, L.key, editVal)} />
                              ) : (val === 0 && !isSub ? <span style={{ color: 'var(--t3)' }}>{editable ? '—' : '0'}</span> : rs(val))}
                            </td>
                          );
                        })}
                        <td className="so-num" style={{ borderLeft: '1px solid var(--border)', fontWeight: isSub ? 700 : 400, color: isSub ? (total[L.key] < 0 ? '#EC6A5E' : 'var(--green)') : 'var(--t1)' }}>{rs(total[L.key])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
            Sourced from Odo-captured channels (Website · Amazon · quick-comm · GT/MT · marketplace where connected) — totals trail a full-company view until every channel + tax feed lands. RTO · Logistics · Platform Fee · Brand Marketing · SG&A are manual (0 until entered). CAC = performance ad spend (Meta + Amazon + Google). COGS = units × standard cost. Fast-follow: Amazon platform-fee + RTO auto-feeds, per-channel split.
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
