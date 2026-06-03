'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, tableThStyle, tableTdStyle, inputStyle, selectStyle, labelStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge, fmtDate,
} from '@/lib/snorkelui';
import { paymentMeta, PAYMENT_MODES, inr, csvCell } from '@/lib/sales';

function daysOverdue(due) {
  if (!due) return null;
  const d = Math.floor((Date.now() - new Date(due + 'T00:00:00').getTime()) / 86400000);
  return d > 0 ? d : 0;
}

export default function CollectionsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [pay, setPay] = useState(null); // { order_id, amount, received_date, mode, reference, note }
  const [busy, setBusy] = useState(false);

  const canPay = !!perms?.sales_payment_manage;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getSalesCollections', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { showToast(e.message || 'Failed to load collections', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  if (perms && !perms.sales_view && !perms.sales_order_manage && !perms.sales_payment_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const filtered = overdueOnly ? rows.filter(r => r.overdue) : rows;
  const totalOutstanding = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
  const totalOverdue = rows.filter(r => r.overdue).reduce((s, r) => s + Number(r.balance || 0), 0);

  async function recordPayment() {
    if (!pay || !(Number(pay.amount) > 0)) { showToast('Enter an amount', 'error'); return; }
    setBusy(true);
    try {
      const res = await workerFetch('recordSalesPayment', { data: pay }, session);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showToast('Payment recorded', 'success');
      setPay(null);
      await load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  function exportCsv() {
    const cols = ['Order', 'Invoice', 'Partner', 'Grand Total', 'Received', 'Balance', 'Due', 'Days Overdue'];
    const lines = [cols.join(',')];
    for (const o of filtered) lines.push([o.order_no, o.invoice_no, o.partner_name, o.grand_total,
      o.amount_received, o.balance, o.due_date, daysOverdue(o.due_date) ?? ''].map(csvCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `lot-collections-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={pageH1}>Collections</h1>
          <p style={pageSub}>Invoiced orders with an outstanding balance. Overdue first.</p>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
          <div style={{ textAlign: 'right' }}><div style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 900 }}>{inr(totalOutstanding)}</div><div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase' }}>Outstanding</div></div>
          <div style={{ textAlign: 'right' }}><div style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 900, color: '#ff7070' }}>{inr(totalOverdue)}</div><div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase' }}>Overdue</div></div>
          <button style={btnSecondary} onClick={exportCsv} disabled={!filtered.length}>↓ CSV</button>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Outstanding ({filtered.length})</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t2)', fontFamily: 'var(--mono)', cursor: 'pointer' }}>
              <input type="checkbox" checked={overdueOnly} onChange={e => setOverdueOnly(e.target.checked)} /> Overdue only
            </label>
            <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
          </div>
        </div>
        {pay && (
          <div style={{ ...panelBodyStyle, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{pay._order_no}</div>
            <div><label style={labelStyle}>Amount</label><input type="number" style={{ ...inputStyle, width: 120 }} value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} /></div>
            <div><label style={labelStyle}>Date</label><input type="date" style={inputStyle} value={pay.received_date} onChange={e => setPay(p => ({ ...p, received_date: e.target.value }))} /></div>
            <div><label style={labelStyle}>Mode</label><select style={selectStyle} value={pay.mode} onChange={e => setPay(p => ({ ...p, mode: e.target.value }))}>{PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
            <div><label style={labelStyle}>Reference</label><input style={{ ...inputStyle, width: 140 }} value={pay.reference} onChange={e => setPay(p => ({ ...p, reference: e.target.value }))} /></div>
            <button style={btnPrimary} onClick={recordPayment} disabled={busy}>Save</button>
            <button style={btnSecondary} onClick={() => setPay(null)} disabled={busy}>Cancel</button>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>Nothing outstanding 🎉</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Order</th><th style={tableThStyle}>Invoice</th><th style={tableThStyle}>Partner</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Total</th><th style={{ ...tableThStyle, textAlign: 'right' }}>Received</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}>Balance</th><th style={tableThStyle}>Due</th><th style={tableThStyle}>Payment</th><th style={tableThStyle}></th>
              </tr></thead>
              <tbody>
                {filtered.map(o => {
                  const od = daysOverdue(o.due_date);
                  const pm = paymentMeta(o.payment_status);
                  return (
                    <tr key={o.id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)', cursor: 'pointer' }} onClick={() => router.push(`/sales/orders/detail?id=${encodeURIComponent(o.id)}`)}>{o.order_no}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{o.invoice_no || '—'}</td>
                      <td style={tableTdStyle}>{o.partner_name || '—'}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{inr(o.grand_total)}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)' }}>{inr(o.amount_received)}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: '#ff7070' }}>{inr(o.balance)}</td>
                      <td style={tableTdStyle}>{o.due_date ? <span style={{ color: o.overdue ? '#ff7070' : 'var(--t2)' }}>{fmtDate(o.due_date)}{od ? ` · ${od}d` : ''}</span> : '—'}</td>
                      <td style={tableTdStyle}><StatusBadge label={pm.label} tone={pm.tone} /></td>
                      <td style={tableTdStyle}>{canPay && <button style={btnSecondary} onClick={() => setPay({ order_id: o.id, _order_no: o.order_no, amount: o.balance, received_date: new Date().toISOString().slice(0, 10), mode: 'bank', reference: '', note: '' })}>Record</button>}</td>
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
