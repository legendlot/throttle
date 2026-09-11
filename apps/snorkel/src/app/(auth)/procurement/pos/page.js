'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, ArrowRight, Download } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact, PO_TONES, PO_STATUSES, sourceTone } from '@/components/format.js';
import { csvCell } from '@/lib/sales.js';
import { buildPoLinesCsv } from '@/lib/poExport.js';
import { todayStr, istDateStr, istRangePresets } from '@throttle/domain';

// Date filter (Joseph, #bugs 1789108860.383049). ⚠️ Defaults to ALL TIME, an exception to the
// standing "range pickers default to Today" rule because this page is a worklist — an open PO
// raised last month must not vanish on load. Flagged to Afshaan; if he wants Today, change this
// one constant to 'today'.
const DEFAULT_DATE_PRESET = 'all';
// The shared IST presets, minus 90D (not asked for here), plus All time.
const DATE_PRESET_KEYS = ['today', '7d', '30d', 'mtd', 'lm', 'fy'];
function datePresets() {
  const shared = istRangePresets().filter((p) => DATE_PRESET_KEYS.includes(p.key));
  return [...shared, { key: 'all', label: 'All time', from: '', to: '' }];
}
// The PO's own date: `raised_date` (a Postgres DATE, so already a calendar day — no timezone
// maths). created_at, read on the IST clock, only covers a row that somehow lacks it (0 of 480
// on 2026-09-11). Compared as YYYY-MM-DD strings against the IST preset bounds.
const poDate = (p) => p.raised_date || istDateStr(p.created_at);
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
  // Vendor + date are CLIENT filters over the loaded rows (getPOs has no params for them), and
  // apply through `filteredRows` — so the table, KPI tiles and both exports all follow them.
  const [vendor, setVendor] = useState('');
  const presets = useMemo(datePresets, []);
  const [range, setRange] = useState(() => {
    const p = presets.find((x) => x.key === DEFAULT_DATE_PRESET);
    return { preset: p.key, from: p.from, to: p.to };
  });
  const [loading, setLoading] = useState(true);
  const [exportingLines, setExportingLines] = useState(false);

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
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    const { from, to } = range;
    return rows.filter((r) => {
      if (vendor && r.vendor_name !== vendor) return false;
      if (from || to) {
        const d = poDate(r);
        if (!d || (from && d < from) || (to && d > to)) return false;
      }
      if (!tokens.length) return true;
      const fields = [r.po_number, r.vendor_name, r.vendor_code, r.order_type, r.source, r.raised_by_name, r.raised_by, r.status]
        .map((v) => (v || '').toString().toLowerCase());
      return tokens.every((t) => fields.some((f) => f.includes(t)));
    });
  }, [rows, search, vendor, range]);

  // Status options = every known status (PO_TONES, one source with the badge) plus any live value
  // it does not know yet — so a new status can never again be unfilterable, as Accepted was.
  const statusOptions = useMemo(() => {
    const extra = [...new Set(rows.map((r) => r.status).filter((s) => s && !PO_STATUSES.includes(s)))];
    return [...PO_STATUSES, ...extra];
  }, [rows]);

  // Vendors present in the loaded rows. po_summary carries no vendor_code today, so the hint is
  // usually empty; it shows whenever a row does carry one. The selected vendor is kept as an
  // option even when a server filter drops its rows, so the box never blanks while still filtering.
  const vendorOptions = useMemo(() => {
    const byName = new Map();
    for (const r of rows) if (r.vendor_name && !byName.get(r.vendor_name)) byName.set(r.vendor_name, r.vendor_code || '');
    if (vendor && !byName.has(vendor)) byName.set(vendor, '');
    return [...byName].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, code]) => ({ value: name, label: name, hint: code || undefined }));
  }, [rows, vendor]);

  // Follows every filter (S374): built from `filteredRows`, not `rows`, so the tiles describe
  // the same set the table shows and the exports write. `To Inward` is a separate read
  // (getPendingInward) that links to Receiving — it does not follow these filters.
  const kpi = useMemo(() => {
    const open = filteredRows.filter((p) => ['Draft', 'Approved', 'Sent', 'Pending Approval'].includes(p.status));
    const openVal = open.reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    const chinaVal = open.filter((p) => p.source === 'China').reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
    return {
      openVal,
      openCount: filteredRows.filter((p) => ['Draft', 'Approved', 'Sent'].includes(p.status)).length,
      chinaShare: openVal ? Math.round((chinaVal / openVal) * 100) : 0,
    };
  }, [filteredRows]);

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
    // `Raised` added with the date filter (S374) so a month's download carries the date it was
    // filtered on — the same column the table now shows.
    const cols = ['PO Number', 'Revision', 'Type', 'Source', 'Vendor', 'Vendor Code', 'Lines',
      'Currency', 'Value', 'Value (INR approx)', 'Raised', 'Expected', 'Raised by', 'Status'];
    const lines = [cols.join(',')];
    for (const p of filteredRows) {
      const restricted = p.source === 'China' && !canChina;
      lines.push([
        p.po_number, p.revision || 0, p.order_type, p.source, p.vendor_name, p.vendor_code,
        p.line_count ?? p.lines ?? 0,
        restricted ? '' : (p.currency || ''),
        restricted ? 'Restricted' : (p.po_value ?? ''),
        restricted ? '' : Math.round(toInr(p.po_value, p.currency)),
        poDate(p), p.expected_delivery || '', p.raised_by_name || p.raised_by || '', p.status,
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

  // Second, SEPARATE export: one row per PO LINE (Prarthi, #bugs 2026-09-10). It does not
  // replace exportCsv above — that one deliberately mirrors the screen for Priya (S334), and two
  // people want two different files.
  // ⚠️ The lines are a SECOND read, so they do NOT inherit getPOs' China/Soft gate the way the
  // header export does. `getPOLinesBulk` re-applies exactly that gate server-side; this function
  // only formats what comes back. Never build this file from a raw po_lines read.
  async function exportCsvWithLines() {
    if (!session) return;
    let payload;
    setExportingLines(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.source) params.source = filters.source;
      if (filters.order_type) params.order_type = filters.order_type;
      payload = await garageFetch('getPOLinesBulk', params, session);
    } catch (e) {
      showToast(e.message || 'Failed to load PO lines', 'error');
      return;
    } finally {
      setExportingLines(false);
    }
    const linesByPo = payload?.linesByPo || {};
    // po_summary carries no vendor_code (23 columns, not among them), so the Vendor Code column
    // can only come from the worker's purchase_orders read — never from `filteredRows`.
    const vendorByPo = payload?.vendorByPo || {};
    // ⚠️ TWO ways this file can be short and only one of them is the S334 one: the PO list may
    // have been cut at PO_PAGE_LIMIT, or the LINE read may have been cut at its own cap. Either
    // makes the file partial, and a partial line file is the more dangerous of the two — a PO
    // present with only some of its lines totals to a plausible, wrong number.
    const partial = !!truncation || !!payload?.truncated;
    if (partial) {
      const ok = window.confirm(
        `This export is PARTIAL.\n\n` +
        (truncation
          ? (truncation.total != null
              ? `${truncation.total} purchase orders match your filters, but only the first ${truncation.limit} were loaded. `
              : `More purchase orders match your filters than the first ${truncation.limit} that were loaded. `)
          : '') +
        (payload?.line_truncated
          ? (payload.total != null
              ? `${payload.total} PO lines exist, but only the first ${payload.limit} were loaded. `
              : `More PO lines exist than the first ${payload.limit} that were loaded. `)
          : '') +
        `Any total you calculate from this file will be too low.\n\nExport the partial file anyway?`
      );
      if (!ok) return;
    }
    // Built from `filteredRows` so the on-screen text search is honoured, exactly like the
    // header export.
    const csv = buildPoLinesCsv({ filteredRows, linesByPo, vendorByPo, canChina: !!perms?.po_china });
    const rowCount = csv.split('\n').length - 1;
    if (!rowCount) { showToast('No PO lines to export for these filters', 'error'); return; }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Same PARTIAL marker as the header export, for the same reason: the filename is the only
    // part of the warning that survives the file being saved, renamed or emailed on.
    a.download = partial
      ? `lot-purchase-order-lines-PARTIAL-${rowCount}-${todayStr()}.csv`
      : `lot-purchase-order-lines-${rowCount}-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const filtered = search.trim() || filters.status || filters.source || filters.order_type || vendor || range.from || range.to;

  return (
    <div className="pg">
      <PageHead title="Purchase Orders" sub="All purchase orders raised across categories."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filteredRows.length}><Download size={14} /> Export</Btn>
          <Btn onClick={exportCsvWithLines} disabled={!filteredRows.length || exportingLines}><Download size={14} /> {exportingLines ? 'Loading lines…' : 'Export + lines'}</Btn>
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
              {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {/* portal: .panel is overflow:hidden, which would clip an absolute dropdown. */}
            <Combobox value={vendor} options={vendorOptions} onChange={(v) => setVendor(v || '')}
              placeholder="All vendors" emptyLabel="No matching vendor" portal
              style={{ width: 200 }} inputStyle={{ fontFamily: 'var(--font-mono)' }} />
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
        <div className="filters" style={{ margin: '12px 16px 0' }}>
          <div className="seg" style={{ marginBottom: 0 }}>
            {presets.map((p) => (
              <button key={p.key} className={`seg-btn ${range.preset === p.key ? 'on' : ''}`}
                onClick={() => setRange({ preset: p.key, from: p.from, to: p.to })}>{p.label}</button>
            ))}
          </div>
          <span className="dim" style={{ fontSize: 12 }}>Raised</span>
          <input className="sel" type="date" value={range.from} max={range.to || undefined}
            onChange={(e) => setRange((r) => ({ preset: '', from: e.target.value, to: r.to }))} />
          <span className="dim">→</span>
          <input className="sel" type="date" value={range.to} min={range.from || undefined}
            onChange={(e) => setRange((r) => ({ preset: '', from: r.from, to: e.target.value }))} />
        </div>
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
                <th className="num">Lines</th><th className="num">Value</th><th>Raised</th><th>Expected</th><th>Raised by</th><th>Status</th><th></th>
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
                    <td className="mono">{fmtDateShort(poDate(p))}</td>
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
