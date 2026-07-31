'use client';
/*
   ORDER CONFIRMATION (proforma) — Snorkel sales.

   Distinct from /sales/orders/invoice on purpose. RULE-SNORKEL-004 sequences an
   order confirm -> pushed to dispatch -> GST invoice generated, so there is a real
   window where the order is with Depot but no tax invoice exists yet. Vinayram
   asked for a document he can send in exactly that window (#bugs 1785489123.908429),
   which the invoice page cannot serve because it hard-gates on invoice_generated.

   This is NOT a tax invoice and says so on its face — printing a GST-invoice
   lookalike before the invoice is raised would be a compliance problem, and the
   real invoice_no does not exist yet to put on it.

   Reuses getSalesInvoiceData verbatim (that action never required invoice_generated;
   only the invoice PAGE did), so there is no second read path to keep in step.
*/
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { inr, amountInWords } from '@/lib/sales';
import { fmtDate } from '@/lib/snorkelui';   // NOT '@/lib/sales' — it has never exported fmtDate

function money(n) { return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// upi://pay deep link. Rendered ONLY when a upi_id is seeded on the default bank
// row, so an unseeded table simply omits the QR rather than drawing a broken one.
function upiPayload(bank, seller, order) {
  if (!bank?.upi_id) return null;
  const p = new URLSearchParams({
    pa: bank.upi_id,
    pn: bank.legal_name || seller?.legal_name || 'Legend of Toys',
    am: Number(order?.grand_total || 0).toFixed(2),
    cu: 'INR',
    tn: order?.order_no || '',
  });
  return `upi://pay?${p.toString()}`;
}

function ConfirmationInner() {
  const { session } = useAuth();
  const sp = useSearchParams();
  const id = sp.get('id');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!session || !id) return;
    try {
      const res = await garageFetch('getSalesInvoiceData', { id }, session);
      setD(res || null);
      if (!res) setErr('Order not found');
    } catch (e) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [session, id]);

  useEffect(() => { load(); }, [load]);

  const qr = d ? upiPayload(d.bank, d.seller, d.order) : null;

  // CDN qrcodejs in-page — the same no-npm-dep pattern the asset labels and
  // operator badges already use (apps/snorkel/src/lib/assets.js).
  useEffect(() => {
    if (!qr) return;
    const el = document.getElementById('so-qr');
    if (!el) return;
    const draw = () => {
      try { el.innerHTML = ''; new window.QRCode(el, { text: qr, width: 108, height: 108, correctLevel: window.QRCode.CorrectLevel.M }); }
      catch { el.textContent = 'QR unavailable'; }
    };
    if (window.QRCode) { draw(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = draw;
    s.onerror = () => { el.textContent = 'QR unavailable'; };
    document.body.appendChild(s);
  }, [qr]);

  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (err || !d) return <div style={{ padding: 24, color: 'var(--t3)' }}>{err || 'Not found'}</div>;

  const { order, partner, seller, bank, intra, lines } = d;
  if (order.status === 'draft') {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>This order is still a draft. Confirm it first — the confirmation document is available once the order is pushed to dispatch.</div>;
  }
  if (order.status === 'cancelled') {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>This order is cancelled.</div>;
  }

  const subtotal = lines.reduce((s, l) => s + Number(l.taxable_value || 0), 0);
  const cgst = lines.reduce((s, l) => s + Number(l.cgst_amount || 0), 0);
  const sgst = lines.reduce((s, l) => s + Number(l.sgst_amount || 0), 0);
  const igst = lines.reduce((s, l) => s + Number(l.igst_amount || 0), 0);
  const grand = Number(order.grand_total || 0);

  const sellerAddr = seller ? [seller.line1, seller.line2, [seller.city, seller.state, seller.pincode].filter(Boolean).join(', ')].filter(Boolean) : [];
  const shipAddr = partner?.shipping_address || partner?.billing_address;

  return (
    <div className="invoice-root">
      <style>{`
        .invoice-root { background:#fff; color:#111; font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; font-size: 12px; }
        .inv-title { text-align:center; font-size:16px; font-weight:700; letter-spacing:1px; margin-bottom:2px; }
        .inv-sub { text-align:center; font-size:10px; color:#666; margin-bottom:8px; }
        .inv-box { border:1px solid #333; }
        .inv-row { display:flex; }
        .inv-cell { padding:6px 8px; border-right:1px solid #333; flex:1; }
        .inv-cell:last-child { border-right:none; }
        .inv-section { border-top:1px solid #333; }
        .inv-label { font-size:9px; color:#666; text-transform:uppercase; letter-spacing:.05em; }
        table.inv-lines { width:100%; border-collapse:collapse; margin-top:8px; }
        table.inv-lines th, table.inv-lines td { border:1px solid #333; padding:4px 6px; font-size:11px; }
        table.inv-lines th { background:#f0f0f0; text-align:center; }
        .num { text-align:right; font-variant-numeric: tabular-nums; }
        .totline { display:flex; justify-content:space-between; padding:2px 0; }
        .print-hint { text-align:center; margin:16px 0; }
        .pay-box { border:1px solid #333; padding:8px; display:flex; gap:12px; align-items:flex-start; }
        .pay-kv { display:flex; gap:6px; }
        .pay-kv span:first-child { color:#666; min-width:88px; display:inline-block; }
        @media print { .print-hint { display:none; } .invoice-root { padding:0; } @page { margin: 12mm; } }
      `}</style>

      <div className="print-hint">
        <button onClick={() => window.print()} style={{ padding: '6px 16px', cursor: 'pointer' }}>Download PDF</button>
        <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>Choose “Save as PDF” as the destination.</div>
      </div>

      <div className="inv-title">ORDER CONFIRMATION</div>
      <div className="inv-sub">This is not a tax invoice.</div>

      <div className="inv-box">
        <div className="inv-row">
          <div className="inv-cell" style={{ flex: 1.4 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{seller?.legal_name || 'Legend of Toys'}</div>
            {sellerAddr.map((l, i) => <div key={i}>{l}</div>)}
            {seller?.gstin && <div><b>GSTIN:</b> {seller.gstin}</div>}
            {seller?.phone && <div>Ph: {seller.phone}</div>}
          </div>
          <div className="inv-cell">
            <div><span className="inv-label">Order No</span><br /><b>{order.order_no}</b></div>
            <div style={{ marginTop: 6 }}><span className="inv-label">Order Date</span><br />{fmtDate(order.order_date)}</div>
            {order.partner_po_ref && <div style={{ marginTop: 6 }}><span className="inv-label">Your PO Ref</span><br />{order.partner_po_ref}</div>}
            {order.expected_dispatch_date && <div style={{ marginTop: 6 }}><span className="inv-label">Expected Dispatch</span><br />{fmtDate(order.expected_dispatch_date)}</div>}
            <div style={{ marginTop: 6 }}><span className="inv-label">Place of Supply</span><br />{d.place_of_supply || '—'}</div>
          </div>
        </div>
        <div className="inv-section inv-row">
          <div className="inv-cell">
            <div className="inv-label">Bill To</div>
            <div style={{ fontWeight: 700 }}>{partner?.name}</div>
            {partner?.billing_address && <div style={{ whiteSpace: 'pre-line' }}>{partner.billing_address}</div>}
            <div>{[partner?.city, partner?.state, partner?.pincode].filter(Boolean).join(', ')}</div>
            {partner?.gstin && <div><b>GSTIN:</b> {partner.gstin}</div>}
            {partner?.phone && <div>Ph: {partner.phone}</div>}
          </div>
          <div className="inv-cell">
            <div className="inv-label">Ship To</div>
            <div style={{ fontWeight: 700 }}>{partner?.name}</div>
            {shipAddr && <div style={{ whiteSpace: 'pre-line' }}>{shipAddr}</div>}
            <div>{[partner?.city, partner?.state, partner?.pincode].filter(Boolean).join(', ')}</div>
          </div>
        </div>
      </div>

      <table className="inv-lines">
        <thead>
          <tr>
            <th>#</th><th style={{ textAlign: 'left' }}>Description</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Taxable</th>
            {intra ? <><th>CGST</th><th>SGST</th></> : <th>IGST</th>}
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id || i}>
              <td className="num">{i + 1}</td>
              <td>{[l.product, l.model, l.color].filter(Boolean).join(' ') || l.description || '—'}</td>
              <td className="num">{l.hsn_code || '—'}</td>
              <td className="num">{l.qty}</td>
              <td className="num">{money(l.rate)}</td>
              <td className="num">{money(l.taxable_value)}</td>
              {intra ? (
                <><td className="num">{Number(l.cgst_pct) || 0}%<br />{money(l.cgst_amount)}</td><td className="num">{Number(l.sgst_pct) || 0}%<br />{money(l.sgst_amount)}</td></>
              ) : (
                <td className="num">{Number(l.igst_pct) || 0}%<br />{money(l.igst_amount)}</td>
              )}
              <td className="num">{money(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, gap: 24 }}>
        <div style={{ flex: 1.3, border: '1px solid #333', padding: 8 }}>
          <div className="inv-label">Amount in words</div>
          <div style={{ fontWeight: 700 }}>{amountInWords(grand)}</div>
        </div>
        <div style={{ flex: 1, fontSize: 12 }}>
          <div className="totline"><span>Taxable Value</span><b>{money(subtotal)}</b></div>
          {intra ? (
            <><div className="totline"><span>CGST</span><b>{money(cgst)}</b></div><div className="totline"><span>SGST</span><b>{money(sgst)}</b></div></>
          ) : (
            <div className="totline"><span>IGST</span><b>{money(igst)}</b></div>
          )}
          <div className="totline" style={{ borderTop: '1px solid #333', marginTop: 4, paddingTop: 4, fontSize: 14 }}><span><b>Grand Total</b></span><b>{inr(grand)}</b></div>
        </div>
      </div>

      {bank && (
        <div style={{ marginTop: 12 }}>
          <div className="inv-label" style={{ marginBottom: 4 }}>Payment Details</div>
          <div className="pay-box">
            <div style={{ flex: 1 }}>
              {bank.legal_name && <div className="pay-kv"><span>Account Name</span><span><b>{bank.legal_name}</b></span></div>}
              {bank.bank_name  && <div className="pay-kv"><span>Bank</span><span>{bank.bank_name}{bank.branch ? ` — ${bank.branch}` : ''}</span></div>}
              {bank.account_no && <div className="pay-kv"><span>Account No</span><span><b>{bank.account_no}</b></span></div>}
              {bank.ifsc       && <div className="pay-kv"><span>IFSC</span><span><b>{bank.ifsc}</b></span></div>}
              {bank.swift      && <div className="pay-kv"><span>SWIFT</span><span>{bank.swift}</span></div>}
              {bank.upi_id     && <div className="pay-kv"><span>UPI</span><span>{bank.upi_id}</span></div>}
            </div>
            {qr && (
              <div style={{ textAlign: 'center' }}>
                <div id="so-qr" style={{ width: 108, height: 108 }} />
                <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>Scan to pay</div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 32 }}>
        <div style={{ fontSize: 10, color: '#666', maxWidth: 380 }}>
          This document confirms the order recorded above and is not a demand for payment
          under GST. A tax invoice will be issued on dispatch.
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginTop: 30, borderTop: '1px solid #333', paddingTop: 4 }}>Authorised Signatory</div>
          <div style={{ fontSize: 10, color: '#666' }}>For {seller?.legal_name || 'Legend of Toys'}</div>
        </div>
      </div>
    </div>
  );
}

export default function OrderConfirmationPage() {
  return <Suspense fallback={<div style={{ padding: 40 }}><Spinner /></div>}><ConfirmationInner /></Suspense>;
}
