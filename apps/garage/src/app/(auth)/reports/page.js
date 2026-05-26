'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  Package, AlertCircle, Inbox, Ship, ClipboardList,
  Factory, Send, FileText, Repeat, Ban, Store, RotateCw,
  BarChart3, Scale, PackageX, Wrench, Undo2, PackageOpen,
  ShieldAlert, AlertOctagon, ListChecks,
} from 'lucide-react';

// Lucide-react icons replace decorative emoji per DESIGN.md "mechanical not
// decorative" rule. Rendered as outline icons at size 28 in --t2 so they
// read as instrumentation, not stickers.
const REPORT_DOWNLOADS = {
  inventory: [
    { type: 'stock',             Icon: Package,       title: 'Stock Position',    desc: 'Full inventory: all parts, all products, current qtys' },
    { type: 'reorder',           Icon: AlertCircle,   title: 'Reorder Flags',     desc: 'Parts at or below reorder level' },
    { type: 'cycle_counts',      Icon: BarChart3,     title: 'Cycle Counts',      desc: 'All count rounds with status and variance, filterable by date' },
    { type: 'stock_adjustments', Icon: Scale,         title: 'Stock Adjustments', desc: 'Every adjustment with reason, approver and delta. Audit trail' },
  ],
  inward: [
    { type: 'grn',               Icon: Inbox,         title: 'GRN Register',          desc: 'All goods received notes, filterable by date' },
    { type: 'shipments',         Icon: Ship,          title: 'Shipments',             desc: 'All inbound shipments with progress status' },
    { type: 'receiving',         Icon: ClipboardList, title: 'Receiving Lines',       desc: 'Part-level count records from all shipments' },
    { type: 'damage_ledger',     Icon: PackageX,      title: 'Damage / Scrap Ledger', desc: 'Damaged and scrap entries with disposition lifecycle' },
  ],
  production: [
    { type: 'production_runs',   Icon: Factory,       title: 'Production Runs', desc: 'All runs with status, product and unit counts' },
    { type: 'issues',            Icon: Send,          title: 'Issue Register',  desc: 'All material issues to production, filterable by date' },
    { type: 'workorders',        Icon: FileText,      title: 'Work Orders',     desc: 'All WOs: planned, ad hoc, rework, standalone' },
  ],
  lineflush: [
    { type: 'flushes',           Icon: Repeat,        title: 'Flush Register',      desc: 'All line flushes with verification status' },
    { type: 'quarantine',        Icon: Ban,           title: 'Quarantine Register', desc: 'All quarantined parts with bin locations' },
  ],
  procurement: [
    { type: 'purchase_orders',   Icon: ClipboardList, title: 'Purchase Orders', desc: 'All POs with status, value and vendor' },
    { type: 'vendors',           Icon: Store,         title: 'Vendor List',     desc: 'All active vendors with contact details' },
  ],
  returns: [
    { type: 'returns',           Icon: RotateCw,      title: 'Returns Log',      desc: 'RTO and RTV returns across all channels, filterable by date' },
    { type: 'customer_repairs',  Icon: Wrench,        title: 'Customer Repairs', desc: 'CR-NNN intake: stage, channel, captured-by, aging' },
    { type: 'unit_restocks',     Icon: Undo2,         title: 'Unit Restocks',    desc: 'Units flipped back to stock by reason, channel, operator' },
  ],
  issuance: [
    { type: 'direct_issuances',  Icon: PackageOpen,   title: 'Direct Issuances', desc: 'DI-NNN: samples, office, external test, replacements' },
  ],
  compliance: [
    { type: 'scan_violations',   Icon: ShieldAlert,   title: 'Scan Violations',    desc: 'Every rejected scan with station, operator, reason' },
    { type: 'process_deviations',Icon: AlertOctagon,  title: 'Process Deviations', desc: 'PD-NNN proposals and approvals across all severity tiers' },
    { type: 'audit_findings',    Icon: ListChecks,    title: 'QC Audit Findings',  desc: 'Audit round findings: open, resolved, confirmed' },
  ],
};

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

function poStatusTone(s) {
  return ({
    Draft: 'gray', Approved: 'blue', Sent: 'yellow',
    'Confirmed & Payment Done': 'green', 'Partially Received': 'yellow',
    Closed: 'green', Cancelled: 'red',
  })[s] || 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: 16,
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'border-color .15s, transform .15s',
};

const tabBtnStyle = (active) => ({
  background: 'transparent',
  color: active ? 'var(--yellow)' : 'var(--t3)',
  border: 'none',
  borderBottom: active ? '2px solid var(--yellow)' : '2px solid transparent',
  padding: '8px 14px 10px',
  fontFamily: 'var(--cond)',
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  cursor: 'pointer',
});

const TABS = [
  { id: 'inventory',   label: 'Inventory' },
  { id: 'inward',      label: 'Inward' },
  { id: 'production',  label: 'Production' },
  { id: 'lineflush',   label: 'Line Flush' },
  { id: 'procurement', label: 'Procurement' },
  { id: 'returns',     label: 'Returns' },
  { id: 'issuance',    label: 'Issuance' },
  { id: 'compliance',  label: 'Compliance' },
  { id: 'analytics',   label: 'Analytics' },
];

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function withinRange(rawDate, from, to) {
  if (!rawDate) return false;
  const d = new Date(rawDate);
  if (isNaN(d)) return false;
  if (from) {
    const f = new Date(from);
    if (!isNaN(f) && d < f) return false;
  }
  if (to) {
    const t = new Date(to);
    if (!isNaN(t)) {
      t.setHours(23, 59, 59, 999);
      if (d > t) return false;
    }
  }
  return true;
}

function downloadCsv(rows, type) {
  if (!rows || !rows.length) return false;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => {
      const v = r[h] === null || r[h] === undefined ? '' : String(r[h]);
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')),
  ].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `LOT_${type.toUpperCase()}_${new Date().toISOString().split('T')[0]}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

export default function ReportsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState('inventory');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [invData, setInvData] = useState(null);
  const [grnData, setGrnData] = useState(null);
  const [prodData, setProdData] = useState(null); // { runs, issues }
  const [flushRpt, setFlushRpt] = useState(null); // { summary, flushes, issues }
  const [procRpt, setProcRpt] = useState(null);
  const [retData, setRetData] = useState(null);

  const [analyticsFlow,       setAnalyticsFlow]       = useState(null);
  const [analyticsRunway,     setAnalyticsRunway]      = useState(null);
  const [analyticsEfficiency, setAnalyticsEfficiency]  = useState(null);
  const [analyticsGap,        setAnalyticsGap]         = useState(null);

  const [loading, setLoading] = useState({});

  const setTabLoading = (tab, val) => setLoading((l) => ({ ...l, [tab]: val }));

  function refreshCurrent() {
    if (activeTab === 'inventory')   setInvData(null);
    if (activeTab === 'inward')      setGrnData(null);
    if (activeTab === 'production')  setProdData(null);
    if (activeTab === 'lineflush')   setFlushRpt(null);
    if (activeTab === 'procurement') setProcRpt(null);
    if (activeTab === 'returns')     setRetData(null);
    if (activeTab === 'analytics') {
      setAnalyticsFlow(null);
      setAnalyticsRunway(null);
      setAnalyticsEfficiency(null);
      setAnalyticsGap(null);
    }
  }

  async function loadAnalyticsFlow() {
    setTabLoading('analytics_flow', true);
    try {
      const params = { type: 'flow' };
      if (fromDate) params.from = fromDate;
      if (toDate)   params.to   = toDate;
      const data = await garageFetch('getAnalyticsReport', params, session);
      setAnalyticsFlow(data || {});
    } catch (e) {
      showToast(e.message || 'Failed to load flow report', 'error');
      setAnalyticsFlow({});
    } finally {
      setTabLoading('analytics_flow', false);
    }
  }

  async function loadAnalyticsRunway() {
    setTabLoading('analytics_runway', true);
    try {
      const data = await garageFetch('getAnalyticsReport', { type: 'runway' }, session);
      setAnalyticsRunway(data || {});
    } catch (e) {
      showToast(e.message || 'Failed to load runway report', 'error');
      setAnalyticsRunway({});
    } finally {
      setTabLoading('analytics_runway', false);
    }
  }

  async function loadAnalyticsEfficiency() {
    setTabLoading('analytics_efficiency', true);
    try {
      const data = await garageFetch('getAnalyticsReport', { type: 'efficiency' }, session);
      setAnalyticsEfficiency(data || {});
    } catch (e) {
      showToast(e.message || 'Failed to load efficiency report', 'error');
      setAnalyticsEfficiency({});
    } finally {
      setTabLoading('analytics_efficiency', false);
    }
  }

  async function loadAnalyticsGap() {
    setTabLoading('analytics_gap', true);
    try {
      const data = await garageFetch('getAnalyticsReport', { type: 'dispatch_gap' }, session);
      setAnalyticsGap(data || {});
    } catch (e) {
      showToast(e.message || 'Failed to load dispatch gap report', 'error');
      setAnalyticsGap({});
    } finally {
      setTabLoading('analytics_gap', false);
    }
  }

  function clearDates() {
    setFromDate('');
    setToDate('');
    refreshCurrent();
  }

  async function handleDownload(type) {
    showToast('Preparing report…', 'info');
    try {
      const params = { report: type };
      if (fromDate) params.from = fromDate;
      if (toDate)   params.to   = toDate;
      const data = await garageFetch('downloadReport', params, session);
      const rows = data?.rows || [];
      if (!rows.length) {
        showToast('No data in selected date range', 'info');
        return;
      }
      downloadCsv(rows, type);
      showToast(`Downloaded: ${type} (${rows.length} rows)`, 'success');
    } catch (e) {
      showToast(e.message || 'Download failed', 'error');
    }
  }

  // Loaders ----------------------------------------------------------------
  async function loadInventory() {
    setTabLoading('inventory', true);
    try {
      const rows = await garageFetch('getStock', {}, session);
      const arr = Array.isArray(rows) ? rows : [];
      const map = {};
      arr.forEach((r) => {
        const p = r.product || '—';
        if (!map[p]) map[p] = { product: p, parts: 0, stocked: 0, reorder: 0, received: 0, issued: 0 };
        map[p].parts += 1;
        if ((r.closing_stock || 0) > 0) map[p].stocked += 1;
        if ((r.reorder_level || 0) > 0 && (r.closing_stock || 0) <= (r.reorder_level || 0)) map[p].reorder += 1;
        map[p].received += parseFloat(r.total_received) || 0;
        map[p].issued += parseFloat(r.total_issued) || 0;
      });
      setInvData(Object.values(map).sort((a, b) => a.product.localeCompare(b.product)));
    } catch (e) {
      showToast(e.message || 'Failed to load inventory summary', 'error');
      setInvData([]);
    } finally {
      setTabLoading('inventory', false);
    }
  }

  async function loadInward() {
    setTabLoading('inward', true);
    try {
      const rows = await garageFetch('getGRNSummary', {}, session);
      const arr = (Array.isArray(rows) ? rows : []).filter((r) => withinRange(r.grn_date, fromDate, toDate));
      setGrnData(arr);
    } catch (e) {
      showToast(e.message || 'Failed to load GRN summary', 'error');
      setGrnData([]);
    } finally {
      setTabLoading('inward', false);
    }
  }

  async function loadProduction() {
    setTabLoading('production', true);
    try {
      const [runs, issues] = await Promise.all([
        garageFetch('getProductionRuns', {}, session).catch(() => []),
        garageFetch('getIssues', {}, session).catch(() => []),
      ]);
      const filteredRuns = (Array.isArray(runs) ? runs : []).filter((r) => withinRange(r.run_date || r.created_at, fromDate, toDate));
      const filteredIssues = (Array.isArray(issues) ? issues : []).filter((r) => withinRange(r.issue_date || r.created_at, fromDate, toDate));
      setProdData({ runs: filteredRuns, issues: filteredIssues });
    } catch (e) {
      showToast(e.message || 'Failed to load production summary', 'error');
      setProdData({ runs: [], issues: [] });
    } finally {
      setTabLoading('production', false);
    }
  }

  async function loadLineFlush() {
    setTabLoading('lineflush', true);
    try {
      const [summary, flushes, issues] = await Promise.all([
        garageFetch('getReportSummary', { type: 'lineflush', from: fromDate || undefined, to: toDate || undefined }, session).catch(() => ({})),
        garageFetch('getFlushes', {}, session).catch(() => []),
        garageFetch('getIssues', {}, session).catch(() => []),
      ]);
      setFlushRpt({
        summary: summary || {},
        flushes: (Array.isArray(flushes) ? flushes : []).filter((r) => withinRange(r.flush_date || r.created_at, fromDate, toDate)),
        issues:  (Array.isArray(issues) ? issues : []).filter((r) => withinRange(r.issue_date, fromDate, toDate)),
      });
    } catch (e) {
      showToast(e.message || 'Failed to load line flush summary', 'error');
      setFlushRpt({ summary: {}, flushes: [], issues: [] });
    } finally {
      setTabLoading('lineflush', false);
    }
  }

  async function loadProcurement() {
    setTabLoading('procurement', true);
    try {
      const data = await garageFetch('getReportSummary', { type: 'procurement' }, session);
      setProcRpt(data || {});
    } catch (e) {
      showToast(e.message || 'Failed to load procurement summary', 'error');
      setProcRpt({});
    } finally {
      setTabLoading('procurement', false);
    }
  }

  async function loadReturns() {
    setTabLoading('returns', true);
    try {
      const rows = await garageFetch('getReturns', {}, session);
      const arr = (Array.isArray(rows) ? rows : []).filter((r) => withinRange(r.return_date || r.created_at, fromDate, toDate));
      const map = {};
      arr.forEach((r) => {
        const ch = r.channel || '—';
        if (!map[ch]) map[ch] = { channel: ch, rto: 0, rtv: 0, total: 0, scrap: 0, claims: 0 };
        map[ch].total += parseInt(r.qty, 10) || 1;
        const t = (r.return_type || '').toLowerCase();
        if (t.includes('rto')) map[ch].rto += parseInt(r.qty, 10) || 1;
        if (t.includes('rtv')) map[ch].rtv += parseInt(r.qty, 10) || 1;
        if ((r.action || '').toLowerCase().includes('scrap')) map[ch].scrap += parseInt(r.qty, 10) || 1;
        if (r.claim_filed === 'Yes' || r.claim_filed === true) map[ch].claims += 1;
      });
      setRetData(Object.values(map).sort((a, b) => a.channel.localeCompare(b.channel)));
    } catch (e) {
      showToast(e.message || 'Failed to load returns summary', 'error');
      setRetData([]);
    } finally {
      setTabLoading('returns', false);
    }
  }

  // Permission gate
  if (perms && !perms.reports) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
        Reports are available to users with reports access only.
      </div>
    );
  }

  const cards = REPORT_DOWNLOADS[activeTab] || [];

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 8 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Reports
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Download CSV extracts and quick summaries by domain.
        </p>
      </div>

      {/* Sub-tabs — Compliance gated by reports_compliance permission */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS
          .filter((t) => t.id !== 'compliance' || !!perms?.reports_compliance)
          .map((t) => (
            <button key={t.id} type="button" style={tabBtnStyle(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
      </div>

      {/* Date filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: '0 0 160px' }}>
          <span style={labelStyle}>From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} />
        </div>
        <div style={{ flex: '0 0 160px' }}>
          <span style={labelStyle}>To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} />
        </div>
        <button style={btnPrimary} onClick={refreshCurrent}>Apply Filter</button>
        <button style={btnSecondary} onClick={clearDates}>Clear</button>
      </div>

      {/* Download cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        {cards.map((c) => (
          <div
            key={c.type}
            style={cardStyle}
            onClick={() => handleDownload(c.type)}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--yellow)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <div style={{ color: 'var(--t2)' }}>
              <c.Icon size={28} strokeWidth={1.75} />
            </div>
            <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--t1)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{c.title}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 6, lineHeight: 1.45 }}>{c.desc}</div>
          </div>
        ))}
      </div>

      {/* Tab summary */}
      {activeTab === 'inventory'   && <InventorySummary data={invData}   loading={loading.inventory}   load={loadInventory} />}
      {activeTab === 'inward'      && <InwardSummary    data={grnData}   loading={loading.inward}      load={loadInward} />}
      {activeTab === 'production'  && <ProductionSummary data={prodData} loading={loading.production}  load={loadProduction} />}
      {activeTab === 'lineflush'   && <LineFlushSummary data={flushRpt}  loading={loading.lineflush}   load={loadLineFlush} />}
      {activeTab === 'procurement' && <ProcurementSummary data={procRpt} loading={loading.procurement} load={loadProcurement} canViewFinance={!!perms?.reports_finance} />}
      {activeTab === 'returns'     && <ReturnsSummary    data={retData}  loading={loading.returns}     load={loadReturns} />}
      {activeTab === 'issuance'    && <IssuanceSummary  loading={false} />}
      {activeTab === 'compliance'  && !!perms?.reports_compliance && <ComplianceSummary loading={false} />}
      {activeTab === 'analytics'   && (
        <>
          <AnalyticsFlowPanel
            data={analyticsFlow}
            loading={loading.analytics_flow}
            load={loadAnalyticsFlow}
            fromDate={fromDate}
            toDate={toDate}
          />
          <AnalyticsRunwayPanel
            data={analyticsRunway}
            loading={loading.analytics_runway}
            load={loadAnalyticsRunway}
          />
          <AnalyticsEfficiencyPanel
            data={analyticsEfficiency}
            loading={loading.analytics_efficiency}
            load={loadAnalyticsEfficiency}
          />
          {perms?.reports_finance ? (
            <AnalyticsGapPanel
              data={analyticsGap}
              loading={loading.analytics_gap}
              load={loadAnalyticsGap}
            />
          ) : (
            <FinanceGatedPanel title="Production vs Dispatch Gap" />
          )}
        </>
      )}
    </div>
  );
}

function SummaryShell({ title, data, loading, load, children, empty }) {
  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        <span>{title}</span>
        <button style={btnSecondary} onClick={load} disabled={loading}>↻ Load</button>
      </div>
      <div style={panelBodyStyle}>
        {loading ? (
          <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : data === null ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Click Load to fetch summary</div>
        ) : (Array.isArray(data) && data.length === 0) ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>{empty || 'No data'}</div>
        ) : children}
      </div>
    </div>
  );
}

function InventorySummary({ data, loading, load }) {
  return (
    <SummaryShell title="Inventory by Product" data={data} loading={loading} load={load} empty="No stock data">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={tableThStyle}>Product</th>
          <th style={tableThStyle}>Parts</th>
          <th style={tableThStyle}>Stocked</th>
          <th style={tableThStyle}>Reorder Flags</th>
          <th style={tableThStyle}>Total Received</th>
          <th style={tableThStyle}>Total Issued</th>
        </tr></thead>
        <tbody>
          {(data || []).map((r) => (
            <tr key={r.product}>
              <td style={tableTdStyle}>{r.product}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.parts}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.stocked}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: r.reorder > 0 ? '#ff7070' : '#4ade80', fontWeight: 700 }}>{r.reorder}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.received.toLocaleString('en-IN')}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.issued.toLocaleString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SummaryShell>
  );
}

function InwardSummary({ data, loading, load }) {
  return (
    <SummaryShell title="GRNs in Range" data={data} loading={loading} load={load} empty="No GRNs in selected range">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={tableThStyle}>GRN</th>
          <th style={tableThStyle}>Date</th>
          <th style={tableThStyle}>Supplier</th>
          <th style={tableThStyle}>Product</th>
          <th style={tableThStyle}>Lines</th>
          <th style={tableThStyle}>Total Qty</th>
        </tr></thead>
        <tbody>
          {(data || []).map((r) => (
            <tr key={r.grn_no}>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.grn_no}</td>
              <td style={tableTdStyle}>{formatDate(r.grn_date)}</td>
              <td style={tableTdStyle}>{r.supplier || '—'}</td>
              <td style={tableTdStyle}>{r.product || '—'}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.lines ?? 0}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{(r.total_qty ?? 0).toLocaleString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SummaryShell>
  );
}

function ProductionSummary({ data, loading, load }) {
  const runs   = data?.runs   || [];
  const issues = data?.issues || [];
  const runsByStatus   = useMemoGroup(runs, (r) => r.status || '—');
  const partsByProduct = useMemoIssueGroups(issues);

  if (!data) return <SummaryShell title="Production" data={data} loading={loading} load={load} />;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <SummaryShell title="Runs by Status" data={runs || []} loading={loading} load={load} empty="No runs">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(runsByStatus).map(([status, count]) => (
              <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'var(--surface2)', borderRadius: 3 }}>
                <StatusBadge label={status} tone="gray" />
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{count}</span>
              </div>
            ))}
          </div>
        </SummaryShell>
        <SummaryShell title="Parts Issued by Product" data={issues || []} loading={loading} load={load} empty="No issues">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Product</th>
              <th style={tableThStyle}>Run</th>
              <th style={tableThStyle}>Ad Hoc</th>
              <th style={tableThStyle}>Total Parts</th>
            </tr></thead>
            <tbody>
              {Object.entries(partsByProduct).map(([product, vals]) => (
                <tr key={product}>
                  <td style={tableTdStyle}>{product}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{vals.run}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{vals.adhoc}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{vals.run + vals.adhoc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SummaryShell>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Recent Production Runs ({Math.min(50, runs.length)} of {runs.length})</span></div>
        <div style={{ overflowX: 'auto' }}>
          {runs.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No runs in selected range</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Run No.</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Variants</th>
                <th style={tableThStyle}>Units</th>
                <th style={tableThStyle}>Status</th>
                <th style={tableThStyle}>Created By</th>
              </tr></thead>
              <tbody>
                {runs.slice(0, 50).map((r) => (
                  <tr key={r.run_no || r.id}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.run_no || r.id}</td>
                    <td style={tableTdStyle}>{formatDate(r.run_date || r.created_at)}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 280 }}>
                      {(r.variants || []).map((v) => `${v.variant || 'Common'}${v.colour ? ' ' + v.colour : ''} ×${v.qty || 0}`).join(', ') || '—'}
                    </td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.total_units ?? 0}</td>
                    <td style={tableTdStyle}><StatusBadge label={r.status || '—'} tone="gray" /></td>
                    <td style={tableTdStyle}>{r.created_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

function LineFlushSummary({ data, loading, load }) {
  if (!data) return <SummaryShell title="Line Flush" data={data} loading={loading} load={load} />;
  const summary = data.summary || {};
  const flushes = data.flushes || [];

  const verifyCounts = {};
  flushes.forEach((f) => { const s = f.status || '—'; verifyCounts[s] = (verifyCounts[s] || 0) + 1; });

  const damaged = summary.damaged_lines || 0;
  const total   = summary.total_lines || flushes.reduce((s, f) => s + (f.line_count || 0), 0) || 1;
  const dmgPct  = (damaged / total) * 100;
  const dmgColor = dmgPct > 5 ? '#ff7070' : dmgPct > 2 ? '#f2cd1a' : '#4ade80';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
      <SummaryShell title="Damage Rate" data={[1]} loading={loading} load={load}>
        <div style={{ textAlign: 'center', padding: 12 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 36, fontWeight: 700, color: dmgColor }}>{dmgPct.toFixed(1)}%</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{damaged} damaged / {total} total</div>
        </div>
      </SummaryShell>
      <SummaryShell title="Verification Status" data={Object.entries(verifyCounts)} loading={loading} load={load} empty="No flushes in range">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Object.entries(verifyCounts).map(([status, count]) => {
            const tone = status === 'Verified' ? 'green' : status === 'Pending Verification' ? 'yellow' : status === 'Disputed' ? 'red' : 'gray';
            return (
              <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'var(--surface2)', borderRadius: 3 }}>
                <StatusBadge label={status} tone={tone} />
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{count}</span>
              </div>
            );
          })}
        </div>
      </SummaryShell>
    </div>
  );
}

function ProcurementSummary({ data, loading, load, canViewFinance }) {
  if (!data) return <SummaryShell title="Procurement" data={data} loading={loading} load={load} />;

  const statusCounts = data.status_counts || data.po_status || {};
  const overdue = data.overdue || data.overdue_pos || [];
  const vendorSpend = data.vendor_spend || data.spend_by_vendor || [];
  const maxSpend = Math.max(1, ...vendorSpend.map((v) => parseFloat(v.spend || v.amount || 0)));

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <SummaryShell title="PO Status Summary" data={Object.entries(statusCounts)} loading={loading} load={load} empty="No POs">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(statusCounts).map(([status, count]) => (
              <div key={status} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'var(--surface2)', borderRadius: 3 }}>
                <StatusBadge label={status} tone={poStatusTone(status)} />
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{count}</span>
              </div>
            ))}
          </div>
        </SummaryShell>
        <SummaryShell title={`Overdue POs (${overdue.length})`} data={overdue} loading={loading} load={load} empty="No overdue POs">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>PO</th>
              <th style={tableThStyle}>Vendor</th>
              <th style={tableThStyle}>Expected</th>
              <th style={tableThStyle}>Status</th>
            </tr></thead>
            <tbody>
              {overdue.slice(0, 10).map((p) => (
                <tr key={p.po_number}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.po_number}</td>
                  <td style={tableTdStyle}>{p.vendor_name || '—'}</td>
                  <td style={tableTdStyle}>{formatDate(p.expected_delivery)}</td>
                  <td style={tableTdStyle}><StatusBadge label={p.status || '—'} tone={poStatusTone(p.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </SummaryShell>
      </div>

      {canViewFinance ? (
        <SummaryShell title="Vendor Spend (top 10)" data={vendorSpend} loading={loading} load={load} empty="No vendor spend data">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {vendorSpend.slice(0, 10).map((v) => {
              const amount = parseFloat(v.spend || v.amount || 0);
              const pct = (amount / maxSpend) * 100;
              return (
                <div key={v.vendor_name || v.vendor} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 100px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <span>{v.vendor_name || v.vendor || '—'}</span>
                  <div style={{ height: 10, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: 10, background: 'var(--yellow)' }} />
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{amount.toLocaleString('en-IN')}</span>
                </div>
              );
            })}
          </div>
        </SummaryShell>
      ) : (
        <FinanceGatedPanel title="Vendor Spend (top 10)" />
      )}
    </>
  );
}

function FinanceGatedPanel({ title }) {
  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}><span>{title}</span></div>
      <div style={{ padding: 18, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>
        Finance / cost detail hidden — requires <strong>reports_finance</strong> permission.
      </div>
    </div>
  );
}

function IssuanceSummary() {
  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}><span>Direct Store Issuance</span></div>
      <div style={panelBodyStyle}>
        <p style={{ margin: 0, color: 'var(--t2)', fontSize: 12, lineHeight: 1.6 }}>
          Use the cards above to download the DI register as CSV (filter by date range).
          For per-DI detail and live status, open <strong style={{ color: 'var(--yellow)' }}>Garage → Direct Issuance</strong>.
        </p>
      </div>
    </div>
  );
}

function ComplianceSummary() {
  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}><span>Compliance & Audit</span></div>
      <div style={panelBodyStyle}>
        <p style={{ margin: 0, color: 'var(--t2)', fontSize: 12, lineHeight: 1.6 }}>
          Scan Violations log every rejected scan with station + operator + reason.
          Process Deviations capture the PD-NNN approval chain across severity tiers.
          QC Audit Findings are the round-by-round audit log.
          Download each as CSV from the cards above.
        </p>
      </div>
    </div>
  );
}

function ReturnsSummary({ data, loading, load }) {
  return (
    <SummaryShell title="Returns by Channel" data={data} loading={loading} load={load} empty="No returns in selected range">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={tableThStyle}>Channel</th>
          <th style={tableThStyle}>RTO</th>
          <th style={tableThStyle}>RTV</th>
          <th style={tableThStyle}>Total Units</th>
          <th style={tableThStyle}>Scrap</th>
          <th style={tableThStyle}>Claims Filed</th>
        </tr></thead>
        <tbody>
          {(data || []).map((r) => (
            <tr key={r.channel}>
              <td style={tableTdStyle}>{r.channel}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.rto}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.rtv}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700 }}>{r.total}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: r.scrap > 0 ? '#ff7070' : 'var(--t3)' }}>{r.scrap}</td>
              <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.claims}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SummaryShell>
  );
}

function useMemoGroup(rows, keyFn) {
  return useMemo(() => {
    const out = {};
    (rows || []).forEach((r) => { const k = keyFn(r); out[k] = (out[k] || 0) + 1; });
    return out;
  }, [rows, keyFn]);
}

function useMemoIssueGroups(issues) {
  return useMemo(() => {
    const out = {};
    (issues || []).forEach((r) => {
      const p = r.product || '—';
      if (!out[p]) out[p] = { run: 0, adhoc: 0 };
      const t = (r.issue_type || '').toLowerCase();
      if (t === 'ad hoc') out[p].adhoc += 1;
      else out[p].run += 1;
    });
    return out;
  }, [issues]);
}

// ── Analytics panel helpers ───────────────────────────────────────────────

function runwayTone(days) {
  if (days === null) return 'gray';
  if (days >= 30) return 'green';
  if (days >= 14) return 'yellow';
  if (days >= 7)  return 'orange';
  return 'red';
}

function runwayColor(days) {
  if (days === null) return 'var(--t3)';
  if (days >= 30) return '#4ade80';
  if (days >= 14) return '#f2cd1a';
  if (days >= 7)  return '#ffaa33';
  return '#ff7070';
}

function gapColor(gap) {
  if (gap <= 0)   return '#4ade80';
  if (gap <= 100) return '#f2cd1a';
  if (gap <= 300) return '#ffaa33';
  return '#ff7070';
}

// 1. Procurement → Production Flow
function AnalyticsFlowPanel({ data, loading, load, fromDate, toDate }) {
  const rows = data?.rows || [];
  const title = data?.from
    ? `Procurement → Production Flow  (${data.from} → ${data.to})`
    : 'Procurement → Production Flow';
  return (
    <SummaryShell title={title} data={data} loading={loading} load={load}>
      {rows.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--t3)', fontSize: 12, textAlign: 'center' }}>No activity in selected range</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Product</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Parts Received (qty)</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Parts Issued (qty)</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Units Produced</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.product}>
                  <td style={tableTdStyle}>{r.product}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                    {r.qty_received.toLocaleString('en-IN')}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                    {r.qty_issued.toLocaleString('en-IN')}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700 }}>
                    {r.units_produced.toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            Parts Received = total qty in GRN register for the period. Parts Issued = materials consumed in production issues. Units Produced = work order qty across completed runs.
          </div>
        </div>
      )}
    </SummaryShell>
  );
}

// 2. Parts Runway by Product
function AnalyticsRunwayPanel({ data, loading, load }) {
  const rows = data?.rows || [];
  return (
    <SummaryShell title="Parts Runway by Product (90-day consumption rate)" data={data} loading={loading} load={load}>
      {rows.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--t3)', fontSize: 12, textAlign: 'center' }}>No BOM data available</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Product</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Runway (days)</th>
              <th style={tableThStyle}>Bottleneck Part</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>BOM Parts</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>With Consumption Data</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.product}>
                  <td style={tableTdStyle}>{r.product}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700, color: runwayColor(r.runway_days) }}>
                    {r.runway_days !== null ? r.runway_days : '—'}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: r.bottleneck_part ? '#ffaa33' : 'var(--t3)' }}>
                    {r.bottleneck_part || '—'}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right' }}>{r.bom_parts}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', color: r.parts_with_data === 0 ? 'var(--t3)' : 'var(--t1)' }}>
                    {r.parts_with_data}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            Runway = min(closing_stock / avg_daily_consumption) across all BOM parts with issues in last 90 days. Parts with no recent consumption are excluded from the calculation.
          </div>
        </div>
      )}
    </SummaryShell>
  );
}

// 3. Weekly Production Trend (8 weeks)
function AnalyticsEfficiencyPanel({ data, loading, load }) {
  const weeks  = data?.weeks   || [];
  const products = data?.products || [];

  // Format "2026-05-04" → "4 May"
  function fmtWeek(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00Z');
    return d.getUTCDate() + ' ' + d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  }

  return (
    <SummaryShell title="Weekly Production Trend (last 8 weeks)" data={data} loading={loading} load={load}>
      {products.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--t3)', fontSize: 12, textAlign: 'center' }}>No production runs in last 8 weeks</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Product</th>
              {weeks.map(w => (
                <th key={w} style={{ ...tableThStyle, textAlign: 'right', minWidth: 56 }}>{fmtWeek(w)}</th>
              ))}
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Total</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Avg/Active Wk</th>
            </tr></thead>
            <tbody>
              {products.map(p => (
                <tr key={p.product}>
                  <td style={tableTdStyle}>{p.product}</td>
                  {p.weekly_units.map((qty, i) => (
                    <td key={i} style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', color: qty === 0 ? 'var(--t3)' : 'var(--t1)' }}>
                      {qty > 0 ? qty.toLocaleString('en-IN') : '—'}
                    </td>
                  ))}
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700 }}>
                    {p.total.toLocaleString('en-IN')}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t2)' }}>
                    {p.avg_per_active_week.toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            Week columns show units produced in work orders for production runs starting that week (Monday–Sunday). Avg/Active Wk excludes zero-production weeks.
          </div>
        </div>
      )}
    </SummaryShell>
  );
}

// 4. Production vs Dispatch Gap
function AnalyticsGapPanel({ data, loading, load }) {
  const rows = data?.rows || [];
  const monthLabel = data?.from
    ? new Date(data.from + 'T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : 'This Month';
  return (
    <SummaryShell
      title={`Production vs Dispatch Gap — ${monthLabel}`}
      data={data}
      loading={loading}
      load={load}
    >
      {rows.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--t3)', fontSize: 12, textAlign: 'center' }}>No production or dispatch data this month</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Product</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Units Produced</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Units Shipped</th>
              <th style={{ ...tableThStyle, textAlign: 'right' }}>Gap</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.product}>
                  <td style={tableTdStyle}>{r.product}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                    {r.units_produced.toLocaleString('en-IN')}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                    {r.units_shipped.toLocaleString('en-IN')}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700, color: gapColor(r.gap) }}>
                    {r.gap > 0 ? '+' : ''}{r.gap.toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
            Gap = Produced − Shipped. Positive gap means units are in pipeline (RTD/handed-over/allocated) or backlog. Negative gap would indicate returns or data discrepancy.
            Shipped = units with current_status=shipped in public.units, updated this month.
          </div>
        </div>
      )}
    </SummaryShell>
  );
}
