'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, tableThStyle, tableTdStyle, btnPrimary, btnSecondary,
  pageH1, pageSub, tabBtn, fmtDate, StatusBadge,
} from '@/lib/snorkelui';

const PAY_TONE = { none: 'gray', requested: 'yellow', paid: 'green' };

export default function PaymentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('to_route');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getPaymentQueue', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load payment queue', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  async function route(po, to) {
    setBusy(po);
    try {
      await workerFetch('routePayment', { data: { po_number: po, route_to: to } }, session);
      showToast(`Payment requested from ${to}`, 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(null); }
  }
  async function markPaid(po) {
    setBusy(po);
    try {
      await workerFetch('markPaid', { data: { po_number: po } }, session);
      showToast(`${po} marked paid`, 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(null); }
  }

  const canPay = !!perms?.payment_route;
  const filtered = rows.filter((r) => {
    const ps = r.payment_status || 'none';
    if (tab === 'to_route') return ps === 'none';
    if (tab === 'requested') return ps === 'requested';
    if (tab === 'paid')      return ps === 'paid';
    return true;
  });
  const count = (s) => rows.filter((r) => (r.payment_status || 'none') === s).length;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Payment Queue</h1>
        <p style={pageSub}>Approved POs — route payment to Finance or the Requester, then mark paid.</p>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button style={tabBtn(tab === 'to_route')} onClick={() => setTab('to_route')}>To Route ({count('none')})</button>
        <button style={tabBtn(tab === 'requested')} onClick={() => setTab('requested')}>Requested ({count('requested')})</button>
        <button style={tabBtn(tab === 'paid')} onClick={() => setTab('paid')}>Paid ({count('paid')})</button>
        <button style={tabBtn(tab === 'all')} onClick={() => setTab('all')}>All ({rows.length})</button>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Approved POs</span>
          <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Nothing here.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>PO</th>
                <th style={tableThStyle}>Vendor</th>
                <th style={tableThStyle}>Value</th>
                <th style={tableThStyle}>Approved</th>
                <th style={tableThStyle}>Payment</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const ps = r.payment_status || 'none';
                  return (
                    <tr key={r.po_number}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', cursor: 'pointer' }}
                          onClick={() => router.push(`/procurement/pos/detail/?po_number=${encodeURIComponent(r.po_number)}`)}>
                        {r.po_number}
                      </td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{r.vendor_name}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                        {r.invoice_value != null ? `${r.currency || ''} ${Number(r.invoice_value).toLocaleString('en-IN')}` : '—'}
                      </td>
                      <td style={tableTdStyle}>{fmtDate(r.approved_at)}</td>
                      <td style={tableTdStyle}>
                        <StatusBadge label={ps} tone={PAY_TONE[ps]} />
                        {r.payment_routed_to && <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>{r.payment_routed_to}</div>}
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        {canPay && ps === 'none' && (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button style={btnSecondary} disabled={busy === r.po_number} onClick={() => route(r.po_number, 'finance')}>→ Finance</button>
                            <button style={btnSecondary} disabled={busy === r.po_number} onClick={() => route(r.po_number, 'requester')}>→ Requester</button>
                          </div>
                        )}
                        {canPay && ps === 'requested' && (
                          <button style={btnPrimary} disabled={busy === r.po_number} onClick={() => markPaid(r.po_number)}>Mark Paid</button>
                        )}
                        {ps === 'paid' && <span style={{ fontSize: 10, color: 'var(--t3)' }}>{r.paid_by || ''} · {fmtDate(r.paid_at)}</span>}
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
