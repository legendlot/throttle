'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowRight } from 'lucide-react';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inr, inrCompact, urgencyTone } from '@/components/format.js';

const REQUEST_TONES = { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'gray' };
const STATUS_TABS = ['all', 'pending', 'approved', 'rejected', 'cancelled'];

export default function RequestsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getRequests', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load requests', 'error');
    } finally { setLoading(false); }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const count = (s) => rows.filter((r) => r.status === s).length;
  const filtered = tab === 'all' ? rows : rows.filter((r) => r.status === tab);
  const pendVal = useMemo(() => rows.filter((r) => r.status === 'pending').reduce((s, r) => s + Number(r.estimated_cost || 0), 0), [rows]);

  return (
    <div className="pg">
      <PageHead title="PO Requests" sub="Anyone at LOT can file a request. Procurement turns it into a formal PO."
        actions={<Btn kind="primary" onClick={() => router.push('/requests/new')}><Plus size={14} /> New Request</Btn>} />

      <div className="kpi-row kpi-3">
        <Kpi label="Pending" value={count('pending')} sub="awaiting a call" tone="yellow" />
        <Kpi label="Pending value" value={pendVal} sub="estimated" tone="blue" format={(v) => inrCompact(v)} />
        <Kpi label="Approved" value={count('approved')} sub="this cycle" tone="green" />
      </div>

      <div className="seg">
        {STATUS_TABS.map((t) => (
          <button key={t} className={`seg-btn ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>
            {t} <span className="seg-n">{t === 'all' ? rows.length : count(t)}</span>
          </button>
        ))}
      </div>

      <Panel title="Requests" count={filtered.length}
        action={<Btn onClick={load} disabled={loading}>Refresh</Btn>}>
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="inbox" title="Nothing here" hint="Requests in this state will show up here." />
          : (
            <table className="dt">
              <thead><tr>
                <th>Request</th><th>Title</th><th>Category</th><th>Urgency</th>
                <th className="num">Items</th><th className="num">Est. cost</th><th>Requested by</th><th>Date</th><th>Status</th><th className="num"></th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.request_no} className="row-click" onClick={() => router.push(`/requests/detail?request_no=${encodeURIComponent(r.request_no)}`)}>
                    <td className="mono accent">{r.request_no}</td>
                    <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{r.title}</td>
                    <td className="dim">{r.category || '—'}</td>
                    <td><Badge label={r.urgency || 'Normal'} tone={urgencyTone(r.urgency)} dot /></td>
                    {/* An itemised request shows its line count; a prose request has none, and
                        the dash is the point — it is how the queue tells the two apart. */}
                    <td className="num mono">{r.line_count > 0 ? r.line_count : <span className="dim">—</span>}</td>
                    <td className="num mono">{r.estimated_cost != null ? inr(r.estimated_cost) : '—'}</td>
                    <td className="dim">{r.requested_by_name || '—'}</td>
                    <td className="mono dim">{fmtDateShort(r.created_at)}</td>
                    <td>
                      <Badge label={r.status} tone={REQUEST_TONES[r.status] || 'gray'} />
                      {r.status === 'approved' && r.linked_po_number && <span className="pay-to"> · {r.linked_po_number}</span>}
                    </td>
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
