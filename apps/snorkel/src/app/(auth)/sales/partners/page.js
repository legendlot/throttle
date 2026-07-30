'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Download, ArrowRight } from 'lucide-react';
import { csvCell } from '@/lib/sales';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { todayStr } from '@throttle/domain';

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
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.partner_code, r.name, r.gstin, r.state, r.city, r.contact_person, r.phone].map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();

  const activeCount = rows.filter(p => p.is_active).length;
  const gtCount = rows.filter(p => p.channel_key === 'GT').length;
  const mtCount = rows.filter(p => p.channel_key === 'MT').length;

  function exportCsv() {
    const cols = ['Code', 'Name', 'Channel', 'Type', 'State', 'City', 'GSTIN', 'Contact', 'Phone', 'Credit Days', 'Active'];
    const lines = [cols.join(',')];
    for (const p of filtered) lines.push([p.partner_code, p.name, p.channel_key, p.partner_type, p.state,
      p.city, p.gstin, p.contact_person, p.phone, p.default_credit_days, p.is_active ? 'Yes' : 'No'].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-sales-partners-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pg">
      <PageHead title="Partners" sub="Retail accounts across general and modern trade. Credit terms live here."
        actions={<>
          <Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>
          {canManage && <Btn kind="primary" onClick={() => router.push('/sales/partners/new')}><Plus size={14} /> Add partner</Btn>}
        </>} />

      <div className="kpi-row">
        <Kpi label="Partners" value={rows.length} sub="GT + MT accounts" tone="blue" />
        <Kpi label="Active" value={activeCount} sub="bookable" tone="green" />
        <Kpi label="GT" value={gtCount} sub="general trade" tone="blue" />
        <Kpi label="MT" value={mtCount} sub="modern trade" tone="orange" />
      </div>

      <Panel title="Accounts" count={search.trim() ? `${filtered.length} of ${rows.length}` : rows.length}
        action={
          <div className="filters">
            <input className="sel" data-search-primary type="text" placeholder="Search name / GSTIN / state · /" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 180 }} />
            <select value={channel} onChange={e => setChannel(e.target.value)} className="sel">
              <option value="">All channels</option>
              {channels.map(c => <option key={c.channel_key} value={c.channel_key}>{c.label}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Active only
            </label>
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="building-2" title="No partners match the filter" hint="Clear a filter to see all accounts." />
          : (
            <table className="dt">
              <thead><tr>
                <th>Code</th><th>Name</th><th>Channel</th><th>State</th><th>GSTIN</th><th>Contact</th><th className="num">Credit</th><th>Active</th><th className="num"></th>
              </tr></thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} className="row-click" onClick={() => router.push(`/sales/partners/detail?id=${encodeURIComponent(p.id)}`)}>
                    <td className="mono accent">{p.partner_code}</td>
                    <td>{p.name}</td>
                    <td><Badge label={p.channel_key || '—'} tone="blue" /></td>
                    <td className="dim">{p.state || '—'}</td>
                    <td className="mono dim" style={{ fontSize: 11 }}>{p.gstin || '—'}</td>
                    <td className="dim">{p.contact_person || '—'}{p.phone ? ` · ${p.phone}` : ''}</td>
                    <td className="num mono">{p.default_credit_days}d</td>
                    <td><Badge label={p.is_active ? 'Active' : 'Inactive'} tone={p.is_active ? 'green' : 'gray'} dot /></td>
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
