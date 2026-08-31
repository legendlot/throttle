'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Lock, Download } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { LINES } from '@throttle/domain';
import { Spinner, useToast } from '@throttle/ui';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, KpiTile, FilterChip, ToneBadge, fmt, lineColor, lineRgb } from '../../../components/kit/index.js';

// Pit Wall v2 reskin — data calls, aggregations and exports unchanged.

// ── Helpers ───────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

function fmtMins(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return n < 60 ? Math.round(n) + ' min' : (n / 60).toFixed(1) + ' hr';
}

// Cycle-time tone (text uses semantic fg vars; tiles use tone keys)
function ctTone(mins) {
  if (mins == null) return undefined;
  if (mins <= 30) return 'ok';
  if (mins <= 60) return 'warn';
  return 'bad';
}
const TONE_FG = { ok: 'var(--ok-fg)', warn: 'var(--warn-fg)', bad: 'var(--bad-fg)' };
function ctColor(mins) {
  return TONE_FG[ctTone(mins)] || 'var(--t3)';
}

function fmtMonthDay(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
}

// ── Severity colour ──────────────────────────────────────────
// ⚠️ These four keys must match the distinct severities in public.defect_master and the
// qc_fail_defects_severity_check CHECK. `cosmetic` was added 2026-08-28 (S322): the CHECK had
// never been widened for it, so no Cosmetic defect could be recorded at all — and this file
// would have silently counted any that were as `minor` (the else-branch below).
const SEVERITY_COLOR = {   // chart fills
  critical: '#ef4444',
  major:    '#f59e0b',
  minor:    '#888',
  cosmetic: '#38bdf8',
};
const SEVERITY_FG = {      // WCAG-safe text colors
  critical: 'var(--bad-fg)',
  major:    'var(--warn-fg)',
  minor:    'var(--t3)',
  cosmetic: 'var(--t2)',
};

// ── Common styles ────────────────────────────────────────────
const dateInputStyle = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border-2)', padding: '6px 10px', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 12.5, outline: 'none' };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--font-ui)', fontSize: 13, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', color: 'var(--t1)' };
const numTd = { ...tdStyle, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--font-ui)' };
const tickStyle = { fontSize: 11, fontFamily: 'var(--font-mono)' };

function EmptyMsg({ icon, text }) {
  return (
    <div style={{ padding: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--t3)' }}>
      <Icon name={icon} size={22} />
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>{text}</span>
    </div>
  );
}

// ── CSV download helper ──────────────────────────────────────
function downloadCsv(filename, rows, headers) {
  if (!rows || !rows.length) return false;
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ── Reporting Page ───────────────────────────────────────────
export default function ReportingPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  // Page gate — mirror canDownload/canViewProd on the server side.
  // Anyone with reports, production_view, or users_manage can view.
  const canViewReporting = !!(perms?.reports || perms?.production_view || perms?.users_manage);
  const canViewFinance   = !!perms?.reports_finance;
  // Attendance & OT (salary) — mirrors the worker's canManageFloor gate on getAttendanceSalary*.
  const canViewAttendance = !!(perms?.users_manage || perms?.production_view || perms?.procurement_approve || perms?.damage_manage);

  const [preset,     setPreset]     = useState('10days');
  const [dateFrom,   setDateFrom]   = useState('');
  const [dateTo,     setDateTo]     = useState('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo,   setCustomTo]   = useState('');

  const [section,    setSection]    = useState('production');

  const [pvaData,    setPvaData]    = useState([]);
  const [ctData,     setCtData]     = useState(null);
  const [qcData,     setQcData]     = useState(null);
  const [taktData,   setTaktData]   = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [taktLoading,setTaktLoading]= useState(false);

  const [attData,    setAttData]    = useState(null);   // salary summary rows (per operator)
  const [attLoading, setAttLoading] = useState(false);
  const [attDetailBusy, setAttDetailBusy] = useState(false);

  const [prodView,   setProdView]   = useState('product');
  const [defView,    setDefView]    = useState('code');

  const [fmtData,    setFmtData]    = useState(null);   // L17: output by run format (CKD/SKD/FBU)
  const [fmtLoading, setFmtLoading] = useState(false);

  // ── Apply preset ─────────────────────────────────────────
  function applyPreset(p) {
    const today = new Date();
    const todayStr = fmtISO(today);
    if (p === '10days') {
      const d = new Date(today); d.setDate(d.getDate() - 9);
      setDateFrom(fmtISO(d)); setDateTo(todayStr);
    } else if (p === 'thisweek') {
      const d = new Date(today);
      const dow = d.getDay();
      const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
      d.setDate(diff);
      setDateFrom(fmtISO(d)); setDateTo(todayStr);
    } else if (p === 'thismonth') {
      setDateFrom(`${today.getFullYear()}-${pad(today.getMonth()+1)}-01`);
      setDateTo(todayStr);
    } else if (p === 'custom') {
      setDateFrom(customFrom); setDateTo(customTo);
    }
    setPreset(p);
  }

  const presetInitRef = useRef(false);
  useEffect(() => {
    if (presetInitRef.current) return;
    presetInitRef.current = true;
    applyPreset('10days');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Main load ─────────────────────────────────────────────
  const loadReporting = useCallback(async () => {
    if (!session || !dateFrom || !dateTo) return;
    setLoading(true);
    setRefreshing(true);
    try {
      const [pva, ct, qc] = await Promise.allSettled([
        garageFetch('getPlanVsActual',     { from: dateFrom, to: dateTo }, session),
        garageFetch('getCycleTimeSummary', { from: dateFrom, to: dateTo }, session),
        garageFetch('getQCView',           { from: dateFrom, to: dateTo }, session),
      ]);
      setPvaData(pva.status === 'fulfilled' && Array.isArray(pva.value) ? pva.value : []);
      setCtData(ct.status === 'fulfilled' ? ct.value : null);
      setQcData(qc.status === 'fulfilled' ? qc.value : null);
      setTaktData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, dateFrom, dateTo, setRefreshing, setLastRefreshed]);

  useEffect(() => { loadReporting(); }, [loadReporting]);

  // ── Lazy-load takt on Throughput section select ─────────
  useEffect(() => {
    if (section === 'throughput' && taktData === null && dateFrom && dateTo && session) {
      setTaktLoading(true);
      garageFetch('getTaktTime', { from: dateFrom, to: dateTo }, session)
        .then(d => setTaktData(d || { takt: [] }))
        .catch(() => setTaktData({ takt: [] }))
        .finally(() => setTaktLoading(false));
    }
  }, [section, taktData, dateFrom, dateTo, session]);

  // ── Output by format (L17) — load when the section is active ──
  useEffect(() => {
    if (section !== 'formats' || !dateFrom || !dateTo || !session) return;
    let cancelled = false;
    setFmtLoading(true);
    garageFetch('getOutputByFormat', { from: dateFrom, to: dateTo }, session)
      .then(res => { if (!cancelled) setFmtData(Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : [])); })
      .catch(() => { if (!cancelled) setFmtData([]); })
      .finally(() => { if (!cancelled) setFmtLoading(false); });
    return () => { cancelled = true; };
  }, [section, dateFrom, dateTo, session]);

  // ── Attendance & OT (salary) — load per selected range ──
  useEffect(() => {
    if (section !== 'attendance' || !dateFrom || !dateTo || !session || !canViewAttendance) return;
    let cancelled = false;
    setAttLoading(true);
    workerFetch('getAttendanceSalaryReport', { data: { start: dateFrom, end: dateTo } }, session)
      .then(res => { if (!cancelled) setAttData(Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])); })
      .catch(() => { if (!cancelled) setAttData([]); })
      .finally(() => { if (!cancelled) setAttLoading(false); });
    return () => { cancelled = true; };
  }, [section, dateFrom, dateTo, session, canViewAttendance]);

  const periodLabel = (dateFrom && dateTo)
    ? `${fmtMonthDay(dateFrom)} – ${fmtMonthDay(dateTo)}`
    : '';

  // ── Attendance & OT CSV downloads ────────────────────────
  function downloadAttendanceSummary() {
    const rows = (attData || []).map(r => ({
      employee_id: r.employee_id, name: r.operator_name, department: r.department, team: r.team,
      employment_type: r.employment_type, present_days: r.present_days, half_days: r.half_days,
      payable_days: r.payable_days, sundays_worked: r.sundays_worked, ot_hours: r.ot_hours,
      ot_minutes: r.ot_minutes, late_minutes: r.late_minutes, absent_days: r.absent_days,
      first_present: r.first_present || '', last_present: r.last_present || '',
    }));
    const ok = downloadCsv(`attendance-ot-summary-${dateFrom}_to_${dateTo}.csv`, rows,
      ['employee_id','name','department','team','employment_type','present_days','half_days','payable_days','sundays_worked','ot_hours','ot_minutes','late_minutes','absent_days','first_present','last_present']);
    if (!ok) showToast('No attendance data to download', 'error');
  }
  async function downloadAttendanceDetail() {
    if (attDetailBusy) return;
    setAttDetailBusy(true);
    try {
      const res = await workerFetch('getAttendanceSalaryDetail', { data: { start: dateFrom, end: dateTo } }, session);
      const rows = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
      const ok = downloadCsv(`attendance-ot-detail-${dateFrom}_to_${dateTo}.csv`, rows,
        ['employee_id','operator_name','department','team','date','clock_in_ist','clock_out_ist','open_shift','ot_minutes','late_minutes','day_status','auto_closed']);
      if (!ok) showToast('No attendance detail to download', 'error');
    } catch {
      showToast('Failed to build detail export', 'error');
    } finally {
      setAttDetailBusy(false);
    }
  }

  // ── Production: aggregations ─────────────────────────────
  const prodAggs = useMemo(() => {
    const byDate = {};
    const byProduct = {};
    const byLine = {};
    let totalQc = 0, totalDispatched = 0, totalTarget = 0, totalRetail = 0, totalEcom = 0, runs = 0;

    for (const r of pvaData) {
      const dateKey = r.run_date;
      const qc = Number(r.actual_qc_pass) || 0;
      const dis = Number(r.total_dispatched) || 0;
      const tgt = Number(r.target_qty) || 0;
      const ret = Number(r.actual_rtr) || 0;
      const ec  = Number(r.actual_rte) || 0;
      runs++;
      totalQc += qc; totalDispatched += dis; totalTarget += tgt; totalRetail += ret; totalEcom += ec;

      if (!byDate[dateKey]) byDate[dateKey] = { date: dateKey, qcPass: 0, dispatched: 0 };
      byDate[dateKey].qcPass     += qc;
      byDate[dateKey].dispatched += dis;

      const pKey = r.product || '—';
      if (!byProduct[pKey]) byProduct[pKey] = { product: pKey, runs: 0, target: 0, qcPass: 0, dispatched: 0, retail: 0, ecom: 0 };
      byProduct[pKey].runs       += 1;
      byProduct[pKey].target     += tgt;
      byProduct[pKey].qcPass     += qc;
      byProduct[pKey].dispatched += dis;
      byProduct[pKey].retail     += ret;
      byProduct[pKey].ecom       += ec;

      const lKey = r.line_no || '—';
      if (!byLine[lKey]) byLine[lKey] = { line: lKey, runs: 0, products: new Set(), target: 0, qcPass: 0, dispatched: 0, retail: 0, ecom: 0 };
      byLine[lKey].runs       += 1;
      byLine[lKey].products.add(pKey);
      byLine[lKey].target     += tgt;
      byLine[lKey].qcPass     += qc;
      byLine[lKey].dispatched += dis;
      byLine[lKey].retail     += ret;
      byLine[lKey].ecom       += ec;
    }

    // NB: no `fpy` here. A dead line used to compute totalQc / (totalQc + fail_count) and
    // put it in `totals`, which nothing renders. Deleted rather than wired up, because that
    // formula is a PASS RATE, not First Pass Yield: totalQc counts rework passes, so a car
    // that failed, went to Workshop and passed on the second attempt scored as a success.
    // FPY exists to exclude exactly that. It also read fail_count off `fpy[0]`, i.e. one
    // arbitrary (date, line, product) group, against a whole-period totalQc.
    // The real figure is `fpyPct` below — derived from the view's own first_pass_count.
    const vsTarget = totalTarget > 0 ? Math.round((totalDispatched / totalTarget) * 1000) / 10 : null;

    const chartRows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(r => ({
      date: fmtMonthDay(r.date), qcPass: r.qcPass, dispatched: r.dispatched,
    }));

    return {
      totals: { totalQc, totalDispatched, totalTarget, totalRetail, totalEcom, runs, vsTarget },
      chartRows,
      byProduct: Object.values(byProduct),
      byLine: Object.values(byLine).map(l => ({ ...l, productCount: l.products.size })),
    };
  }, [pvaData, qcData]);

  // ── Defects: aggregations ────────────────────────────────
  const defectAggs = useMemo(() => {
    const heatmap = qcData?.heatmap || [];
    const breakdown = qcData?.defect_breakdown || [];
    let total = 0;
    const codeMap = {};
    const productMap = {};
    for (const row of heatmap) {
      const cnt = Number(row.count) || Number(row.fail_count) || 0;
      total += cnt;
      const code = row.error_code || row.code || '—';
      if (!codeMap[code]) codeMap[code] = { code, issue: row.issue || '', category: row.category || '', severity: (row.severity || 'minor').toLowerCase(), count: 0 };
      codeMap[code].count += cnt;
      const product = row.product || '—';
      const sev = (row.severity || 'minor').toLowerCase();
      if (!productMap[product]) productMap[product] = { product, total: 0, critical: 0, major: 0, minor: 0, cosmetic: 0, top: { code: '', count: 0 } };
      productMap[product].total += cnt;
      if (sev === 'critical') productMap[product].critical += cnt;
      else if (sev === 'major') productMap[product].major += cnt;
      else if (sev === 'cosmetic') productMap[product].cosmetic += cnt;
      else productMap[product].minor += cnt;
      if (cnt > productMap[product].top.count) productMap[product].top = { code, count: cnt };
    }
    const codeList = Object.values(codeMap).sort((a, b) => b.count - a.count);
    const top = codeList[0];

    const top8 = codeList.slice(0, 8).map(c => ({ code: c.code, count: c.count, severity: c.severity }));
    const sevSplit = { critical: 0, major: 0, minor: 0, cosmetic: 0 };
    for (const c of codeList) sevSplit[c.severity || 'minor'] = (sevSplit[c.severity || 'minor'] || 0) + c.count;
    const sevPie = ['critical', 'major', 'minor', 'cosmetic']
      .map(k => ({ name: k.charAt(0).toUpperCase() + k.slice(1), value: sevSplit[k] || 0, key: k }))
      .filter(d => d.value > 0);

    return {
      total,
      uniqueCodes: codeList.length,
      top,
      codeList,
      productList: Object.values(productMap),
      top8, sevPie,
      breakdown,
    };
  }, [qcData]);

  // ⚠️ `v_first_pass_yield` is grouped per (scan_date, line, product) and the worker returns
  // its rows RAW, newest first. Reading `fpy[0].fpy_pct` therefore showed ONE arbitrary
  // group — one product, on one line, on one day — under a tile labelled as the period's
  // FPY. Measured 2026-08-27 over a 30-day window: 125 rows across 26 dates, row 0 read
  // 75.3% (Shadow on L1) while the true figure was 83.8%, and per-row values span 0–100.
  // ⚠️ Aggregate by SUMMING the view's counts, never by averaging fpy_pct — that would give
  // a 1-car group the same weight as a 500-car one.
  // NB the view is cars only (component_type='car'), so this is car FPY by definition.
  const fpyPct = (() => {
    const rows = Array.isArray(qcData?.fpy) ? qcData.fpy : [];
    let firstPass = 0, inspected = 0;
    for (const r of rows) {
      firstPass += Number(r?.first_pass_count) || 0;
      inspected += Number(r?.total_inspected)  || 0;
    }
    return inspected > 0 ? Math.round((firstPass / inspected) * 1000) / 10 : null;
  })();
  const fpyTone = fpyPct == null ? undefined : fpyPct >= 95 ? 'ok' : fpyPct >= 85 ? 'warn' : 'bad';
  const vsTargetTone = prodAggs.totals.vsTarget == null ? undefined
    : prodAggs.totals.vsTarget >= 95 ? 'ok'
    : prodAggs.totals.vsTarget >= 75 ? 'warn'
    : 'bad';

  // ── Throughput aggs ──────────────────────────────────────
  const taktAggs = useMemo(() => {
    if (!taktData) return null;
    const taktRows = Array.isArray(taktData.takt) ? taktData.takt : [];
    const stations = ['INW', 'QC_DECISION', 'QC_PASS', 'PKG', 'PKG_OUT'];
    const lines = LINES;   // S324: was ['L1','L2','L3'] — silently dropped L4/L5 units from throughput
    const grid = {};
    for (const r of taktRows) {
      grid[`${r.line}|${r.station}`] = r;
    }
    const byStation = {};
    for (const st of stations) {
      const lineRows = lines.map(l => grid[`${l}|${st}`]).filter(Boolean);
      if (!lineRows.length) { byStation[st] = null; continue; }
      const totalUnits = lineRows.reduce((s, r) => s + (r.units_measured || 0), 0);
      if (!totalUnits) { byStation[st] = null; continue; }
      const weighted = lineRows.reduce((s, r) => s + ((r.avg_takt_mins || 0) * (r.units_measured || 0)), 0);
      const avg = weighted / totalUnits;
      byStation[st] = { avg, unitsPerHour: avg > 0 ? 60 / avg : 0, unitsMeasured: totalUnits };
    }
    return { grid, byStation, lines, stations };
  }, [taktData]);

  // ── CSV downloads ────────────────────────────────────────
  function downloadQc() {
    const rows = (qcData?.heatmap || []).map(r => ({ product: r.product || '', code: r.error_code || '', issue: r.issue || '', category: r.category || '', severity: r.severity || '', count: r.count || r.fail_count || 0 }));
    const ok = downloadCsv(`qc-view-${dateFrom}-${dateTo}.csv`, rows, ['product','code','issue','category','severity','count']);
    if (!ok) showToast('No QC data to download', 'error');
  }
  function downloadPva() {
    const rows = pvaData.map(r => ({ run_date: r.run_date, product: r.product, line_no: r.line_no, target_qty: r.target_qty, actual_qc_pass: r.actual_qc_pass, total_dispatched: r.total_dispatched, actual_rtr: r.actual_rtr, actual_rte: r.actual_rte }));
    const ok = downloadCsv(`plan-vs-actual-${dateFrom}-${dateTo}.csv`, rows, ['run_date','product','line_no','target_qty','actual_qc_pass','total_dispatched','actual_rtr','actual_rte']);
    if (!ok) showToast('No PVA data to download', 'error');
  }
  function downloadDefects() {
    const rows = defectAggs.codeList.map(c => ({ code: c.code, issue: c.issue, category: c.category, severity: c.severity, count: c.count }));
    const ok = downloadCsv(`defects-${dateFrom}-${dateTo}.csv`, rows, ['code','issue','category','severity','count']);
    if (!ok) showToast('No defect data to download', 'error');
  }

  // Module CSV exports — call worker downloadReport with date range, infer headers from rows.
  async function downloadModule(type, label) {
    showToast(`Preparing ${label}…`, 'info');
    try {
      const params = { report: type };
      if (dateFrom) params.from = dateFrom;
      if (dateTo)   params.to   = dateTo;
      const data = await garageFetch('downloadReport', params, session);
      const rows = data?.rows || [];
      if (!rows.length) {
        showToast(`No ${label} rows in selected range`, 'info');
        return;
      }
      const headers = Object.keys(rows[0]);
      const ok = downloadCsv(`${type}-${dateFrom}-${dateTo}.csv`, rows, headers);
      if (ok) showToast(`Downloaded ${label} (${rows.length} rows)`, 'success');
    } catch (e) {
      showToast(e.message || `${label} download failed`, 'error');
    }
  }

  // ── Render ────────────────────────────────────────────────
  const SECTIONS = [
    { id: 'production',  label: 'Production' },
    { id: 'cycle',       label: 'Cycle Time' },
    { id: 'defects',     label: 'Defects' },
    { id: 'throughput',  label: 'Throughput' },
    { id: 'formats',     label: 'Output by Format' },
    ...(canViewAttendance ? [{ id: 'attendance', label: 'Attendance & OT' }] : []),
    { id: 'downloads',   label: 'Downloads' },
  ];

  if (perms && !canViewReporting) {
    return (
      <Panel pad={32} style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <Lock size={22} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 }}>
            Access restricted — reporting view requires <span className="num" style={{ color: 'var(--t1)' }}>reports</span>,{' '}
            <span className="num" style={{ color: 'var(--t1)' }}>production_view</span>, or{' '}
            <span className="num" style={{ color: 'var(--t1)' }}>users_manage</span>.
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <div>
      {/* Section selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <FilterChip key={s.id} active={section === s.id} onClick={() => setSection(s.id)}>{s.label}</FilterChip>
        ))}
      </div>

      {/* Time bar (hidden on Downloads) */}
      {section !== 'downloads' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <FilterChip active={preset === '10days'}    onClick={() => applyPreset('10days')}>10 Days</FilterChip>
          <FilterChip active={preset === 'thisweek'}  onClick={() => applyPreset('thisweek')}>This Week</FilterChip>
          <FilterChip active={preset === 'thismonth'} onClick={() => applyPreset('thismonth')}>This Month</FilterChip>
          <FilterChip active={preset === 'custom'}    onClick={() => applyPreset('custom')}>Custom</FilterChip>
          {preset === 'custom' && (
            <>
              <span className="eyebrow">From</span>
              <input type="date" style={dateInputStyle} value={customFrom} onChange={e => { setCustomFrom(e.target.value); setDateFrom(e.target.value); }} />
              <span className="eyebrow">To</span>
              <input type="date" style={dateInputStyle} value={customTo}   onChange={e => { setCustomTo(e.target.value); setDateTo(e.target.value); }} />
            </>
          )}
          <div style={{ flex: 1 }} />
          <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{periodLabel}</span>
        </div>
      )}

      {loading && section !== 'downloads' && section !== 'attendance' && (
        <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      )}

      {!loading && section === 'production' && (
        <ProductionSection aggs={prodAggs} fpyPct={fpyPct} fpyTone={fpyTone} vsTargetTone={vsTargetTone} prodView={prodView} setProdView={setProdView} />
      )}
      {!loading && section === 'cycle' && (
        <CycleSection ct={ctData} />
      )}
      {!loading && section === 'defects' && (
        <DefectsSection aggs={defectAggs} fpyPct={fpyPct} fpyTone={fpyTone} defView={defView} setDefView={setDefView} />
      )}
      {section === 'throughput' && (
        <ThroughputSection taktAggs={taktAggs} taktLoading={taktLoading} />
      )}
      {section === 'formats' && (
        <FormatsSection data={fmtData} loading={fmtLoading} periodLabel={periodLabel} />
      )}
      {section === 'attendance' && (
        <AttendanceSection
          data={attData}
          loading={attLoading}
          onDownloadSummary={downloadAttendanceSummary}
          onDownloadDetail={downloadAttendanceDetail}
          detailBusy={attDetailBusy}
          periodLabel={periodLabel}
        />
      )}
      {section === 'downloads' && (
        <DownloadsSection
          downloadQc={downloadQc}
          downloadPva={downloadPva}
          downloadDefects={downloadDefects}
          downloadModule={downloadModule}
          canViewFinance={canViewFinance}
          periodLabel={periodLabel}
        />
      )}
    </div>
  );
}

// ── Production section ───────────────────────────────────────
function ProductionSection({ aggs, fpyPct, fpyTone, vsTargetTone, prodView, setProdView }) {
  const t = aggs.totals;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 18 }}>
        <KpiTile label="QC Pass"    value={fmt(t.totalQc)}                              tone="brand" />
        <KpiTile label="FPY %"      value={fpyPct != null ? fpyPct + '%' : '—'}         tone={fpyTone} />
        <KpiTile label="Dispatched" value={fmt(t.totalDispatched)}                      tone="ok" />
        <KpiTile label="vs Target"  value={t.vsTarget != null ? t.vsTarget + '%' : '—'} tone={vsTargetTone} />
        <KpiTile label="Runs"       value={fmt(t.runs)}                                 sub={`${fmt(t.totalTarget)} target`} />
      </div>

      <div style={{ marginBottom: 18 }}>
        <Panel pad={14} style={{ height: 280 }}>
          {aggs.chartRows.length === 0 ? (
            <EmptyMsg icon="chart" text="No production data in this period" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={aggs.chartRows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" stroke="var(--t4)" tick={tickStyle} />
                <YAxis stroke="var(--t4)" tick={tickStyle} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-ui)' }} />
                <Bar dataKey="qcPass"     name="QC Pass"     fill="#22c55e" />
                <Bar dataKey="dispatched" name="Dispatched"  fill="var(--yellow)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <FilterChip active={prodView === 'product'} onClick={() => setProdView('product')}>By Product</FilterChip>
        <FilterChip active={prodView === 'line'}    onClick={() => setProdView('line')}>By Line</FilterChip>
      </div>

      <Panel pad={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {prodView === 'product'
                  ? ['Product','Runs','Target','QC Pass','Dispatched','Retail','Ecom','Done %'].map(h => <th key={h} style={thStyle}>{h}</th>)
                  : ['Line','Runs','Products','Target','QC Pass','Dispatched','Retail','Ecom','Done %'].map(h => <th key={h} style={thStyle}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {(prodView === 'product' ? aggs.byProduct : aggs.byLine).map((r, i) => {
                const pct = r.target > 0 ? Math.round((r.dispatched / r.target) * 1000) / 10 : null;
                return (
                  <tr key={i}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {prodView === 'product' ? r.product : (
                        <span className="num" style={{ fontSize: 11, fontWeight: 700, color: lineColor(r.line), background: `rgba(${lineRgb(r.line)},0.12)`, padding: '1px 6px', borderRadius: 3 }}>{r.line}</span>
                      )}
                    </td>
                    <td style={numTd}>{fmt(r.runs)}</td>
                    {prodView === 'line' && <td style={numTd}>{fmt(r.productCount)}</td>}
                    <td style={numTd}>{fmt(r.target)}</td>
                    <td style={{ ...numTd, color: 'var(--ok-fg)' }}>{fmt(r.qcPass)}</td>
                    <td style={{ ...numTd, color: 'var(--yellow)' }}>{fmt(r.dispatched)}</td>
                    <td style={numTd}>{fmt(r.retail)}</td>
                    <td style={numTd}>{fmt(r.ecom)}</td>
                    <td style={{ ...numTd, color: pct == null ? 'var(--t3)' : pct >= 95 ? 'var(--ok-fg)' : pct >= 75 ? 'var(--warn-fg)' : 'var(--bad-fg)' }}>
                      {pct == null ? '—' : pct + '%'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ── Cycle Time section ───────────────────────────────────────
function CycleSection({ ct }) {
  const sections = ['qc', 'pkg', 'rtd'];
  const labels   = { qc: 'QC Cycle', pkg: 'PKG Cycle', rtd: 'RTD Cycle' };
  const data     = sections.map(k => ({ key: k, label: labels[k], avg: ct?.[k]?.avg_mins_all }));

  if (!ct || sections.every(s => !ct[s]?.units_measured)) {
    return (
      <Panel pad={0}>
        <EmptyMsg icon="clock" text="No cycle time data in this period" />
      </Panel>
    );
  }

  // Stacked horizontal bar — single row with 3 segments
  const stackedData = [{
    name: 'Total',
    qc:  ct.qc?.avg_mins_all  || 0,
    pkg: ct.pkg?.avg_mins_all || 0,
    rtd: ct.rtd?.avg_mins_all || 0,
  }];

  return (
    <>
      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        {data.map(d => (
          <KpiTile key={d.key} label={`${d.label} Avg`} value={fmtMins(d.avg)} tone={ctTone(d.avg)}
            sub={`${fmt(ct[d.key]?.units_measured)} units measured`} />
        ))}
      </div>

      {/* Stacked horizontal bar */}
      <div style={{ marginBottom: 18 }}>
        <Panel pad={14} style={{ height: 130 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={stackedData}>
              <XAxis type="number" stroke="var(--t4)" tick={tickStyle} unit=" min" />
              <YAxis type="category" dataKey="name" stroke="var(--t4)" tick={tickStyle} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtMins(v)} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-ui)' }} />
              <Bar dataKey="qc"  name="QC"  stackId="a" fill="#22c55e" />
              <Bar dataKey="pkg" name="PKG" stackId="a" fill="var(--yellow)" />
              <Bar dataKey="rtd" name="RTD" stackId="a" fill="#60a5fa" />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* Detail panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {sections.map(k => {
          const seg = ct[k];
          if (!seg) return null;
          return (
            <Panel key={k} title={labels[k]} icon="clock" pad={16}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Stat label="Avg"               value={fmtMins(seg.avg_mins_all)}     valueColor={ctColor(seg.avg_mins_all)} />
                <Stat label="Median"            value={fmtMins(seg.median_mins)} />
                {seg.avg_mins_pass != null && <Stat label="Pass / Ecom"  value={fmtMins(seg.avg_mins_pass)} valueColor="var(--ok-fg)" />}
                {seg.avg_mins_fail != null && <Stat label="Fail / Retail" value={fmtMins(seg.avg_mins_fail)} valueColor="var(--bad-fg)" />}
                <Stat label="Fastest"           value={fmtMins(seg.fastest_mins)} />
                <Stat label="Slowest (normal)"  value={fmtMins(seg.slowest_normal_mins)} />
                <Stat label="Units measured"    value={fmt(seg.units_measured)} />
                {seg.outlier_count > 0 && <Stat label="Outliers" value={`${fmt(seg.outlier_count)} (max ${fmtMins(seg.outlier_max_mins)})`} valueColor="var(--warn-fg)" />}
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}

function Stat({ label, value, valueColor }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 3 }}>{label}</div>
      <div className="num" style={{ color: valueColor || 'var(--t1)', fontWeight: 600, fontSize: 13 }}>{value}</div>
    </div>
  );
}

// ── Defects section ──────────────────────────────────────────
function DefectsSection({ aggs, fpyPct, fpyTone, defView, setDefView }) {
  if (!aggs.total) {
    return (
      <Panel pad={0}>
        <EmptyMsg icon="alert" text="No defect data in this period" />
      </Panel>
    );
  }
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <KpiTile label="Total Occurrences" value={fmt(aggs.total)} tone="bad" />
        <KpiTile label="FPY %"             value={fpyPct != null ? fpyPct + '%' : '—'} tone={fpyTone} />
        <KpiTile label="Top Defect"        value={aggs.top?.code || '—'} sub={aggs.top?.issue || ''} />
        <KpiTile label="Unique Codes"      value={fmt(aggs.uniqueCodes)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 18 }}>
        <Panel title="Top 8 Defect Codes" icon="alert" pad={14} style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={aggs.top8}>
              <XAxis dataKey="code" stroke="var(--t4)" tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} />
              <YAxis stroke="var(--t4)" tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="count">
                {aggs.top8.map((d, i) => <Cell key={i} fill={SEVERITY_COLOR[d.severity] || '#888'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Severity Split" icon="chart" pad={14} style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={aggs.sevPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {aggs.sevPie.map((d, i) => <Cell key={i} fill={SEVERITY_COLOR[d.key]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-ui)' }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <FilterChip active={defView === 'code'}    onClick={() => setDefView('code')}>By Code</FilterChip>
        <FilterChip active={defView === 'product'} onClick={() => setDefView('product')}>By Product</FilterChip>
      </div>

      <Panel pad={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {defView === 'code'
                  ? ['Code','Issue','Category','Severity','Count'].map(h => <th key={h} style={thStyle}>{h}</th>)
                  : ['Product','Total','Critical','Major','Minor','Cosmetic','Top Defect'].map(h => <th key={h} style={thStyle}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {defView === 'code'
                ? aggs.codeList.map((c, i) => (
                    <tr key={i}>
                      <td style={{ ...numTd, color: 'var(--yellow)', fontWeight: 700 }}>{c.code}</td>
                      <td style={{ ...tdStyle, whiteSpace: 'normal' }}>{c.issue || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{c.category || '—'}</td>
                      <td style={tdStyle}><span className="label" style={{ fontSize: 10, color: SEVERITY_FG[c.severity] || 'var(--t3)' }}>{c.severity}</span></td>
                      <td style={numTd}>{fmt(c.count)}</td>
                    </tr>
                  ))
                : aggs.productList.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{p.product}</td>
                      <td style={numTd}>{fmt(p.total)}</td>
                      <td style={{ ...numTd, color: 'var(--bad-fg)' }}>{fmt(p.critical)}</td>
                      <td style={{ ...numTd, color: 'var(--warn-fg)' }}>{fmt(p.major)}</td>
                      <td style={{ ...numTd, color: 'var(--t3)' }}>{fmt(p.minor)}</td>
                      <td style={{ ...numTd, color: 'var(--t2)' }}>{fmt(p.cosmetic)}</td>
                      <td style={{ ...numTd, color: 'var(--yellow)' }}>{p.top.code} <span style={{ color: 'var(--t3)' }}>({fmt(p.top.count)})</span></td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ── Throughput section ───────────────────────────────────────
function FormatsSection({ data, loading, periodLabel }) {
  const tdNum  = { padding: '9px 12px', fontSize: 12, textAlign: 'right', fontFamily: 'var(--mono)', borderBottom: '1px solid rgba(42,42,42,.6)' };
  const tdNumB = { ...tdNum, fontWeight: 700, borderBottom: 'none' };
  if (loading || data === null) {
    return <Panel pad={40}><div style={{ display: 'flex', justifyContent: 'center' }}><Spinner /></div></Panel>;
  }
  const rows = (data || []).filter(r => Number(r.run_count) > 0 || Number(r.target_qty) > 0);
  if (!rows.length) return <Panel pad={0}><EmptyMsg icon="clock" text="No runs in this period" /></Panel>;
  const FMT_SUB = { CKD: 'full in-house build', SKD: 'semi-built kit', FBU: 'fully-built units', '(unspecified)': 'legacy runs, no format set' };
  const num = v => Number(v || 0);
  const pct = (a, b) => b > 0 ? Math.round((a / b) * 1000) / 10 : null;
  const tot = rows.reduce((a, r) => ({
    run_count: a.run_count + num(r.run_count), target_qty: a.target_qty + num(r.target_qty),
    actual_qc_pass: a.actual_qc_pass + num(r.actual_qc_pass), actual_dispatched: a.actual_dispatched + num(r.actual_dispatched),
  }), { run_count: 0, target_qty: 0, actual_qc_pass: 0, actual_dispatched: 0 });
  const real = rows.filter(r => r.issue_format !== '(unspecified)');
  return (
    <>
      {real.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${real.length}, 1fr)`, gap: 10, marginBottom: 16 }}>
          {real.map(r => (
            <KpiTile key={r.issue_format} label={`${r.issue_format} dispatched`} value={fmt(num(r.actual_dispatched))}
              sub={`${fmt(num(r.target_qty))} target · ${num(r.run_count)} run${num(r.run_count) === 1 ? '' : 's'}`} />
          ))}
        </div>
      )}
      <Panel pad={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['Format', 'Runs', 'Target', 'QC-Pass', 'Dispatched', 'Completion'].map((h, i) => (
                <th key={h} style={{ padding: '10px 12px', fontSize: 10, textAlign: i === 0 ? 'left' : 'right', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const cp = pct(num(r.actual_dispatched), num(r.target_qty));
                return (
                  <tr key={r.issue_format}>
                    <td style={{ padding: '9px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{r.issue_format}</span>
                      <span style={{ color: 'var(--t3)', fontSize: 11, marginLeft: 8 }}>{FMT_SUB[r.issue_format] || ''}</span>
                    </td>
                    <td style={tdNum}>{fmt(num(r.run_count))}</td>
                    <td style={tdNum}>{fmt(num(r.target_qty))}</td>
                    <td style={tdNum}>{fmt(num(r.actual_qc_pass))}</td>
                    <td style={tdNum}>{fmt(num(r.actual_dispatched))}</td>
                    <td style={tdNum}>{cp == null ? '—' : `${cp}%`}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ padding: '9px 12px', fontSize: 12, fontWeight: 700 }}>Total</td>
                <td style={tdNumB}>{fmt(tot.run_count)}</td>
                <td style={tdNumB}>{fmt(tot.target_qty)}</td>
                <td style={tdNumB}>{fmt(tot.actual_qc_pass)}</td>
                <td style={tdNumB}>{fmt(tot.actual_dispatched)}</td>
                <td style={tdNumB}>{pct(tot.actual_dispatched, tot.target_qty) == null ? '—' : `${pct(tot.actual_dispatched, tot.target_qty)}%`}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>
        {periodLabel} · Output attributed to a run's format by product + line + day (same basis as the Lines board); a day/line/product shared by two formats counts once. Primary unit = car or drone; remotes excluded.
      </div>
    </>
  );
}

function ThroughputSection({ taktAggs, taktLoading }) {
  if (taktLoading || !taktAggs) {
    return (
      <Panel pad={40}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      </Panel>
    );
  }
  const { byStation, lines, stations, grid } = taktAggs;
  const stationLabels = { INW: 'INW Takt', QC_DECISION: 'QC Decision', QC_PASS: 'QC Pass Takt', PKG: 'PKG Takt', PKG_OUT: 'PKG_OUT Takt' };

  const allEmpty = stations.every(st => !byStation[st]);
  if (allEmpty) {
    return (
      <Panel pad={0}>
        <EmptyMsg icon="clock" text="No takt data in this period" />
      </Panel>
    );
  }

  return (
    <>
      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 18 }}>
        {stations.map(st => {
          const s = byStation[st];
          return (
            <KpiTile key={st} label={stationLabels[st]} value={fmtMins(s?.avg)} tone={ctTone(s?.avg)}
              sub={s ? `${s.unitsPerHour.toFixed(1)} u/hr` : '—'} />
          );
        })}
      </div>

      {/* Bottleneck per line */}
      <div style={{ marginBottom: 18 }}>
      <Panel title="Per-Line Bottleneck" icon="activity" pad={16}>
        {lines.map(line => {
          const lineRows = stations.map(st => grid[`${line}|${st}`]).filter(Boolean);
          if (!lineRows.length) return null;
          const maxRow = lineRows.reduce((m, r) => (r.avg_takt_mins > (m?.avg_takt_mins || 0) ? r : m), null);
          return (
            <div key={line} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span className="num" style={{ fontSize: 12, fontWeight: 700, color: lineColor(line),
                  background: `rgba(${lineRgb(line)},0.12)`, padding: '1px 7px', borderRadius: 3 }}>{line}</span>
                {maxRow && <ToneBadge tone="bad">Bottleneck: {maxRow.station}</ToneBadge>}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {lineRows.map(r => {
                  const isMax = r === maxRow;
                  return (
                    <div key={r.station} style={{ flex: 1, padding: 9, background: 'var(--surface-2)',
                      border: `1px solid ${isMax ? 'var(--bad-bd)' : 'var(--border-2)'}`, borderRadius: 'var(--r-sm)' }}>
                      <div className="eyebrow" style={{ fontSize: 9 }}>{r.station}</div>
                      <div className="num" style={{ fontSize: 13, fontWeight: 700, color: ctColor(r.avg_takt_mins), marginTop: 3 }}>{fmtMins(r.avg_takt_mins)}</div>
                      <div className="num" style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{Number(r.units_per_hour).toFixed(1)} u/hr</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </Panel>
      </div>

      {/* Takt grid table */}
      <Panel pad={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Line</th>
                {stations.map(st => <th key={st} style={thStyle}>{stationLabels[st]}</th>)}
              </tr>
            </thead>
            <tbody>
              {lines.map(line => (
                <tr key={line}>
                  <td style={tdStyle}><span className="num" style={{ fontSize: 11, fontWeight: 700, color: lineColor(line),
                    background: `rgba(${lineRgb(line)},0.12)`, padding: '1px 6px', borderRadius: 3 }}>{line}</span></td>
                  {stations.map(st => {
                    const r = grid[`${line}|${st}`];
                    return (
                      <td key={st} style={numTd}>
                        {r ? (
                          <>
                            <div style={{ color: ctColor(r.avg_takt_mins), fontWeight: 600 }}>{fmtMins(r.avg_takt_mins)}</div>
                            <div style={{ fontSize: 10, color: 'var(--t3)' }}>{Number(r.units_per_hour).toFixed(1)} u/hr · {fmt(r.units_measured)} units</div>
                          </>
                        ) : <span style={{ color: 'var(--t3)' }}>—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ── Downloads section ────────────────────────────────────────
// ── Attendance & OT (salary) section ─────────────────────────
function AttendanceSection({ data, loading, onDownloadSummary, onDownloadDetail, detailBusy, periodLabel }) {
  const [q, setQ] = useState('');
  if (loading) {
    return <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  }
  const rows = data || [];
  const totals = rows.reduce((a, r) => {
    a.present += Number(r.present_days) || 0;
    a.ot      += Number(r.ot_hours) || 0;
    a.sun     += Number(r.sundays_worked) || 0;
    return a;
  }, { present: 0, ot: 0, sun: 0 });
  const ql = q.trim().toLowerCase();
  const shown = ql
    ? rows.filter(r => `${r.employee_id || ''} ${r.operator_name || ''} ${r.department || ''} ${r.team || ''}`.toLowerCase().includes(ql))
    : rows;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <KpiTile label="Operators"      value={fmt(rows.length)}      tone="brand" />
        <KpiTile label="Present-days"   value={fmt(totals.present)} />
        <KpiTile label="OT hours"       value={totals.ot.toFixed(1)}  tone="ok" />
        <KpiTile label="Sundays worked" value={fmt(totals.sun)} />
      </div>

      <Panel title={`Attendance & OT — for salary${periodLabel ? ` · ${periodLabel}` : ''}`} icon="arrowDown" pad={18} style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.6, marginBottom: 12 }}>
          Per-operator attendance and overtime for the selected range. <b>Payable days</b> = present days − ½ × half-days;
          Sundays are pure-OT days. Download the <b>summary</b> for the salary sheet, or the <b>day-by-day detail</b> (with
          IST check-in / check-out times) to audit it.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
          <DownloadCard title="Summary (per operator)" sub="Days present, payable days, OT hours, late, absent" onClick={onDownloadSummary} />
          <DownloadCard title={detailBusy ? 'Building…' : 'Detailed (per day)'} sub="Every day with IST check-in / check-out times + OT" onClick={onDownloadDetail} />
        </div>
      </Panel>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <input type="text" placeholder="Filter operator / ID / department…" value={q} onChange={e => setQ(e.target.value)} style={{ ...dateInputStyle, minWidth: 260 }} />
        <div style={{ flex: 1 }} />
        <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{fmt(shown.length)} shown</span>
      </div>

      <Panel pad={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Employee ID','Name','Dept','Team','Present','Half','Payable','Sun','OT hrs','Late (min)','Absent'].map(h => <th key={h} style={thStyle}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr><td colSpan={11} style={{ ...tdStyle, textAlign: 'center', color: 'var(--t3)', padding: '28px 0' }}>No attendance in this period</td></tr>
              ) : shown.map((r, i) => (
                <tr key={r.employee_id || i}>
                  <td style={tdStyle}><span className="num" style={{ fontSize: 11.5 }}>{r.employee_id || '—'}</span></td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{r.operator_name || '—'}</td>
                  <td style={tdStyle}>{r.department || '—'}</td>
                  <td style={tdStyle}>{r.team || '—'}</td>
                  <td style={numTd}>{fmt(r.present_days)}</td>
                  <td style={{ ...numTd, color: Number(r.half_days) ? 'var(--warn-fg)' : 'var(--t3)' }}>{fmt(r.half_days)}</td>
                  <td style={{ ...numTd, fontWeight: 700 }}>{r.payable_days}</td>
                  <td style={{ ...numTd, color: Number(r.sundays_worked) ? 'var(--yellow)' : 'var(--t3)' }}>{fmt(r.sundays_worked)}</td>
                  <td style={{ ...numTd, color: Number(r.ot_hours) ? 'var(--ok-fg)' : 'var(--t3)' }}>{r.ot_hours}</td>
                  <td style={{ ...numTd, color: Number(r.late_minutes) ? 'var(--warn-fg)' : 'var(--t3)' }}>{fmt(r.late_minutes)}</td>
                  <td style={{ ...numTd, color: Number(r.absent_days) ? 'var(--bad-fg)' : 'var(--t3)' }}>{fmt(r.absent_days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function DownloadsSection({ downloadQc, downloadPva, downloadDefects, downloadModule, canViewFinance, periodLabel }) {
  return (
    <>
      <Panel title={`Production Exports${periodLabel ? ` — ${periodLabel}` : ''}`} icon="arrowDown" pad={18}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          <DownloadCard
            title="QC View"
            sub="All defect rows for the selected period"
            onClick={downloadQc}
          />
          <DownloadCard
            title="Plan vs Actual"
            sub="Run-level production vs target"
            onClick={downloadPva}
          />
          <DownloadCard
            title="Defects"
            sub="Aggregated defect counts by code"
            onClick={downloadDefects}
          />
        </div>
      </Panel>

      <Panel title={`Audit & Compliance Exports${periodLabel ? ` — ${periodLabel}` : ''}`} icon="shield" pad={18} style={{ marginTop: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          <DownloadCard
            title="Process Deviations"
            sub="PD-NNN proposals and approvals across severity tiers"
            onClick={() => downloadModule('process_deviations', 'Process Deviations')}
          />
          <DownloadCard
            title="QC Audit Findings"
            sub="Audit round findings: open, resolved, confirmed"
            onClick={() => downloadModule('audit_findings', 'QC Audit Findings')}
          />
          <DownloadCard
            title="Scan Violations"
            sub="Every rejected scan with station, operator, reason"
            onClick={() => downloadModule('scan_violations', 'Scan Violations')}
          />
          <DownloadCard
            title="Unit Restocks"
            sub="Units flipped back to stock by reason, channel, operator"
            onClick={() => downloadModule('unit_restocks', 'Unit Restocks')}
          />
          <DownloadCard
            title="Damage / Scrap Ledger"
            sub="Damaged and scrap entries with disposition lifecycle"
            onClick={() => downloadModule('damage_ledger', 'Damage Ledger')}
          />
        </div>
      </Panel>

      <Panel title={`Movement & Issuance Exports${periodLabel ? ` — ${periodLabel}` : ''}`} icon="truck" pad={18} style={{ marginTop: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          <DownloadCard
            title="Direct Issuances"
            sub="DI-NNN: samples, office, external test, replacements"
            onClick={() => downloadModule('direct_issuances', 'Direct Issuances')}
          />
          <DownloadCard
            title="Cycle Counts"
            sub="All count rounds with status and variance"
            onClick={() => downloadModule('cycle_counts', 'Cycle Counts')}
          />
          {canViewFinance ? (
            <DownloadCard
              title="Stock Adjustments"
              sub="Adjustment audit trail with reason and approver"
              onClick={() => downloadModule('stock_adjustments', 'Stock Adjustments')}
            />
          ) : (
            <DownloadCard
              title="Stock Adjustments"
              sub="Requires the reports_finance permission"
              onClick={() => {}}
              disabled
            />
          )}
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', marginTop: 14, lineHeight: 1.5 }}>
          CSV files are UTF-8 with BOM — Excel opens them correctly.
          For richer per-module views see <strong style={{ color: 'var(--t2)' }}>Garage → Reports</strong>.
        </div>
      </Panel>
    </>
  );
}

function DownloadCard({ title, sub, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
        padding: 14, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--font-ui)', color: 'var(--t1)',
        opacity: disabled ? 0.55 : 1, transition: 'border-color var(--fast) var(--ease)',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--border-3)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; }}
    >
      <div className="eyebrow" style={{ marginBottom: 7 }}>CSV Download</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
        {disabled
          ? <Lock size={14} strokeWidth={1.75} style={{ color: 'var(--t3)', flexShrink: 0 }} />
          : <Download size={14} strokeWidth={1.75} style={{ color: 'var(--yellow)', flexShrink: 0 }} />}
        <span style={{ fontSize: 14, fontWeight: 700, color: disabled ? 'var(--t2)' : 'var(--yellow)' }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.4 }}>{sub}</div>
    </button>
  );
}
