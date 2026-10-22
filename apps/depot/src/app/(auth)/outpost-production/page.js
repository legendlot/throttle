'use client';
/* ════════════════════════════════════════════════════════════
   OUTPOST › PRODUCTION (S431 O13) — how many units each outsourced
   vendor makes, and at what pace. Redline's Hourly, for vendors.
   One read: outpostops getProduction → outpost.owner_production.
   Vendor (or All vendors) × range (Today … All time). Hours for a
   range of 2 days or less, days beyond. No daily target (volume
   follows demand): pace is shown against the vendor's own usual
   day (the 7 working days before the range) and against the open
   PO. No shift setup: the hour axis runs first pack → last pack.
   Stations are packing devices, not bench numbers (every Satish
   device is bench 1 so its labels print on the one laptop).
   Plan: docs/outpost/PRODUCTION_DASHBOARD_PLAN.md.
   ════════════════════════════════════════════════════════════ */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useRefreshState } from '../layout.js';
import { Panel, FilterChip, KpiTile, istTodayISO } from '../../../components/kit/index.js';
import { opGet, fmtIST } from '../../../lib/outpost.js';
import { ErrorPanel, Input, OwnerGate, Select, label, mono, smallBtn, text, useOutpostVendors } from '../../../components/outpost/OutpostKit.js';
import { addDays, axis, bucketLabel, colourway, csvCell, daysCover, HIST_COLS, historyProducts, historyView, OTHER, perHour, pivot, usual } from '../../../lib/production.mjs';

const num = v => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 }));
const td = { padding: 8, whiteSpace: 'nowrap' };
const th = { ...label, textAlign: 'left', padding: '6px 8px', whiteSpace: 'nowrap' };
const thN = { ...th, textAlign: 'right' };
const tdN = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const PALETTE = ['#F2CD1A', '#6d83ff', '#4ade80', '#f97316', '#c084fc', '#22d3ee', '#f472b6'];
const hrs = min => (min == null ? '—' : Number(min) >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);
const istNow = () => { const d = new Date(Date.now() + 5.5 * 3_600_000); return { h: d.getUTCHours(), m: d.getUTCMinutes() }; };
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['all', 'All time'], ['custom', 'Custom']];

function rangeFor(id, today, custom) {
  switch (id) {
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'all': return { from: 'all', to: today };
    case 'custom': return custom;
    default: return { from: today, to: today };
  }
}

function downloadCsv(name, head, rows) {
  const csv = [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}-${istTodayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
const CsvBtn = ({ onClick }) => <button style={smallBtn} onClick={onClick}>Export CSV</button>;

export default function OutpostProductionPage() {
  return <OwnerGate><ProductionInner /></OwnerGate>;
}

function ProductionInner() {
  const { session, userId } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const V = useOutpostVendors(session, userId);
  const today = istTodayISO();
  const [sel, setSel] = useState(null);                       // null = the default: All vendors when there are several
  const [rid, setRid] = useState('today');                    // range pickers default to Today
  const [custom, setCustom] = useState({ from: today, to: today });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const seq = useRef(0);

  const vendor = sel ?? (V.vendors.length > 1 ? 'all' : V.vendorId);
  const { from, to } = rangeFor(rid, today, custom);

  const load = async () => {
    if (!vendor) return;
    const mine = ++seq.current;                               // a slower, older reply (another range, an earlier poll) is dropped
    setRefreshing(true);
    try {
      const d = await opGet('getProduction', { vendor_id: vendor, from, to }, session);
      if (mine === seq.current) { setData(d); setErr(null); }
    } catch (e) { if (mine === seq.current) setErr(e.message); }
    finally { setRefreshing(false); setLastRefreshed(new Date()); }
  };
  useEffect(() => { setData(null); setErr(null); load(); /* eslint-disable-next-line */ }, [vendor, from, to]);
  // Live while the range includes today, like Redline's Hourly — but not All time, which is a long read. The poll calls the
  // latest `load` through a ref, so a refreshed session token is used rather than the one the interval started with.
  const loadRef = useRef(load);
  loadRef.current = load;
  const live = to === today && rid !== 'all';
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => loadRef.current(), 30_000);
    return () => clearInterval(t);
  }, [live, vendor, from, to]);

  if (V.loading) return <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (V.error) return <ErrorPanel error={V.error} onRetry={V.reload} />;
  if (!V.vendors.length) return <Panel pad={24}><div style={text}>No vendor is set up in Outpost yet — add one under Outpost › Vendors &amp; Devices.</div></Panel>;

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 260, maxWidth: '100%' }}>
          <Select value={String(vendor || '')} onChange={e => setSel(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All vendors</option>
            {V.vendors.map(v => <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name || `Vendor ${v.vendor_id}`}</option>)}
          </Select>
        </div>
        {RANGES.map(([k, n]) => <FilterChip key={k} active={rid === k} onClick={() => setRid(k)}>{n}</FilterChip>)}
        {rid === 'custom' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Input type="date" value={custom.from} min="2026-01-01" max={custom.to} onChange={e => e.target.value && setCustom(c => ({ ...c, from: e.target.value }))} style={{ width: 150 }} aria-label="From" />
            <span style={text}>to</span>
            <Input type="date" value={custom.to} min={custom.from} max={today} onChange={e => e.target.value && setCustom(c => ({ ...c, to: e.target.value }))} style={{ width: 150 }} aria-label="To" />
          </div>
        )}
      </div>
      {err && <ErrorPanel error={err} onRetry={load} />}
      {!data && !err && <div style={{ padding: 60, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}
      {data && <Production d={data} live={live} onPick={id => setSel(id)} />}
    </div>
  );
}

function Production({ d, live, onPick }) {
  const R = d.range;
  const T = d.totals || {};
  const multiVendor = (d.vendors || []).length > 1;
  const vName = useMemo(() => Object.fromEntries((d.vendors || []).map(v => [v.vendor_id, v.name])), [d.vendors]);
  const buckets = useMemo(() => axis(R, [...(d.series || []).map(s => s.t), ...(d.station_buckets || []).map(s => s.t)]), [d, R]);
  const multiDay = R.from !== R.to;
  const isToday = R.from === R.today && R.to === R.today;
  const now = istNow();
  const u = usual(d.baseline, { isToday, nowHour: now.h, nowMin: now.m, allTime: R.all_time });
  // One measure throughout: packs (a re-pack after an un-pack counts again, as it does on the chart and the baseline).
  const perDay = Number(T.days_worked) ? Number(T.packs) / Number(T.days_worked) : null;
  const pipeline = (d.skus || []).reduce((a, s) => a + Number(s.at_vendor) + Number(s.on_road) + Number(s.checked_in), 0);
  const toMake = (d.skus || []).reduce((a, s) => a + Math.max(Number(s.po_open || 0) - Number(s.at_vendor) - Number(s.on_road) - Number(s.checked_in), 0), 0);

  const vsUsual = !u ? (R.all_time ? 'Since the first pack' : 'No earlier working days to compare with yet')
    : isToday ? `Usual by this hour: ${num(u.byNow)} (avg of the last ${u.days} working days)`
      : `Usual day before this range: ${num(u.perDay)}`;
  const behind = u && (isToday ? Number(T.packs) < 0.85 * u.byNow : perDay != null && perDay < 0.85 * u.perDay);
  const repacks = Number(T.packs) - Number(T.new_units);

  return (
    <>
      <div style={{ ...text, fontSize: 12 }}>
        {R.all_time ? `All time — since the first pack on ${fmtIST(R.first_pack_at)}.` : multiDay ? `${R.from} to ${R.to}.` : `${R.from}.`}
        {' '}By {R.grain === 'hour' ? 'hour' : 'day'}, IST.{live ? ' Refreshes every 30 s.' : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KpiTile big label={isToday ? 'Packed today' : 'Units packed'} value={num(T.packs)}
          sub={`${vsUsual}${repacks > 0 ? ` · ${num(T.new_units)} new, ${num(repacks)} re-packed` : ''}`} tone={behind ? 'warn' : T.packs ? 'ok' : undefined} />
        <KpiTile label="Per working day" value={num(perDay == null ? null : Math.round(perDay))} sub={`${num(T.days_worked)} day${Number(T.days_worked) === 1 ? '' : 's'} with packing`} />
        <KpiTile label="Units per active hour" value={num(perHour(T.packs, T.active_min)?.toFixed(0))} sub={`Packing time ${hrs(T.active_min)} (gaps over 10 min left out)`} />
        <KpiTile label="Seconds per pack" value={num(T.median_gap_s == null ? null : Math.round(T.median_gap_s))} sub="Median, car scan to car scan on a station" />
        <KpiTile label="Stations · operators" value={`${num(T.stations)} · ${num(T.operators)}`} sub={T.first_at ? `First ${fmtIST(T.first_at)} · last ${fmtIST(T.last_at)}` : 'Nothing packed'} />
        <KpiTile label="Still to make on the PO" value={num(toMake)} sub={`All live PO lines, less ${num(pipeline)} packed and on the way · ${perDay ? `${num(daysCover(toMake, perDay)?.toFixed(1))} working days at this pace` : 'no pace yet'}`} />
        <KpiTile label="Un-packs" value={num(T.unpacks)} tone={Number(T.unpacks) ? 'warn' : undefined} sub="Units taken apart at the vendor in range" />
      </div>
      {multiVendor && <Vendors d={d} vName={vName} onPick={onPick} />}
      <OutputChart d={d} buckets={buckets} multiDay={multiDay} multiVendor={multiVendor} vName={vName} />
      <History d={d} multiVendor={multiVendor} vName={vName} />
      <StationGrid d={d} buckets={buckets} multiDay={multiDay} multiVendor={multiVendor} vName={vName} />
      <Operators d={d} multiVendor={multiVendor} vName={vName} />
      <Colourways d={d} perDay={perDay} days={Number(T.days_worked)} multiVendor={multiVendor} vName={vName} />
      <Orders d={d} multiVendor={multiVendor} vName={vName} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
        <Flow d={d} />
        <Quality d={d} />
      </div>
      <Stickers d={d} multiVendor={multiVendor} vName={vName} />
    </>
  );
}

// ── Output chart ────────────────────────────────────────────
function OutputChart({ d, buckets, multiDay, multiVendor, vName }) {
  const R = d.range;
  // More than 7 series: the rest fold into "Other" so the colours stay readable.
  const { rows, keys } = useMemo(() => pivot(d.series, buckets,
    multiVendor ? s => vName[s.vendor_id] || `Vendor ${s.vendor_id}` : colourway, PALETTE.length), [d.series, buckets, multiVendor, vName]);
  const usualAt = useMemo(() => {
    if (d.baseline?.kind === 'hour') {
      const m = Object.fromEntries((d.baseline.by_hour || []).map(h => [h.h, Number(h.avg)]));
      return t => m[Number(t.slice(11, 13))] ?? 0;
    }
    const m = Object.fromEntries((d.baseline?.by_day || []).map(x => [x.d, x.avg7 == null ? null : Number(x.avg7)]));
    return t => m[t] ?? null;
  }, [d.baseline]);
  const showUsual = d.baseline?.kind === 'hour' ? Number(d.baseline.days) > 0 : (d.baseline?.by_day || []).some(x => x.avg7 != null);
  // recharts reads a dataKey as a path ("Vortex 2.0" → ['Vortex 2', '0']), so each series gets a plain key and keeps its name.
  const data = rows.map(r => Object.assign({ label: bucketLabel(r.t, R.grain, multiDay), usual: showUsual ? usualAt(r.t) : undefined },
    ...keys.map((k, i) => ({ [`s${i}`]: r.v.get(k) || 0 }))));

  return (
    <Panel title={`Output by ${R.grain === 'hour' ? 'hour' : 'day'}`} pad={12}>
      {!rows.some(r => r.total) ? <div style={{ ...text, padding: 12 }}>Nothing packed in this range.</div> : (
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
              <XAxis dataKey="label" stroke="#666" tick={{ fontSize: 10, fontFamily: 'var(--mono)' }} interval="preserveStartEnd" />
              <YAxis stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} allowDecimals={false} width={44} />
              <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {keys.map((k, i) => <Bar key={k} dataKey={`s${i}`} name={k === OTHER ? 'Other' : k} stackId="u" fill={k === OTHER ? '#8c8c96' : PALETTE[i % PALETTE.length]} />)}
              {showUsual && <Line dataKey="usual" name={d.baseline.kind === 'hour' ? 'Usual for the hour' : 'Usual day (7 working days before)'}
                stroke="#e5e5e5" strokeDasharray="4 4" dot={false} connectNulls />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

// ── Station × time grid (Redline Hourly's line × hour) ──────
function StationGrid({ d, buckets, multiDay, multiVendor, vName }) {
  const R = d.range;
  const st = d.stations || [];
  const cell = useMemo(() => {
    const m = new Map();
    for (const b of d.station_buckets || []) m.set(`${b.device_id}|${b.t}`, Number(b.packs));
    return m;
  }, [d.station_buckets]);
  const max = Math.max(1, ...[...cell.values()]);
  const name = s => `${s.label || `Device ${s.device_id}`}${multiVendor ? ` · ${vName[s.vendor_id] || ''}` : ''}`;
  const csv = () => downloadCsv('outpost-stations', ['Station', 'Vendor', 'Bench', 'Packs', 'New units', 'Un-packs', 'Packing minutes', 'Units per active hour', 'Median seconds per pack', 'First pack (IST)', 'Last pack (IST)'],
    st.map(s => [s.label, vName[s.vendor_id], s.bench_no, s.packs, s.new_units, s.unpacks, s.active_min, perHour(s.packs, s.active_min)?.toFixed(1), s.median_gap_s, fmtIST(s.first_at), fmtIST(s.last_at)]));

  return (
    <Panel title={`Stations × ${R.grain === 'hour' ? 'hour' : 'day'}`} pad={8} action={st.length ? <CsvBtn onClick={csv} /> : null}>
      {!st.length ? <div style={{ ...text, padding: 12 }}>No station packed in this range.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
            <thead><tr>
              <th style={th}>Station</th>
              {buckets.map(t => <th key={t} style={{ ...thN, fontSize: 10 }}>{bucketLabel(t, R.grain, multiDay && R.grain === 'hour')}</th>)}
              <th style={thN}>Total</th><th style={thN}>Per hr</th><th style={thN}>s / pack</th>
            </tr></thead>
            <tbody>{st.map(s => (
              <tr key={s.device_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...text, ...td, color: 'var(--t1)' }}>{name(s)}</td>
                {buckets.map(t => {
                  const n = cell.get(`${s.device_id}|${t}`) || 0;
                  return <td key={t} style={{ ...tdN, ...mono, background: n ? `rgba(242,205,26,${(0.08 + 0.5 * n / max).toFixed(2)})` : undefined,
                    color: n ? 'var(--t1)' : 'var(--t4)' }}>{n || '·'}</td>;
                })}
                <td style={{ ...tdN, color: 'var(--t1)', fontWeight: 600 }}>{num(s.packs)}</td>
                <td style={tdN}>{num(perHour(s.packs, s.active_min)?.toFixed(0))}</td>
                <td style={tdN}>{num(s.median_gap_s == null ? null : Math.round(s.median_gap_s))}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Operators ───────────────────────────────────────────────
function Operators({ d, multiVendor, vName }) {
  const ops = d.operators || [];
  const csv = () => downloadCsv('outpost-operators', ['Operator code', 'Name', 'Vendor', 'Stations', 'Packs', 'Un-packs', 'Packing minutes', 'Units per active hour', 'Median seconds per pack', 'First pack (IST)', 'Last pack (IST)'],
    ops.map(o => [o.op_code, o.name, vName[o.vendor_id], o.stations, o.packs, o.unpacks, o.active_min, perHour(o.packs, o.active_min)?.toFixed(1), o.median_gap_s, fmtIST(o.first_at), fmtIST(o.last_at)]));
  return (
    <Panel title={`Operators (${ops.length})`} pad={8} action={ops.length ? <CsvBtn onClick={csv} /> : null}>
      {!ops.length ? <div style={{ ...text, padding: 12 }}>Nobody packed in this range.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>{['Operator', ...(multiVendor ? ['Vendor'] : [])].map(h => <th key={h} style={th}>{h}</th>)}
              {['Stations', 'Packs', 'Un-packs', 'Packing time', 'Per hr', 's / pack'].map(h => <th key={h} style={thN}>{h}</th>)}
              <th style={th}>First – last</th></tr></thead>
            <tbody>{ops.map(o => (
              <tr key={o.operator_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...text, ...td, color: 'var(--t1)' }}><span style={mono}>{o.op_code}</span> {o.name}</td>
                {multiVendor && <td style={{ ...text, ...td }}>{vName[o.vendor_id]}</td>}
                <td style={tdN}>{num(o.stations)}</td>
                <td style={{ ...tdN, color: 'var(--t1)', fontWeight: 600 }}>{num(o.packs)}</td>
                <td style={tdN}>{num(o.unpacks)}</td>
                <td style={tdN}>{hrs(o.active_min)}</td>
                <td style={tdN}>{num(perHour(o.packs, o.active_min)?.toFixed(0))}</td>
                <td style={tdN}>{num(o.median_gap_s == null ? null : Math.round(o.median_gap_s))}</td>
                <td style={{ ...text, ...td, fontSize: 12 }}>{fmtIST(o.first_at)} – {fmtIST(o.last_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {ops.length === 1 && (d.stations || []).length > 1 && (
        <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>Every station is signed in as the same operator, so this is the line, not a person. It splits by person once each packer has their own operator code.</div>
      )}
    </Panel>
  );
}

// ── Colourways against the PO ───────────────────────────────
function Colourways({ d, perDay, days, multiVendor, vName }) {
  const sk = d.skus || [];
  // A colourway only on the PO (nothing packed, nothing in the pipeline) folds away: with several vendors those rows
  // would bury the ones in production. "Still to make" above still counts them.
  const [showAll, setShowAll] = useState(false);
  const started = s => Number(s.packs) + Number(s.dtk) + Number(s.at_vendor) + Number(s.on_road) + Number(s.checked_in) + Number(s.lot) + Number(s.rejected) > 0;
  const notStarted = sk.filter(s => !started(s)).length;
  const shown = showAll ? sk : sk.filter(started);
  const noPoShown = shown.some(s => !Number(s.po_open) && Number(s.at_vendor) + Number(s.on_road) + Number(s.checked_in) > 0);
  const left = s => Math.max(Number(s.po_open || 0) - Number(s.at_vendor) - Number(s.on_road) - Number(s.checked_in), 0);
  const rate = s => (days ? Number(s.packs) / days : null);
  const csv = () => downloadCsv('outpost-colourways', ['Vendor', 'Product', 'Model', 'Colour', 'Sticker code', 'Packed in range', 'At vendor', 'On the road', 'Checked in', 'Through DTK in range', 'LOT stock and beyond', 'Rejected', 'PO ordered', 'PO received', 'PO open', 'Still to make', 'Working days left at this pace'],
    sk.map(s => [vName[s.vendor_id], s.product, s.model, s.color, s.sku, s.packs, s.at_vendor, s.on_road, s.checked_in, s.dtk, s.lot, s.rejected, s.po_ordered, s.po_received, s.po_open, left(s), daysCover(left(s), rate(s))?.toFixed(1)]));
  return (
    <Panel title="Colourways — made, where they are now, and the PO" pad={8} action={sk.length ? <CsvBtn onClick={csv} /> : null}>
      {!sk.length ? <div style={{ ...text, padding: 12 }}>Nothing made yet.</div> : !shown.length ? (
        <div style={{ ...text, padding: 12 }}>Nothing in production yet — all {sk.length} colourways are on the PO only.</div>) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
            <thead><tr><th style={th}>Colourway</th>{multiVendor && <th style={th}>Vendor</th>}
              {['Packed', 'At vendor', 'On the road', 'Checked in', 'Through DTK', 'LOT stock+', 'Rejected', 'PO ordered', 'PO open', 'Still to make', 'Days left'].map(h => <th key={h} style={thN}>{h}</th>)}</tr></thead>
            <tbody>{shown.map(s => (
              <tr key={rawKey(s)} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...text, ...td, color: 'var(--t1)' }}>{colourway(s)} <span style={{ ...mono, color: 'var(--t3)' }}>{s.sku}</span></td>
                {multiVendor && <td style={{ ...text, ...td }}>{vName[s.vendor_id]}</td>}
                <td style={{ ...tdN, color: 'var(--t1)', fontWeight: 600 }}>{num(s.packs)}</td>
                <td style={tdN}>{num(s.at_vendor)}</td>
                <td style={tdN}>{num(s.on_road)}</td>
                <td style={tdN}>{num(s.checked_in)}</td>
                <td style={tdN}>{num(s.dtk)}</td>
                <td style={tdN}>{num(s.lot)}</td>
                <td style={{ ...tdN, color: Number(s.rejected) ? 'var(--bad-fg)' : undefined }}>{num(s.rejected)}</td>
                <td style={tdN}>{num(s.po_ordered)}</td>
                <td style={tdN}>{num(s.po_open)}</td>
                <td style={{ ...tdN, color: !Number(s.po_open) && Number(s.at_vendor) ? 'var(--bad-fg)' : 'var(--t1)' }}>{Number(s.po_open) ? num(left(s)) : 'no PO'}</td>
                <td style={tdN}>{Number(s.po_open) ? num(daysCover(left(s), rate(s))?.toFixed(1)) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {notStarted > 0 && (
        <div style={{ padding: '6px 8px' }}>
          <button style={smallBtn} onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Hide colourways not started' : `Show ${notStarted} colourway${notStarted === 1 ? '' : 's'} on the PO, not started`}</button>
          {!showAll && noPoShown && <span style={{ ...text, fontSize: 12, marginLeft: 8 }}>A colourway marked &ldquo;no PO&rdquo; may be one of these under a different spelling on the PO line.</span>}
        </div>
      )}
      <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>
        Packed and Through DTK are for the range; the stage columns are where every unit is now. Still to make = PO open − units already packed or on the way.
        Days left = still to make ÷ this colourway&apos;s units per working day in the range{perDay ? '' : ' (no pace in this range)'}.
      </div>
    </Panel>
  );
}

// ── Open work orders ────────────────────────────────────────
function Orders({ d, multiVendor, vName }) {
  const os = d.orders || [];
  if (!os.length) return null;
  return (
    <Panel title={`Open work orders (${os.length})`} pad={8}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead><tr>{['Order', ...(multiVendor ? ['Vendor'] : []), 'SKU', 'Channel', 'Packaging'].map(h => <th key={h} style={th}>{h}</th>)}
            {['Target', 'Packed', 'In range', 'Done'].map(h => <th key={h} style={thN}>{h}</th>)}</tr></thead>
          <tbody>{os.map(o => (
            <tr key={o.wo_no} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ ...td, ...mono, color: 'var(--t1)' }}>{o.wo_no}</td>
              {multiVendor && <td style={{ ...text, ...td }}>{vName[o.vendor_id]}</td>}
              <td style={{ ...td, ...mono }}>{o.sku}</td>
              <td style={{ ...text, ...td }}>{o.channel || '—'}</td>
              <td style={{ ...text, ...td }}>{o.pack_type || '—'}</td>
              <td style={tdN}>{num(o.target_qty)}</td>
              <td style={{ ...tdN, color: 'var(--t1)', fontWeight: 600 }}>{num(o.packed)}</td>
              <td style={tdN}>{num(o.packed_in_range)}</td>
              <td style={tdN}>{o.target_qty ? `${Math.round(100 * Number(o.packed) / Number(o.target_qty))}%` : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Panel>
  );
}

// ── Flow: where stock waits ─────────────────────────────────
function Flow({ d }) {
  const F = d.flow || {};
  const sk = d.skus || [];
  const now = k => sk.reduce((a, s) => a + Number(s[k] || 0), 0);
  const leg = (name, x, wait) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 4px', borderTop: '1px solid var(--border)' }}>
      <div><div style={{ ...text, color: 'var(--t1)', fontWeight: 600 }}>{name}</div><div style={{ ...text, fontSize: 12 }}>{num(x?.units)} units in range · {wait}</div></div>
      <div style={{ ...mono, fontSize: 18, color: 'var(--t1)', alignSelf: 'center' }}>{x?.median_h == null ? '—' : `${num(x.median_h)} h`}</div>
    </div>
  );
  return (
    <Panel title="Flow — median wait per leg" pad={12}>
      {leg('Packed → dispatched', F.dispatched, `${num(now('at_vendor'))} at the vendor now`)}
      {leg('Dispatched → checked in at LOT', F.checked_in, `${num(now('on_road'))} on the road now`)}
      {leg('Checked in → through DTK (paid)', F.dtk, `${num(now('checked_in'))} checked in, waiting for DTK now`)}
    </Panel>
  );
}

// ── Quality by day ──────────────────────────────────────────
function Quality({ d }) {
  const q = d.quality || [];
  const tol = Object.values(d.tolerance || {}).map(Number);
  const per100 = (n, of) => (Number(of) ? (100 * Number(n) / Number(of)).toFixed(1) : '—');
  return (
    <Panel title={`Quality by day${tol.length === 1 ? ` — tolerance ${tol[0]}%` : ''}`} pad={8}>
      {!q.length ? <div style={{ ...text, padding: 12 }}>Nothing in this range.</div> : (
        <div style={{ overflowX: 'auto', maxHeight: 320 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Day</th>{['Packs', 'Un-packs', 'per 100', 'Rejected', 'per 100'].map((h, i) => <th key={i} style={thN}>{h}</th>)}</tr></thead>
            <tbody>{[...q].reverse().map(r => (
              <tr key={r.d} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ ...text, ...td }}>{bucketLabel(r.d, 'day')}</td>
                <td style={tdN}>{num(r.packs)}</td>
                <td style={tdN}>{num(r.unpacks)}</td>
                <td style={tdN}>{per100(r.unpacks, r.packs)}</td>
                <td style={{ ...tdN, color: Number(r.rejected) ? 'var(--bad-fg)' : undefined }}>{num(r.rejected)}</td>
                <td style={tdN}>{per100(r.rejected, r.packs)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>Rejected = failed at LOT on that day, against that day&apos;s packs: a trend, not the defect %. The defect % against tolerance is on Monitor › Reports.</div>
    </Panel>
  );
}

// ── Stickers ────────────────────────────────────────────────
function Stickers({ d, multiVendor, vName }) {
  const S = d.stickers || {};
  const oh = S.on_hand || [];
  const minted = (S.minted || []).reduce((a, m) => a + Number(m.n), 0);
  return (
    <Panel title={`Stickers on hand at the vendor — ${num(minted)} minted in range`} pad={8}>
      {!oh.length ? <div style={{ ...text, padding: 12 }}>No unused stickers at the vendor.</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead><tr>{[...(multiVendor ? ['Vendor'] : []), 'Sticker code'].map(h => <th key={h} style={th}>{h}</th>)}
              {['On hand', 'Used per working day', 'Days of cover'].map(h => <th key={h} style={thN}>{h}</th>)}</tr></thead>
            <tbody>{oh.map(s => {
              const cover = daysCover(s.on_hand, s.used_per_day);
              return (
                <tr key={`${s.vendor_id}|${s.product_code}`} style={{ borderTop: '1px solid var(--border)' }}>
                  {multiVendor && <td style={{ ...text, ...td }}>{vName[s.vendor_id]}</td>}
                  <td style={{ ...td, ...mono, color: 'var(--t1)' }}>{s.product_code}</td>
                  <td style={tdN}>{num(s.on_hand)}</td>
                  <td style={tdN}>{num(s.used_per_day)}</td>
                  <td style={{ ...tdN, color: cover != null && cover < 3 ? 'var(--warn-fg)' : undefined }}>{cover == null ? 'not in use' : num(cover.toFixed(1))}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>Used per working day = over the last 7 days the vendor packed (car and remote stickers counted separately). Under 3 days of cover is amber: time to mint more.</div>
    </Panel>
  );
}

// ── Vendors (All vendors) ───────────────────────────────────
function Vendors({ d, vName, onPick }) {
  const pipe = useMemo(() => {
    const m = {};
    for (const s of d.skus || []) {
      const v = (m[s.vendor_id] ||= { at_vendor: 0, on_road: 0, checked_in: 0, toMake: 0 });
      v.at_vendor += Number(s.at_vendor); v.on_road += Number(s.on_road); v.checked_in += Number(s.checked_in);
      v.toMake += Math.max(Number(s.po_open || 0) - Number(s.at_vendor) - Number(s.on_road) - Number(s.checked_in), 0);
    }
    return m;
  }, [d.skus]);
  const rows = d.by_vendor || [];
  const csv = () => downloadCsv('outpost-vendors', ['Vendor', 'Packs', 'New units', 'Per working day', 'Units per active hour', 'Median seconds per pack', 'Stations', 'Operators', 'At vendor now', 'On the road now', 'Checked in now', 'Still to make on the PO', 'Checked in (range)', 'Rejected (range)'],
    rows.map(v => { const p = pipe[v.vendor_id] || {}; return [vName[v.vendor_id], v.packs, v.new_units, Number(v.days_worked) ? (v.packs / v.days_worked).toFixed(1) : '',
      perHour(v.packs, v.active_min)?.toFixed(1), v.median_gap_s, v.stations, v.operators, p.at_vendor, p.on_road, p.checked_in, p.toMake, v.checked_in, v.rejected]; }));
  return (
    <Panel title={`Vendors (${rows.length})`} pad={8} action={<CsvBtn onClick={csv} />}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr><th style={th}>Vendor</th>
            {['Packed', 'Per day', 'Per hr', 's / pack', 'Stations', 'At vendor', 'On the road', 'Checked in', 'Still to make', 'Rejected'].map(h => <th key={h} style={thN}>{h}</th>)}</tr></thead>
          <tbody>{rows.map(v => {
            const p = pipe[v.vendor_id] || {};
            return (
              <tr key={v.vendor_id} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => onPick(v.vendor_id)} title="Show this vendor only">
                <td style={{ ...text, ...td, color: 'var(--t1)', fontWeight: 600 }}>{vName[v.vendor_id] || `Vendor ${v.vendor_id}`}</td>
                <td style={{ ...tdN, color: 'var(--t1)', fontWeight: 600 }}>{num(v.packs)}</td>
                <td style={tdN}>{Number(v.days_worked) ? num(Math.round(v.packs / v.days_worked)) : '—'}</td>
                <td style={tdN}>{num(perHour(v.packs, v.active_min)?.toFixed(0))}</td>
                <td style={tdN}>{num(v.median_gap_s == null ? null : Math.round(v.median_gap_s))}</td>
                <td style={tdN}>{num(v.stations)}</td>
                <td style={tdN}>{num(p.at_vendor ?? 0)}</td>
                <td style={tdN}>{num(p.on_road ?? 0)}</td>
                <td style={tdN}>{num(p.checked_in ?? 0)}</td>
                <td style={tdN}>{num(p.toMake ?? 0)}</td>
                <td style={{ ...tdN, color: Number(v.rejected) ? 'var(--bad-fg)' : undefined }}>{num(v.rejected)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>Packed, per day, per hour and rejected are for the range; the stage columns are now. Click a vendor to see only that vendor.</div>
    </Panel>
  );
}

// ── Production history (Redline's, for vendors) ─────────────
const HIST_HEAD = { made: 'Made', repacks: 'Re-packs', unpacks: 'Un-packs', dispatched: 'Dispatched', checked_in: 'Checked in', dtk: 'Through DTK' };
function History({ d, multiVendor, vName }) {
  const [q, setQ] = useState('');
  const days = useMemo(() => historyView(d.history, q), [d.history, q]);
  const [open, setOpen] = useState(() => new Set(days.length ? [days[0].d] : []));   // the newest day starts open
  const anyOpen = days.some(x => open.has(x.d));
  const products = useMemo(() => historyProducts(d.history), [d.history]);
  const toggle = day => setOpen(s => { const n = new Set(s); if (n.has(day)) n.delete(day); else n.add(day); return n; });
  const R = d.range;
  // One row per day × colourway, then a "Day total" row carrying the running total — a running figure on a colourway row
  // would be the day's, not the colourway's. A filtered export says so in its name.
  const slug = q.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const csv = () => downloadCsv(`outpost-production-history-${R.from}-to-${R.to}${slug ? `-only-${slug}` : ''}`,
    ['Date', 'Vendor', 'Product', 'Model', 'Colour', 'Made', 'Re-packs', 'Un-packs', 'Dispatched', 'Checked in', 'Through DTK (paid)', 'Made — running total'],
    [...days].reverse().flatMap(day => [
      ...day.rows.map(r => [r.d, vName[r.vendor_id], r.product, r.model, r.color, ...HIST_COLS.map(c => r[c]), '']),
      [day.d, '', 'Day total', '', '', ...HIST_COLS.map(c => day.tot[c]), day.running]]));
  const cell = (n, strong) => <td style={{ ...tdN, color: Number(n) ? (strong ? 'var(--t1)' : undefined) : 'var(--t4)', fontWeight: strong ? 600 : undefined }}>{Number(n) ? num(n) : '·'}</td>;
  return (
    <Panel title="Production history — day by day" pad={8} action={days.length ? <CsvBtn onClick={csv} /> : null}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        <Input list="op-hist-products" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter: product, model or colour" style={{ width: 260 }} />
        <datalist id="op-hist-products">{products.map(p => <option key={p} value={p} />)}</datalist>
        {q && <button style={smallBtn} onClick={() => setQ('')}>Clear</button>}
        {days.length > 0 && <button style={smallBtn} onClick={() => setOpen(anyOpen ? new Set() : new Set(days.map(x => x.d)))}>{anyOpen ? 'Collapse all' : 'Expand all'}</button>}
      </div>
      {!days.length ? <div style={{ ...text, padding: 12 }}>{q ? 'Nothing matches that filter in this range.' : 'Nothing happened in this range.'}</div> : (
        <div style={{ overflowX: 'auto', maxHeight: 520 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
            <thead><tr><th style={th}>Day · colourway</th>{multiVendor && <th style={th}>Vendor</th>}
              {HIST_COLS.map(c => <th key={c} style={thN}>{HIST_HEAD[c]}</th>)}<th style={thN}>Running total</th></tr></thead>
            <tbody>{days.map(day => (
              <HistDay key={day.d} day={day} expanded={open.has(day.d)} onToggle={() => toggle(day.d)} multiVendor={multiVendor} vName={vName} cell={cell} />
            ))}</tbody>
          </table>
        </div>
      )}
      <div style={{ ...text, fontSize: 12, padding: '6px 8px' }}>
        Made = a unit packed for the first time that day. Re-packs and un-packs are units taken apart and packed again. Dispatched, checked in and through DTK
        are the units that moved on that day, whenever they were made. Running total = units made from the first day shown. Click a day to see its colourways.
      </div>
    </Panel>
  );
}
const rawKey = r => `${r.vendor_id}|${r.product ?? ''}|${r.model ?? ''}|${r.color ?? ''}`;
function HistDay({ day, expanded, onToggle, multiVendor, vName, cell }) {
  const nCw = new Set(day.rows.map(r => `${r.product ?? ''}|${r.model ?? ''}|${r.color ?? ''}`)).size;   // one colourway made by 2 vendors is 1
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border-3, var(--border))', background: 'var(--surface-2, transparent)', cursor: 'pointer' }} onClick={onToggle}>
        <td style={{ ...text, ...td, color: 'var(--t1)', fontWeight: 600 }}>{expanded ? '▾' : '▸'} {bucketLabel(day.d, 'day')} <span style={{ color: 'var(--t3)', fontWeight: 400 }}>· {nCw} colourway{nCw === 1 ? '' : 's'}</span></td>
        {multiVendor && <td style={td} />}
        {HIST_COLS.map(c => <React.Fragment key={c}>{cell(day.tot[c], c === 'made')}</React.Fragment>)}
        <td style={{ ...tdN, color: 'var(--t1)' }}>{num(day.running)}</td>
      </tr>
      {expanded && day.rows.map(r => (
        <tr key={rawKey(r)} style={{ borderTop: '1px solid var(--border)' }}>
          <td style={{ ...text, ...td, paddingLeft: 26 }}>{colourway(r)}</td>
          {multiVendor && <td style={{ ...text, ...td }}>{vName[r.vendor_id]}</td>}
          {HIST_COLS.map(c => <React.Fragment key={c}>{cell(r[c], c === 'made')}</React.Fragment>)}
          <td style={td} />
        </tr>
      ))}
    </>
  );
}
