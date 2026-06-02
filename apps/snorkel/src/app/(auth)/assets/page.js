'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, selectStyle, inputStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import { ASSET_STATUSES, ACQ_TYPES, statusLabel, statusTone, acqLabel, assetExpiry, isExpiring } from '@/lib/assets';

function costCell(a) {
  if (a.acquisition_type === 'rented') {
    if (a.rental_cost == null) return '—';
    return `${a.currency || ''} ${Number(a.rental_cost).toLocaleString('en-IN')}${a.rental_period ? ' /' + a.rental_period[0] : ''}`;
  }
  if (a.purchase_cost == null) return '—';
  return `${a.currency || ''} ${Number(a.purchase_cost).toLocaleString('en-IN')}`;
}

const tileStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '10px 14px', minWidth: 110 };
const tileNum   = { fontFamily: 'var(--cond)', fontSize: 24, fontWeight: 900, lineHeight: 1 };
const tileLbl   = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 };

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

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
    } finally {
      setLoading(false);
    }
  }, [session, filters, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getAssetCategories', {}, session).then(d => setCats(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getAssetLocations', {}, session).then(d => setLocs(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.asset_view && !perms.asset_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  let filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.asset_code, r.name, r.serial_no, r.model_no, r.secondary_ref,
        r.custodian_name, r.vendor_name, r.category_name, r.location_name]
        .map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();
  if (expiringOnly) filtered = filtered.filter(r => isExpiring(r));

  // KPI tiles (computed over the full loaded set, not the text-filtered view)
  const kpi = {
    total: rows.length,
    in_use: rows.filter(r => r.status === 'in_use').length,
    in_storage: rows.filter(r => r.status === 'in_storage').length,
    attention: rows.filter(r => r.status === 'damaged' || r.status === 'in_repair').length,
    expiring: rows.filter(r => isExpiring(r)).length,
  };

  function exportCsv() {
    const cols = ['Code', 'Name', 'Category', 'Status', 'Acquisition', 'Location', 'Custodian',
      'Serial', 'Model', 'Secondary Ref', 'Vendor', 'Currency', 'Purchase Cost', 'Rental Cost',
      'Rental Period', 'Source PO', 'Warranty Expiry', 'AMC Renewal', 'Docs'];
    const lines = [cols.join(',')];
    for (const a of filtered) {
      lines.push([
        a.asset_code, a.name, a.category_name, statusLabel(a.status), acqLabel(a.acquisition_type),
        a.location_name, a.custodian_name, a.serial_no, a.model_no, a.secondary_ref, a.vendor_name,
        a.currency, a.purchase_cost, a.rental_cost, a.rental_period, a.source_po_number,
        a.warranty_expiry, a.amc_renewal, a.doc_count ?? 0,
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-asset-register-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>Asset Register</h1>
          <p style={pageSub}>What we own &amp; rent — where it is, who has it, what it cost.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={exportCsv} disabled={!filtered.length}>↓ Export CSV</button>
          {canManage && <button style={btnPrimary} onClick={() => router.push('/assets/new')}>+ New Asset</button>}
        </div>
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={tileStyle}><div style={tileNum}>{kpi.total}</div><div style={tileLbl}>Total assets</div></div>
        <div style={tileStyle}><div style={{ ...tileNum, color: '#4ade80' }}>{kpi.in_use}</div><div style={tileLbl}>In use</div></div>
        <div style={tileStyle}><div style={{ ...tileNum, color: '#7b93ff' }}>{kpi.in_storage}</div><div style={tileLbl}>In storage</div></div>
        <div style={tileStyle}><div style={{ ...tileNum, color: '#ff7070' }}>{kpi.attention}</div><div style={tileLbl}>Damaged / repair</div></div>
        <div
          style={{ ...tileStyle, cursor: 'pointer', borderColor: expiringOnly ? 'var(--yellow)' : 'var(--border)' }}
          onClick={() => setExpiringOnly(v => !v)}
          title="Warranty or AMC expired / within 60 days — click to filter"
        >
          <div style={{ ...tileNum, color: '#f2cd1a' }}>{kpi.expiring}</div><div style={tileLbl}>Expiring ⚠</div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Filters {(search.trim() || expiringOnly) && <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 11 }}>· {filtered.length} of {rows.length}</span>}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" data-search-primary placeholder="Search code / name / serial · /" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)', minWidth: 200 }} />
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={selectStyle}>
              <option value="">All Statuses</option>
              {ASSET_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <select value={filters.acquisition_type} onChange={e => setFilters(f => ({ ...f, acquisition_type: e.target.value }))} style={selectStyle}>
              <option value="">All Types</option>
              {ACQ_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <select value={filters.category_id} onChange={e => setFilters(f => ({ ...f, category_id: e.target.value }))} style={selectStyle}>
              <option value="">All Categories</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={filters.location_id} onChange={e => setFilters(f => ({ ...f, location_id: e.target.value }))} style={selectStyle}>
              <option value="">All Locations</option>
              {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
              <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} /> Expiring
            </label>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No assets match the filter</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Code</th>
                <th style={tableThStyle}>Name</th>
                <th style={tableThStyle}>Category</th>
                <th style={tableThStyle}>Status</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Location</th>
                <th style={tableThStyle}>Custodian</th>
                <th style={tableThStyle}>Cost</th>
                <th style={tableThStyle}>Warr/AMC</th>
                <th style={{ ...tableThStyle, textAlign: 'center' }}>Docs</th>
              </tr></thead>
              <tbody>
                {filtered.map(a => {
                  const exp = assetExpiry(a);
                  return (
                    <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/assets/detail?id=${encodeURIComponent(a.id)}`)}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{a.asset_code}</td>
                      <td style={tableTdStyle}>{a.name}</td>
                      <td style={tableTdStyle}>{a.category_name || '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={statusLabel(a.status)} tone={statusTone(a.status)} /></td>
                      <td style={tableTdStyle}>{acqLabel(a.acquisition_type)}</td>
                      <td style={tableTdStyle}>{a.location_name || '—'}</td>
                      <td style={tableTdStyle}>{a.custodian_name || <span style={{ color: 'var(--t3)' }}>—</span>}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{costCell(a)}</td>
                      <td style={tableTdStyle}>
                        {exp
                          ? <StatusBadge label={exp.level === 'expired' ? `${exp.what} expired` : `${exp.what} ${exp.days}d`} tone={exp.tone} />
                          : <span style={{ color: 'var(--t3)' }}>—</span>}
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'center', fontFamily: 'var(--mono)', color: a.doc_count ? 'var(--t1)' : 'var(--t3)' }}>
                        {a.doc_count ? `📎 ${a.doc_count}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
