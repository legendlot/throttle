'use client';
/* ════════════════════════════════════════════════════════════
   OVERVIEW — the Triage dashboard (redesign-reference/app/triage.jsx).
   Answers "what needs me now": KPI rail with date presets ·
   manpower summary strip · prioritized exception feed with a
   drill-down drawer · right rail shift batteries + dispatch today.
   All data from existing APIs (getProductionDashboard,
   getPlanVsActual, getScanSummary, getManpowerLog,
   getOperatorAttendance). Exceptions are computed client-side.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { Plus, Users, X } from 'lucide-react';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Spark, ShiftBattery, KpiTile, Panel, FilterChip, ToneBadge, Drawer,
  lineColor, lineRgb, fmt, SEV, istNow, btnPrimary, btnGhost,
} from '../../../components/kit/index.js';

// run status → kit ToneBadge tone
const RUN_TONE = {
  Requested: 'info', Submitted: 'info', Draft: 'mute', Picking: 'warn',
  Issued: 'brand', 'In Progress': 'ok',
};

const SHIFT_START = 9, SHIFT_END = 18, SHIFT_HRS = 9;
const REPAIR_CAP = 50;

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

/* ── Manpower summary strip — who's on the floor today ──────── */
function ManpowerStrip({ mp, onOpen }) {
  if (!mp || !mp.plan) return null;
  const { present, plan, lines } = mp;
  const absent = Math.max(plan - present, 0);
  const rate = plan ? Math.round((present / plan) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-card)',
      overflow: 'hidden', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 15, padding: '15px 22px', flexShrink: 0 }}>
        <div style={{ width: 42, height: 42, borderRadius: 'var(--r-sm)', display: 'grid', placeItems: 'center',
          background: 'var(--brand-bg)', color: 'var(--yellow)', border: '1px solid var(--brand-bd)' }}>
          <Users size={21} strokeWidth={1.75} />
        </div>
        <div>
          <div className="eyebrow">On floor today</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 3 }}>
            <span className="num" style={{ fontSize: 28, fontWeight: 700, color: 'var(--t1)', lineHeight: 1 }}>{present}</span>
            <span className="num" style={{ fontSize: 14, color: 'var(--t4)' }}>/ {plan} planned</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '0 24px', borderLeft: '1px solid var(--border)' }}>
        <div>
          <div className="eyebrow">Present</div>
          <div className="num" style={{ fontSize: 18, fontWeight: 700, color: rate >= 95 ? 'var(--ok-fg)' : 'var(--warn-fg)', marginTop: 3 }}>{rate}%</div>
        </div>
        <div>
          <div className="eyebrow">Absent</div>
          <div className="num" style={{ fontSize: 18, fontWeight: 700, color: absent > 0 ? 'var(--bad-fg)' : 'var(--t1)', marginTop: 3 }}>{absent}</div>
        </div>
      </div>
      {lines.length > 0 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, padding: '12px 24px',
          borderLeft: '1px solid var(--border)', minWidth: 0 }}>
          {lines.map(l => {
            const short = l.present < l.plan;
            const pct = l.plan ? Math.round((l.present / l.plan) * 100) : 0;
            return (
              <div key={l.id} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: lineColor(l.id), flexShrink: 0 }} />
                  <span className="font-display" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--t1)' }}>{l.id}</span>
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--t1)', marginLeft: 'auto' }}>
                    {l.present}<span style={{ color: 'var(--t4)', fontWeight: 400 }}>/{l.plan}</span>
                  </span>
                  {short && <span className="num" style={{ fontSize: 10, fontWeight: 700, color: 'var(--bad-fg)',
                    background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 3, padding: '0 4px' }}>−{l.plan - l.present}</span>}
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3,
                    background: short ? 'var(--red)' : lineColor(l.id) }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 20px', borderLeft: '1px solid var(--border)' }}>
        <button onClick={onOpen} style={{ ...btnGhost, background: 'transparent', whiteSpace: 'nowrap' }}>
          <Users size={14} strokeWidth={1.75} /> Manpower
        </button>
      </div>
    </div>
  );
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
  const { session } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [preset, setPreset] = useState('today');
  const [summary, setSummary] = useState(null);
  const [hourly, setHourly] = useState([]);
  const [pva, setPva] = useState([]);          // today — batteries + line context
  const [rangePva, setRangePva] = useState([]); // preset range — week/month KPIs
  const [scanSummary, setScanSummary] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(0);
  const [returnsOpen, setReturnsOpen] = useState(0);
  const [mp, setMp] = useState(null);
  const [runs, setRuns] = useState([]);           // open runs (for tomorrow's-runs panel)
  const [mtdDispatched, setMtdDispatched] = useState(0); // month-to-date dispatched (Σ rtr+rte)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());

  const rangeFor = (p) => {
    const today = todayStr();
    if (p === 'week') return { from: getMondayISO(), to: today };
    if (p === 'month') return { from: getFirstOfMonthISO(), to: today };
    return { from: today, to: today };
  };

  const loadData = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const date = todayStr();
      const monthStart = getFirstOfMonthISO();
      const [dashData, pvaData, monthPvaData, scanData, vioData, retData, mplData, attData] = await Promise.allSettled([
        garageFetch('getProductionDashboard', { date }, session),
        garageFetch('getPlanVsActual', { from: date, to: date }, session),
        garageFetch('getPlanVsActual', { from: monthStart, to: date }, session),
        garageFetch('getScanSummary', { date }, session),
        garageFetch('getViolations', { acknowledged: 'false' }, session),
        garageFetch('getReturnQueue', {}, session),
        workerFetch('getManpowerLog', { data: { shift_date: date } }, session),
        workerFetch('getOperatorAttendance', { data: { date_from: date, date_to: date } }, session),
      ]);

      if (dashData.status === 'fulfilled') {
        const d = dashData.value;
        setSummary(d.summary || null);
        setHourly(d.hourly_dispatch?.length ? d.hourly_dispatch : (d.hourly_chart || []));
        setRuns(Array.isArray(d.open_runs) ? d.open_runs : []);
        setError(null);
      } else {
        setError('Dashboard data unavailable');
      }
      setPva(pvaData.status === 'fulfilled' ? (pvaData.value || []) : []);

      // Month-to-date dispatched (Σ rtr+rte) — drives the per-card monthly projection.
      if (monthPvaData.status === 'fulfilled' && Array.isArray(monthPvaData.value)) {
        const mtd = monthPvaData.value.reduce((sum, r) =>
          sum + (Number(r.actual_rtr) || 0) + (Number(r.actual_rte) || 0), 0);
        setMtdDispatched(mtd);
      }
      setScanSummary(scanData.status === 'fulfilled' ? (scanData.value || null) : null);
      setAlertsOpen(vioData.status === 'fulfilled' && Array.isArray(vioData.value) ? vioData.value.length : 0);
      setReturnsOpen(retData.status === 'fulfilled' && Array.isArray(retData.value) ? retData.value.length : 0);

      // manpower strip — planned (assignments) vs present (clock-ins)
      try {
        const mplRaw = mplData.status === 'fulfilled' ? mplData.value : null;
        const attRaw = attData.status === 'fulfilled' ? attData.value : null;
        const mpl = Array.isArray(mplRaw?.data) ? mplRaw.data : (Array.isArray(mplRaw) ? mplRaw : []);
        const att = Array.isArray(attRaw?.data) ? attRaw.data : (Array.isArray(attRaw) ? attRaw : []);
        if (mpl.length) {
          // ⚠️ An attendance row is NOT the same as being present — a supervisor can mark the
          // day `absent`/`leave` and the row remains (RULE-ATT-001). Counting raw rows showed
          // people known to be away as "present" against the roster plan. Fixed S322, same
          // day as the identical bug on Garage's Store Present KPI.
          // ⚠️ Values are lowercase snake_case (`absent`, not `Absent`) — a filter written
          // against the manual's display labels matches nothing and looks like it worked.
          // ⚠️ Depot's dashboard is NOT affected and needs no change: it filters on
          // `!clock_out`, and all 27 absent rows carry a clock_out (verified 2026-08-28).
          const AWAY = new Set(['absent', 'leave']);
          const attIds = new Set(att.filter(a => !AWAY.has(a.day_status)).map(a => a.operator_id));
          const byLine = {};
          for (const a of mpl) {
            const line = a.line || a.line_no || 'Others';
            if (!/^L\d$/.test(line)) continue; // strip non-production sections from the rail
            byLine[line] = byLine[line] || { id: line, plan: 0, present: 0 };
            byLine[line].plan += 1;
            if (attIds.has(a.operator_id)) byLine[line].present += 1;
          }
          const lines = Object.values(byLine).sort((a, b) => a.id.localeCompare(b.id));
          const plan = mpl.length;
          const present = new Set(mpl.filter(a => attIds.has(a.operator_id)).map(a => a.operator_id)).size;
          setMp({ plan, present, lines });
        } else setMp(null);
      } catch (_) { setMp(null); }
    } catch (e) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadData, 30000, !session);

  // week/month KPI source — PvA over the preset range (existing API)
  const loadRange = useCallback(async (p) => {
    if (!session || p === 'today') { setRangePva([]); return; }
    const { from, to } = rangeFor(p);
    try { setRangePva(await garageFetch('getPlanVsActual', { from, to }, session) || []); }
    catch (_) { setRangePva([]); }
  }, [session]);

  const onPreset = (p) => { setPreset(p); loadRange(p); };

  /* ── KPI rail (preset-keyed; '—' where a range number isn't available) ── */
  const s = summary || {};
  const k = useMemo(() => {
    if (preset === 'today') {
      return {
        dispatched: fmt(s.today_dispatched), subR: `${fmt(s.today_rtr)} retail · ${fmt(s.today_rte)} ecom`,
        qcPass: fmt(s.today_qc_pass), passRate: s.today_pass_rate != null ? s.today_pass_rate + '%' : '—',
        passTone: s.today_pass_rate >= 95 ? 'ok' : s.today_pass_rate != null ? 'warn' : undefined,
        qcFail: fmt(s.today_qc_fail),
        failSub: s.qc_fail_car != null ? `${fmt(s.qc_fail_car)}C · ${fmt(s.qc_fail_remote || 0)}R` : 'Today',
      };
    }
    const agg = rangePva.reduce((a, r) => {
      a.disp += (Number(r.actual_rtr) || 0) + (Number(r.actual_rte) || 0);
      a.rtr += Number(r.actual_rtr) || 0; a.rte += Number(r.actual_rte) || 0;
      a.pass += Number(r.actual_qc_pass) || 0;
      a.fail += Number(r.actual_qc_fail) || 0;
      return a;
    }, { disp: 0, rtr: 0, rte: 0, pass: 0, fail: 0 });
    const label = preset === 'week' ? 'Mon → today' : '1st → today';
    // Pass Rate + QC Fail over the range, now that get_plan_vs_actual carries actual_qc_fail
    // (previously hardcoded '—' for non-today presets). All range KPIs derive from rangePva so
    // the rail is internally consistent (pass, fail, rate one source).
    const denom = agg.pass + agg.fail;
    const rate = denom > 0 ? Math.round((agg.pass / denom) * 100) : null;
    return {
      dispatched: fmt(agg.disp), subR: `${fmt(agg.rtr)} retail · ${fmt(agg.rte)} ecom`,
      qcPass: fmt(agg.pass),
      passRate: rate != null ? rate + '%' : '—',
      passTone: rate >= 95 ? 'ok' : rate != null ? 'warn' : undefined,
      qcFail: fmt(agg.fail),
      failSub: label,
    };
  }, [preset, s, rangePva]);

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
    const ids = [...new Set([...Object.keys(byLine), ...Object.keys(targets)])].sort();
    return ids.map(id => ({
      id,
      hourly: byLine[id] || {},
      done: Object.values(byLine[id] || {}).reduce((a, b) => a + b, 0),
      target: targets[id] || 0,
      product: products[id] || '—',
      run: runNos[id] || '',
    }));
  }, [hourly, pva]);

  /* ── exception feed — computed from live data ───────────────── */
  const exceptions = useMemo(() => {
    const list = [];
    const nowHr = istNow().hour;
    const hrsElapsed = Math.max(0, Math.min(nowHr - SHIFT_START, SHIFT_HRS));

    for (const l of lineData) {
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
  }, [lineData, s, alertsOpen, returnsOpen, dismissed]);

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

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;
  }

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
        <button onClick={() => router.push('/new-run')} style={btnPrimary}>
          <Plus size={15} strokeWidth={2} /> New Run
        </button>
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '12px 14px', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 20 }}>
          {error}
        </div>
      )}

      {/* KPI rail */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 22 }}>
        <KpiTile label="Packed" value={k.dispatched} sub={k.subR} tone="ok"
          proj={projOf(mtdDispatched)} projTitle={projNote(mtdDispatched, 'packed')} />
        <KpiTile label="QC Pass" value={k.qcPass} sub="First-pass yield" tone="brand"
          proj={projOf(s.mtd_pass)} projTitle={projNote(s.mtd_pass, 'passed QC')} />
        <KpiTile label="Pass Rate" value={k.passRate} sub="Target 95%" tone={k.passTone} />
        <KpiTile label="QC Fail" value={k.qcFail} sub={k.failSub} tone={preset === 'today' && (Number(s.today_qc_fail) || 0) > 0 ? 'bad' : undefined} />
        <KpiTile label="Repair Q" value={fmt(s.repair_queue)} sub={`Cap ${REPAIR_CAP}`} tone={(Number(s.repair_queue) || 0) > REPAIR_CAP ? 'warn' : undefined} />
        <KpiTile label="Pkg Out" value={fmt(s.dispatch_stock)} sub="Units at RTD" tone="blue" />
      </div>

      {/* manpower summary */}
      <ManpowerStrip mp={mp} onOpen={() => router.push('/manpower')} />

      {/* two columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 18, alignItems: 'start' }}>
        <Panel title="Needs attention now" icon="alert" pad={8}
          action={<div style={{ display: 'flex', gap: 6 }}>
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>All</FilterChip>
            <FilterChip active={filter === 'high'} onClick={() => setFilter('high')} dot={SEV.high.dot} count={counts.high}>High</FilterChip>
            <FilterChip active={filter === 'med'} onClick={() => setFilter('med')} dot={SEV.med.dot} count={counts.med}>Med</FilterChip>
            <FilterChip active={filter === 'low'} onClick={() => setFilter('low')} dot={SEV.low.dot} count={counts.low}>Low</FilterChip>
          </div>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {shown.map((ex, i) => <TriageRow key={ex.id} ex={ex} idx={i} onOpen={setSel} onAck={(e) => doAction('ack', e)} />)}
            {!shown.length && (
              <div style={{ padding: '40px 0', textAlign: 'center' }}>
                <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
                  background: 'var(--ok-bg)', color: 'var(--ok-fg)', border: '1px solid var(--ok-bd)', marginBottom: 12 }}>
                  <Icon name="shield" size={22} /></div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>All clear</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Nothing needs your attention right now.</div>
              </div>
            )}
          </div>
          {shown.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 10, textAlign: 'center' }}>
              <span onClick={() => router.push('/alerts')}
                style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', cursor: 'pointer' }}>View all activity →</span>
            </div>
          )}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Shift progress" icon="activity"
            action={<span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>9:00 → 18:00</span>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {lineData.filter(l => l.target > 0 || l.done > 0).map(line => (
                <div key={line.id} onClick={() => router.push('/lines')} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: lineColor(line.id), flexShrink: 0 }} />
                    <span className="font-display" style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--t1)', flexShrink: 0 }}>{line.id}</span>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.product}</span>
                    <span className="num" style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{line.run}</span>
                  </div>
                  <ShiftBattery lineId={line.id} done={line.done} target={line.target} segments={18} height={26} />
                </div>
              ))}
              {!lineData.filter(l => l.target > 0 || l.done > 0).length && (
                <div style={{ padding: '18px 0', textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>
                  No line targets set for today.
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>

      {/* Tomorrow's planned runs */}
      <div style={{ marginTop: 18 }}>
        <Panel title={`Tomorrow's runs · ${tomorrowISO}`} icon="factory"
          action={<span onClick={() => router.push('/lines')}
            style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', cursor: 'pointer' }}>Lines →</span>}
          pad={tomorrowRuns.length ? 8 : 16}>
          {tomorrowRuns.length === 0 ? (
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
    </div>
  );
}
