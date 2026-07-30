'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Download, ArrowRight } from 'lucide-react';
import { ASSET_STATUSES, ACQ_TYPES, statusLabel, statusTone, acqLabel, assetExpiry, isExpiring } from '@/lib/assets';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort } from '@/components/format.js';
import { todayStr } from '@throttle/domain';

function costCell(a) {
  if (a.acquisition_type === 'rented') {
    if (a.rental_cost == null) return '—';
    return `${a.currency || ''} ${Number(a.rental_cost).toLocaleString('en-IN')}${a.rental_period ? ' /' + a.rental_period[0] : ''}`;
  }
  if (a.purchase_cost == null) return '—';
  return `${a.currency || ''} ${Number(a.purchase_cost).toLocaleString('en-IN')}`;
}
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default function AssetListPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [locs, setLocs] = useState([]);
  const [filters, setFilters] = useState({ status: '', category_id: '', location_id: '', acquisition_type: '' });
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canManage = !!perms?.asset_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (filters.status) params.status = filters.status;
      if (filters.category_id) params.category_id = filters.category_id;
      if (filters.location_id) params.location_id = filters.location_id;
      if (filters.acquisition_type) params.acquisition_type = filters.acquisition_type;
      const assets = await garageFetch('getAssets', params, session);
      setRows(Array.isArray(assets) ? assets : []);
    } catch (e) {
      showToast(e.message || 'Failed to load assets', 'error');
    } finally { setLoading(false); }
  }, [session, filters, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getAssetCategories', {}, session).then(d => setCats(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetLocations', {}, session).then(d => setLocs(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.asset_view && !perms.asset_manage) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  let filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.asset_code, r.name, r.serial_no, r.model_no, r.secondary_ref, r.custodian_name, r.vendor_name, r.category_name, r.location_name]
        .map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();
  if (expiringOnly) filtered = filtered.filter(r => isExpiring(r));

  const kpi = {
    total: rows.length,
    in_use: rows.filter(r => r.status === 'in_use').length,
    attention: rows.filter(r => r.status === 'damaged' || r.status === 'in_repair').length,
    expiring: rows.filter(r => isExpiring(r)).length,
  };

  function exportCsv() {
    const cols = ['Code', 'Name', 'Category', 'Status', 'Acquisition', 'Location', 'Custodian', 'Serial', 'Model', 'Secondary Ref', 'Vendor', 'Currency', 'Purchase Cost', 'Rental Cost', 'Rental Period', 'Source PO', 'Warranty Expiry', 'AMC Renewal', 'Docs'];
    const lines = [cols.join(',')];
    for (const a of filtered) {
      lines.push([a.asset_code, a.name, a.category_name, statusLabel(a.status), acqLabel(a.acquisition_type),
        a.location_name, a.custodian_name, a.serial_no, a.model_no, a.secondary_ref, a.vendor_name,
        a.currency, a.purchase_cost, a.rental_cost, a.rental_period, a.source_po_number,
        a.warranty_expiry, a.amc_renewal, a.doc_count ?? 0].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-asset-register-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const filtersActive = search.trim() || expiringOnly;

  return (
    <div className="pg">
      <PageHead title="Asset Register" sub="Tools, moulds and machines bought through procurement — where they are, who has them, what they cost."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>
          {canManage && <Btn kind="primary" onClick={() => router.push('/assets/new')}><Plus size={14} /> Add asset</Btn>}
        </>} />

      <div className="kpi-row">
        <Kpi label="Assets" value={kpi.total} sub="on the register" tone="blue" />
        <Kpi label="In use" value={kpi.in_use} sub="deployed" tone="green" />
        <Kpi label="Needs attention" value={kpi.attention} sub="damaged / repair" tone="red" />
        <Kpi label="Expiring" value={kpi.expiring} sub="warranty / AMC · click to filter" tone="yellow" onClick={() => setExpiringOnly(v => !v)} />
      </div>

      <Panel title="Register" count={filtersActive ? `${filtered.length} of ${rows.length}` : rows.length}
        action={
          <div className="filters">
            <input className="sel" data-search-primary type="text" placeholder="Search code / name / serial · /" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 170 }} />
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} className="sel">
              <option value="">All statuses</option>
              {ASSET_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={filters.acquisition_type} onChange={e => setFilters(f => ({ ...f, acquisition_type: e.target.value }))} className="sel">
              <option value="">All types</option>
              {ACQ_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <select value={filters.category_id} onChange={e => setFilters(f => ({ ...f, category_id: e.target.value }))} className="sel">
              <option value="">All categories</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={filters.location_id} onChange={e => setFilters(f => ({ ...f, location_id: e.target.value }))} className="sel">
              <option value="">All locations</option>
              {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {expiringOnly && <button className="chip-clear" onClick={() => setExpiringOnly(false)}>Expiring ✕</button>}
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="boxes" title="No assets match the filter" hint="Clear a filter to see the full register." />
          : (
            <table className="dt">
              <thead><tr>
                <th>Code</th><th>Asset</th><th>Category</th><th>Status</th><th>Type</th><th>Location</th><th>Custodian</th><th className="num">Cost</th><th>Warr/AMC</th><th className="num">Docs</th><th className="num"></th>
              </tr></thead>
              <tbody>
                {filtered.map(a => {
                  const exp = assetExpiry(a);
                  return (
                    <tr key={a.id} className="row-click" onClick={() => router.push(`/assets/detail?id=${encodeURIComponent(a.id)}`)}>
                      <td className="mono accent">{a.asset_code}</td>
                      <td>{a.name}</td>
                      <td className="dim">{a.category_name || '—'}</td>
                      <td><Badge label={statusLabel(a.status)} tone={statusTone(a.status)} dot /></td>
                      <td className="dim">{acqLabel(a.acquisition_type)}</td>
                      <td className="dim">{a.location_name || '—'}</td>
                      <td className="dim">{a.custodian_name || '—'}</td>
                      <td className="num mono">{costCell(a)}</td>
                      <td>{exp ? <Badge label={exp.level === 'expired' ? `${exp.what} expired` : `${exp.what} ${exp.days}d`} tone={exp.tone} /> : <span className="dim">—</span>}</td>
                      <td className="num mono dim">{a.doc_count ? a.doc_count : '—'}</td>
                      <td className="num"><span className="row-go"><ArrowRight size={14} /></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
