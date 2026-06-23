'use client';
/* ════════════════════════════════════════════════════════════
   Depot — Reporting Suite (Session 166)
   The dispatch team's one place for every report, any period.
   • Server-side scan-activity aggregation (public.get_dispatch_activity_report
     RPC) so the 100k+/mo scans table is never pulled into the worker.
   • Bundled fetch via lotopsproxy `getDispatchReports` (POST, reports-gated):
     activity + shipped-by-channel + shipments/challans/fulfilment/audits/
     counts/restocks aggregates with channel names resolved + raw rows.
   • On-screen tiles/charts/tables + a CSV button per report; the full
     scan log exports by paging the existing getAllScans.
   Gate = perms.reports (canDownload), same as every other system.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, KpiCard, useToast } from '@throttle/ui';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { useRefreshState } from '../layout.js';

// ── styles (match repack-runs/reports) ──────────────────────
const th    = { padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 12px', borderBottom: '1px solid rgba(64,64,64,.5)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)' };
const tdNum = { ...td, textAlign: 'right', fontWeight: 700 };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontFamily: 'var(--cond)', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', letterSpacing: '0.05em', textTransform: 'uppercase' };
const BAR   = 'var(--yellow)';
const sectionHead = { fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 8 };

const DISPATCH_ACTS = ['RTE','RTR','DTK','ALLOC','PACK','DOUT','RTO_IN','RTD_RETURN','REPACK_IN','REPACK_OUT'];
const ACT_LABELS = {
  RTE: 'Ready to Eship', RTR: 'Ready to Retail', DTK: 'Dock (handover)', ALLOC: 'Allocate',
  PACK: 'Pack', DOUT: 'Dispatch out', RTO_IN: 'RTO in', RTD_RETURN: 'RTD return',
  REPACK_IN: 'Repack in', REPACK_OUT: 'Repack out',
};
const OP_ACT_COLS = ['PACK','DTK','ALLOC','DOUT','RTE','RTR','RTO_IN','RTD_RETURN'];

function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function nf(n) { return (n == null || n === '') ? '—' : Number(n).toLocaleString('en-IN'); }
function inr(n) { return (n == null || n === '') ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }

function downloadCsv(filename, rows, columns) {
  if (!rows || !rows.length) return false;
  const lines = [columns.map(c => c.label).join(',')];
  for (const r of rows) lines.push(columns.map(c => JSON.stringify(r[c.key] ?? '')).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return true;
}

const PRESETS = [
  { id: 'today',   label: 'Today'      },
  { id: '7days',   label: '7 days'     },
  { id: '30days',  label: '30 days'    },
  { id: 'month',   label: 'This month' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'all',     label: 'All time'   },
  { id: 'custom',  label: 'Custom'     },
];
function rangeFor(preset) {
  const today = new Date();
  const to = fmtISO(today);
  if (preset === 'today')   return { from: to, to };
  if (preset === '7days')   { const d = new Date(today); d.setDate(d.getDate()-6);  return { from: fmtISO(d), to }; }
  if (preset === '30days')  { const d = new Date(today); d.setDate(d.getDate()-29); return { from: fmtISO(d), to }; }
  if (preset === 'month')   return { from: fmtISO(new Date(today.getFullYear(), today.getMonth(), 1)), to };
  if (preset === 'quarter') { const qm = today.getMonth() - (today.getMonth()%3); return { from: fmtISO(new Date(today.getFullYear(), qm, 1)), to }; }
  if (preset === 'all')     return { from: '', to: '' };
  return null; // custom
}

// horizontal ranked bar chart (by activity / line / channel / reason)
function RankChart({ title, data, dataKey = 'count', labelKey, colorFor }) {
  if (!data || !data.length) return null;
  return (
    <Panel header={title}>
      <div style={{ width: '100%', height: Math.max(160, data.length * 30) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
            <XAxis type="number" stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} allowDecimals={false} />
            <YAxis type="category" dataKey={labelKey} width={150} stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
            <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
            <Bar dataKey={dataKey} radius={[0,3,3,0]}>
              {data.map((d,i) => <Cell key={i} fill={colorFor ? colorFor(d) : BAR} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// vertical bar chart over an x-axis (by day / by hour)
function SeriesChart({ title, data, labelKey, dataKey = 'count' }) {
  if (!data || !data.length) return null;
  return (
    <Panel header={title}>
      <div style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
            <XAxis dataKey={labelKey} stroke="#666" tick={{ fontSize: 10, fontFamily: 'var(--mono)' }} interval="preserveStartEnd" />
            <YAxis stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} allowDecimals={false} width={44} />
            <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
            <Bar dataKey={dataKey} radius={[3,3,0,0]} fill={BAR} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function Table({ title, rows, columns, csvName, action }) {
  return (
    <Panel
      header={title}
      headerAction={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {action}
          {rows && rows.length ? <button style={btnS} onClick={() => downloadCsv(csvName, rows, columns)}>CSV</button> : null}
        </span>
      }
    >
      {!rows || rows.length === 0 ? <EmptyState message="No data in range." /> : (
        <div style={{ overflowX: 'auto', maxHeight: 460 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{columns.map(c => <th key={c.key} style={c.num ? { ...th, textAlign: 'right' } : th}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r,i) => (
                <tr key={i}>{columns.map(c => <td key={c.key} style={c.num ? tdNum : td}>{c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '—')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const allowed = !!perms?.reports;

  const [preset, setPreset] = useState('30days');
  const init = rangeFor('30days');
  const [from, setFrom] = useState(init.from);
  const [to, setTo]     = useState(init.to);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!session || !allowed) return;
    setLoading(true); setRefreshing?.(true);
    try {
      const body = {};
      if (from) body.from = from;
      if (to)   body.to = to;
      const r = await workerFetch('getDispatchReports', { data: body }, session);
      if (!r?.ok) { toast(r?.error || 'Failed to load reports', 'error'); setData(null); return; }
      setData(r.data);
      setLastRefreshed?.(new Date());
    } catch (e) {
      toast(e.message || 'Failed to load reports', 'error'); setData(null);
    } finally { setLoading(false); setRefreshing?.(false); }
  }, [session, allowed, from, to]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  function applyPreset(p) {
    setPreset(p);
    const r = rangeFor(p);
    if (r) { setFrom(r.from); setTo(r.to); }
  }

  // ── Full scan-log CSV — pages getAllScans (dispatch activities only) ──
  async function downloadScanLog() {
    if (!session) return;
    setExporting(true);
    try {
      const f = from || '2020-01-01';
      const t = to || fmtISO(new Date());
      const acts = DISPATCH_ACTS.join(',');
      const MAX_PAGES = 60; // 30k rows
      let offset = 0, all = [], capped = false;
      for (let i = 0; i < MAX_PAGES; i++) {
        const rows = await garageFetch('getAllScans',
          { date_from: f, date_to: t, activities: acts, offset, voided: 'false' }, session);
        const batch = Array.isArray(rows) ? rows : [];
        all = all.concat(batch);
        if (batch.length < 500) break;
        offset += 500;
        if (i === MAX_PAGES - 1) capped = true;
      }
      if (!all.length) { toast('No scans in range', 'error'); return; }
      const ok = downloadCsv(`dispatch-scan-log-${f}_${t}.csv`, all, [
        { key: 'timestamp',     label: 'Timestamp' },
        { key: 'activity',      label: 'Activity' },
        { key: 'upc',           label: 'UPC' },
        { key: 'unit_product',  label: 'Product' },
        { key: 'operator_name', label: 'Operator' },
        { key: 'line',          label: 'Line' },
        { key: 'station',       label: 'Station' },
        { key: 'batch_label',   label: 'Batch label' },
        { key: 'ean',           label: 'EAN' },
      ]);
      if (ok) toast(`Exported ${all.length.toLocaleString('en-IN')} scans${capped ? ' (capped — narrow the range for more)' : ''}`, capped ? 'error' : 'success');
    } catch (e) {
      toast(e.message || 'Scan-log export failed', 'error');
    } finally { setExporting(false); }
  }

  // ── derived view models ──────────────────────────────────
  const act = data?.activity || null;
  const operatorRows = useMemo(() => (act?.by_operator || []).map(o => {
    const a = o.acts || {};
    const row = { operator_name: o.operator_name, count: o.count };
    OP_ACT_COLS.forEach(k => { row[k] = a[k] || 0; });
    return row;
  }), [act]);
  const hourRows = useMemo(() => (act?.by_hour || []).map(h => ({ hour: `${String(h.hour).padStart(2,'0')}`, count: h.count })), [act]);
  const dayRows  = useMemo(() => (act?.by_day || []).map(d => ({ day: d.day.slice(5), count: d.count })), [act]);
  const actRows  = useMemo(() => (act?.by_activity || []).map(a => ({ ...a, label: ACT_LABELS[a.activity] || a.activity })), [act]);

  const rangeLabel = from || to ? `${from || '…'} → ${to || 'today'}` : 'All time';

  if (!allowed) {
    return <div style={{ padding: 16 }}><EmptyState message="Access denied — Reports need the reports permission. Ask an admin to enable it on your role." /></div>;
  }

  const t = act?.totals || {};
  const sh = data?.shipments, ch = data?.challans, fr = data?.fulfilment, au = data?.audits, ct = data?.counts, rs = data?.restocks;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Range picker */}
      <Panel
        header="Dispatch Reports"
        headerAction={
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>{rangeLabel}</span>
            <button style={btnS} onClick={load}>Refresh</button>
          </span>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {PRESETS.map(p => <Chip key={p.id} active={preset === p.id} onClick={() => applyPreset(p.id)}>{p.label}</Chip>)}
          {preset === 'custom' && (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 8 }}>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ ...btnS, color: 'var(--t1)' }} />
              <span style={{ color: 'var(--t3)' }}>→</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ ...btnS, color: 'var(--t1)' }} />
            </span>
          )}
        </div>
      </Panel>

      {loading ? (
        <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : !data ? (
        <EmptyState message="No report data." />
      ) : (
        <>
          {/* ── ACTIVITY (scans & operations) ───────────────── */}
          <div style={sectionHead}>Activity · Scans &amp; floor operations</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <KpiCard label="Dispatch scans" value={nf(t.total_scans)} />
            <KpiCard label="Operators" value={nf(t.operators)} />
            <KpiCard label="Lines active" value={nf(t.lines)} />
            <KpiCard label="Days with activity" value={nf(t.days)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            <RankChart title="Scans by activity" data={actRows} labelKey="label" />
            <RankChart title="Scans by line" data={act?.by_line} labelKey="line" />
            <SeriesChart title="Scans by day (IST)" data={dayRows} labelKey="day" />
            <SeriesChart title="Scans by hour of day (IST)" data={hourRows} labelKey="hour" />
          </div>
          <Table
            title="By activity"
            rows={actRows}
            columns={[
              { key: 'label',    label: 'Activity' },
              { key: 'activity', label: 'Code' },
              { key: 'count',    label: 'Scans', num: true, fmt: nf },
            ]}
            csvName={`dispatch-by-activity-${from||'all'}_${to||'today'}.csv`}
            action={<button style={{ ...btnS, color: 'var(--t1)', borderColor: 'var(--yellow)' }} disabled={exporting} onClick={downloadScanLog}>{exporting ? 'Exporting…' : 'Full scan log CSV'}</button>}
          />

          {/* ── OPERATORS (output) ──────────────────────────── */}
          <div style={sectionHead}>Operators · Dispatch output</div>
          <Table
            title="By operator"
            rows={operatorRows}
            columns={[
              { key: 'operator_name', label: 'Operator' },
              { key: 'count', label: 'Total', num: true, fmt: nf },
              ...OP_ACT_COLS.map(k => ({ key: k, label: k, num: true, fmt: nf })),
            ]}
            csvName={`dispatch-by-operator-${from||'all'}_${to||'today'}.csv`}
          />

          {/* ── OUTBOUND ────────────────────────────────────── */}
          <div style={sectionHead}>Outbound · Shipments, challans &amp; fulfilment</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <KpiCard label="Shipments" value={nf(sh?.total)} />
            <KpiCard label="Units packed-out" value={nf(sh?.units)} />
            <KpiCard label="Challans" value={nf(ch?.total)} />
            <KpiCard label="Challan value" value={inr(ch?.value)} />
            <KpiCard label="Fulfilment requests" value={nf(fr?.total)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            <RankChart title="Units dispatched by channel" data={(data.shipped_by_channel || []).map(r => ({ channel: r.channel_name || r.channel || '—', count: Number(r.units ?? r.count ?? r.qty ?? 0) }))} labelKey="channel" />
            <RankChart title="Shipments by channel" data={(sh?.by_channel || []).map(r => ({ channel: r.channel, count: r.shipments }))} labelKey="channel" />
            <SeriesChart title="Shipments by day (IST)" data={(sh?.by_day || []).map(d => ({ day: d.day.slice(5), count: d.count }))} labelKey="day" />
          </div>
          <Table
            title="Shipments"
            rows={sh?.rows}
            columns={[
              { key: 'shipment_no', label: 'Shipment' },
              { key: 'channel',     label: 'Channel' },
              { key: 'status',      label: 'Status' },
              { key: 'scheduled_date', label: 'Scheduled' },
              { key: 'packed_count',label: 'Packed', num: true, fmt: nf },
              { key: 'expected_units', label: 'Expected', num: true, fmt: nf },
              { key: 'tracking_status', label: 'Tracking' },
              { key: 'courier_partner', label: 'Courier' },
              { key: 'delivery_date', label: 'Delivered' },
              { key: 'sales_order_no', label: 'SO' },
            ]}
            csvName={`dispatch-shipments-${from||'all'}_${to||'today'}.csv`}
          />
          <Table
            title="Delivery challans"
            rows={ch?.rows}
            columns={[
              { key: 'challan_no',   label: 'Challan' },
              { key: 'challan_date', label: 'Date' },
              { key: 'status',       label: 'Status' },
              { key: 'to_name',      label: 'To' },
              { key: 'purpose',      label: 'Purpose' },
              { key: 'total_quantity', label: 'Qty', num: true, fmt: nf },
              { key: 'total_amount', label: 'Value', num: true, fmt: inr },
              { key: 'ewb_number',   label: 'E-way bill' },
            ]}
            csvName={`dispatch-challans-${from||'all'}_${to||'today'}.csv`}
          />
          <Table
            title="Fulfilment requests"
            rows={fr?.rows}
            columns={[
              { key: 'request_no',   label: 'Request' },
              { key: 'status',       label: 'Status' },
              { key: 'fulfilment_mode', label: 'Mode' },
              { key: 'channel',      label: 'Channel' },
              { key: 'partner_name', label: 'Partner' },
              { key: 'sales_order_no', label: 'SO' },
              { key: 'requested_units', label: 'Units', num: true, fmt: nf },
              { key: 'created_at',   label: 'Raised' },
            ]}
            csvName={`dispatch-fulfilment-${from||'all'}_${to||'today'}.csv`}
          />

          {/* ── RETURNS ─────────────────────────────────────── */}
          <div style={sectionHead}>Returns · Restocks &amp; repack</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            <RankChart title="Restocks by reason" data={(rs?.by_reason || []).map(r => ({ reason: r.key, count: r.count }))} labelKey="reason" />
            <RankChart title="Restocks by channel" data={(rs?.by_channel || []).map(r => ({ channel: r.key, count: r.count }))} labelKey="channel" />
          </div>
          <Table
            title="Restocks by reason"
            rows={(rs?.by_reason || []).map(r => ({ reason: r.key, count: r.count }))}
            columns={[{ key: 'reason', label: 'Reason' }, { key: 'count', label: 'Units', num: true, fmt: nf }]}
            csvName={`dispatch-restocks-${from||'all'}_${to||'today'}.csv`}
            action={<button style={btnS} onClick={() => router.push('/repack-runs/reports')}>Repack reports →</button>}
          />

          {/* ── AUDITS & COUNTS ─────────────────────────────── */}
          <div style={sectionHead}>Audits &amp; counts</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <KpiCard label="Stock audits" value={nf(au?.total)} />
            <KpiCard label="Audit missing" value={nf(au?.missing)} tone={au?.missing ? 'bad' : undefined} />
            <KpiCard label="Audit extra" value={nf(au?.extra)} />
            <KpiCard label="Corrected" value={nf(au?.corrected)} />
            <KpiCard label="Dispatch counts" value={nf(ct?.total)} />
          </div>
          <Table
            title="Stock audits"
            rows={au?.rows}
            columns={[
              { key: 'audit_no', label: 'Audit' },
              { key: 'status',   label: 'Status' },
              { key: 'area',     label: 'Area' },
              { key: 'present_count', label: 'Present', num: true, fmt: nf },
              { key: 'missing_count', label: 'Missing', num: true, fmt: nf },
              { key: 'extra_count',   label: 'Extra',   num: true, fmt: nf },
              { key: 'corrected_count', label: 'Corrected', num: true, fmt: nf },
              { key: 'opened_at',  label: 'Opened' },
              { key: 'reviewed_at',label: 'Reviewed' },
            ]}
            csvName={`dispatch-audits-${from||'all'}_${to||'today'}.csv`}
          />
          <Table
            title="Dispatch counts"
            rows={ct?.rows}
            columns={[
              { key: 'count_no',   label: 'Count' },
              { key: 'count_date', label: 'Date' },
              { key: 'status',     label: 'Status' },
              { key: 'area',       label: 'Area' },
              { key: 'expected_count', label: 'Expected', num: true, fmt: nf },
              { key: 'present_count',  label: 'Present',  num: true, fmt: nf },
              { key: 'missing_count',  label: 'Missing',  num: true, fmt: nf },
              { key: 'extra_count',    label: 'Extra',    num: true, fmt: nf },
            ]}
            csvName={`dispatch-counts-${from||'all'}_${to||'today'}.csv`}
          />
        </>
      )}
    </div>
  );
}
