'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, getValidSession } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { NewPayeeModal } from '../new/page.js';

export default function PayeesPage() {
  const { userId } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const firstLoadDone = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    if (!firstLoadDone.current) setLoading(true);
    try {
      const s = await getValidSession();
      const data = await garageFetch('getPaymentPayees', {}, s);
      setRows(data?.payees || []);
    } catch (e) {
      showToast(e.message || 'Failed to load', 'error');
    } finally { firstLoadDone.current = true; setLoading(false); }
  }, [userId, showToast]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  const filtered = rows.filter(r =>
    !q || `${r.name} ${r.payee_code} ${r.gstin || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead title="Payees" sub="Everyone we pay — vendors, influencers, ad platforms, utilities. Bank details are visible to Finance only." />
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search payees…"
          style={{ flex: 1, minWidth: 200, padding: '10px 12px', fontSize: 15, borderRadius: 8,
                   border: '1px solid var(--bd)', background: 'var(--surface)', color: 'var(--t1)' }} />
        <Btn kind="primary" onClick={() => setOpen(true)}>+ New payee</Btn>
      </div>
      <Panel title="Payees" count={filtered.length}>
        {filtered.length === 0
          ? <EmptyState icon="building" title="No payees" hint="Add the first one." />
          : (
            <div style={{ overflowX: 'auto' }}>
              <table className="dt">
                <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>GSTIN</th><th>Status</th></tr></thead>
                <tbody>
                  {filtered.map(p => (
                    <tr key={p.id}>
                      <td><b>{p.payee_code}</b></td>
                      <td>{p.name}</td>
                      <td>{String(p.payee_type || '').replace(/_/g, ' ')}</td>
                      <td>{p.gstin || '—'}</td>
                      <td><Badge tone={p.is_active ? 'green' : 'gray'}>{p.is_active ? 'Active' : 'Inactive'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
      {open && <NewPayeeModal canEnterBank onClose={() => setOpen(false)}
        onCreated={async (c) => { setOpen(false); await load(); showToast(`${c.payee_code} added`, 'success'); }} />}
    </>
  );
}
