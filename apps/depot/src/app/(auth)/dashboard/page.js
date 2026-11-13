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
   Instant load (2026-11-13, Garage's pattern): one useCachedQuery
   per call — each section paints its last-known result from this
   tab's sessionStorage and fills in as its own call lands; a
   failure with nothing to show is an error + Retry, never zeros.
   ════════════════════════════════════════════════════════════ */
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, useCachedQuery } from '@throttle/db';
import { Panel, Chip, EmptyState, StatusBadge, Skeleton } from '@throttle/ui';
import { isPresent } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  isForbidden, pickCounts, pickLines, pickChannelRows, pickScanSummary, countRequests,
  rosterByLine, floorOpsCount, slimPipeline, dispatchedToday, freshness, panelAsOf,
} from '../../../lib/overview.mjs';

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
  const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : t === 'export' ? 'success' : 'neutral';
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
  const { session, userId } = useAuth();
  const router = useRouter();
  const { setRefreshing } = useRefreshState();

  const [preset,     setPreset]     = useState('10days');
  const [shippedFrom, setShippedFrom] = useState('');
  const [shippedTo,   setShippedTo]   = useState('');
  const [customFrom,  setCustomFrom]  = useState('');
  const [customTo,    setCustomTo]    = useState('');

  // One cached query per call. Each fetcher is the call + normalisation the page made
  // before, slimmed to what it renders (lib/overview.mjs says what is dropped and why).
  // A failure now THROWS instead of leaving the last value or a silent []/0 behind.
  const live = !!session;
  // Today-scoped calls carry the IST date in their cache key, so a tab reopened after
  // midnight never seeds yesterday's figures as today's. The same `day` goes to the call.
  const day = istToday();

  // ── Live reads (cheap RPCs) — auto-refresh 30s ──────────────
  const countsQ = useCachedQuery({ key: 'depot:dashboard:counts', userId, enabled: live,
    fetcher: () => garageFetch('getDispatchDashboard', { limit: '1' }, session).then(pickCounts) });
  const linesQ = useCachedQuery({ key: `depot:dashboard:lines:${day}`, userId, enabled: live,
    fetcher: () => garageFetch('getDispatchLineView', {}, session).then(pickLines) });
  const allocQ = useCachedQuery({ key: 'depot:dashboard:allocated', userId, enabled: live,
    fetcher: () => garageFetch('getAllocatedByChannel', {}, session).then(pickChannelRows) });
  const scanQ = useCachedQuery({ key: `depot:dashboard:scan-summary:${day}`, userId, enabled: live,
    fetcher: () => garageFetch('getDispatchScanSummary', { date: day }, session).then(pickScanSummary) });
  const requestsQ = useCachedQuery({ key: 'depot:dashboard:requests', userId, enabled: live,
    fetcher: () => garageFetch('getFulfilmentRequests', { status: 'pending' }, session).then(countRequests) });
  const liveQs = [countsQ, linesQ, allocQ, scanQ, requestsQ];

  function loadLive() {
    if (!session) return;
    liveQs.forEach(q => q.refresh());
  }

  useAutoRefresh(loadLive, 30000, !session);

  // ── Floor people (roster per line + on-floor headcount) ─────
  // workerFetch / canManageFloor-gated: the worker 403s by design for a viewer without
  // the permission, and the page shows what it always has then (no roster on the line
  // cards; "—" on the floor). Any OTHER failure is an error the section shows.
  const rosterQ = useCachedQuery({ key: `depot:dashboard:roster:${day}`, userId, enabled: live,
    fetcher: async () => {
      try {
        return rosterByLine(await workerFetch('getManpowerLog', { data: { shift_date: day } }, session));
      } catch (e) {
        if (isForbidden(e)) return {};
        throw e;
      }
    } });
  // `!clock_out` alone is not enough: someone marked `absent`/`leave` who has not clocked
  // out yet would still count as on-floor. Today no absent row has an open shift (0 of 27,
  // measured 2026-08-28), so this was latent rather than live — closed anyway now that the
  // rule has one home. See isPresent() in @throttle/domain.
  const floorOpsQ = useCachedQuery({ key: `depot:dashboard:floor-ops:${day}`, userId, enabled: live,
    fetcher: async () => {
      try {
        return floorOpsCount(await workerFetch('getOperatorAttendance', { data: { date_from: day, date_to: day, team: 'dispatch' } }, session), isPresent);
      } catch (e) {
        if (isForbidden(e)) return null;
        throw e;
      }
    } });
  const floorQs = [rosterQ, floorOpsQ];

  function loadFloorPeople() {
    if (!session) return;
    floorQs.forEach(q => q.refresh());
  }

  useAutoRefresh(loadFloorPeople, 60000, !session);

  // At IST midnight the dated keys change and those panels drop to their skeleton; fetch
  // the new day now rather than on the next 30/60 s tick. (On mount this joins the
  // requests the auto-refresh loops have just started — no extra call.)
  useEffect(() => {
    if (session) [linesQ, scanQ, rosterQ, floorOpsQ].forEach(q => q.refresh());
  }, [day, live]); // eslint-disable-line

  // ── On-hand stock by product (heavier pipeline read) — once + manual ──
  const stockQ = useCachedQuery({ key: 'depot:dashboard:pipeline', userId, enabled: live,
    fetcher: () => garageFetch('getDispatchPipeline', {}, session).then(slimPipeline) });

  useEffect(() => { if (session) stockQ.refresh(); }, [session]); // eslint-disable-line

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

  // With a date blank (Custom before both are picked) nothing is fetched and the last
  // complete range's cards remain on screen, as before — the query stays keyed on that last
  // complete range. Each complete range is its own cache entry: changing to one shows that
  // range's cached data or a skeleton until it answers.
  const shippedRangeRef = useRef(null);
  if (shippedFrom && shippedTo) shippedRangeRef.current = { from: shippedFrom, to: shippedTo };
  const shippedRange = shippedRangeRef.current;
  const shippedQ = useCachedQuery({
    key: shippedRange ? `depot:dashboard:shipped:${shippedRange.from}:${shippedRange.to}` : null,
    userId, enabled: live && !!shippedRange,
    fetcher: () => garageFetch('getShippedByChannel', { date_from: shippedRange.from, date_to: shippedRange.to }, session).then(pickChannelRows) });

  useEffect(() => { if (session) shippedQ.refresh(); }, [session, shippedRange?.from, shippedRange?.to]); // eslint-disable-line

  // ── Topbar + freshness ──────────────────────────────────────
  // The Live/Sync dot tracks the 30 s live calls, as it did when they were one allSettled.
  const liveInFlight = liveQs.some(q => q.loading || q.refreshing);
  useEffect(() => { setRefreshing(liveInFlight); }, [liveInFlight]); // eslint-disable-line
  useEffect(() => () => setRefreshing(false), []); // eslint-disable-line
  // The freshness line below the header replaces the topbar's "Updated h:mm" on this page
  // (one indicator, not two — and the topbar's is hidden on phones); DepotTopbar hides its
  // stamp on /dashboard. It covers the POLLED calls only: On-Hand and Sent Out are loaded
  // once and carry their own "as of" in their headers.
  const fresh = freshness([...liveQs, ...floorQs]);
  const stockAsOf = panelAsOf(stockQ);
  const shippedAsOf = panelAsOf(shippedQ);

  // Per-section readiness: no data yet → skeleton; a failure with no data → inline retry.
  const has = (q) => q.data !== undefined;
  const failedEmpty = (q) => !!q.error && q.data === undefined;
  const settled = (q) => has(q) || failedEmpty(q);

  // ── Derived ─────────────────────────────────────────────────
  const counts = countsQ.data ?? null;
  const lines = linesQ.data ?? [];
  const today = scanQ.data ?? null;              // getDispatchScanSummary
  const pendingReqs = requestsQ.data ?? 0;       // open fulfilment requests
  const allocByLine = rosterQ.data ?? {};        // { D1: n, D2: n } rostered
  const floorOps = floorOpsQ.data ?? null;       // distinct present dispatch operators
  const alloc = allocQ.data ?? [];
  const stock = stockQ.data ?? null;             // pipeline products
  const shipped = shippedQ.data ?? [];

  const c = counts || {};
  const inArea = (c.rtd_count || 0) + (c.handed_over_count || 0) + (c.allocated_count || 0);

  const todayPacked = lines.reduce((s, l) => s + (l.pack_count || 0), 0);
  // Two calls (DOUT from the scan summary, else the line sum) — see dispatchedToday().
  const dispatched = dispatchedToday(scanQ, linesQ);
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
    // Includes unallocated_unknown (S308): legacy held units with no packing scan used to
    // be counted as Retail. They are still WITH DISPATCH — only their channel is unknown —
    // so omitting them here would drop 112 units off this tile.
    const withDispatch = (t.unallocated_retail || 0) + (t.unallocated_ecom || 0) + (t.unallocated_export || 0) + (t.unallocated_unknown || 0);
    const allocated = Object.values(t.channels || {}).reduce((s, n) => s + n, 0);
    const onHand = (t.with_production || 0) + withDispatch;
    return { product: p.product, rtd: t.with_production || 0, withDispatch, allocated, onHand };
  }).filter(r => r.onHand + r.allocated > 0)
    .sort((a, b) => (b.onHand + b.allocated) - (a.onHand + a.allocated));
  const stockOnHandTotal = stockRows.reduce((s, r) => s + r.onHand, 0);
  // Outpost (O10): vendor cars on their way to LOT stock — not on hand, so a card of their own (only once there are any).
  const vendorPipe = (stock || []).reduce((s, p) => s + (p.totals?.vendor_at || 0) + (p.totals?.vendor_in_transit || 0) + (p.totals?.vendor_receiving || 0), 0);

  // ── Pipeline stat cards (live state + today throughput) ─────
  // `state` per card: its own query's readiness (Dispatched: both of its calls).
  const qState = (q) => ({ state: has(q) ? 'ready' : failedEmpty(q) ? 'error' : 'loading', retry: [q] });
  const statCards = [
    { label: 'Fulfilment Requests', value: pendingReqs,
      sub: pendingReqs ? 'Awaiting accept / reject →' : 'None pending',
      color: pendingReqs ? 'var(--red)' : 'var(--border)', tag: 'open',
      onClick: () => router.push('/fulfilment-requests'), ...qState(requestsQ) },
    // Only once the pipeline has answered, as before (no data → no card, not a skeleton
    // for a card that may not exist; a failed pipeline says so in its own section).
    ...(vendorPipe > 0 ? [{ label: 'At Vendors', value: vendorPipe, sub: 'Outpost — packed, on the road or in QC →', color: 'var(--t3)', tag: 'now',
      onClick: () => router.push('/outpost-monitor'), state: 'ready' }] : []),
    { label: 'With Production', value: c.rtd_count,         sub: 'Awaiting handover',   color: 'var(--amber)',  tag: 'now', ...qState(countsQ) },
    { label: 'With Dispatch',   value: c.handed_over_count, sub: 'Awaiting allocation', color: 'var(--yellow)', tag: 'now', ...qState(countsQ) },
    { label: 'Allocated',       value: c.allocated_count,   sub: 'Awaiting ship',       color: 'var(--blue)',   tag: 'now', ...qState(countsQ) },
    { label: 'Dispatched',      value: dispatched.value,    sub: 'Sent out (DOUT)',     color: 'var(--green)',  tag: 'today', state: dispatched.state, retry: dispatched.retry },
    { label: 'Shipments',       value: shipmentsToday,      sub: 'Manifests sent out',  color: '#14b8a6',       tag: 'today', ...qState(scanQ) },
  ];
  const retryAll = (qs) => () => qs.forEach(q => q.refresh());

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* ── Hero: in the dispatch area + on-floor headcount ──── */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h1 className="font-display" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Depot</h1>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t3)' }}>Warehouse · finished goods · dispatch</div>
            <div aria-live="polite" style={{ fontFamily: 'var(--font-ui)', fontSize: 12, minHeight: 16, marginTop: 4, color: fresh.warn ? 'var(--amber)' : 'var(--t3)' }}>{fresh.text}</div>
          </div>
          <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end' }}>
            <div style={{ textAlign: 'right' }}>
              {has(countsQ)
                ? <div style={{ fontFamily: 'var(--cond)', fontSize: 40, fontWeight: 800, color: 'var(--yellow)', lineHeight: 1 }}>{fmt(inArea)}</div>
                : failedEmpty(countsQ) ? <HeroError onRetry={countsQ.refresh} /> : <HeroSkeleton />}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>units in the dispatch area</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {has(floorOpsQ)
                ? <div style={{ fontFamily: 'var(--cond)', fontSize: 40, fontWeight: 800, color: floorOps ? 'var(--green)' : 'var(--t2)', lineHeight: 1 }}>{floorOps != null ? fmt(floorOps) : '—'}</div>
                : failedEmpty(floorOpsQ) ? <HeroError onRetry={floorOpsQ.refresh} /> : <HeroSkeleton />}
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t3)', marginTop: 4 }}>operators on the floor</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pipeline stat cards (replaces the funnel) ────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {statCards.map(({ state, retry, ...s }) => state === 'ready' ? <StatCard key={s.label} {...s} />
            : state === 'error' ? <StatCardError key={s.label} {...s} onRetry={retryAll(retry)} />
            : <StatCardSkeleton key={s.label} color={s.color} />)}
        </div>
      </section>

      {/* ── Today on the floor ─────────────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <h2 style={sectionLabel}>Today on the Floor</h2>
          {/* Two calls (packed: line view · on floor: attendance) — shown once both have answered. */}
          {has(linesQ) && settled(floorOpsQ) ? (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>
              {fmt(todayPacked)} packed{floorOps != null ? ` · ${fmt(floorOps)} on floor` : ''}
            </span>
          ) : !failedEmpty(linesQ) && <Skeleton width={150} height={12} />}
        </div>
        {/* Line cards pair the line view with the roster — held until both have answered. */}
        {failedEmpty(linesQ) ? (
          <Panel><PanelError message="Could not load today's dispatch lines." onRetry={linesQ.refresh} /></Panel>
        ) : !(has(linesQ) && settled(rosterQ)) ? (
          <LineCardsSkeleton />
        ) : lines.length === 0 ? (
          <Panel padding={0}><EmptyState message="No dispatch line activity yet today" /></Panel>
        ) : (
          <>
            {failedEmpty(rosterQ) && (
              <div style={{ marginBottom: 12 }}><PanelError message="Could not load the line roster." onRetry={rosterQ.refresh} /></div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {lines.map(l => <LineCard key={l.line} row={l} rostered={allocByLine[l.line]} />)}
            </div>
          </>
        )}
      </section>

      {/* ── Allocated — awaiting ship ──────────────────────── */}
      <section style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ ...sectionLabel }}>Allocated — Awaiting Ship</h2>
          {has(allocQ)
            ? <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--blue)' }}>{fmt(allocTotal)} units</span>
            : !failedEmpty(allocQ) && <Skeleton width={70} height={12} />}
        </div>
        {failedEmpty(allocQ) ? (
          <Panel><PanelError message="Could not load allocated units." onRetry={allocQ.refresh} /></Panel>
        ) : !has(allocQ) ? (
          <ChannelCardsSkeleton />
        ) : allocSorted.length === 0 ? (
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
          {has(stockQ)
            ? <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)' }}>{fmt(stockOnHandTotal)} unallocated on hand</span>
            : !failedEmpty(stockQ) && <Skeleton width={160} height={12} />}
          <PanelAsOf asOf={stockAsOf} />
        </div>
        <Panel padding={0}>
          {failedEmpty(stockQ) ? (
            <PanelError message="Could not load finished goods on hand." onRetry={stockQ.refresh} pad="20px 14px" />
          ) : !has(stockQ) ? (
            <TableSkeleton />
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
          <PanelAsOf asOf={shippedAsOf} />
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
        {has(shippedQ) ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 12, letterSpacing: '0.04em' }}>
            <span style={{ color: 'var(--green)' }}>{fmt(shippedSale)} sold</span>{' · '}
            <span>{fmt(shippedNonSale)} non-sale</span>{' · '}
            <span style={{ color: 'var(--t1)' }}>{fmt(shippedTotal)} total</span>
          </div>
        ) : !failedEmpty(shippedQ) && <Skeleton width={260} height={12} style={{ marginBottom: 12 }} />}
        {failedEmpty(shippedQ) ? (
          <Panel><PanelError message="Could not load units sent out in this range." onRetry={shippedQ.refresh} /></Panel>
        ) : !has(shippedQ) ? (
          <ChannelCardsSkeleton />
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

// ── Loading / error states ────────────────────────────────────
const retryBtn = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '5px 12px', borderRadius: 3, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' };

// A failed section with nothing to fall back on says so — never zeros, never an empty
// state, never a skeleton that spins forever.
function PanelError({ message, onRetry, pad }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)', padding: pad }}>
      <span>{message}</span>
      <button onClick={onRetry} style={retryBtn}>Retry</button>
    </div>
  );
}

function HeroError({ onRetry }) {
  return (
    <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
      <span>Couldn't load</span>
      <button onClick={onRetry} style={retryBtn}>Retry</button>
    </div>
  );
}

function StatCardError({ label, color, tag, onRetry }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color || 'var(--border)' }} />
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontFamily: 'var(--cond)', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t2)' }}>{label}</span>
        {tag && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t4)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 5px' }}>{tag}</span>}
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)', marginTop: 12 }}>Couldn't load</div>
      <button onClick={onRetry} style={{ ...retryBtn, marginTop: 8 }}>Retry</button>
    </div>
  );
}

// A once-loaded panel's own freshness (never polled, so the header line does not cover it).
function PanelAsOf({ asOf }) {
  if (!asOf) return null;
  return <span aria-live="polite" style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: asOf.warn ? 'var(--amber)' : 'var(--t4)' }}>{asOf.text}</span>;
}

// Skeletons, each laid out like the content it stands in for.
function HeroSkeleton() {
  return <div aria-busy="true" style={{ display: 'flex', justifyContent: 'flex-end' }}><Skeleton width={84} height={40} /></div>;
}

function StatCardSkeleton({ color }) {
  return (
    <div aria-busy="true" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color || 'var(--border)' }} />
      <Skeleton width="60%" height={13} />
      <Skeleton width="45%" height={34} style={{ marginTop: 10 }} />
      <Skeleton width="70%" height={11} style={{ marginTop: 8 }} />
    </div>
  );
}

function LineCardsSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <Skeleton width={44} height={22} />
            <Skeleton width={110} height={26} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
            {[0, 1, 2].map(k => <div key={k}><Skeleton width="60%" height={22} /><Skeleton width="70%" height={10} style={{ marginTop: 4 }} /></div>)}
          </div>
          <Skeleton width="40%" height={18} />
        </div>
      ))}
    </div>
  );
}

function ChannelCardsSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
            <Skeleton width="55%" height={16} />
            <Skeleton width={44} height={16} />
          </div>
          <Skeleton width="35%" height={24} />
          <Skeleton width="45%" height={11} style={{ marginTop: 6 }} />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 14, padding: '10px 14px', borderBottom: '1px solid rgba(64,64,64,.5)' }}>
          <Skeleton width="28%" height={14} />
          <span style={{ flex: 1 }} />
          {[0, 1, 2, 3].map(k => <Skeleton key={k} width={48} height={14} />)}
        </div>
      ))}
    </div>
  );
}
