'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, btnPrimary, btnSecondary,
  pageH1, pageSub, tabBtn, fmtDate, urgencyColor, StatusBadge, REQUEST_TONES,
} from '@/lib/snorkelui';

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
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const filtered = tab === 'all' ? rows : rows.filter((r) => r.status === tab);

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>PO Requests</h1>
          <p style={pageSub}>Anyone at LOT can file a request — procurement turns it into a formal PO.</p>
        </div>
        <button style={btnPrimary} onClick={() => router.push('/requests/new')}>+ New Request</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {STATUS_TABS.map((t) => (
          <button key={t} style={tabBtn(tab === t)} onClick={() => setTab(t)}>
            {t}{t !== 'all' ? ` (${rows.filter((r) => r.status === t).length})` : ` (${rows.length})`}
          </button>
        ))}
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Requests</span>
          <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No requests in this view.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Request</th>
                <th style={tableThStyle}>Title</th>
                <th style={tableThStyle}>Category</th>
                <th style={tableThStyle}>Urgency</th>
                <th style={tableThStyle}>Est. Cost</th>
                <th style={tableThStyle}>Requested By</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Status</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.request_no}
                      style={{ cursor: 'pointer' }}
                      onClick={() => router.push(`/requests/detail/?request_no=${encodeURIComponent(r.request_no)}`)}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.request_no}</td>
                    <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 320 }}>{r.title}</td>
                    <td style={tableTdStyle}>{r.category || '—'}</td>
                    <td style={{ ...tableTdStyle, color: urgencyColor(r.urgency), fontWeight: 600 }}>{r.urgency || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                      {r.estimated_cost != null ? `${r.currency || ''} ${Number(r.estimated_cost).toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td style={tableTdStyle}>{r.requested_by_name || '—'}</td>
                    <td style={tableTdStyle}>{fmtDate(r.created_at)}</td>
                    <td style={tableTdStyle}>
                      <StatusBadge label={r.status} tone={REQUEST_TONES[r.status] || 'gray'} />
                      {r.status === 'approved' && r.linked_po_number && (
                        <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{r.linked_po_number}</div>
                      )}
                    </td>
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
