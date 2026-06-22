'use client';
/* ════════════════════════════════════════════════════════════
   Depot Overview — live warehouse cockpit.
   Phase 2 (S141): built on cheap lotopsproxy reads.
   S147 redesign: the 3-bar funnel → 5 individual Redline-style
   pipeline stat cards (With Production · With Dispatch · Allocated
   · Dispatched today · Shipments today); operators-on-floor added
   to the hero; line cards now show rostered manpower per line.
   Reads: getDispatchDashboard (live counts) · getDispatchLineView
   (today's floor) · getDispatchScanSummary (today DOUT + shipments)
   · getManpowerLog (per-line roster) · getOperatorAttendance
   (on-floor headcount) · getAllocatedByChannel · getDispatchPipeline
   · getShippedByChannel.
   ════════════════════════════════════════════════════════════ */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Panel, Chip, EmptyState, Spinner, StatusBadge } from '@throttle/ui';
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
function istToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }

// ── Shared style constants (Pit Wall tokens) ──────────────────
const sectionLabel = { margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };
const numTd = { ...tdStyle, textAlign: 'right' };
const numTh = { ...thStyle, textAlign: 'right' };

function ChannelTypeBadge({ type }) {
  const t = (type || 'other').toLowerCase();
  const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : 'neutral';
  return <StatusBadge variant={variant}>{type || '—'}</StatusBadge>;
}

// ── Pipeline stat card (Redline summary-tile style) ───────────
function StatCard({ label, value, sub, color, tag, onClick }) {
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      padding: 16, position: 'relative', overflow: 'hidden', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color || 'var(--border)' }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t2)' }}>{label}</span>
        {tag && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t4)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>{tag}</span>}
      </div>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 34, fontWeight: 800, color: color || 'var(--t1)', lineHeight: 1, marginTop: 10 }}>{fmt(value)}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 8, letterSpacing: '0.03em' }}>{sub}</div>
    </div>
  );
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
function LineCard({ row, rostered }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, letterSpacing: '0.05em', color: 'var(--t1)' }}>{row.line}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textAlign: 'right' }}>
          {rostered != null
            ? <><span style={{ color: 'var(--t1)' }}>{rostered}</span> rostered · {row.active_operators || 0} active</>
            : <>{row.active_operators || 0} op{(row.active_operators || 0) === 1 ? '' : 's'}</>}
          <br />last {fmtClock(row.last_scan_at)}
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
  const router = useRouter();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [pendingReqs, setPendingReqs] = useState(0);   // open fulfilment requests
  const [counts,    setCounts]    = useState(null);
  const [lines,     setLines]     = useState([]);
  const [today,     setToday]     = useState(null);   // getDispatchScanSummary
  const [allocByLine, setAllocByLine] = useState({}); // { D1: n, D2: n } rostered
  const [floorOps,  setFloorOps]  = useState(null);   // distinct present dispatch operators
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
    const tdy = istToday();
    try {
      const [dash, lv, ab, dss, fr] = await Promise.allSettled([
        garageFetch('getDispatchDashboard',  { limit: '1' }, session),
        garageFetch('getDispatchLineView',   {}, session),
        garageFetch('getAllocatedByChannel', {}, session),
        garageFetch('getDispatchScanSummary', { date: tdy }, session),
        garageFetch('getFulfilmentRequests', { status: 'pending' }, session),
      ]);
      if (dash.status === 'fulfilled') setCounts(dash.value?.counts || null);
      if (lv.status   === 'fulfilled') setLines(Array.isArray(lv.value?.dispatch_lines) ? lv.value.dispatch_lines : []);
      if (ab.status   === 'fulfilled') setAlloc(Array.isArray(ab.value) ? ab.value : []);
      if (dss.status  === 'fulfilled') setToday(dss.value || null);
      if (fr.status   === 'fulfilled') setPendingReqs(Array.isArray(fr.value) ? fr.value.length : 0);
    } finally {
      setRefreshing(false);
      setLastRefreshed(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }));
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadLive, 30000, !session);

  // ── Floor people (roster per line + on-floor headcount) ─────
  // workerFetch / canManageFloor-gated; degrade silently if the
  // viewer lacks the permission (manpower figures just show —).
  const loadFloorPeople = useCallback(async () => {
    if (!session) return;
    const tdy = istToday();
    const [logRes, attRes] = await Promise.allSettled([
      workerFetch('getManpowerLog',         { data: { shift_date: tdy } }, session),
      workerFetch('getOperatorAttendance',  { data: { date_from: tdy, date_to: tdy, team: 'dispatch' } }, session),
    ]);
    if (logRes.status === 'fulfilled') {
      const log = logRes.value?.data;
      if (log && typeof log === 'object' && !Array.isArray(log)) {
        setAllocByLine({
          D1: Array.isArray(log.D1) ? log.D1.length : 0,
          D2: Array.isArray(log.D2) ? log.D2.length : 0,
        });
      }
    }
    if (attRes.status === 'fulfilled') {
      const rows = Array.isArray(attRes.value?.data) ? attRes.value.data
        : Array.isArray(attRes.value) ? attRes.value : [];
      const present = new Set(rows.filter(r => !r.clock_out).map(r => r.operator_id));
      setFloorOps(present.size);
    }
  }, [session]);

  useAutoRefresh(loadFloorPeople, 60000, !session);

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

  const todayPacked = lines.reduce((s, l) => s + (l.pack_count || 0), 0);
  const dispatchedToday = today?.DOUT != null ? Number(today.DOUT) : lines.reduce((s, l) => s + (l.dout_count || 0), 0);
  const shipmentsToday  = today?.shipments_out != null ? Number(today.shipments_out) : null;

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

  // ── Pipeline stat cards (live state + today throughput) ─────
  const statCards = [
    { label: 'Fulfilment Requests', value: pendingReqs,
      sub: pendingReqs ? 'Awaiting accept / reject →' : 'None pending',
      color: pendingReqs ? 'var(--red)' : 'var(--border)', tag: 'open',
      onClick: () => router.push('/fulfilment-requests') },
    { label: 'With Production', value: c.rtd_count,         sub: 'Awaiting handover',   color: 'var(--amber)',  tag: 'now' },
    { label: 'With Dispatch',   value: c.handed_over_count, sub: 'Awaiting allocation', color: 'var(--yellow)', tag: 'now' },
    { label: 'Allocated',       value: c.allocated_count,   sub: 'Awaiting ship',       color: 'var(--blue)',   tag: 'now' },
    { label: 'Dispatched',      value: dispatchedToday,     sub: 'Sent out (DOUT)',     color: 'var(--green)',  tag: 'today' },
    { label: 'Shipments',       value: shipmentsToday,      sub: 'Manifests sent out',  color: '#14b8a6',       tag: 'today' },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* ── Hero: in the dispatch area + on-floor headcount ──── */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h1 className="font-display" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Depot</h1>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)' }}>Warehouse · finished goods · dispatch</div>
          </div>
          <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--cond)', fontSize: 40, fontWeight: 800, color: 'var(--yellow)', lineHeight: 1 }}>{fmt(inArea)}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>units in the dispatch area</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--cond)', fontSize: 40, fontWeight: 800, color: floorOps ? 'var(--green)' : 'var(--t2)', lineHeight: 1 }}>{floorOps != null ? fmt(floorOps) : '—'}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>operators on the floor</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pipeline stat cards (replaces the funnel) ────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {statCards.map(s => <StatCard key={s.label} {...s} />)}
        </div>
      </section>

      {/* ── Today on the floor ─────────────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <h2 style={sectionLabel}>Today on the Floor</h2>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
            {fmt(todayPacked)} packed{floorOps != null ? ` · ${fmt(floorOps)} on floor` : ''}
          </span>
        </div>
        {lines.length === 0 ? (
          <Panel padding={0}><EmptyState message="No dispatch line activity yet today" /></Panel>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {lines.map(l => <LineCard key={l.line} row={l} rostered={allocByLine[l.line]} />)}
          </div>
        )}
      </section>

      {/* ── Allocated — awaiting ship ──────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ ...sectionLabel }}>Allocated — Awaiting Ship</h2>
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
          <h2 style={{ ...sectionLabel }}>On-Hand Finished Goods</h2>
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
          <h2 style={{ ...sectionLabel }}>Sent Out by Channel</h2>
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
