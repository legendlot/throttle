'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, KpiCard, useToast } from '@throttle/ui';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { canManageRepack } from '../new/page';

const th = { padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td = { padding: '8px 12px', borderBottom: '1px solid rgba(64,64,64,.5)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)' };
const tdNum = { ...td, textAlign: 'right', fontWeight: 700 };
const btnS = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontFamily: 'var(--cond)', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', letterSpacing: '0.05em', textTransform: 'uppercase' };

const BAR = 'var(--yellow)';
const DIR_COLORS = { 'retail → ecom': '#34d399', 'ecom → retail': '#60a5fa' };

function fmtISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function downloadCsv(filename, rows, headers) {
  if (!rows || !rows.length) return false;
  const lines = [headers.map(h => h.label).join(',')];
  for (const r of rows) lines.push(headers.map(h => JSON.stringify(r[h.key] ?? '')).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return true;
}

const PRESETS = [
  { id: '7days',  label: '7 days'  },
  { id: '30days', label: '30 days' },
  { id: 'month',  label: 'This month' },
  { id: 'all',    label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

function rangeFor(preset) {
  const today = new Date();
  const to = fmtISO(today);
  if (preset === '7days')  { const d = new Date(today); d.setDate(d.getDate() - 6);  return { from: fmtISO(d), to }; }
  if (preset === '30days') { const d = new Date(today); d.setDate(d.getDate() - 29); return { from: fmtISO(d), to }; }
  if (preset === 'month')  { return { from: fmtISO(new Date(today.getFullYear(), today.getMonth(), 1)), to }; }
  if (preset === 'all')    { return { from: '', to: '' }; }
  return null; // custom — caller keeps current values
}

function ChartCard({ title, data, dataKey, labelKey, colorFor }) {
  if (!data || !data.length) return null;
  return (
    <Panel header={title}>
      <div style={{ width: '100%', height: Math.max(180, data.length * 34) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
            <XAxis type="number" stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} allowDecimals={false} />
            <YAxis type="category" dataKey={labelKey} width={150} stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
            <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} cursor={{ fill: 'rgba(255,255,255,.04)' }} />
            <Bar dataKey={dataKey} radius={[0, 3, 3, 0]}>
              {data.map((d, i) => <Cell key={i} fill={colorFor ? colorFor(d) : BAR} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function Table({ title, rows, columns, csvName }) {
  return (
    <Panel
      header={title}
      headerAction={rows.length ? <button style={btnS} onClick={() => downloadCsv(csvName, rows, columns)}>CSV</button> : null}
    >
      {rows.length === 0 ? <EmptyState message="No data in range." /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{columns.map(c => <th key={c.key} style={c.num ? { ...th, textAlign: 'right' } : th}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{columns.map(c => <td key={c.key} style={c.num ? tdNum : td}>{r[c.key] ?? '—'}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function RepackReportsPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = canManageRepack(perms);

  const [preset, setPreset] = useState('30days');
  const init = rangeFor('30days');
  const [from, setFrom] = useState(init.from);
  const [to, setTo]     = useState(init.to);
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!session || !allowed) return;
    setLoading(true);
    try {
      const body = {};
      if (from) body.from = from;
      if (to)   body.to = to;
      const r = await workerFetch('getRepackReports', { data: body }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); setData(null); return; }
      setData(r.data);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
      setData(null);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, from, to]);

  function applyPreset(p) {
    setPreset(p);
    const r = rangeFor(p);
    if (r) { setFrom(r.from); setTo(r.to); }
  }

  const hourRows = useMemo(() => (data?.byHour || []).map(h => ({
    hour: `${String(h.hour).padStart(2, '0')}:00`, count: h.count,
  })), [data]);

  if (!allowed) {
    return <div style={{ padding: 16 }}><EmptyState message="Access denied — you need repack_run_manage (or dispatch) permission." /></div>;
  }

  const t = data?.totals || {};

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel
        header="Repack Reports · Channel Swap Analytics"
        headerAction={<button onClick={() => router.push('/repack-runs')} style={btnS}>← Runs</button>}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {PRESETS.map(p => (
            <Chip key={p.id} active={preset === p.id} onClick={() => applyPreset(p.id)}>{p.label}</Chip>
          ))}
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
      ) : !data || t.swaps === 0 ? (
        <EmptyState message="No completed channel swaps in this range." />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <KpiCard label="Swaps" value={t.swaps} />
            <KpiCard label="Products" value={t.products} />
            <KpiCard label="Lines" value={t.lines} />
            <KpiCard label="Operators" value={t.operators} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            <ChartCard
              title="By direction (from → to)"
              data={data.byDirection} dataKey="count" labelKey="label"
              colorFor={d => DIR_COLORS[d.label] || BAR}
            />
            <ChartCard title="By product" data={data.byProduct} dataKey="count" labelKey="product" />
            <ChartCard title="By line" data={data.byLine} dataKey="count" labelKey="line" />
            <ChartCard
              title="By hour of day (IST)"
              data={hourRows.filter(h => h.count > 0)} dataKey="count" labelKey="hour"
            />
          </div>

          <Table
            title="By product / colour"
            rows={data.byVariant}
            columns={[
              { key: 'product', label: 'Product' },
              { key: 'model',   label: 'Model'   },
              { key: 'colour',  label: 'Colour'  },
              { key: 'count',   label: 'Swaps', num: true },
            ]}
            csvName={`repack-by-variant-${from || 'all'}-${to || 'all'}.csv`}
          />

          <Table
            title="By operator"
            rows={data.byOperator}
            columns={[
              { key: 'operator_name', label: 'Operator' },
              { key: 'count',         label: 'Swaps', num: true },
            ]}
            csvName={`repack-by-operator-${from || 'all'}-${to || 'all'}.csv`}
          />

          <Table
            title="By day"
            rows={data.byDay}
            columns={[
              { key: 'date',  label: 'Date (IST)' },
              { key: 'count', label: 'Swaps', num: true },
            ]}
            csvName={`repack-by-day-${from || 'all'}-${to || 'all'}.csv`}
          />
        </>
      )}
    </div>
  );
}
