'use client';
/* ════════════════════════════════════════════════════════════
   Depot Overview — live warehouse cockpit (Phase 2, Session 141).
   Built entirely on existing cheap lotopsproxy reads (NO worker
   change): getDispatchDashboard (counts), getDispatchLineView
   (today's floor), getAllocatedByChannel, getDispatchPipeline
   (on-hand finished goods by product), getShippedByChannel.
   ════════════════════════════════════════════════════════════ */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { KpiCard, Panel, Chip, EmptyState, Spinner, StatusBadge, ProgressBar } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtClock(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  } catch { return '—'; }
}

// ── Shared style constants (Pit Wall tokens) ──────────────────
const sectionLabel = { margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };
const numTd = { ...tdStyle, textAlign: 'right' };
const numTh = { ...thStyle, textAlign: 'right' };

function ChannelTypeBadge({ type }) {
  const t = (type || 'other').toLowerCase();
  const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : 'neutral';
  return <StatusBadge variant={variant}>{type || '—'}</StatusBadge>;
}

// ── Allocated / shipped channel card ──────────────────────────
function ChannelCard({ row }) {
  const sale = !!row.is_sale;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 14, opacity: sale ? 1 : 0.78 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.channel_name}
        </div>
        <ChannelTypeBadge type={row.channel_type} />
      </div>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 24, color: sale ? 'var(--green)' : 'var(--t2)', fontWeight: 700, lineHeight: 1 }}>
        {fmt(row.unit_count)}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 6, letterSpacing: '0.04em' }}>
        {sale ? 'Sale channel' : 'Non-sale'}
      </div>
    </div>
  );
}

// ── Today's line card (D1/D2) ─────────────────────────────────
function LineCard({ row }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, letterSpacing: '0.05em', color: 'var(--t1)' }}>{row.line}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          {row.active_operators || 0} op{(row.active_operators || 0) === 1 ? '' : 's'} · last {fmtClock(row.last_scan_at)}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
        {[
          { k: 'Packed',     v: row.pack_count,  c: 'var(--t1)' },
          { k: 'Allocated',  v: row.alloc_count, c: 'var(--blue)' },
          { k: 'Dispatched', v: row.dout_count,  c: 'var(--green)' },
        ].map(s => (
          <div key={s.k}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, color: s.c, lineHeight: 1 }}>{fmt(s.v)}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>{s.k}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(row.active_channels || []).length === 0
          ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>No channel yet</span>
          : (row.active_channels || []).map(ch => (
              <span key={ch} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 8px' }}>{ch}</span>
            ))}
      </div>
    </div>
  );
}

// ── Overview page ─────────────────────────────────────────────
export default function DepotOverview() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [counts,    setCounts]    = useState(null);
  const [lines,     setLines]     = useState([]);
  const [alloc,     setAlloc]     = useState([]);
  const [stock,     setStock]     = useState(null);   // pipeline products
  const [stockLoad, setStockLoad] = useState(false);
  const [shipped,   setShipped]   = useState([]);
  const [shippedLoad, setShippedLoad] = useState(false);

  const [preset,     setPreset]     = useState('10days');
  const [shippedFrom, setShippedFrom] = useState('');
  const [shippedTo,   setShippedTo]   = useState('');
  const [customFrom,  setCustomFrom]  = useState('');
  const [customTo,    setCustomTo]    = useState('');

  // ── Live reads (cheap RPCs) — auto-refresh 30s ──────────────
  const loadLive = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const [dash, lv, ab] = await Promise.allSettled([
        garageFetch('getDispatchDashboard',  { limit: '1' }, session),
        garageFetch('getDispatchLineView',   {}, session),
        garageFetch('getAllocatedByChannel', {}, session),
      ]);
      if (dash.status === 'fulfilled') setCounts(dash.value?.counts || null);
      if (lv.status   === 'fulfilled') setLines(Array.isArray(lv.value?.dispatch_lines) ? lv.value.dispatch_lines : []);
      if (ab.status   === 'fulfilled') setAlloc(Array.isArray(ab.value) ? ab.value : []);
    } finally {
      setRefreshing(false);
      setLastRefreshed(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }));
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadLive, 30000, !session);

  // ── On-hand stock by product (heavier pipeline read) — once + manual ──
  const loadStock = useCallback(async () => {
    if (!session) return;
    setStockLoad(true);
    try {
      const r = await garageFetch('getDispatchPipeline', {}, session);
      setStock(Array.isArray(r?.products) ? r.products : []);
    } catch { setStock([]); }
    finally { setStockLoad(false); }
  }, [session]);

  useEffect(() => { loadStock(); }, [loadStock]);

  // ── Shipped by channel (date presets) ───────────────────────
  function applyPreset(p) {
    const today = new Date();
    const todayStr = fmtISO(today);
    if (p === '10days') {
      const d = new Date(today); d.setDate(d.getDate() - 9);
      setShippedFrom(fmtISO(d)); setShippedTo(todayStr);
    } else if (p === 'thisweek') {
      const d = new Date(today); const dow = d.getDay();
      d.setDate(d.getDate() - dow + (dow === 0 ? -6 : 1));
      setShippedFrom(fmtISO(d)); setShippedTo(todayStr);
    } else if (p === 'thismonth') {
      setShippedFrom(`${today.getFullYear()}-${pad(today.getMonth()+1)}-01`); setShippedTo(todayStr);
    } else if (p === 'custom') {
      setShippedFrom(customFrom); setShippedTo(customTo);
    }
    setPreset(p);
  }

  const presetInit = useRef(false);
  useEffect(() => {
    if (presetInit.current) return;
    presetInit.current = true;
    applyPreset('10days');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadShipped = useCallback(async () => {
    if (!session || !shippedFrom || !shippedTo) return;
    setShippedLoad(true);
    try {
      const r = await garageFetch('getShippedByChannel', { date_from: shippedFrom, date_to: shippedTo }, session);
      setShipped(Array.isArray(r) ? r : []);
    } catch { setShipped([]); }
    finally { setShippedLoad(false); }
  }, [session, shippedFrom, shippedTo]);

  useEffect(() => { loadShipped(); }, [loadShipped]);

  // ── Derived ─────────────────────────────────────────────────
  const c = counts || {};
  const inArea = (c.rtd_count || 0) + (c.handed_over_count || 0) + (c.allocated_count || 0);

  const todayPacked     = lines.reduce((s, l) => s + (l.pack_count  || 0), 0);
  const todayAllocated  = lines.reduce((s, l) => s + (l.alloc_count || 0), 0);
  const todayDispatched = lines.reduce((s, l) => s + (l.dout_count  || 0), 0);
  const todayOperators  = lines.reduce((s, l) => s + (l.active_operators || 0), 0);

  const allocTotal = alloc.reduce((s, r) => s + (r.unit_count || 0), 0);
  const allocSorted = [...alloc].sort((a, b) => (b.unit_count || 0) - (a.unit_count || 0));

  const shippedSale    = shipped.filter(r => r.is_sale).reduce((s, r) => s + (r.unit_count || 0), 0);
  const shippedNonSale = shipped.filter(r => !r.is_sale).reduce((s, r) => s + (r.unit_count || 0), 0);
  const shippedTotal   = shippedSale + shippedNonSale;
  const shippedSorted  = [...shipped].sort((a, b) => (b.unit_count || 0) - (a.unit_count || 0));

  // On-hand finished goods by product (RTD + with-dispatch), allocated separate
  const stockRows = (stock || []).map(p => {
    const t = p.totals || {};
    const withDispatch = (t.unallocated_retail || 0) + (t.unallocated_ecom || 0);
    const allocated = Object.values(t.channels || {}).reduce((s, n) => s + n, 0);
    const onHand = (t.with_production || 0) + withDispatch;
    return { product: p.product, rtd: t.with_production || 0, withDispatch, allocated, onHand };
  }).filter(r => r.onHand + r.allocated > 0)
    .sort((a, b) => (b.onHand + b.allocated) - (a.onHand + a.allocated));
  const stockOnHandTotal = stockRows.reduce((s, r) => s + r.onHand, 0);

  // funnel proportions
  const funnelMax = Math.max(c.rtd_count || 0, c.handed_over_count || 0, c.allocated_count || 0, 1);

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* ── Hero: in the dispatch area ─────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
          <div>
            <h1 className="font-display" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Depot</h1>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)' }}>Warehouse · finished goods · dispatch</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--cond)', fontSize: 40, fontWeight: 800, color: 'var(--yellow)', lineHeight: 1 }}>{fmt(inArea)}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>units in the dispatch area</div>
          </div>
        </div>

        {/* funnel */}
        <Panel padding={18}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
            {[
              { label: 'PKG Out',       sub: 'Awaiting handover', val: c.rtd_count,         tone: 'warn',  color: 'var(--amber)' },
              { label: 'With Dispatch', sub: 'Awaiting allocation', val: c.handed_over_count, tone: 'brand', color: 'var(--yellow)' },
              { label: 'Allocated',     sub: 'Awaiting ship',     val: c.allocated_count,   tone: 'info',  color: 'var(--blue)' },
            ].map((s, i) => (
              <div key={s.label} style={{ position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t2)' }}>
                    {i + 1}. {s.label}
                  </span>
                  <span style={{ fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 800, color: s.color, lineHeight: 1 }}>{fmt(s.val)}</span>
                </div>
                <ProgressBar value={s.val || 0} target={funnelMax} tone={s.tone} height={8} />
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>{s.sub}</div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      {/* ── Today on the floor ─────────────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <h2 style={sectionLabel}>Today on the Floor</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
          <KpiCard label="Packed Today"     value={fmt(todayPacked)}     sub="Boxed on dispatch lines" />
          <KpiCard label="Allocated Today"  value={fmt(todayAllocated)}  sub="Assigned to channels" color={todayAllocated > 0 ? 'blue' : undefined} />
          <KpiCard label="Dispatched Today" value={fmt(todayDispatched)} sub="Sent out (DOUT)"      color="green" />
          <KpiCard label="Active Operators" value={fmt(todayOperators)}  sub="Across dispatch lines" />
        </div>
        {lines.length === 0 ? (
          <Panel padding={0}><EmptyState message="No dispatch line activity yet today" /></Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {lines.map(l => <LineCard key={l.line} row={l} />)}
          </div>
        )}
      </section>

      {/* ── Allocated — awaiting ship ──────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ ...sectionLabel, marginBottom: 0 }}>Allocated — Awaiting Ship</h2>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--blue)' }}>{fmt(allocTotal)} units</span>
        </div>
        {allocSorted.length === 0 ? (
          <Panel padding={0}><EmptyState message="Nothing allocated and awaiting ship" /></Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {allocSorted.map((row, i) => <ChannelCard key={`${row.channel_name}-${i}`} row={row} />)}
          </div>
        )}
      </section>

      {/* ── On-hand finished goods by product ──────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ ...sectionLabel, marginBottom: 0 }}>On-Hand Finished Goods</h2>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>{fmt(stockOnHandTotal)} unallocated on hand</span>
        </div>
        <Panel padding={0}>
          {stockLoad && !stock ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : stockRows.length === 0 ? (
            <EmptyState message="No finished goods in the dispatch area" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Product</th>
                    <th style={numTh}>PKG Out</th>
                    <th style={numTh}>With Dispatch</th>
                    <th style={numTh}>Allocated</th>
                    <th style={numTh}>On Hand</th>
                  </tr>
                </thead>
                <tbody>
                  {stockRows.map(r => (
                    <tr key={r.product}>
                      <td style={{ ...tdStyle, color: 'var(--yellow)', fontWeight: 600 }}>{r.product}</td>
                      <td style={{ ...numTd, color: 'var(--amber)' }}>{fmt(r.rtd)}</td>
                      <td style={numTd}>{fmt(r.withDispatch)}</td>
                      <td style={{ ...numTd, color: 'var(--blue)' }}>{fmt(r.allocated)}</td>
                      <td style={{ ...numTd, fontWeight: 700 }}>{fmt(r.onHand)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      {/* ── Sent out by channel (throughput) ───────────────── */}
      <section style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <h2 style={{ ...sectionLabel, marginBottom: 0 }}>Sent Out by Channel</h2>
          <div style={{ flex: 1 }} />
          <Chip active={preset === '10days'}    onClick={() => applyPreset('10days')}>10 Days</Chip>
          <Chip active={preset === 'thisweek'}  onClick={() => applyPreset('thisweek')}>This Week</Chip>
          <Chip active={preset === 'thismonth'} onClick={() => applyPreset('thismonth')}>This Month</Chip>
          <Chip active={preset === 'custom'}    onClick={() => applyPreset('custom')}>Custom</Chip>
        </div>
        {preset === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>From</span>
            <input type="date" style={{ background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' }}
              value={customFrom} onChange={e => { setCustomFrom(e.target.value); setShippedFrom(e.target.value); }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>To</span>
            <input type="date" style={{ background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' }}
              value={customTo} onChange={e => { setCustomTo(e.target.value); setShippedTo(e.target.value); }} />
          </div>
        )}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 12, letterSpacing: '0.04em' }}>
          <span style={{ color: 'var(--green)' }}>{fmt(shippedSale)} sold</span>{' · '}
          <span>{fmt(shippedNonSale)} non-sale</span>{' · '}
          <span style={{ color: 'var(--t1)' }}>{fmt(shippedTotal)} total</span>
        </div>
        {shippedLoad ? (
          <Panel padding={0}><div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div></Panel>
        ) : shippedSorted.length === 0 ? (
          <Panel padding={0}><EmptyState message="No units shipped in this range" /></Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {shippedSorted.map((row, i) => <ChannelCard key={`${row.channel_name}-${i}`} row={row} />)}
          </div>
        )}
      </section>
    </div>
  );
}
