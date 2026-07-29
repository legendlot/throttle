'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { panelStyle, panelHeaderStyle, panelBodyStyle, btnPrimary, btnSecondary, tableThStyle, tableTdStyle, labelStyle, fmtDate } from '@/lib/snorkelui';
import { inr, creditReasonLabel, cnStatusLabel } from '@/lib/sales';

const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function CreditNoteDetailInner() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const canManage = !!perms?.sales_credit_note;

  const load = useCallback(async () => {
    if (!session || !id) return;
    setLoading(true);
    try { setD(await garageFetch('getCreditNote', { id }, session)); }
    catch (e) { showToast(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [session, id, showToast]);
  useEffect(() => { load(); }, [load]);

  async function act(action, body, okMsg) {
    setBusy(true);
    try {
      const res = await workerFetch(action, { id, ...body }, session);
      if (res?.ok) { showToast(okMsg, 'success'); return res; }
      showToast(res?.error || 'Action failed', 'error');
    } catch (e) { showToast(e.message || 'Action failed', 'error'); }
    finally { setBusy(false); }
    return null;
  }

  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!d?.cn) return <div style={{ padding: 24, color: 'var(--t3)' }}>Credit note not found.</div>;

  const { cn, partner, order, intra, lines } = d;
  const isDraft = cn.status === 'draft', isIssued = cn.status === 'issued';
  const netDue = order ? +(Number(order.grand_total) - Number(order.credit_total) - Number(order.amount_received)).toFixed(2) : null;

  async function onIssue() {
    if (!confirm('Issue this credit note? It will get a GST number and reduce the order receivable.')) return;
    const r = await act('issueCreditNote', {}, 'Credit note issued'); if (r) load();
  }
  async function onCancel() {
    const reason = prompt('Reason for cancelling this credit note:'); if (!reason) return;
    const r = await act('cancelCreditNote', { reason }, 'Credit note cancelled'); if (r) load();
  }
  async function onDelete() {
    if (!confirm('Delete this draft credit note?')) return;
    const r = await act('deleteCreditNote', {}, 'Deleted'); if (r) router.push('/sales/credit-notes');
  }

  const Cell = ({ children, r }) => <td style={{ ...tableTdStyle, textAlign: r ? 'right' : 'left', fontFamily: r ? 'var(--mono)' : undefined }}>{children}</td>;

  return (
    <div className="pg">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 12px', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>{cn.cn_no || 'Draft credit note'} <span style={{ fontSize: 13, color: 'var(--t3)' }}>· {cnStatusLabel(cn.status)}</span></h2>
          <div style={{ fontSize: 12, color: 'var(--t2)' }}>Against invoice <b>{cn.invoice_no}</b>{cn.invoice_date ? ` dated ${fmtDate(cn.invoice_date)}` : ''}{order ? ` · order ${order.order_no}` : ''}</div>
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8 }}>
            {isDraft && <><Link href={`/sales/credit-notes/new?id=${cn.id}`}><button style={btnSecondary}>Edit</button></Link>
              <button style={btnPrimary} onClick={onIssue} disabled={busy}>Issue</button>
              <button style={{ ...btnSecondary, color: '#ff7070' }} onClick={onDelete} disabled={busy}>Delete</button></>}
            {isIssued && <><Link href={`/sales/credit-notes/print?id=${cn.id}`} target="_blank"><button style={btnPrimary}>Print</button></Link>
              <button style={{ ...btnSecondary, color: '#ff7070' }} onClick={onCancel} disabled={busy}>Cancel</button></>}
          </div>
        )}
      </div>

      <div style={panelStyle}>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, fontSize: 13 }}>
            <div><div style={labelStyle}>Partner</div>{partner?.name || '—'}{partner?.gstin ? <div style={{ fontSize: 11, color: 'var(--t3)' }}>{partner.gstin}</div> : null}</div>
            <div><div style={labelStyle}>Reason</div>{creditReasonLabel(cn.reason)}{cn.reason_note ? <div style={{ fontSize: 11, color: 'var(--t3)' }}>{cn.reason_note}</div> : null}</div>
            <div><div style={labelStyle}>CN date</div>{fmtDate(cn.cn_date)}</div>
            <div><div style={labelStyle}>Place of supply</div>{cn.place_of_supply || '—'} <span style={{ color: 'var(--t3)' }}>({intra ? 'intra' : 'inter'}-state)</span></div>
          </div>
          {order && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bd)', display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--t3)' }}>Invoice total <b style={{ color: 'var(--t1)' }}>{inr(order.grand_total)}</b></span>
              <span style={{ color: 'var(--t3)' }}>Credits (issued) <b style={{ color: 'var(--t1)' }}>{inr(order.credit_total)}</b></span>
              <span style={{ color: 'var(--t3)' }}>Received <b style={{ color: 'var(--t1)' }}>{inr(order.amount_received)}</b></span>
              <span style={{ color: 'var(--t3)' }}>Net due after credits <b style={{ color: 'var(--yellow)' }}>{inr(netDue)}</b></span>
            </div>
          )}
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Lines</span></div>
        <div style={{ padding: '0 16px 12px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['#', 'Item', 'HSN', 'Qty', 'Rate', 'Taxable', ...(intra ? ['CGST', 'SGST'] : ['IGST']), 'Total'].map((h, i) => (
                <th key={i} style={{ ...tableThStyle, textAlign: i === 0 || i === 1 || i === 2 ? 'left' : 'right' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id || i}>
                  <Cell r>{i + 1}</Cell>
                  <Cell>{[l.product, l.model, l.color].filter(Boolean).join(' ') || l.description || '—'}</Cell>
                  <Cell>{l.hsn_code || '—'}</Cell>
                  <Cell r>{l.qty}</Cell>
                  <Cell r>{money(l.rate)}</Cell>
                  <Cell r>{money(l.taxable_value)}</Cell>
                  {intra
                    ? <><Cell r>{money(l.cgst_amount)}</Cell><Cell r>{money(l.sgst_amount)}</Cell></>
                    : <Cell r>{money(l.igst_amount)}</Cell>}
                  <Cell r>{money(l.line_total)}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginTop: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--t3)' }}>Taxable <b style={{ color: 'var(--t1)' }}>{inr(cn.subtotal)}</b></span>
            <span style={{ color: 'var(--t3)' }}>GST <b style={{ color: 'var(--t1)' }}>{inr(cn.tax_total)}</b></span>
            <span style={{ color: 'var(--t3)' }}>Total credit <b style={{ color: 'var(--yellow)' }}>{inr(cn.grand_total)}</b></span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CreditNoteDetailPage() {
  return <Suspense fallback={<div style={{ padding: 40 }}><Spinner /></div>}><CreditNoteDetailInner /></Suspense>;
}
