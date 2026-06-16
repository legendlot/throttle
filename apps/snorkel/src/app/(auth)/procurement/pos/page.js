'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowRight } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, money, inrCompact, PO_TONES, sourceTone } from '@/components/format.js';

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
      setRows(Array.isArray(pos) ? pos : []);
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

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const filtered = search.trim() || filters.status || filters.source || filters.order_type;

  return (
    <div className="pg">
      <PageHead title="Purchase Orders" sub="All purchase orders raised across categories."
        actions={perms?.po_create && <Btn kind="primary" onClick={() => router.push('/procurement/pos/new')}><Plus size={14} /> New PO</Btn>} />

      <div className="kpi-row">
        <Kpi label="Open value" value={kpi.openVal} sub="≈ INR, all open" tone="blue" format={(v) => inrCompact(v)} />
        <Kpi label="Open POs" value={kpi.openCount} sub="not yet closed" tone="yellow" />
        <Kpi label="To Inward" value={pendingInward} sub="confirmed · arriving" tone="green" onClick={() => router.push('/receiving')} />
        <Kpi label="China share" value={kpi.chinaShare} sub="of open value" tone="blue" format={(v) => Math.round(v) + '%'} />
      </div>

      <Panel title="Purchase Orders" count={filtered ? `${filteredRows.length} of ${rows.length}` : rows.length}
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
