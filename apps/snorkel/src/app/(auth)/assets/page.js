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
import { ASSET_STATUSES, ACQ_TYPES, statusLabel, statusTone, acqLabel } from '@/lib/assets';

function costCell(a) {
  if (a.acquisition_type === 'rented') {
    if (a.rental_cost == null) return '—';
    return `${a.currency || ''} ${Number(a.rental_cost).toLocaleString('en-IN')}${a.rental_period ? ' /' + a.rental_period[0] : ''}`;
  }
  if (a.purchase_cost == null) return '—';
  return `${a.currency || ''} ${Number(a.purchase_cost).toLocaleString('en-IN')}`;
}

export default function AssetListPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [locs, setLocs] = useState([]);
  const [filters, setFilters] = useState({ status: '', category_id: '', location_id: '', acquisition_type: '' });
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

  const filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.asset_code, r.name, r.serial_no, r.model_no, r.secondary_ref,
        r.custodian_name, r.vendor_name, r.category_name, r.location_name]
        .map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>Asset Register</h1>
          <p style={pageSub}>What we own &amp; rent — where it is, who has it, what it cost.</p>
        </div>
        {canManage && <button style={btnPrimary} onClick={() => router.push('/assets/new')}>+ New Asset</button>}
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Filters {search.trim() && <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 11 }}>· {filtered.length} of {rows.length}</span>}</span>
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
              </tr></thead>
              <tbody>
                {filtered.map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/assets/detail?id=${encodeURIComponent(a.id)}`)}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{a.asset_code}</td>
                    <td style={tableTdStyle}>{a.name}</td>
                    <td style={tableTdStyle}>{a.category_name || '—'}</td>
                    <td style={tableTdStyle}><StatusBadge label={statusLabel(a.status)} tone={statusTone(a.status)} /></td>
                    <td style={tableTdStyle}>{acqLabel(a.acquisition_type)}</td>
                    <td style={tableTdStyle}>{a.location_name || '—'}</td>
                    <td style={tableTdStyle}>{a.custodian_name || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{costCell(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
