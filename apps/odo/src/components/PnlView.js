'use client';
// One P&L page — scope = 'overall' (company master, full waterfall through EBITDA) OR a channel
// family key (that channel's waterfall through CM2). Rendered by the /pnl/* route pages. COGS +
// per-product P&L live under Products (/products/pnl), not here.
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, salesPost, istToday } from '../lib/api.js';
import { RangePicker, SegmentedToggle } from './kit.js';
import { FAMILIES } from '../lib/families.js';

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
const CHANNEL_LINES = LINES.slice(0, LINES.findIndex(l => l.key === 'cm2') + 1);
const AMZ_AUTO = new Set(['rto', 'logistics', 'platform_fee']);

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

function PnlTable({ rows, months, lines, channelKey, editable, autoLines, session, isAdmin, onSaved, mode }) {
  const [edit, setEdit] = useState(null);
  const [val, setVal] = useState('');
  const cols = months.map(m => withSubtotals(rows.find(r => r.month === m) || { month: m }));
  const total = {}; for (const L of lines) total[L.key] = cols.reduce((a, c) => a + (Number(c[L.key]) || 0), 0);
  const pct = mode === 'pct';
  const nmvByCol = cols.map(c => Number(c.nmv) || 0);
  const totalNmv = nmvByCol.reduce((a, b) => a + b, 0);
  const cellText = (v, base, isSub, canEdit) => { if (pct) return base ? `${(100 * v / base).toFixed(1)}%` : '—'; if (v === 0 && !isSub) return canEdit ? '—' : '0'; return rs(v); };
  const isMuted = (v, base, isSub) => (pct ? !base : (v === 0 && !isSub));
  const SUB_BG = 'color-mix(in srgb, var(--accent) 8%, transparent)';
  const save = async (m, key) => { setEdit(null); try { await salesPost('setPnlManual', { month: m.slice(0, 7), channel_key: channelKey, line_key: key, amount_inr: Math.round(Number(val) || 0) }, session); onSaved(); } catch { /* reload surfaces */ } };
  return (
    <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
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
    </div>
  );
}

export default function PnlView({ scope }) {
  const { session, perms } = useAuth();
  const isAdmin = !!(perms && perms.salesops_admin);
  const isOverall = scope === 'overall';
  const label = isOverall ? 'Company P&L' : (FAMILIES[scope]?.label || scope);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('abs');
  const [err, setErr] = useState('');

  useEffect(() => { const t = istToday(); const [y, m] = t.split('-').map(Number); setFrom(new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10)); setTo(t); }, []);
  const load = () => { if (from && to) salesGet('getPnl', { from, to }, session).then(d => setData(d || {})).catch(e => setErr(e.message || String(e))); };
  useEffect(() => { if (session && from && to) { setData(null); setErr(''); load(); } }, [session, from, to]);

  const months = data?.months || [];
  const rows = isOverall ? (data?.master || []) : ((data?.channels || {})[scope] || []);
  const lines = isOverall ? LINES : CHANNEL_LINES;
  const editable = isOverall ? new Set(['brand_marketing', 'sga']) : (scope === 'amazon' ? new Set() : new Set(['rto', 'logistics', 'platform_fee']));
  const autoLines = isOverall ? new Set() : (scope === 'amazon' ? AMZ_AUTO : new Set());

  return (
    <div className="so-page">
      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }}
        right={<><SegmentedToggle options={[['abs', '₹'], ['pct', '% of NMV']]} value={mode} onChange={setMode} size="sm" /><span className="so-sub" style={{ marginLeft: 10 }}>{isOverall ? 'Company · monthly' : `${label} · monthly`}</span></>} />
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!data ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div className="so-kpi-lbl">{label} <span className="so-sub" style={{ fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>· {mode === 'pct' ? '% of NMV' : '₹ monthly'}{isOverall ? '' : ' · rolls up to CM2'}{isAdmin && !isOverall && scope !== 'amazon' ? ' · click RTO/Logistics/Platform cells to edit' : ''}{isAdmin && isOverall ? ' · click Brand/SG&A cells to edit' : ''}</span></div>
          <PnlTable rows={rows} months={months} lines={lines} channelKey={isOverall ? 'all' : scope}
            editable={editable} autoLines={autoLines} session={session} isAdmin={isAdmin} onSaved={load} mode={mode} />
          {isOverall ? (
            <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
              GMV = booked value (tax-incl, net of discounts) · COGS = units × standard cost · CAC = performance ad spend. Amazon RTO + Platform Fee + Logistics auto-feed from settlement; other channels manual until connectors. RTO/Logistics/Platform here are channel rollups — edit them on each channel's P&L page. Brand Marketing = manual; SG&A wired to Podium salaries (0 until live). Odo-captured channels only.
            </div>
          ) : (
            <div className="so-sub" style={{ fontSize: 10.5, color: 'var(--t3)' }}>
              {scope === 'amazon' ? 'Amazon RTO / Platform Fee / Logistics auto-feed from settlement (marked auto). CAC = Amazon ad spend.' : 'RTO / Logistics / Platform Fee are manual for this channel until its connector lands (editable above). CAC attributed from ad platforms.'} Rolls up to CM2; company overheads (Brand, SG&A) sit on the Overall P&L.
            </div>
          )}
        </>
      )}
    </div>
  );
}
