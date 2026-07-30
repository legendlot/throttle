'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { Download } from 'lucide-react';
import { inputStyle, selectStyle, labelStyle } from '@/lib/snorkelui';
import { paymentMeta, PAYMENT_MODES, inr, csvCell } from '@/lib/sales';
import { PageHead, Kpi, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inrCompact, TONES } from '@/components/format.js';

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
  const [pay, setPay] = useState(null);
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
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  const filtered = overdueOnly ? rows.filter(r => r.overdue) : rows;
  const totalOutstanding = rows.reduce((s, r) => s + Number(r.balance || 0), 0);
  const totalOverdue = rows.filter(r => r.overdue).reduce((s, r) => s + Number(r.balance || 0), 0);
  const partnersOwing = new Set(rows.map(r => r.partner_name)).size;

  const buckets = [
    { label: 'Current', tone: 'green', val: rows.filter(r => (daysOverdue(r.due_date) || 0) <= 0).reduce((s, r) => s + Number(r.balance || 0), 0) },
    { label: '1–30 days', tone: 'yellow', val: rows.filter(r => { const d = daysOverdue(r.due_date) || 0; return d > 0 && d <= 30; }).reduce((s, r) => s + Number(r.balance || 0), 0) },
    { label: '30+ days', tone: 'red', val: rows.filter(r => (daysOverdue(r.due_date) || 0) > 30).reduce((s, r) => s + Number(r.balance || 0), 0) },
  ];
  const maxB = Math.max(...buckets.map(b => b.val), 1);

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
    a.href = url; a.download = `lot-collections-${todayStr()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pg">
      <PageHead title="Collections" sub="Outstanding balances on offline orders, oldest first."
        actions={<Btn onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export</Btn>} />

      <div className="kpi-row kpi-3">
        <Kpi label="Outstanding" value={totalOutstanding} sub={`${rows.length} open invoices`} tone="yellow" format={(v) => inrCompact(v)} />
        <Kpi label="Overdue" value={totalOverdue} sub="past due date" tone="red" format={(v) => inrCompact(v)} />
        <Kpi label="Partners owing" value={partnersOwing} sub="to chase" tone="blue" />
      </div>

      <Panel title="Ageing" pad>
        <div className="age-buckets">
          {buckets.map(b => (
            <div className="age-b" key={b.label}>
              <div className="age-head"><span className="age-lbl">{b.label}</span><span className="age-val mono" style={{ color: TONES[b.tone].fg }}>{inrCompact(b.val)}</span></div>
              <div className="age-track"><div className="age-fill" style={{ width: (b.val / maxB) * 100 + '%', background: TONES[b.tone].solid }} /></div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Open Invoices" count={filtered.length}
        action={
          <div className="filters">
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={overdueOnly} onChange={e => setOverdueOnly(e.target.checked)} /> Overdue only
            </label>
            <Btn onClick={load} disabled={loading}>Refresh</Btn>
          </div>
        }>
        {pay && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            <div className="mono accent">{pay._order_no}</div>
            <div><label style={labelStyle}>Amount</label><input type="number" style={{ ...inputStyle, width: 120 }} value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} /></div>
            <div><label style={labelStyle}>Date</label><input type="date" style={inputStyle} value={pay.received_date} onChange={e => setPay(p => ({ ...p, received_date: e.target.value }))} /></div>
            <div><label style={labelStyle}>Mode</label><select style={selectStyle} value={pay.mode} onChange={e => setPay(p => ({ ...p, mode: e.target.value }))}>{PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
            <div><label style={labelStyle}>Reference</label><input style={{ ...inputStyle, width: 140 }} value={pay.reference} onChange={e => setPay(p => ({ ...p, reference: e.target.value }))} /></div>
            <Btn kind="primary" onClick={recordPayment} disabled={busy}>Save</Btn>
            <Btn onClick={() => setPay(null)} disabled={busy}>Cancel</Btn>
          </div>
        )}
        {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          : filtered.length === 0 ? <EmptyState icon="party-popper" title="All settled" hint="No outstanding balances right now." />
          : (
            <table className="dt">
              <thead><tr>
                <th>Order</th><th>Invoice</th><th>Partner</th><th className="num">Balance</th><th>Due</th><th className="num">Ageing</th><th>Payment</th><th className="num">Action</th>
              </tr></thead>
              <tbody>
                {filtered.map(o => {
                  const od = daysOverdue(o.due_date);
                  const pm = paymentMeta(o.payment_status);
                  return (
                    <tr key={o.id}>
                      <td className="mono accent row-click" onClick={() => router.push(`/sales/orders/detail?id=${encodeURIComponent(o.id)}`)}>{o.order_no}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{o.invoice_no || '—'}</td>
                      <td>{o.partner_name || '—'}</td>
                      <td className="num mono" style={{ color: 'var(--red-fg)' }}>{inr(o.balance)}</td>
                      <td className="mono dim">{o.due_date ? fmtDateShort(o.due_date) : '—'}</td>
                      <td className="num mono">{od > 0 ? <span style={{ color: 'var(--red-fg)' }}>{od}d over</span> : <span className="dim">on time</span>}</td>
                      <td><Badge label={pm.label} tone={pm.tone} /></td>
                      <td className="num">{canPay && <Btn kind="primary" onClick={() => setPay({ order_id: o.id, _order_no: o.order_no, amount: o.balance, received_date: todayStr(), mode: 'bank', reference: '', note: '' })}>Collect</Btn>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </Panel>
    </div>
  );
}
