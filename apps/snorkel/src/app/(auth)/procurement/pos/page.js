'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowRight, Download } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact, PO_TONES, sourceTone } from '@/components/format.js';
import { csvCell } from '@/lib/sales.js';
import { todayStr } from '@throttle/domain';

const PO_STATUSES = ['Soft', 'Draft', 'Pending Approval', 'Approved', 'Sent', 'Confirmed & Payment Done', 'Partially Received', 'Closed', 'Cancelled'];
const PO_SOURCES = ['China', 'India', 'USA', 'Germany', 'Taiwan', 'Vietnam', 'Bangladesh', 'Japan', 'South Korea', 'UK', 'Italy', 'Turkey', 'Other'];
const PO_TYPES = ['Product', 'Packaging', 'Para', 'Consumable', 'Component', 'Tools', 'Machines'];
const FX = { INR: 1, USD: 84, RMB: 11.6, CNY: 11.6 };
const toInr = (v, cur) => (Number(v) || 0) * (FX[cur] || 1);

export default function POListPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  // Non-null only when the worker says the read was cut short: { total, fetched, limit }.
  const [truncation, setTruncation] = useState(null);
  const [pendingInward, setPendingInward] = useState(0);
  const [filters, setFilters] = useState({ status: '', source: '', order_type: '' });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.source) params.source = filters.source;
      if (filters.order_type) params.order_type = filters.order_type;
      const [pos, inward] = await Promise.all([
        garageFetch('getPOs', params, session),
        garageFetch('getPendingInward', {}, session).catch(() => []),
      ]);
      // getPOs returns { rows, total, fetched, limit, truncated } as of S334. The array
      // fallback keeps this working against an older worker rather than silently rendering
      // an empty list if the two ever deploy out of step.
      setRows(Array.isArray(pos) ? pos : (pos?.rows ?? []));
      setTruncation(Array.isArray(pos) ? null : (pos?.truncated ? pos : null));
      setPendingInward(Array.isArray(inward) ? inward.length : 0);
    } catch (e) {
      showToast(e.message || 'Failed to load purchase orders', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, filters, showToast]);

  useEffect(() => { load(); }, [load]);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      const fields = [r.po_number, r.vendor_name, r.vendor_code, r.order_type, r.source, r.raised_by_name, r.raised_by, r.status]
        .map((v) => (v || '').toString().toLowerCase());
      return tokens.every((t) => fields.some((f) => f.includes(t)));
    });
  }, [rows, search]);

  const kpi = useMemo(() => {
    const open = rows.filter((p) => ['Draft', 'Approved', 'Sent', 'Pending Approval'].includes(p.status));
    const openVal = open.reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    const chinaVal = open.filter((p) => p.source === 'China').reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    return {
      openVal,
      openCount: rows.filter((p) => ['Draft', 'Approved', 'Sent'].includes(p.status)).length,
      chinaShare: openVal ? Math.round((chinaVal / openVal) * 100) : 0,
    };
  }, [rows]);

  // Export exactly what is on screen — same rows, same filters, same order (Priya,
  // #bugs 2026-08-28). Mirrors the Sales Orders export rather than inventing a second
  // pattern; `csvCell` is the shared quoter.
  // ⚠️ Built from `filteredRows`, which is the CLIENT's list, and that is what makes the
  // China permission hold automatically: getPOs already drops Soft POs and strips China
  // header values for anyone without `po_china`, so a restricted user's file simply cannot
  // contain what their screen does not. A server-side export would have had to re-implement
  // that gate — the recurring way a permission gets taught to one surface and not the next.
  // The value column is written as the RESTRICTED marker for those users, never the number.
  function exportCsv() {
    // ⚠️ The whole point of the truncation signal: this file gets TOTALLED in a spreadsheet,
    // where a short total reads as authoritative. So a partial export is confirmed first and
    // then carries the fact in its FILENAME — that is the only part of the warning that
    // survives the file being saved, renamed in a folder, or emailed on (S334).
    if (truncation) {
      // ⚠️ `total` is null when Content-Range could not be read — the fail-safe path still sets
      // truncated=true. Never interpolate it raw: it renders the literal word "null" in a
      // template string (and nothing at all in JSX). Say what we actually know instead.
      const ok = window.confirm(
        `This list is PARTIAL.\n\n` +
        (truncation.total != null
          ? `${truncation.total} purchase orders match your filters, but only the first ${truncation.limit} were loaded. `
          : `More purchase orders match your filters than the first ${truncation.limit} that were loaded. `) +
        `Any total you calculate from this file will be too low.\n\nExport the partial list anyway?`
      );
      if (!ok) return;
    }
    const canChina = !!perms?.po_china;
    const cols = ['PO Number', 'Revision', 'Type', 'Source', 'Vendor', 'Vendor Code', 'Lines',
      'Currency', 'Value', 'Value (INR approx)', 'Expected', 'Raised by', 'Status'];
    const lines = [cols.join(',')];
    for (const p of filteredRows) {
      const restricted = p.source === 'China' && !canChina;
      lines.push([
        p.po_number, p.revision || 0, p.order_type, p.source, p.vendor_name, p.vendor_code,
        p.line_count ?? p.lines ?? 0,
        restricted ? '' : (p.currency || ''),
        restricted ? 'Restricted' : (p.po_value ?? ''),
        restricted ? '' : Math.round(toInr(p.po_value, p.currency)),
        p.expected_delivery || '', p.raised_by_name || p.raised_by || '', p.status,
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // todayStr() is LOCAL-date, not `toISOString()` — PATTERN-221. Between midnight and
    // 05:30 IST, toISOString() still reads the previous UTC day, so an early-morning
    // download would be stamped yesterday. The three sibling exports in this app all use
    // this helper; matching them is the point.
    a.download = truncation
      ? `lot-purchase-orders-PARTIAL-${filteredRows.length}${truncation.total != null ? `-of-${truncation.total}` : ''}-${todayStr()}.csv`
      : `lot-purchase-orders-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const filtered = search.trim() || filters.status || filters.source || filters.order_type;

  return (
    <div className="pg">
      <PageHead title="Purchase Orders" sub="All purchase orders raised across categories."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filteredRows.length}><Download size={14} /> Export</Btn>
          {perms?.po_create && <Btn kind="primary" onClick={() => router.push('/procurement/pos/new')}><Plus size={14} /> New PO</Btn>}
        </>} />

      <div className="kpi-row">
        <Kpi label="Open value" value={kpi.openVal} sub="≈ INR, all open" tone="blue" format={(v) => inrCompact(v)} />
        <Kpi label="Open POs" value={kpi.openCount} sub="not yet closed" tone="yellow" />
        <Kpi label="To Inward" value={pendingInward} sub="confirmed · arriving" tone="green" onClick={() => router.push('/receiving')} />
        <Kpi label="China share" value={kpi.chinaShare} sub="of open value" tone="blue" format={(v) => Math.round(v) + '%'} />
      </div>

      {truncation && (
        <div style={{
          margin: '0 0 12px', padding: '10px 14px', borderRadius: 8,
          background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
          color: 'var(--warn-fg, #9a3412)', fontSize: 13, lineHeight: 1.5,
        }}>
          <strong>
            {truncation.total != null
              ? `Showing the first ${truncation.limit} of ${truncation.total} purchase orders.`
              : `Showing the first ${truncation.limit} purchase orders — there are more.`}
          </strong>{' '}
          The KPI tiles above and any export are calculated from the loaded rows only, so they
          under-report. Narrow the filters to bring the list under {truncation.limit}.
        </div>
      )}

      <Panel title="Purchase Orders"
        count={filtered
          ? `${filteredRows.length} of ${rows.length}${truncation?.total != null ? ` (of ${truncation.total})` : (truncation ? '+' : '')}`
          : (truncation?.total != null ? `${rows.length} of ${truncation.total}` : (truncation ? `${rows.length}+` : rows.length))}
        action={
          <div className="filters">
            <input className="sel" data-search-primary type="text" placeholder="Search PO / vendor · /" value={search} onChange={(e) => setSearch(e.target.value)} style={{ fontFamily: 'var(--font-mono)', minWidth: 180 }} />
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="sel">
              <option value="">All statuses</option>
              {PO_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.source} onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))} className="sel">
              <option value="">All sources</option>
              {PO_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.order_type} onChange={(e) => setFilters((f) => ({ ...f, order_type: e.target.value }))} className="sel">
              <option value="">All types</option>
              {PO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        }>
        {pendingInward > 0 && (
          <div className="info-bar" style={{ margin: '12px 16px 0', background: 'var(--accent-soft)', borderColor: 'var(--accent-bd)' }}>
            <span style={{ color: 'var(--accent)' }}>
              {pendingInward} PO{pendingInward === 1 ? '' : 's'} confirmed &amp; awaiting inward.{' '}
              <button onClick={() => router.push('/receiving')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}>Go to Receiving</button>
            </span>
          </div>
        )}
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filteredRows.length === 0 ? <EmptyState icon="file-search" title="No purchase orders match" hint="Try clearing a filter or the search box." />
          : (
            <table className="dt">
              <thead><tr>
                <th>PO Number</th><th>Type</th><th>Source</th><th>Vendor</th>
                <th className="num">Lines</th><th className="num">Value</th><th>Expected</th><th>Raised by</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {filteredRows.map((p) => (
                  <tr key={p.po_number} className="row-click" onClick={() => router.push(`/procurement/pos/detail?po_number=${encodeURIComponent(p.po_number)}`)}>
                    <td className="mono accent">{p.po_number}{p.revision > 0 && <span className="rev">r{p.revision}</span>}</td>
                    <td>{p.order_type || '—'}</td>
                    <td><Badge label={p.source || '—'} tone={sourceTone(p.source)} soft={false} /></td>
                    <td>{p.vendor_name || '—'}</td>
                    <td className="num mono">{p.line_count ?? p.lines ?? 0}</td>
                    <td className="num mono">{p.source === 'China' && !perms?.po_china ? <span className="dim">Restricted</span> : money(p.currency, p.po_value)}</td>
                    <td className="mono">{fmtDateShort(p.expected_delivery)}</td>
                    <td>{p.raised_by_name || p.raised_by || '—'}</td>
                    <td><Badge label={p.status || '—'} tone={PO_TONES[p.status] || 'gray'} /></td>
                    <td className="num"><span className="row-go"><ArrowRight size={14} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
