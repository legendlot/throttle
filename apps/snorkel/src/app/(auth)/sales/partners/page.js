'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, selectStyle, inputStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge,
} from '@/lib/snorkelui';
import { csvCell } from '@/lib/sales';

export default function SalesPartnersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canManage = !!perms?.sales_partner_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (channel) params.channel_key = channel;
      if (activeOnly) params.active = '1';
      const data = await garageFetch('getSalesPartners', params, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load partners', 'error');
    } finally { setLoading(false); }
  }, [session, channel, activeOnly, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session) return;
    garageFetch('getSalesChannels', {}, session).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_partner_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.partner_code, r.name, r.gstin, r.state, r.city, r.contact_person, r.phone]
        .map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();

  function exportCsv() {
    const cols = ['Code', 'Name', 'Channel', 'Type', 'State', 'City', 'GSTIN', 'Contact', 'Phone', 'Credit Days', 'Active'];
    const lines = [cols.join(',')];
    for (const p of filtered) lines.push([p.partner_code, p.name, p.channel_key, p.partner_type, p.state,
      p.city, p.gstin, p.contact_person, p.phone, p.default_credit_days, p.is_active ? 'Yes' : 'No'].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-sales-partners-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>Partners</h1>
          <p style={pageSub}>GT / MT stores &amp; distributors — credit terms live here.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnSecondary} onClick={exportCsv} disabled={!filtered.length}>↓ Export CSV</button>
          {canManage && <button style={btnPrimary} onClick={() => router.push('/sales/partners/new')}>+ New Partner</button>}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Partners {search.trim() && <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)', fontWeight: 400, fontSize: 11 }}>· {filtered.length} of {rows.length}</span>}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" data-search-primary placeholder="Search name / GSTIN / state · /" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)', minWidth: 200 }} />
            <select value={channel} onChange={e => setChannel(e.target.value)} style={selectStyle}>
              <option value="">All Channels</option>
              {channels.map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Active only
            </label>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No partners match the filter</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Code</th>
                <th style={tableThStyle}>Name</th>
                <th style={tableThStyle}>Channel</th>
                <th style={tableThStyle}>State</th>
                <th style={tableThStyle}>GSTIN</th>
                <th style={tableThStyle}>Contact</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Credit</th>
                <th style={tableThStyle}>Active</th>
              </tr></thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/sales/partners/detail?id=${encodeURIComponent(p.id)}`)}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.partner_code}</td>
                    <td style={tableTdStyle}>{p.name}</td>
                    <td style={tableTdStyle}>{p.channel_key || '—'}</td>
                    <td style={tableTdStyle}>{p.state || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{p.gstin || '—'}</td>
                    <td style={tableTdStyle}>{p.contact_person || '—'}{p.phone ? ` · ${p.phone}` : ''}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{p.default_credit_days}d</td>
                    <td style={tableTdStyle}><StatusBadge label={p.is_active ? 'Active' : 'Inactive'} tone={p.is_active ? 'green' : 'gray'} /></td>
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
