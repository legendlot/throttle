'use client';
// One P&L page — scope = 'overall' (company master, full waterfall through EBITDA) OR a channel
// family key (that channel's waterfall through CM2). Rendered by the /pnl/* route pages. COGS +
// per-product P&L live under Products (/products/pnl), not here.
//
// Prism redesign (§4 + §9.6): scope selection moved OUT of the sidebar into the in-page tab strip
// below. Each tab still pushes its OWN existing route (/pnl/<scope>) — the URLs are 1:1 with the
// old rail items, so links and bookmarks keep working. The active tab derives from the `scope`
// prop, never from local state.
// EVERYTHING numeric here is arithmetic the business reads off directly: LINES + its order,
// CHANNEL_LINES truncation at CM2, withSubtotals, AMZ_AUTO, the editable sets and the admin gate
// are load-bearing product logic — this file was restyled, not re-computed.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Pencil } from 'lucide-react';
import { salesGet, salesPost, istToday, inr } from '../lib/api.js';
import { RangePicker, SegmentedToggle, Kpi } from './kit.js';
import { PageHead, PanelHead, ScopeTab, Nil } from './prism.js';
import { HUE, STATUS } from '../lib/hues.js';
import { FAMILIES, FAMILY_ORDER } from '../lib/families.js';

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

// Subtotal-row wash + the divider that fences the Total column off from the months (§9.6).
const SUB_BG = 'rgba(242,205,26,.07)';
const TOT_BD = '1px solid #2a2d35';

function PnlTable({ cols, months, lines, channelKey, editable, autoLines, session, isAdmin, onSaved, mode }) {
  const [edit, setEdit] = useState(null);
  const [val, setVal] = useState('');
  const total = {}; for (const L of lines) total[L.key] = cols.reduce((a, c) => a + (Number(c[L.key]) || 0), 0);
  const pct = mode === 'pct';
  const nmvByCol = cols.map(c => Number(c.nmv) || 0);
  const totalNmv = nmvByCol.reduce((a, b) => a + b, 0);
  const cellText = (v, base, isSub, canEdit) => { if (pct) return base ? `${(100 * v / base).toFixed(1)}%` : '—'; if (v === 0 && !isSub) return canEdit ? '—' : '0'; return rs(v); };
  const isMuted = (v, base, isSub) => (pct ? !base : (v === 0 && !isSub));
  const save = async (m, key) => { setEdit(null); try { await salesPost('setPnlManual', { month: m.slice(0, 7), channel_key: channelKey, line_key: key, amount_inr: Math.round(Number(val) || 0) }, session); onSaved(); } catch { /* reload surfaces */ } };
  return (
    // Horizontal scroll lives here so the sticky Line column pins against THIS box. The sticky
    // column must be OPAQUE (--surface-solid): the panel's translucent --surface would let the
    // months scroll visibly underneath it.
    <div style={{ overflowX: 'auto' }}>
      <table className="so-table" style={{ minWidth: 760 }}>
        <thead><tr>
          <th style={{ position: 'sticky', left: 0, background: 'var(--surface-solid)', zIndex: 2 }}>Line</th>
          {months.map(m => <th key={m} className="so-num">{monLabel(m)}</th>)}
          <th className="so-num" style={{ borderLeft: TOT_BD, color: 'var(--t1)' }}>Total</th>
        </tr></thead>
        <tbody>
          {lines.map(L => {
            const isSub = L.kind === 'sub';
            const isAuto = autoLines && autoLines.has(L.key);
            const canEdit = !pct && isAdmin && L.kind === 'manual' && editable && editable.has(L.key) && !isAuto;
            return (
              <tr key={L.key} style={isSub ? { background: SUB_BG, fontWeight: 700 } : undefined}>
                <td style={{ position: 'sticky', left: 0, zIndex: 1, background: isSub ? '#1c1e26' : 'var(--surface-solid)', fontWeight: isSub ? 700 : 400, color: isSub ? 'var(--t1)' : 'var(--t2)', whiteSpace: 'nowrap' }}>
                  {L.neg && !isSub ? <span style={{ color: 'var(--t3)' }}>− </span> : null}{L.label}
                  {isAuto ? <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t5)' }}>auto</span> : null}
                  {canEdit ? <Pencil size={11} strokeWidth={1.75} style={{ marginLeft: 6, color: 'var(--accent)', verticalAlign: -1 }} aria-label="editable" /> : null}
                </td>
                {cols.map((c, i) => {
                  const v = Number(c[L.key]) || 0, m = months[i];
                  const editing = canEdit && edit && edit.month === m && edit.key === L.key;
                  const muted = isMuted(v, nmvByCol[i], isSub);
                  const color = muted ? 'var(--t5)' : (isSub ? (v < 0 ? STATUS.bad : STATUS.good) : 'var(--t2-cell)');
                  return (
                    <td key={m} className="so-num" style={{ color, cursor: canEdit ? 'pointer' : 'default' }}
                      onClick={canEdit && !editing ? () => { setEdit({ month: m, key: L.key }); setVal(String(Math.round(v))); } : undefined}>
                      {editing ? (
                        <input autoFocus className="so-input" style={{ width: 92, padding: '2px 6px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--mono)' }}
                          value={val} onChange={e => setVal(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') save(m, L.key); if (e.key === 'Escape') setEdit(null); }}
                          onBlur={() => save(m, L.key)} />
                      ) : cellText(v, nmvByCol[i], isSub, canEdit)}
                    </td>
                  );
                })}
                <td className="so-num" style={{ borderLeft: TOT_BD, fontWeight: isSub ? 700 : 500, color: isSub ? (total[L.key] < 0 ? STATUS.bad : STATUS.good) : 'var(--t1)' }}>{cellText(total[L.key], totalNmv, isSub, false)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function PnlView({ scope }) {
  const router = useRouter();
  const { session, perms } = useAuth();
  // Super-admin, not admin: every P&L handler behind this view (getPnl, getPnlManual,
  // setPnlManual) is canSuperAdmin since S307. Deriving edit rights from salesops_admin would
  // render editable Brand/SG&A cells that 403 on save for an admin-without-super-admin.
  const isAdmin = !!(perms && perms.salesops_super_admin);
  const isOverall = scope === 'overall';
  const label = isOverall ? 'Company P&L' : (FAMILIES[scope]?.label || scope);
  const title = isOverall ? 'Company P&L' : `${FAMILIES[scope]?.label || scope} P&L`;
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

  // Same rows the table draws, hoisted so the 4-up summary reads the LAST month off the identical
  // withSubtotals output — no second aggregation, no second source of truth.
  const cols = months.map(m => withSubtotals(rows.find(r => r.month === m) || { month: m }));
  const last = cols.length ? cols[cols.length - 1] : null;
  const lastMon = months.length ? monLabel(months[months.length - 1]) : '';
  // The 4-up row is the LAST month only, sitting above a table whose Total column spans the whole
  // range — so the month has to be stated on every tile, and flagged when it's the in-progress
  // month (a 6-month default range ends mid-current-month, i.e. a part-month next to full ones).
  const isPartial = months.length ? months[months.length - 1].slice(0, 7) === istToday().slice(0, 7) : false;
  const monthTag = lastMon ? `${lastMon}${isPartial ? ' MTD' : ''}` : '—';
  const share = v => (last && last.nmv) ? `${(100 * v / last.nmv).toFixed(1)}% of NMV` : '—';
  // Month FIRST: .so-stat-sub is nowrap+ellipsis, so a long tail truncates before the month does.
  const sub = (v, tail) => (last ? `${monthTag} · ${share(v)} · ${tail}` : '—');
  const sign = v => (v < 0 ? STATUS.bad : STATUS.good);
  const kpiVal = (v, color) => (last ? <span style={color ? { color } : undefined}>{inr(v)}</span> : <Nil />);

  // The qualifier that used to sit above the table — kept verbatim, including the click-to-edit hint.
  const qual = `· ${mode === 'pct' ? '% of NMV' : '₹ monthly'}${isOverall ? '' : ' · rolls up to CM2'}${isAdmin && !isOverall && scope !== 'amazon' ? ' · click RTO/Logistics/Platform cells to edit' : ''}${isAdmin && isOverall ? ' · click Brand/SG&A cells to edit' : ''}`;

  return (
    <div className="so-page">
      <PageHead
        title={title}
        sub={isOverall ? 'Monthly waterfall through EBITDA · GMV → NMV → CM2 → EBITDA' : 'Monthly waterfall through CM2 · rolls up to the company P&L'}
        right={<SegmentedToggle options={[['abs', '₹'], ['pct', '% of NMV']]} value={mode} onChange={setMode} />} />

      {/* Scope strip — each tab is its own route, so the URL contract is unchanged. */}
      <div className="so-scopebar">
        <ScopeTab on={isOverall} color={HUE.primary} label="Company" title="Company P&L"
          onClick={() => router.push('/pnl/overall')} />
        {FAMILY_ORDER.map(k => (
          <ScopeTab key={k} on={scope === k} color={FAMILIES[k].color} label={FAMILIES[k].label}
            title={`${FAMILIES[k].label} P&L`} onClick={() => router.push('/pnl/' + k)} />
        ))}
      </div>

      <RangePicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {!data ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--t3)', marginBottom: -4 }}>
            Latest month only — <span style={{ fontFamily: 'var(--mono)', color: 'var(--t2)' }}>{monthTag}</span>
            {isPartial ? ' (month still in progress, figures to date). ' : '. '}
            The table below covers the full selected range.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <Kpi dense hue={HUE.primary} lbl="NMV / Revenue" val={kpiVal(last?.nmv ?? 0)} sub={monthTag} />
            <Kpi dense hue={HUE.gross} lbl="Gross Margin" val={kpiVal(last?.gm ?? 0, sign(last?.gm ?? 0))} sub={sub(last?.gm ?? 0, 'after COGS')} />
            <Kpi dense hue={HUE.units} lbl={isOverall ? 'CM2' : 'CM2 (channel)'} val={kpiVal(last?.cm2 ?? 0, sign(last?.cm2 ?? 0))} sub={sub(last?.cm2 ?? 0, 'after CAC')} />
            {isOverall
              ? <Kpi dense hue={HUE.derived} lbl="EBITDA" val={kpiVal(last?.ebitda ?? 0, sign(last?.ebitda ?? 0))} sub={sub(last?.ebitda ?? 0, 'after Brand + SG&A')} />
              : <Kpi dense hue={HUE.derived} lbl="COGS" val={kpiVal(last?.cogs ?? 0)} sub={sub(last?.cogs ?? 0, 'units × standard cost')} />}
          </div>

          <div className="so-card flush" style={{ overflow: 'hidden' }}>
            <PanelHead title={label} qual={qual} />
            <PnlTable cols={cols} months={months} lines={lines} channelKey={isOverall ? 'all' : scope}
              editable={editable} autoLines={autoLines} session={session} isAdmin={isAdmin} onSaved={load} mode={mode} />
          </div>

          {/* SG&A provenance. Only rendered once the source is actually Podium — while it is manual
              there is nothing to qualify. An incomplete salary run UNDERSTATES SG&A and therefore
              OVERSTATES EBITDA, so the coverage has to travel with the number rather than live in a
              doc nobody opens. */}
          {isOverall && data?.sga_meta && data.sga_meta.source !== 'manual' && (
            <div className="so-card" style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.6,
                 borderColor: data.sga_meta.missing_ctc > 0 ? 'var(--amber)' : undefined }}>
              {data.sga_meta.source === 'unknown'
                ? <strong style={{ color: 'var(--amber)' }}>SG&amp;A source could not be determined — treat this line as unverified.</strong>
                : <><strong>SG&amp;A source: Podium salaries</strong> · accrual on plan (CTC ÷ 12), not cash paid</>}
              {data.sga_meta.eligible ? <> · covering <strong>{data.sga_meta.counted} of {data.sga_meta.eligible}</strong> employees in {data.sga_meta.month}</> : null}
              {data.sga_meta.missing_ctc > 0 && (
                <div style={{ color: 'var(--amber)', marginTop: 4 }}>
                  ⚠ {data.sga_meta.missing_ctc} employee{data.sga_meta.missing_ctc === 1 ? ' has' : 's have'} no
                  compensation record, so SG&amp;A is understated and EBITDA correspondingly overstated.
                  Fix in Podium → Compensation; this figure corrects itself once the records exist.
                </div>
              )}
            </div>
          )}

          {isOverall ? (
            <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--t3)', maxWidth: 1100 }}>
              GMV = booked value (tax-incl, net of discounts) · COGS = units × standard cost · CAC = performance ad spend. Amazon RTO + Platform Fee + Logistics auto-feed from settlement; other channels manual until connectors. RTO/Logistics/Platform here are channel rollups — edit them on each channel's P&L page. Brand Marketing = manual; SG&A = Podium salary run (non-factory CTC ÷ 12) when switched on, manual otherwise. Odo-captured channels only.
            </div>
          ) : (
            <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--t3)', maxWidth: 1100 }}>
              {scope === 'amazon' ? 'Amazon RTO / Platform Fee / Logistics auto-feed from settlement (marked auto). CAC = Amazon ad spend.' : 'RTO / Logistics / Platform Fee are manual for this channel until its connector lands (editable above). CAC attributed from ad platforms.'} Rolls up to CM2; company overheads (Brand, SG&A) sit on the Overall P&L.
            </div>
          )}
        </>
      )}
    </div>
  );
}
