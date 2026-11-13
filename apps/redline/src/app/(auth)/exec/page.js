'use client';
/* ════════════════════════════════════════════════════════════
   OVERVIEW — the Triage dashboard (redesign-reference/app/triage.jsx).
   Answers "what needs me now": KPI rail with date presets ·
   manpower summary strip · prioritized exception feed with a
   drill-down drawer · right rail shift batteries + dispatch today.
   All data from existing APIs (getProductionDashboard,
   getPlanVsActual, getActivityBreakdown, getManpowerLog,
   getOperatorAttendance; violations + return queue via the
   layout's pending counts). Exceptions are computed client-side.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, useCachedQuery } from '@throttle/db';
import { Skeleton, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { Plus, X } from 'lucide-react';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState, usePendingState } from '../layout.js';
import { istDay, istMonth, normaliseDashboard, sumMtdPacked, normaliseRange } from '../../../lib/execData.js';
import {
  Icon, Spark, ShiftBattery, KpiTile, Panel, FilterChip, ToneBadge, Drawer,
  lineColor, lineRgb, fmt, SEV, istNow, btnPrimary, btnGhost,
} from '../../../components/kit/index.js';
import KpiDrilldown from '../../../components/KpiDrilldown.js';
import { scanProductLabel } from '../../../lib/scanProducts.js';

// Packed sub-line: retail · ecom, plus export only once an RTX (export packed-out) scan exists (S392c).
// Packed activities — the Today tile (today_rtr+rte+rtx) and the Packed drawer use the same set.
const PACKED_ACTS = 'RTE,RTR,RTX';
const packedSub = (rtr, rte, rtx) => `${fmt(rtr)} retail · ${fmt(rte)} ecom` + (Number(rtx) > 0 ? ` · ${fmt(rtx)} export` : '');

// run status → kit ToneBadge tone
const RUN_TONE = {
  Requested: 'info', Submitted: 'info', Draft: 'mute', Picking: 'warn',
  Issued: 'brand', 'In Progress': 'ok',
};

const SHIFT_START = 9, SHIFT_END = 18, SHIFT_HRS = 9;
const REPAIR_CAP = 50;
const EMPTY = []; // stable stand-in while a query has no data (keeps the memos' deps steady)

function getMondayISO() {
  // Same IST trap as getFirstOfMonthISO below: .toISOString() on a now-timestamped date
  // rolls back a day between 00:00–05:30 IST, making "This Week" start on Sunday.
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getFirstOfMonthISO() {
  // Build the local Y-M-01 string directly — going via new Date(y,m,1).toISOString() renders
  // LOCAL midnight of the 1st as UTC, which in IST (+5:30) rolls back to the prev month's last
  // day (e.g. "This Month" showing 2026-06-30 instead of 07-01, and pulling one extra day of data).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// IST stamp for the freshness line: "21:04" today, "12 Nov 21:04" otherwise (as Garage).
function istStamp(ms) {
  const d = new Date(ms);
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) return hhmm;
  return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${hhmm}`;
}

/* ── snooze persistence (client-side triage convenience) ────── */
function snoozedSet() {
  try {
    const raw = JSON.parse(localStorage.getItem('rl-exec-snooze') || '{}');
    const now = Date.now();
    const live = Object.fromEntries(Object.entries(raw).filter(([, t]) => t > now));
    localStorage.setItem('rl-exec-snooze', JSON.stringify(live));
    return new Set(Object.keys(live));
  } catch (_) { return new Set(); }
}
function snooze(id, ms = 3600e3) {
  try {
    const raw = JSON.parse(localStorage.getItem('rl-exec-snooze') || '{}');
    raw[id] = Date.now() + ms;
    localStorage.setItem('rl-exec-snooze', JSON.stringify(raw));
  } catch (_) {}
}

/* ── clickable exception row with inline quick-ack ──────────── */
function TriageRow({ ex, onOpen, onAck, idx }) {
  const s = SEV[ex.sev];
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={() => onOpen(ex)}
      className="rl-row-in" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px',
        borderRadius: 'var(--r-sm)', cursor: 'pointer', animationDelay: `${idx * 45}ms`,
        background: hover ? 'var(--surface-2)' : 'transparent',
        border: '1px solid', borderColor: hover ? 'var(--border-2)' : 'transparent',
        transition: 'background var(--fast), border-color var(--fast)' }}>
      <div style={{ width: 32, height: 32, borderRadius: 'var(--r-sm)', flexShrink: 0, display: 'grid', placeItems: 'center',
        background: s.bg, color: s.fg, border: `1px solid ${s.bd}` }}><Icon name={ex.icon} size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {ex.line && <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(ex.line),
            background: `rgba(${lineRgb(ex.line)},0.14)`, padding: '1px 5px', borderRadius: 3 }}>{ex.line}</span>}
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.title}</span>
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ex.detail}</div>
      </div>
      {hover ? (
        <button onClick={(e) => { e.stopPropagation(); onAck(ex); }} title="Acknowledge"
          style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, background: 'var(--surface-3)',
            border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)', padding: '5px 9px', cursor: 'pointer',
            color: 'var(--t1)', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase' }}>
          <Icon name="shield" size={13} /> Ack
        </button>
      ) : (
        <span className="num" style={{ fontSize: 14, fontWeight: 700, color: s.fg, flexShrink: 0 }}>{ex.metric}</span>
      )}
      <div style={{ width: 16, color: hover ? 'var(--t2)' : 'var(--t4)', flexShrink: 0,
        transform: hover ? 'translateX(2px)' : 'none', transition: 'all var(--fast)' }}><Icon name="chevR" size={16} /></div>
    </div>
  );
}

/* ── drill-down drawer ──────────────────────────────────────── */
function ExceptionDrawer({ ex, onClose, onAction }) {
  if (!ex) return null;
  const s = SEV[ex.sev];
  const trend = ex.trend && ex.trend.length > 1 ? ex.trend : null;
  const tmin = trend ? Math.min(...trend) : 0, tmax = trend ? Math.max(...trend) : 0;
  return (
    <Drawer open onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <span className="label" style={{ fontSize: 10, color: s.fg, background: s.bg, border: `1px solid ${s.bd}`,
          borderRadius: 3, padding: '2px 7px' }}>{ex.sev === 'med' ? 'medium' : ex.sev} priority</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)',
          width: 26, height: 26, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
          <X size={14} strokeWidth={1.75} /></button>
      </div>
      <div style={{ overflowY: 'auto', padding: 20, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, marginBottom: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 'var(--r-sm)', display: 'grid', placeItems: 'center', flexShrink: 0,
            background: s.bg, color: s.fg, border: `1px solid ${s.bd}` }}><Icon name={ex.icon} size={20} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 17, fontWeight: 700, color: 'var(--t1)', lineHeight: 1.25 }}>{ex.title}</div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>{ex.detail}</div>
          </div>
          <span className="num" style={{ flexShrink: 0 }}><span style={{ fontSize: 26, fontWeight: 700, color: s.fg }}>{ex.metric}</span></span>
        </div>

        {trend && (
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '13px 15px', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="eyebrow">Today's trend</span>
              <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>9a → now</span>
            </div>
            <Spark data={trend} color={s.dot} w={386} h={48} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{fmt(tmin)}</span>
              <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{fmt(tmax)}</span>
            </div>
          </div>
        )}

        {ex.rec && (
          <div style={{ borderLeft: `2px solid ${s.bd}`, paddingLeft: 13, marginBottom: 18 }}>
            <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 5 }}>What to do</div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.55 }}>{ex.rec}</div>
          </div>
        )}

        {ex.ctx && ex.ctx.length > 0 && (
          <>
            <div className="label" style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 10 }}>Context</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {ex.ctx.map(([l, v]) => (
                <div key={l} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', padding: '9px 12px' }}>
                  <div className="eyebrow">{l}</div>
                  <div className="num" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', marginTop: 3 }}>{v}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button onClick={() => onAction('open', ex)} style={{ ...btnPrimary, width: '100%', padding: '11px', fontSize: 12 }}>
          <Icon name="upRight" size={15} /> {ex.primaryLabel || 'Open'}
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onAction('ack', ex)} style={{ ...btnGhost, flex: 1, padding: '9px', fontSize: 12 }}>
            <Icon name="shield" size={14} /> Acknowledge
          </button>
          <button onClick={() => onAction('snooze', ex)} style={{ ...btnGhost, flex: 1, padding: '9px', fontSize: 12 }}>
            <Icon name="clock" size={14} /> Snooze 1h
          </button>
        </div>
      </div>
    </Drawer>
  );
}

/* ══════════════════════════════════════════════════════════════
   PAGE
   ══════════════════════════════════════════════════════════════ */
export default function OverviewPage() {
  const { session, userId } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  // Open violations + return queue: the layout's badge queries (one request, one result).
  const { alertsQ, returnsQ } = usePendingState();

  const [preset, setPreset] = useState('today');
  const [drill, setDrill] = useState(null);       // KPI tile drill-down: 'packed' | 'qcPass' | 'qcFail' | 'pkgOut'
  const [tick, setTick] = useState(0);            // bumps after every live refresh so an open drawer refetches with the tiles
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());

  const rangeFor = (p) => {
    const today = todayStr();
    if (p === 'week') return { from: getMondayISO(), to: today };
    if (p === 'month') return { from: getFirstOfMonthISO(), to: today };
    return { from: today, to: today };
  };

  // One cached query per data source (instant-load pattern, as Garage's Overview): each
  // section paints the last-known result from this tab's sessionStorage straight away and
  // fills in as its own call returns, instead of the page waiting on the slowest of eight.
  // Each fetcher is the call + normalisation the page made before; failures are thrown,
  // never turned into [] (the hook would cache the empty answer as fresh). "Today" figures
  // are keyed by the IST day, month-to-date by the IST month (see istDay in execData).
  // No longer called: getScanSummary (nothing read its result) and getManpowerLog +
  // getOperatorAttendance — they fed only the manpower strip, which never rendered
  // (getManpowerLog answers lines grouped in an object; the strip read it as an array, so
  // it was always empty). The strip goes with them; the Manpower page is unaffected.
  const live = !!session;
  const day = istDay();
  const month = istMonth();
  const dashQ = useCachedQuery({ key: `redline:exec:dashboard:${day}`, userId, enabled: live,
    fetcher: () => garageFetch('getProductionDashboard', { date: todayStr() }, session).then(normaliseDashboard) });
  // today — batteries + line context
  const pvaQ = useCachedQuery({ key: `redline:exec:pva:${day}`, userId, enabled: live,
    fetcher: () => { const date = todayStr(); return garageFetch('getPlanVsActual', { from: date, to: date }, session).then(v => v || []); } });
  // Month-to-date packed — ALL RTE/RTR/RTX car/drone scans, run or no run; drives the
  // Packed card's monthly projection. A month aggregate, so it refreshes every 5 min.
  const mtdQ = useCachedQuery({ key: `redline:exec:mtd-packed:${month}`, userId, enabled: live,
    fetcher: () => garageFetch('getActivityBreakdown', { from: getFirstOfMonthISO(), to: todayStr(), activities: PACKED_ACTS }, session).then(sumMtdPacked) });
  // This Week / This Month tiles. Keyed by preset + the exact range sent, so each range
  // seeds only its own figures. Packed counts everything packed (Afshaan 2026-09-25), not
  // just units matched to planned runs — same source as the Packed drawer, so tile and
  // drawer agree.
  const ranged = preset !== 'today';
  const { from: rFrom, to: rTo } = rangeFor(preset);
  const rangeQ = useCachedQuery({ key: `redline:exec:range:${preset}:${rFrom}:${rTo}`, userId, enabled: live && ranged,
    fetcher: async () => {
      const [pv, pk] = await Promise.all([
        garageFetch('getPlanVsActual', { from: rFrom, to: rTo }, session),
        garageFetch('getActivityBreakdown', { from: rFrom, to: rTo, activities: PACKED_ACTS }, session),
      ]);
      return normaliseRange(pv, pk);
    } });

  const liveQs = [dashQ, pvaQ];
  const allQs = [...liveQs, mtdQ, alertsQ, returnsQ, ...(ranged ? [rangeQ] : [])];

  // Live production numbers keep the 30 s loop (violations + returns ride the layout's own
  // 30 s loop; the range tiles re-pull on it too, as before); the month-to-date aggregate
  // moves to 5 min. Both pause in a hidden tab.
  function loadLive() {
    if (!session) return;
    liveQs.forEach(q => q.refresh());
    if (preset !== 'today') rangeQ.refresh();
  }
  useAutoRefresh(loadLive, 30000, !session);
  useAutoRefresh(() => { if (session) mtdQ.refresh(); }, 300000, !session);

  // A new key (preset picked, IST day/month rolled over) starts with no data — fetch it
  // now rather than at the next tick. A refresh already in flight is joined, not repeated.
  useEffect(() => { if (session && ranged) rangeQ.refresh(); }, [session, preset, rFrom, rTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const rolled = useRef(null);
  useEffect(() => {
    const prev = rolled.current;
    rolled.current = `${day}|${month}`;
    if (!session || prev === null || prev === rolled.current) return;
    loadLive();
    mtdQ.refresh();
  }, [session, day, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // Topbar spinner + "last refreshed" + the drawer's refetch tick follow the live calls, as
  // they followed the one Promise.allSettled before (set after each round, failed or not).
  const liveInFlight = liveQs.some(q => q.loading || q.refreshing);
  const wasInFlight = useRef(false);
  useEffect(() => {
    setRefreshing(liveInFlight);
    if (wasInFlight.current && !liveInFlight) {
      setLastRefreshed(new Date());
      setTick(t => t + 1);
    }
    wasInFlight.current = liveInFlight;
  }, [liveInFlight]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setRefreshing(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-section readiness: no data yet → skeleton; a failure with no data → inline retry.
  const has = (q) => q.data !== undefined;
  const failedEmpty = (q) => !!q.error && q.data === undefined;
  const ready = (q) => has(q) || failedEmpty(q);

  // Same banner + message as before when the main dashboard call fails.
  const error = dashQ.error ? 'Dashboard data unavailable' : null;
  const dashFailed = failedEmpty(dashQ);
  const dashHasData = has(dashQ);

  const summary = dashQ.data?.summary ?? null;
  const hourly = dashQ.data?.hourly ?? EMPTY;
  const runs = dashQ.data?.runs ?? EMPTY;           // open runs (for tomorrow's-runs panel)
  const scanProducts = dashQ.data?.scanProducts ?? EMPTY; // per-line scan-derived product (lines with no run)
  const pva = pvaQ.data ?? EMPTY;
  const mtdDispatched = mtdQ.data ?? 0;
  const alertsOpen = alertsQ.data ?? 0;
  const returnsOpen = returnsQ.data ?? 0;
  // preset range — week/month KPIs. null = no range data (loading or failed) → '—'.
  const rangePva = rangeQ.data?.pva ?? null;
  const rangePacked = rangeQ.data?.packed ?? null; // ALL packed (drawer's source), feeds the Packed tile

  // Freshness: always the OLDEST data on the page. "Updating…" while anything is in
  // flight; "Couldn't refresh" when any call failed — with stale data showing OR with
  // none (a failed empty section must not sit under a grey "Updated").
  const anyInFlight = allQs.some(q => q.loading || q.refreshing);
  const stamps = allQs.map(q => q.updatedAt).filter(Boolean);
  const oldest = stamps.length ? istStamp(Math.min(...stamps)) : null;
  const anyFailed = allQs.some(q => q.error);
  const freshness = anyInFlight ? (oldest ? `Updating… (showing ${oldest})` : 'Updating…')
    : anyFailed ? (oldest ? `Couldn't refresh — showing ${oldest}` : "Couldn't refresh")
    : oldest ? `Updated ${oldest}` : '';

  const onPreset = (p) => setPreset(p);

  /* ── KPI rail (preset-keyed; '—' where a range number isn't available) ── */
  const s = summary || {};
  const k = useMemo(() => {
    // The dashboard call failed with nothing to show: unknown, not zero (fmt(null) is '0').
    if (preset === 'today' && dashFailed) {
      return { dispatched: '—', subR: '—', qcPass: '—', passRate: '—', passTone: undefined, qcFail: '—', failSub: 'Today' };
    }
    if (preset === 'today') {
      return {
        dispatched: fmt(s.today_dispatched), subR: packedSub(s.today_rtr, s.today_rte, s.today_rtx),
        qcPass: fmt(s.today_qc_pass), passRate: s.today_pass_rate != null ? s.today_pass_rate + '%' : '—',
        passTone: s.today_pass_rate >= 95 ? 'ok' : s.today_pass_rate != null ? 'warn' : undefined,
        qcFail: fmt(s.today_qc_fail),
        failSub: s.qc_fail_car != null ? `${fmt(s.qc_fail_car)}C · ${fmt(s.qc_fail_remote || 0)}R` : 'Today',
      };
    }
    const agg = (rangePva || []).reduce((a, r) => {
      a.pass += Number(r.actual_qc_pass) || 0;
      a.fail += Number(r.actual_qc_fail) || 0;
      return a;
    }, { disp: 0, rtr: 0, rte: 0, rtx: 0, pass: 0, fail: 0 });
    // Packed = every car/drone packed scan in the range (drawer source); split by packaging channel.
    // Split by packaging CHANNEL (the drawer's chips), not by scan activity as Today does — a stated
    // choice (S400 review): totals are identical; ~1.4% of units sit in the other bucket per method.
    for (const r of rangePacked || []) {
      const n = Number(r.cnt) || 0;
      agg.disp += n;
      if (r.channel === 'retail') agg.rtr += n;
      else if (r.channel === 'export') agg.rtx += n;
      else agg.rte += n;
    }
    const label = preset === 'week' ? 'Mon → today' : '1st → today';
    // Pass Rate + QC Fail over the range, now that get_plan_vs_actual carries actual_qc_fail
    // (previously hardcoded '—' for non-today presets). Pass, fail and rate derive from rangePva so
    // they share one source; Packed alone reads rangePacked (all packed, see rangeQ).
    const denom = agg.pass + agg.fail;
    const rate = denom > 0 ? Math.round((agg.pass / denom) * 100) : null;
    return {
      dispatched: rangePacked ? fmt(agg.disp) : '—', subR: rangePacked ? packedSub(agg.rtr, agg.rte, agg.rtx) : label,
      qcPass: rangePva ? fmt(agg.pass) : '—',
      passRate: rangePva && rate != null ? rate + '%' : '—',
      passTone: !rangePva ? undefined : rate >= 95 ? 'ok' : rate != null ? 'warn' : undefined,
      qcFail: rangePva ? fmt(agg.fail) : '—',
      failSub: label,
    };
  }, [preset, s, rangePva, rangePacked, dashFailed]);

  /* ── per-line today series (batteries + pace exceptions) ────── */
  const lineData = useMemo(() => {
    const byLine = {};
    for (const r of hourly) {
      const line = r.line;
      if (!line) continue;
      byLine[line] = byLine[line] || {};
      byLine[line][r.hour] = (byLine[line][r.hour] || 0) + (r.dispatched || r.unit_count || 0);
    }
    const targets = {}, products = {}, runNos = {};
    for (const r of pva) {
      if (!r.line_no) continue;
      targets[r.line_no] = (targets[r.line_no] || 0) + (Number(r.target_qty) || 0);
      products[r.line_no] = products[r.line_no] ? `${products[r.line_no]} +` : r.product;
      runNos[r.line_no] = runNos[r.line_no] || r.run_no;
    }
    // A line that is scanning without a run (L4/L5, 2026-09-21) has no PvA row, so it also
    // appears from the scan-products list — still flagged "no run", but named from its scans.
    const scanLines = (scanProducts || []).map(r => r.line).filter(Boolean);
    const ids = [...new Set([...Object.keys(byLine), ...Object.keys(targets), ...scanLines])].sort();
    return ids.map(id => ({
      id,
      hourly: byLine[id] || {},
      done: Object.values(byLine[id] || {}).reduce((a, b) => a + b, 0),
      target: targets[id] || 0,
      product: products[id] || '—',
      run: runNos[id] || '',
      scan: products[id] ? null : scanProductLabel(scanProducts, id),
    }));
  }, [hourly, pva, scanProducts]);

  /* ── exception feed — computed from live data ───────────────── */
  const exceptions = useMemo(() => {
    const list = [];
    const nowHr = istNow().hour;
    const hrsElapsed = Math.max(0, Math.min(nowHr - SHIFT_START, SHIFT_HRS));

    // Pace needs the hourly output: without dashboard data every line would read 0 done
    // and raise a false "behind pace".
    if (dashHasData) for (const l of lineData) {
      if (!l.target) continue;
      const pace = (l.target * hrsElapsed) / SHIFT_HRS;
      const gap = Math.round(pace - l.done);
      const tol = Math.max(8, Math.round((l.target / SHIFT_HRS) * 0.15));
      if (gap > tol) {
        // cumulative gap trend from real hourly data
        const trend = [];
        let cum = 0;
        for (let h = SHIFT_START; h <= Math.min(nowHr, SHIFT_END); h++) {
          cum += l.hourly[h] || 0;
          trend.push(Math.round(cum - (l.target * (h - SHIFT_START + 1)) / SHIFT_HRS));
        }
        list.push({
          id: `pace-${l.id}`, sev: gap > 2 * tol ? 'high' : 'med', icon: 'activity', line: l.id,
          title: `${l.id} behind pace`, detail: `${l.product} · ${l.run}`, metric: `−${fmt(gap)}`,
          rec: `${l.id} is ${fmt(gap)} units behind where it should be by now. Check crew gaps and the hourly matrix for the slipping hour.`,
          ctx: [['Line', `${l.id} · ${l.product}`], ['Run', l.run || '—'], ['Done', fmt(l.done)], ['Day target', fmt(l.target)], ['Hours left', `${Math.max(SHIFT_END - nowHr, 0)}h`]],
          trend, route: '/hourly', primaryLabel: `Open Hourly · ${l.id}`,
        });
      }
    }
    if (s.today_pass_rate != null && s.today_pass_rate < 95 && (Number(s.today_qc_fail) || 0) > 0) {
      list.push({
        id: 'qc-rate', sev: s.today_pass_rate < 90 ? 'high' : 'med', icon: 'shield',
        title: 'Pass rate below target', detail: `First-pass yield ${s.today_pass_rate}% · target 95%`,
        metric: `${s.today_pass_rate}%`,
        rec: 'Fail rate is above the 95% line. Open QC to find the defect and line driving it.',
        ctx: [['Pass rate', `${s.today_pass_rate}%`], ['Target', '95%'], ['Fails today', fmt(s.today_qc_fail)], ['QC pass', fmt(s.today_qc_pass)]],
        route: '/qc', primaryLabel: 'Open QC',
      });
    }
    if ((Number(s.repair_queue) || 0) > REPAIR_CAP) {
      list.push({
        id: 'repair-cap', sev: 'med', icon: 'wrench',
        title: 'Repair queue over cap', detail: `${fmt(s.repair_queue)} in workshop · cap ${REPAIR_CAP}`,
        metric: fmt(s.repair_queue),
        rec: `Queue is ${fmt(Number(s.repair_queue) - REPAIR_CAP)} over cap. Allocate an extra repair tech this hour or it spills into tomorrow.`,
        ctx: [['In workshop', fmt(s.repair_queue)], ['Cap', String(REPAIR_CAP)]],
        route: '/repair-queue', primaryLabel: 'Open Repair Queue',
      });
    }
    if (alertsOpen > 0) {
      list.push({
        id: 'alerts-open', sev: alertsOpen >= 10 ? 'high' : 'med', icon: 'alert',
        title: 'Unacknowledged scan alerts', detail: 'Scan-time QC violations awaiting ack',
        metric: fmt(alertsOpen),
        rec: 'Review and acknowledge open scan violations so real issues stay visible.',
        ctx: [['Open alerts', fmt(alertsOpen)]],
        route: '/alerts', primaryLabel: 'Open Alerts',
      });
    }
    if (returnsOpen > 0) {
      list.push({
        id: 'returns-open', sev: 'low', icon: 'undo',
        title: 'Returns awaiting action', detail: 'Return pile pending inspection / disposition',
        metric: fmt(returnsOpen),
        rec: 'Inspect and disposition the oldest returns first.',
        ctx: [['Awaiting', fmt(returnsOpen)]],
        route: '/returns', primaryLabel: 'Open Returns',
      });
    }
    if ((Number(s.open_findings) || 0) > 0) {
      list.push({
        id: 'audit-open', sev: 'low', icon: 'clipboard',
        title: 'Open audit findings', detail: 'Findings awaiting confirmation / closure',
        metric: fmt(s.open_findings),
        rec: 'Close or delegate open findings before the next audit cycle.',
        ctx: [['Open findings', fmt(s.open_findings)]],
        route: '/audit', primaryLabel: 'Open Audit',
      });
    }
    const order = { high: 0, med: 1, low: 2 };
    const snoozed = snoozedSet();
    return list
      .filter(e => !dismissed.has(e.id) && !snoozed.has(e.id))
      .sort((a, b) => order[a.sev] - order[b.sev]);
  }, [lineData, s, alertsOpen, returnsOpen, dismissed, dashHasData]);

  const counts = {
    all: exceptions.length,
    high: exceptions.filter(e => e.sev === 'high').length,
    med: exceptions.filter(e => e.sev === 'med').length,
    low: exceptions.filter(e => e.sev === 'low').length,
  };
  const shown = filter === 'all' ? exceptions : exceptions.filter(e => e.sev === filter);

  /* ── monthly projection (run-rate extrapolation of MTD → month-end) ──
     factor = daysInMonth / dayElapsed. Applied to cumulative flow metrics
     only (Dispatched, QC Pass) — the others are point-in-time snapshots or
     ratios where a cumulative projection isn't meaningful. */
  const todayISO = todayStr();
  const dayOfMonth = Number(todayISO.slice(8, 10)) || 1;
  const monthNum = Number(todayISO.slice(5, 7));
  const yearNum = Number(todayISO.slice(0, 4));
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate() || 30;
  const projFactor = daysInMonth / dayOfMonth;
  const projOf = (v) => '~' + fmt(Math.round((Number(v) || 0) * projFactor));
  const projNote = (mtdVal, what) => `${fmt(mtdVal)} ${what} in ${dayOfMonth} of ${daysInMonth} days → projected month-end at this pace`;

  /* ── tomorrow's planned runs (Submitted/Requested + in-flight, not closed) ── */
  const tomorrowISO = (() => {
    const d = new Date(`${todayISO}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const tomorrowRuns = (runs || [])
    .filter(r => r.run_date === tomorrowISO && !['Completed', 'Cancelled', 'Rejected'].includes(r.status))
    .sort((a, b) => (a.line_no || '').localeCompare(b.line_no || ''));

  const doAction = (a, ex) => {
    if (a === 'open') { setSel(null); router.push(ex.route); }
    else if (a === 'ack') {
      setDismissed(d => new Set([...d, ex.id])); setSel(null);
      showToast(`Acknowledged · ${ex.title}`, 'success');
    } else if (a === 'snooze') {
      snooze(ex.id); setDismissed(d => new Set([...d, ex.id])); setSel(null);
      showToast(`Snoozed 1h · ${ex.title}`, 'info');
    }
  };

  // Sections, each with the queries it is drawn from. The feed and the batteries say
  // "All clear" / "No line targets" only when every source behind them answered.
  const kpiReady = ready(dashQ) && (!ranged || ready(rangeQ));
  const attentionQs = [[dashQ, 'production numbers'], [pvaQ, 'line targets'], [alertsQ, 'scan alerts'], [returnsQ, 'returns']];
  const attentionReady = attentionQs.every(([q]) => ready(q));
  const attentionFailed = attentionQs.filter(([q]) => failedEmpty(q));
  const shiftReady = ready(dashQ) && ready(pvaQ);
  const shiftFailed = failedEmpty(dashQ) || failedEmpty(pvaQ);
  const retryFailed = (qs) => qs.forEach(q => { if (failedEmpty(q)) q.refresh(); });
  // With a source missing the severity counts are incomplete, so no chips and no filter.
  const feed = attentionFailed.length ? exceptions : shown;

  const presetBtn = (key, label) => (
    <button key={key} onClick={() => onPreset(key)} style={{ border: 'none', cursor: 'pointer', borderRadius: 'var(--r-xs)',
      padding: '5px 11px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', background: preset === key ? 'var(--yellow)' : 'transparent',
      color: preset === key ? '#1a1a1a' : 'var(--t3)' }}>{label}</button>
  );

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '6px 11px', color: 'var(--t2)' }}>
            <Icon name="clock" size={14} /><span className="num" style={{ fontSize: 12.5, color: 'var(--t1)' }}>{preset === 'today' ? todayStr() : `${rangeFor(preset).from} → ${rangeFor(preset).to}`}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, padding: 3, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
            {presetBtn('today', 'Today')}{presetBtn('week', 'This Week')}{presetBtn('month', 'This Month')}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span aria-live="polite" style={{ fontSize: 12, color: anyFailed && !anyInFlight ? 'var(--warn-fg)' : 'var(--t3)' }}>{freshness}</span>
          <button onClick={() => router.push('/new-run')} style={btnPrimary}>
            <Plus size={15} strokeWidth={2} /> New Run
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          {error}
          {dashFailed && <button onClick={dashQ.refresh} style={retryBtn}>Retry</button>}
        </div>
      )}

      {/* KPI rail */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 22 }}>
        {!kpiReady ? [true, true, false, false, false, false].map((p, i) => <KpiSkeleton key={i} proj={p} />) : <>
        <KpiTile label="Packed" value={k.dispatched} sub={k.subR} tone="ok"
          proj={has(mtdQ) ? projOf(mtdDispatched) : failedEmpty(mtdQ) ? '—' : <Skeleton width={44} height={11} />}
          projTitle={has(mtdQ) ? projNote(mtdDispatched, 'packed') : failedEmpty(mtdQ) ? 'Month-to-date packed could not be loaded' : undefined}
          onClick={() => setDrill('packed')} hint="Which units were packed — product, variant, colour, channel" />
        <KpiTile label="QC Pass" value={k.qcPass} sub="First-pass yield" tone="brand"
          proj={dashFailed ? '—' : projOf(s.mtd_pass)} projTitle={dashFailed ? undefined : projNote(s.mtd_pass, 'passed QC')}
          onClick={() => setDrill('qcPass')} hint="Which units passed QC" />
        <KpiTile label="Pass Rate" value={k.passRate} sub="Target 95%" tone={k.passTone}
          onClick={() => setDrill('qcFail')} hint="The fails behind the rate" />
        <KpiTile label="QC Fail" value={k.qcFail} sub={k.failSub} tone={preset === 'today' && (Number(s.today_qc_fail) || 0) > 0 ? 'bad' : undefined}
          onClick={() => setDrill('qcFail')} hint="Which units failed QC" />
        <KpiTile label="Repair Q" value={dashFailed ? '—' : fmt(s.repair_queue)} sub={`Cap ${REPAIR_CAP}`} tone={(Number(s.repair_queue) || 0) > REPAIR_CAP ? 'warn' : undefined}
          onClick={() => router.push('/repair-queue')} hint="Open the repair queue" />
        <KpiTile label="Pkg Out" value={dashFailed ? '—' : fmt(s.dispatch_stock)} sub="Units at RTD" tone="blue"
          onClick={() => setDrill('pkgOut')} hint="Units at RTD by product, variant, colour" />
        </>}
      </div>

      {/* two columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 18, alignItems: 'start' }}>
        <Panel title="Needs attention now" icon="alert" pad={8}
          action={!attentionReady || attentionFailed.length ? null : <div style={{ display: 'flex', gap: 6 }}>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>All</FilterChip>
            <FilterChip active={filter === 'high'} onClick={() => setFilter('high')} dot={SEV.high.dot} count={counts.high}>High</FilterChip>
            <FilterChip active={filter === 'med'} onClick={() => setFilter('med')} dot={SEV.med.dot} count={counts.med}>Med</FilterChip>
            <FilterChip active={filter === 'low'} onClick={() => setFilter('low')} dot={SEV.low.dot} count={counts.low}>Low</FilterChip>
          </div>}>
          {!attentionReady ? <RowsSkeleton rows={3} /> : <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {attentionFailed.length > 0 && (
              <PanelError message={`Could not load ${attentionFailed.map(([, l]) => l).join(', ')} — this list may be incomplete.`}
                onRetry={() => retryFailed(attentionFailed.map(([q]) => q))} pad="11px 13px" />
            )}
            {feed.map((ex, i) => <TriageRow key={ex.id} ex={ex} idx={i} onOpen={setSel} onAck={(e) => doAction('ack', e)} />)}
            {!feed.length && !attentionFailed.length && (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
                  background: 'var(--ok-bg)', color: 'var(--ok-fg)', border: '1px solid var(--ok-bd)', marginBottom: 12 }}>
                  <Icon name="shield" size={22} /></div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>All clear</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Nothing needs your attention right now.</div>
              </div>
            )}
          </div>
          {feed.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10, textAlign: 'center' }}>
              <span onClick={() => router.push('/alerts')}
                style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', cursor: 'pointer' }}>View all activity →</span>
            </div>
          )}
          </>}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Shift progress" icon="activity"
            action={<span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>9:00 → 18:00</span>}>
            {!shiftReady ? <BatteriesSkeleton /> : shiftFailed ? (
              <PanelError message={failedEmpty(dashQ) ? 'Could not load line output.' : 'Could not load line targets.'}
                onRetry={() => retryFailed([dashQ, pvaQ])} />
            ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {lineData.filter(l => l.target > 0 || l.done > 0 || l.scan).map(line => (
                <div key={line.id} onClick={() => router.push('/lines')} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: lineColor(line.id), flexShrink: 0 }} />
                    <span className="font-display" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--t1)', flexShrink: 0 }}>{line.id}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                      {line.product !== '—' ? line.product : line.scan ? (
                        <>
                          <span style={{ color: 'var(--t3)' }}>No run · </span>{line.scan.label}
                          {line.scan.others > 0 && <span style={{ color: 'var(--t4)' }}> +{line.scan.others}</span>}
                        </>
                      ) : <span style={{ color: 'var(--t3)' }}>No run assigned</span>}
                    </span>
                    <span className="num" style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      {line.run || (line.scan ? `${fmt(line.scan.total)} scans` : '')}
                    </span>
                  </div>
                  <ShiftBattery lineId={line.id} done={line.done} target={line.target} segments={18} height={26} />
                </div>
              ))}
              {!lineData.filter(l => l.target > 0 || l.done > 0 || l.scan).length && (
                <div style={{ padding: '18px 0', textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>
                  No line targets set for today.
                </div>
              )}
            </div>
            )}
          </Panel>
        </div>
      </div>

      {/* Tomorrow's planned runs */}
      <div style={{ marginTop: 18 }}>
        <Panel title={`Tomorrow's runs · ${tomorrowISO}`} icon="factory"
          action={<span onClick={() => router.push('/lines')}
            style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', cursor: 'pointer' }}>Lines →</span>}
          pad={has(dashQ) && tomorrowRuns.length ? 8 : 16}>
          {!ready(dashQ) ? <RowsSkeleton rows={2} /> : dashFailed ? (
            <PanelError message="Could not load tomorrow's runs." onRetry={dashQ.refresh} />
          ) : tomorrowRuns.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>
              No runs requested or submitted for tomorrow yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1.4fr 80px 1fr 110px', gap: 12, padding: '0 12px 9px', borderBottom: '1px solid var(--border)' }}>
                {['Run', 'Product', 'Line', 'Target', 'Status'].map(h => <div key={h} className="eyebrow">{h}</div>)}
              </div>
              {tomorrowRuns.map((r, i) => (
                <div key={r.run_no} onClick={() => router.push('/new-run')}
                  style={{ display: 'grid', gridTemplateColumns: '120px 1.4fr 80px 1fr 110px', gap: 12, alignItems: 'center',
                    padding: '11px 12px', cursor: 'pointer', borderTop: i ? '1px solid var(--border)' : 'none',
                    transition: 'background var(--fast) var(--ease)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--yellow)' }}>{r.run_no}</span>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.product || '—'}</span>
                  <span>
                    {r.line_no
                      ? <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(r.line_no), background: `rgba(${lineRgb(r.line_no)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{r.line_no}</span>
                      : <span style={{ color: 'var(--t4)' }}>—</span>}
                  </span>
                  <span className="num" style={{ fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                    {fmt(r.target_qty)}
                    <span style={{ color: 'var(--t4)' }}> · {fmt(r.target_retail)}R / {fmt(r.target_ecom)}E</span>
                  </span>
                  <span><ToneBadge tone={RUN_TONE[r.status] || 'mute'}>{r.status}</ToneBadge></span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <ExceptionDrawer ex={sel} onClose={() => setSel(null)} onAction={doAction} />
      {drill && (
        <KpiDrilldown drill={drill} from={rangeFor(preset).from} to={rangeFor(preset).to}
          session={session} onClose={() => setDrill(null)} refreshKey={tick}
          tileValue={preset === 'today' || !rangePva ? null : ({ qcPass: k.qcPass, qcFail: k.qcFail }[drill] ?? null)} />
      )}
    </div>
  );
}

const retryBtn = { ...btnGhost, padding: '6px 13px', flexShrink: 0 };

// A failed section with nothing to fall back on says so — never zeros, never an
// "all clear", never a skeleton that spins forever.
function PanelError({ message, onRetry, pad }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)', padding: pad }}>
      <span>{message}</span>
      <button onClick={onRetry} style={retryBtn}>Retry</button>
    </div>
  );
}

// Skeletons, each laid out like the content it stands in for.
function KpiSkeleton({ proj }) {
  return (
    <div aria-busy="true" style={{ background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)', padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      {proj && <div style={{ paddingBottom: 8, borderBottom: '1px dashed var(--border-2)' }}><Skeleton width="45%" height={11} /></div>}
      <Skeleton width="50%" height={10} />
      <Skeleton width="60%" height={23} />
      <Skeleton width="75%" height={11} />
    </div>
  );
}

function RowsSkeleton({ rows }) {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px' }}>
          <Skeleton width={32} height={32} radius="var(--r-sm)" />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="55%" height={13} />
            <Skeleton width="35%" height={11} />
          </div>
          <Skeleton width={36} height={14} />
        </div>
      ))}
    </div>
  );
}

function BatteriesSkeleton() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Skeleton width={8} height={8} radius="50%" />
            <Skeleton width="40%" height={13} />
            <span style={{ flex: 1 }} />
            <Skeleton width={56} height={11} />
          </div>
          <Skeleton height={26} />
        </div>
      ))}
    </div>
  );
}
