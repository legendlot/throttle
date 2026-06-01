'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { KpiCard, Spinner, EmptyState, useToast, Panel, Chip, StatusBadge } from '@throttle/ui';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

function fmtMins(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  return n < 60 ? Math.round(n) + ' min' : (n / 60).toFixed(1) + ' hr';
}

function ctColor(mins) {
  if (mins == null) return 'var(--t3)';
  if (mins <= 30) return 'var(--green)';
  if (mins <= 60) return 'var(--yellow)';
  return 'var(--red)';
}

function fmtMonthDay(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
}

// ── Severity colour ──────────────────────────────────────────
const SEVERITY_COLOR = {
  critical: '#ef4444',
  major:    '#f59e0b',
  minor:    '#888',
};

// ── Common styles ────────────────────────────────────────────
const dateInputStyle = { background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' };
const dateLabelStyle = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' };
const sectionLabel = { margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
const cardStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 14, fontFamily: 'var(--mono)' };
const cardLbl = { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 };
const cardVal = (color) => ({ fontSize: 22, color: color || 'var(--t1)', lineHeight: 1, fontWeight: 700 });
const cardSub = { fontSize: 11, color: 'var(--t3)', marginTop: 4 };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

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

  // Page gate — mirror canDownload/canViewProd on the server side.
  // Anyone with reports, production_view, or users_manage can view.
  const canViewReporting = !!(perms?.reports || perms?.production_view || perms?.users_manage);
  const canViewFinance   = !!perms?.reports_finance;

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

  const [prodView,   setProdView]   = useState('product');
  const [defView,    setDefView]    = useState('code');

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
    }
  }, [session, dateFrom, dateTo]);

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

  const periodLabel = (dateFrom && dateTo)
    ? `${fmtMonthDay(dateFrom)} – ${fmtMonthDay(dateTo)}`
    : '';

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

    const fpy = totalQc > 0 ? Math.round((totalQc / (totalQc + (qcData?.fpy?.[0]?.fail_count || 0))) * 1000) / 10 : null;
    const vsTarget = totalTarget > 0 ? Math.round((totalDispatched / totalTarget) * 1000) / 10 : null;

    const chartRows = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)).map(r => ({
      date: fmtMonthDay(r.date), qcPass: r.qcPass, dispatched: r.dispatched,
    }));

    return {
      totals: { totalQc, totalDispatched, totalTarget, totalRetail, totalEcom, runs, fpy, vsTarget },
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
      if (!productMap[product]) productMap[product] = { product, total: 0, critical: 0, major: 0, minor: 0, top: { code: '', count: 0 } };
      productMap[product].total += cnt;
      if (sev === 'critical') productMap[product].critical += cnt;
      else if (sev === 'major') productMap[product].major += cnt;
      else productMap[product].minor += cnt;
      if (cnt > productMap[product].top.count) productMap[product].top = { code, count: cnt };
    }
    const codeList = Object.values(codeMap).sort((a, b) => b.count - a.count);
    const top = codeList[0];

    const top8 = codeList.slice(0, 8).map(c => ({ code: c.code, count: c.count, severity: c.severity }));
    const sevSplit = { critical: 0, major: 0, minor: 0 };
    for (const c of codeList) sevSplit[c.severity || 'minor'] = (sevSplit[c.severity || 'minor'] || 0) + c.count;
    const sevPie = ['critical', 'major', 'minor']
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

  const fpy = qcData?.fpy?.[0];
  const fpyPct = fpy?.fpy_pct != null ? Number(fpy.fpy_pct) : null;
  const fpyColor = fpyPct == null ? 'var(--t3)' : fpyPct >= 95 ? 'var(--green)' : fpyPct >= 85 ? 'var(--yellow)' : 'var(--red)';
  const vsTargetColor = prodAggs.totals.vsTarget == null ? 'var(--t3)'
    : prodAggs.totals.vsTarget >= 95 ? 'var(--green)'
    : prodAggs.totals.vsTarget >= 75 ? 'var(--yellow)'
    : 'var(--red)';

  // ── Throughput aggs ──────────────────────────────────────
  const taktAggs = useMemo(() => {
    if (!taktData) return null;
    const taktRows = Array.isArray(taktData.takt) ? taktData.takt : [];
    const stations = ['INW', 'QC_DECISION', 'QC_PASS', 'PKG', 'PKG_OUT'];
    const lines = ['L1', 'L2', 'L3'];
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
    { id: 'downloads',   label: 'Downloads' },
  ];

  if (perms && !canViewReporting) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
        🔒 Access restricted — reporting view requires <strong>reports</strong>, <strong>production_view</strong>, or <strong>users_manage</strong>.
      </div>
    );
  }

  return (
    <div>
      {/* Section selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <Chip key={s.id} active={section === s.id} onClick={() => setSection(s.id)}>{s.label}</Chip>
        ))}
      </div>

      {/* Time bar (hidden on Downloads) */}
      {section !== 'downloads' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <Chip active={preset === '10days'}    onClick={() => applyPreset('10days')}>10 Days</Chip>
          <Chip active={preset === 'thisweek'}  onClick={() => applyPreset('thisweek')}>This Week</Chip>
          <Chip active={preset === 'thismonth'} onClick={() => applyPreset('thismonth')}>This Month</Chip>
          <Chip active={preset === 'custom'}    onClick={() => applyPreset('custom')}>Custom</Chip>
          {preset === 'custom' && (
            <>
              <span style={dateLabelStyle}>From</span>
              <input type="date" style={dateInputStyle} value={customFrom} onChange={e => { setCustomFrom(e.target.value); setDateFrom(e.target.value); }} />
              <span style={dateLabelStyle}>To</span>
              <input type="date" style={dateInputStyle} value={customTo}   onChange={e => { setCustomTo(e.target.value); setDateTo(e.target.value); }} />
            </>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{periodLabel}</span>
        </div>
      )}

      {loading && section !== 'downloads' && (
        <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      )}

      {!loading && section === 'production' && (
        <ProductionSection aggs={prodAggs} fpyPct={fpyPct} fpyColor={fpyColor} vsTargetColor={vsTargetColor} prodView={prodView} setProdView={setProdView} />
      )}
      {!loading && section === 'cycle' && (
        <CycleSection ct={ctData} />
      )}
      {!loading && section === 'defects' && (
        <DefectsSection aggs={defectAggs} fpyPct={fpyPct} fpyColor={fpyColor} defView={defView} setDefView={setDefView} />
      )}
      {section === 'throughput' && (
        <ThroughputSection taktAggs={taktAggs} taktLoading={taktLoading} />
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
function ProductionSection({ aggs, fpyPct, fpyColor, vsTargetColor, prodView, setProdView }) {
  const t = aggs.totals;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 18 }}>
        <KpiCard label="QC Pass"       value={fmt(t.totalQc)}                                   color="yellow" />
        <KpiCard label="FPY %"         value={fpyPct != null ? fpyPct + '%' : '—'}              color={fpyColor === 'var(--green)' ? 'green' : fpyColor === 'var(--yellow)' ? 'yellow' : fpyColor === 'var(--red)' ? 'red' : undefined} />
        <KpiCard label="Dispatched"    value={fmt(t.totalDispatched)}                           color="green" />
        <KpiCard label="vs Target"     value={t.vsTarget != null ? t.vsTarget + '%' : '—'}      color={vsTargetColor === 'var(--green)' ? 'green' : vsTargetColor === 'var(--yellow)' ? 'yellow' : vsTargetColor === 'var(--red)' ? 'red' : undefined} />
        <KpiCard label="Runs"          value={fmt(t.runs)}                                      sub={`${fmt(t.totalTarget)} target`} />
      </div>

      <div style={{ marginBottom: 18 }}>
        <Panel padding={14} style={{ height: 280 }}>
          {aggs.chartRows.length === 0 ? (
            <EmptyState icon="📊" message="No production data in this period" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={aggs.chartRows} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
                <YAxis stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
                <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
                <Bar dataKey="qcPass"     name="QC Pass"     fill="#22c55e" />
                <Bar dataKey="dispatched" name="Dispatched"  fill="var(--yellow)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Chip active={prodView === 'product'} onClick={() => setProdView('product')}>By Product</Chip>
        <Chip active={prodView === 'line'}    onClick={() => setProdView('line')}>By Line</Chip>
      </div>

      <Panel padding={0}>
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
                    <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 600 }}>{prodView === 'product' ? r.product : r.line}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(r.runs)}</td>
                    {prodView === 'line' && <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(r.productCount)}</td>}
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(r.target)}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{fmt(r.qcPass)}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{fmt(r.dispatched)}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(r.retail)}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(r.ecom)}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: pct == null ? 'var(--t3)' : pct >= 95 ? 'var(--green)' : pct >= 75 ? 'var(--yellow)' : 'var(--red)' }}>
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
      <Panel padding={0}>
        <EmptyState icon="⏱" message="No cycle time data in this period" />
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
      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18 }}>
        {data.map(d => (
          <div key={d.key} style={cardStyle}>
            <div style={cardLbl}>{d.label} Avg</div>
            <div style={cardVal(ctColor(d.avg))}>{fmtMins(d.avg)}</div>
            <div style={cardSub}>{fmt(ct[d.key]?.units_measured)} units measured</div>
          </div>
        ))}
      </div>

      {/* Stacked horizontal bar */}
      <div style={{ marginBottom: 18 }}>
        <Panel padding={14} style={{ height: 130 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart layout="vertical" data={stackedData}>
              <XAxis type="number" stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} unit=" min" />
              <YAxis type="category" dataKey="name" stroke="#666" tick={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
              <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} formatter={(v) => fmtMins(v)} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
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
            <Panel key={k} padding={16}>
              <h3 style={{ ...sectionLabel, marginBottom: 10 }}>{labels[k]}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11, fontFamily: 'var(--mono)' }}>
                <Stat label="Avg"               value={fmtMins(seg.avg_mins_all)}     valueColor={ctColor(seg.avg_mins_all)} />
                <Stat label="Median"            value={fmtMins(seg.median_mins)} />
                {seg.avg_mins_pass != null && <Stat label="Pass / Ecom"  value={fmtMins(seg.avg_mins_pass)} valueColor="var(--green)" />}
                {seg.avg_mins_fail != null && <Stat label="Fail / Retail" value={fmtMins(seg.avg_mins_fail)} valueColor="var(--red)" />}
                <Stat label="Fastest"           value={fmtMins(seg.fastest_mins)} />
                <Stat label="Slowest (normal)"  value={fmtMins(seg.slowest_normal_mins)} />
                <Stat label="Units measured"    value={fmt(seg.units_measured)} />
                {seg.outlier_count > 0 && <Stat label="Outliers" value={`${fmt(seg.outlier_count)} (max ${fmtMins(seg.outlier_max_mins)})`} valueColor="var(--orange)" />}
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
      <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>{label}</div>
      <div style={{ color: valueColor || 'var(--t1)', fontWeight: 600, fontSize: 13 }}>{value}</div>
    </div>
  );
}

// ── Defects section ──────────────────────────────────────────
function DefectsSection({ aggs, fpyPct, fpyColor, defView, setDefView }) {
  if (!aggs.total) {
    return (
      <Panel padding={0}>
        <EmptyState icon="⚠" message="No defect data in this period" />
      </Panel>
    );
  }
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <KpiCard label="Total Occurrences" value={fmt(aggs.total)} color="red" />
        <KpiCard label="FPY %"             value={fpyPct != null ? fpyPct + '%' : '—'} color={fpyColor === 'var(--green)' ? 'green' : fpyColor === 'var(--yellow)' ? 'yellow' : fpyColor === 'var(--red)' ? 'red' : undefined} />
        <KpiCard label="Top Defect"        value={aggs.top?.code || '—'} sub={aggs.top?.issue || ''} />
        <KpiCard label="Unique Codes"      value={fmt(aggs.uniqueCodes)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 18 }}>
        <Panel padding={14} style={{ height: 280 }}>
          <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Top 8 Defect Codes</h3>
          <ResponsiveContainer width="100%" height="90%">
            <BarChart data={aggs.top8}>
              <XAxis dataKey="code" stroke="#666" tick={{ fontSize: 10, fontFamily: 'var(--mono)' }} />
              <YAxis stroke="#666" tick={{ fontSize: 10, fontFamily: 'var(--mono)' }} />
              <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} />
              <Bar dataKey="count">
                {aggs.top8.map((d, i) => <Cell key={i} fill={SEVERITY_COLOR[d.severity] || '#888'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel padding={14} style={{ height: 280 }}>
          <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Severity Split</h3>
          <ResponsiveContainer width="100%" height="90%">
            <PieChart>
              <Pie data={aggs.sevPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {aggs.sevPie.map((d, i) => <Cell key={i} fill={SEVERITY_COLOR[d.key]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#111', border: '1px solid #333', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'var(--mono)' }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <Chip active={defView === 'code'}    onClick={() => setDefView('code')}>By Code</Chip>
        <Chip active={defView === 'product'} onClick={() => setDefView('product')}>By Product</Chip>
      </div>

      <Panel padding={0}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {defView === 'code'
                  ? ['Code','Issue','Category','Severity','Count'].map(h => <th key={h} style={thStyle}>{h}</th>)
                  : ['Product','Total','Critical','Major','Minor','Top Defect'].map(h => <th key={h} style={thStyle}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {defView === 'code'
                ? aggs.codeList.map((c, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontWeight: 700 }}>{c.code}</td>
                      <td style={{ ...tdStyle, color: 'var(--t1)', whiteSpace: 'normal' }}>{c.issue || '—'}</td>
                      <td style={{ ...tdStyle, color: 'var(--t2)' }}>{c.category || '—'}</td>
                      <td style={{ ...tdStyle, color: SEVERITY_COLOR[c.severity] || 'var(--t3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>{c.severity}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(c.count)}</td>
                    </tr>
                  ))
                : aggs.productList.map((p, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 600 }}>{p.product}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(p.total)}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: SEVERITY_COLOR.critical }}>{fmt(p.critical)}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: SEVERITY_COLOR.major }}>{fmt(p.major)}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: SEVERITY_COLOR.minor }}>{fmt(p.minor)}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.top.code} <span style={{ color: 'var(--t3)' }}>({fmt(p.top.count)})</span></td>
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
function ThroughputSection({ taktAggs, taktLoading }) {
  if (taktLoading || !taktAggs) {
    return (
      <Panel padding={40} style={{ display: 'flex', justifyContent: 'center' }}>
        <Spinner />
      </Panel>
    );
  }
  const { byStation, lines, stations, grid } = taktAggs;
  const stationLabels = { INW: 'INW Takt', QC_DECISION: 'QC Decision', QC_PASS: 'QC Pass Takt', PKG: 'PKG Takt', PKG_OUT: 'PKG_OUT Takt' };

  const allEmpty = stations.every(st => !byStation[st]);
  if (allEmpty) {
    return (
      <Panel padding={0}>
        <EmptyState icon="⏱" message="No takt data in this period" />
      </Panel>
    );
  }

  return (
    <>
      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 18 }}>
        {stations.map(st => {
          const s = byStation[st];
          return (
            <div key={st} style={cardStyle}>
              <div style={cardLbl}>{stationLabels[st]}</div>
              <div style={cardVal(ctColor(s?.avg))}>{fmtMins(s?.avg)}</div>
              <div style={cardSub}>{s ? `${s.unitsPerHour.toFixed(1)} u/hr` : '—'}</div>
            </div>
          );
        })}
      </div>

      {/* Bottleneck per line */}
      <div style={{ marginBottom: 18 }}>
      <Panel padding={14}>
        <h3 style={{ ...sectionLabel, marginBottom: 12 }}>Per-Line Bottleneck</h3>
        {lines.map(line => {
          const lineRows = stations.map(st => grid[`${line}|${st}`]).filter(Boolean);
          if (!lineRows.length) return null;
          const maxRow = lineRows.reduce((m, r) => (r.avg_takt_mins > (m?.avg_takt_mins || 0) ? r : m), null);
          return (
            <div key={line} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', fontFamily: 'var(--mono)' }}>{line}</span>
                {maxRow && <StatusBadge variant="error">Bottleneck: {maxRow.station}</StatusBadge>}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {lineRows.map(r => {
                  const isMax = r === maxRow;
                  return (
                    <div key={r.station} style={{ flex: 1, padding: 8, background: 'var(--surface2)', border: `1px solid ${isMax ? 'var(--red)' : 'var(--border)'}`, borderRadius: 3 }}>
                      <div style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{r.station}</div>
                      <div style={{ fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 700, color: ctColor(r.avg_takt_mins) }}>{fmtMins(r.avg_takt_mins)}</div>
                      <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{Number(r.units_per_hour).toFixed(1)} u/hr</div>
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
      <Panel padding={0}>
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
                  <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 700 }}>{line}</td>
                  {stations.map(st => {
                    const r = grid[`${line}|${st}`];
                    return (
                      <td key={st} style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>
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
function DownloadsSection({ downloadQc, downloadPva, downloadDefects, downloadModule, canViewFinance, periodLabel }) {
  return (
    <>
      <Panel padding={18}>
        <h2 style={{ ...sectionLabel, marginBottom: 14 }}>Production Exports{periodLabel && ` — ${periodLabel}`}</h2>
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

      <Panel padding={18} style={{ marginTop: 14 }}>
        <h2 style={{ ...sectionLabel, marginBottom: 14 }}>Audit & Compliance Exports{periodLabel && ` — ${periodLabel}`}</h2>
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

      <Panel padding={18} style={{ marginTop: 14 }}>
        <h2 style={{ ...sectionLabel, marginBottom: 14 }}>Movement & Issuance Exports{periodLabel && ` — ${periodLabel}`}</h2>
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
              sub="🔒 Requires reports_finance permission"
              onClick={() => {}}
              disabled
            />
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 14, fontFamily: 'var(--mono)' }}>
          CSV files are UTF-8 with BOM — Excel opens them correctly.
          For richer per-module views see <strong>Garage → Reports</strong>.
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
        background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4,
        padding: 14, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--mono)', color: 'var(--t1)',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--t3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>CSV Download</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--yellow)', marginBottom: 4 }}>📥 {title}</div>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{sub}</div>
    </button>
  );
}
