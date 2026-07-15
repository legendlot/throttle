'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { Plus, ArrowRight } from 'lucide-react';
import { listMoulds } from '@/lib/moulds';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';

export default function MouldListPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const canManage = !!perms?.po_create;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await listMoulds(session);
      setRows(Array.isArray(data) ? data : []);
    } finally { setLoading(false); }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const filtered = !search.trim() ? rows : (() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
      const fields = [r.mould_no, r.description, r.vendor_code].map(v => (v || '').toString().toLowerCase());
      return tokens.every(t => fields.some(f => f.includes(t)));
    });
  })();

  const kpi = {
    total: rows.length,
    active: rows.filter(r => r.is_active).length,
    parts: rows.reduce((s, r) => s + (Number(r.parts_count) || 0), 0),
  };

  return (
    <div className="pg">
      <PageHead title="Moulds" sub="Injection moulds LOT owns — each produces several part codes per shot. Order by mould; the store receives the real part codes."
        actions={canManage && <Btn kind="primary" onClick={() => router.push('/moulds/new')}><Plus size={14} /> New mould</Btn>} />

      <div className="kpi-row kpi-3">
        <Kpi label="Moulds" value={kpi.total} sub="on the register" tone="blue" />
        <Kpi label="Active" value={kpi.active} sub="orderable" tone="green" />
        <Kpi label="Parts mapped" value={kpi.parts} sub="across all moulds" tone="yellow" />
      </div>

      <Panel title="Mould register" count={search.trim() ? `${filtered.length} of ${rows.length}` : rows.length}
        action={
          <div className="filters">
            <input className="sel" data-search-primary type="text" placeholder="Search mould / description · /" value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 200 }} />
          </div>
        }>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="boxes" title="No moulds yet" hint={canManage ? 'Add a mould, then map its part codes.' : 'No moulds match.'} />
          : (
            <table className="dt">
              <thead><tr>
                <th>Mould No</th><th>Description</th><th>Vendor</th><th className="num">Parts</th><th>Status</th><th className="num"></th>
              </tr></thead>
              <tbody>
                {filtered.map(m => (
                  <tr key={m.mould_no} className="row-click" onClick={() => router.push(`/moulds/detail?mould_no=${encodeURIComponent(m.mould_no)}`)}>
                    <td className="mono accent">{m.mould_no}</td>
                    <td>{m.description || '—'}</td>
                    <td className="dim mono">{m.vendor_code || '—'}</td>
                    <td className="num mono">{m.parts_count || 0}</td>
                    <td><Badge label={m.is_active ? 'Active' : 'Inactive'} tone={m.is_active ? 'green' : 'gray'} dot /></td>
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
