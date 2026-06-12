'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { KpiCard, Spinner, EmptyState, Panel, Chip, StatusBadge } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import { useDispatchChannels } from '../../../hooks/useDispatchChannels.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function pad(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

function formatPackedDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
}

// Map unit status → StatusBadge variant.
const UNIT_STATUS_MAP = {
  rtd:         { variant: 'neutral', label: 'PKG Out' },
  handed_over: { variant: 'brand',   label: 'With Dispatch' },
  allocated:   { variant: 'info',    label: 'Allocated' },
  shipped:     { variant: 'success', label: 'Shipped', icon: '✓' },
};

function ChannelTypeBadge({ type }) {
  const t = (type || 'other').toLowerCase();
  const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : 'neutral';
  return <StatusBadge variant={variant}>{type || '—'}</StatusBadge>;
}

function UnitStatusBadge({ status }) {
  const meta = UNIT_STATUS_MAP[status] || { variant: 'neutral', label: status || '—' };
  return <StatusBadge variant={meta.variant} icon={meta.icon}>{meta.label}</StatusBadge>;
}

function ChannelCard({ row, isSale }) {
  const showSaleColor = !!isSale;
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      padding: 14,
      opacity: showSaleColor ? 1 : 0.75,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.channel_name}
        </div>
        <ChannelTypeBadge type={row.channel_type} />
      </div>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 24, color: showSaleColor ? 'var(--green)' : 'var(--t2)', fontWeight: 700, lineHeight: 1 }}>
        {fmt(row.unit_count)}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 6, letterSpacing: '0.04em' }}>
        {showSaleColor ? 'Sale channel' : 'Non-sale'}
      </div>
    </div>
  );
}

// ── Dispatch Overview Page ────────────────────────────────────
export default function DispatchPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const { channels } = useDispatchChannels(session);

  const [counts,           setCounts]           = useState(null);
  const [units,            setUnits]            = useState([]);
  const [allocByChannel,   setAllocByChannel]   = useState([]);
  const [shippedByChannel, setShippedByChannel] = useState([]);
  const [loading,          setLoading]          = useState(false);
  const [unitsLoading,     setUnitsLoading]     = useState(false);

  const [statusFilter,     setStatusFilter]     = useState('');
  const [channelFilter,    setChannelFilter]    = useState('');
  const [dateFrom,         setDateFrom]         = useState('');
  const [dateTo,           setDateTo]           = useState('');

  const [shippedPreset,     setShippedPreset]    = useState('10days');
  const [shippedFrom,       setShippedFrom]      = useState('');
  const [shippedTo,         setShippedTo]        = useState('');
  const [shippedCustomFrom, setShippedCustomFrom] = useState('');
  const [shippedCustomTo,   setShippedCustomTo]   = useState('');

  // ── Apply preset ──────────────────────────────────────────
  function applyPreset(preset) {
    const today = new Date();
    const todayStr = fmtISO(today);
    if (preset === '10days') {
      const d = new Date(today); d.setDate(d.getDate() - 9);
      setShippedFrom(fmtISO(d)); setShippedTo(todayStr);
    } else if (preset === 'thisweek') {
      const d = new Date(today);
      const dow = d.getDay();
      const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
      d.setDate(diff);
      setShippedFrom(fmtISO(d)); setShippedTo(todayStr);
    } else if (preset === 'thismonth') {
      setShippedFrom(`${today.getFullYear()}-${pad(today.getMonth()+1)}-01`);
      setShippedTo(todayStr);
    } else if (preset === 'custom') {
      setShippedFrom(shippedCustomFrom);
      setShippedTo(shippedCustomTo);
    }
    setShippedPreset(preset);
  }

  const presetInitRef = useRef(false);
  useEffect(() => {
    if (presetInitRef.current) return;
    presetInitRef.current = true;
    applyPreset('10days');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Loaders ───────────────────────────────────────────────
  const loadOverview = useCallback(async () => {
    if (!session) return;
    if (!shippedFrom || !shippedTo) return;
    setRefreshing(true);
    setLoading(true);
    try {
      const [dash, alloc, shipped] = await Promise.allSettled([
        garageFetch('getDispatchDashboard',   {}, session),
        garageFetch('getAllocatedByChannel',  {}, session),
        garageFetch('getShippedByChannel',    { date_from: shippedFrom, date_to: shippedTo }, session),
      ]);
      if (dash.status === 'fulfilled')    setCounts(dash.value?.counts || null);
      if (alloc.status === 'fulfilled')   setAllocByChannel(Array.isArray(alloc.value) ? alloc.value : []);
      if (shipped.status === 'fulfilled') setShippedByChannel(Array.isArray(shipped.value) ? shipped.value : []);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [session, shippedFrom, shippedTo, setRefreshing, setLastRefreshed]);

  const loadUnits = useCallback(async () => {
    if (!session) return;
    setUnitsLoading(true);
    try {
      const params = { limit: '200' };
      if (statusFilter)  params.status     = statusFilter;
      if (channelFilter) params.channel_id = channelFilter;
      if (dateFrom)      params.date_from  = dateFrom;
      if (dateTo)        params.date_to    = dateTo;
      const data = await garageFetch('getDispatchDashboard', params, session);
      setUnits(Array.isArray(data?.units) ? data.units : []);
      if (data?.counts) setCounts(data.counts);
    } catch (_) {
      setUnits([]);
    } finally {
      setUnitsLoading(false);
    }
  }, [session, statusFilter, channelFilter, dateFrom, dateTo]);

  // Auto-refresh the overview only
  useAutoRefresh(loadOverview, 30000, !session || !shippedFrom || !shippedTo);

  // Reload units whenever filters change (debounced via re-renders is fine)
  useEffect(() => { loadUnits(); }, [loadUnits]);

  // ── KPI cards ─────────────────────────────────────────────
  const c = counts || {};

  // ── Sent-out summary line ─────────────────────────────────
  const saleTotal     = shippedByChannel.filter(r => r.is_sale).reduce((s, r) => s + (r.unit_count || 0), 0);
  const nonSaleTotal  = shippedByChannel.filter(r => !r.is_sale).reduce((s, r) => s + (r.unit_count || 0), 0);
  const shippedTotal  = saleTotal + nonSaleTotal;

  // ── Style constants ───────────────────────────────────────
  const dateInputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
  const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 13, padding: '6px 10px', borderRadius: 3, outline: 'none', cursor: 'pointer' };
  const sectionLabel = { margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };
  const refreshBtnStyle = { padding: '7px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer' };

  return (
    <div>
      {/* Live Dispatch Status */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionLabel}>Live Dispatch Status</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          <KpiCard label="PKG Out"        value={fmt(c.rtd_count)}          sub="Awaiting handover" />
          <KpiCard label="With Dispatch"  value={fmt(c.handed_over_count)}  sub="To allocate"        color={c.handed_over_count > 0 ? 'yellow' : undefined} />
          <KpiCard label="Allocated"      value={fmt(c.allocated_count)}    sub="Awaiting ship"      color={c.allocated_count > 0 ? 'blue' : undefined} />
          <KpiCard label="Shipped"        value={fmt(c.shipped_count)}      sub="Total shipped"      color="green" />
        </div>
      </section>

      {/* Allocated — Awaiting Dispatch */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionLabel}>Allocated — Awaiting Dispatch</h2>
        {allocByChannel.length === 0 ? (
          <Panel padding={0}>
            <EmptyState message="No allocated units" />
          </Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {allocByChannel.map((row, i) => <ChannelCard key={`${row.channel_name}-${i}`} row={row} isSale={row.is_sale} />)}
          </div>
        )}
      </section>

      {/* Sent Out by Channel */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 style={{ ...sectionLabel, marginBottom: 0 }}>Sent Out by Channel</h2>
          <div style={{ flex: 1 }} />
          <Chip active={shippedPreset === '10days'}    onClick={() => applyPreset('10days')}>10 Days</Chip>
          <Chip active={shippedPreset === 'thisweek'}  onClick={() => applyPreset('thisweek')}>This Week</Chip>
          <Chip active={shippedPreset === 'thismonth'} onClick={() => applyPreset('thismonth')}>This Month</Chip>
          <Chip active={shippedPreset === 'custom'}    onClick={() => applyPreset('custom')}>Custom</Chip>
        </div>
        {shippedPreset === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>From</span>
            <input type="date" style={dateInputStyle} value={shippedCustomFrom} onChange={e => { setShippedCustomFrom(e.target.value); setShippedFrom(e.target.value); }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>To</span>
            <input type="date" style={dateInputStyle} value={shippedCustomTo} onChange={e => { setShippedCustomTo(e.target.value); setShippedTo(e.target.value); }} />
          </div>
        )}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 12, letterSpacing: '0.04em' }}>
          <span style={{ color: 'var(--green)' }}>{fmt(saleTotal)} sold</span>
          {' · '}
          <span>{fmt(nonSaleTotal)} non-sale</span>
          {' · '}
          <span style={{ color: 'var(--t1)' }}>{fmt(shippedTotal)} total</span>
        </div>
        {shippedByChannel.length === 0 ? (
          <Panel padding={0}>
            <EmptyState message="No units shipped in this range" />
          </Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {shippedByChannel.map((row, i) => <ChannelCard key={`${row.channel_name}-${i}`} row={row} isSale={row.is_sale} />)}
          </div>
        )}
      </section>

      {/* Units */}
      <section>
        <h2 style={sectionLabel}>Units</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <select style={selectStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="rtd">PKG Out</option>
            <option value="handed_over">With Dispatch</option>
            <option value="allocated">Allocated</option>
            <option value="shipped">Shipped</option>
          </select>
          <select style={selectStyle} value={channelFilter} onChange={e => setChannelFilter(e.target.value)}>
            <option value="">All Channels</option>
            {channels.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input type="date" style={dateInputStyle} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>to</span>
          <input type="date" style={dateInputStyle} value={dateTo}   onChange={e => setDateTo(e.target.value)} />
          <div style={{ flex: 1 }} />
          <button style={refreshBtnStyle} onClick={loadUnits} disabled={unitsLoading}>↻ Refresh</button>
        </div>

        <Panel padding={0}>
          {unitsLoading ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : units.length === 0 ? (
            <EmptyState message="No units match these filters" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Batch Label','Product','Line','Channel','Shipment','Packed','Status'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {units.map((u, i) => (
                    <tr key={`${u.batch_label}-${i}`}>
                      <td style={{ ...tdStyle, color: 'var(--yellow)', fontWeight: 600 }}>{u.batch_label || '—'}</td>
                      <td style={tdStyle}>
                        {u.product || '—'}
                        {(u.model || u.color) && (
                          <span style={{ color: 'var(--t3)', marginLeft: 8, fontSize: 12 }}>
                            {[u.model, u.color].filter(Boolean).join(' ')}
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{u.line || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>
                        {u.channel_name ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            {u.channel_name}
                            <ChannelTypeBadge type={u.channel_type} />
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{u.shipment_no || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t3)' }}>{formatPackedDate(u.packed_at)}</td>
                      <td style={tdStyle}><UnitStatusBadge status={u.current_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}
