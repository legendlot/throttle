'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { inr, amountInWords, fmtDate, creditReasonLabel } from '@/lib/sales';

function money(n) { return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function CreditNoteInner() {
  const { session } = useAuth();
  const id = useSearchParams().get('id');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!session || !id) return;
    try {
      const res = await garageFetch('getCreditNote', { id }, session);
      setD(res || null);
      if (!res) setErr('Credit note not found');
    } catch (e) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (d && d.cn?.status === 'issued') { const t = setTimeout(() => window.print(), 500); return () => clearTimeout(t); }
  }, [d]);

  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (err || !d) return <div style={{ padding: 24, color: 'var(--t3)' }}>{err || 'Not found'}</div>;

  const { cn, partner, order, seller, intra, lines } = d;
  if (cn.status !== 'issued') return <div style={{ padding: 24, color: 'var(--t3)' }}>This credit note is not issued yet.</div>;

  const subtotal = lines.reduce((s, l) => s + Number(l.taxable_value || 0), 0);
  const cgst = lines.reduce((s, l) => s + Number(l.cgst_amount || 0), 0);
  const sgst = lines.reduce((s, l) => s + Number(l.sgst_amount || 0), 0);
  const igst = lines.reduce((s, l) => s + Number(l.igst_amount || 0), 0);
  const grand = Number(cn.grand_total || 0);

  const sellerAddr = seller ? [seller.line1, seller.line2, [seller.city, seller.state, seller.pincode].filter(Boolean).join(', ')].filter(Boolean) : [];
  const shipAddr = partner?.shipping_address || partner?.billing_address;

  return (
    <div className="invoice-root">
      <style>{`
        .invoice-root { background:#fff; color:#111; font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; font-size: 12px; }
        .inv-title { text-align:center; font-size:16px; font-weight:700; letter-spacing:1px; margin-bottom:8px; }
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
        @media print { .print-hint { display:none; } .invoice-root { padding:0; } @page { margin: 12mm; } }
      `}</style>

      <div className="print-hint"><button onClick={() => window.print()} style={{ padding: '6px 16px', cursor: 'pointer' }}>Print</button></div>

      <div className="inv-title">CREDIT NOTE</div>
      <div className="inv-box">
        <div className="inv-row">
          <div className="inv-cell" style={{ flex: 1.4 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{seller?.legal_name || 'Legend of Toys'}</div>
            {sellerAddr.map((l, i) => <div key={i}>{l}</div>)}
            {seller?.gstin && <div><b>GSTIN:</b> {seller.gstin}</div>}
            {seller?.phone && <div>Ph: {seller.phone}</div>}
          </div>
          <div className="inv-cell">
            <div><span className="inv-label">Credit Note No</span><br /><b>{cn.cn_no}</b></div>
            <div style={{ marginTop: 6 }}><span className="inv-label">CN Date</span><br />{fmtDate(cn.cn_date)}</div>
            <div style={{ marginTop: 6 }}><span className="inv-label">Against Invoice</span><br />{cn.invoice_no}{cn.invoice_date ? ` · ${fmtDate(cn.invoice_date)}` : ''}</div>
            <div style={{ marginTop: 6 }}><span className="inv-label">Order No</span><br />{order?.order_no || '—'}</div>
            <div style={{ marginTop: 6 }}><span className="inv-label">Place of Supply</span><br />{cn.place_of_supply || '—'}</div>
            <div style={{ marginTop: 6 }}><span className="inv-label">Reason</span><br />{creditReasonLabel(cn.reason)}</div>
          </div>
        </div>
        <div className="inv-section inv-row">
          <div className="inv-cell">
            <div className="inv-label">Credit To</div>
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
          <div className="totline" style={{ borderTop: '1px solid #333', marginTop: 4, paddingTop: 4, fontSize: 14 }}><span><b>Total Credit</b></span><b>{inr(grand)}</b></div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 11 }}>
        This is a Credit Note issued against Tax Invoice <b>{cn.invoice_no}</b>{cn.invoice_date ? ` dated ${fmtDate(cn.invoice_date)}` : ''}.
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 40 }}>
        <div style={{ fontSize: 10, color: '#666', maxWidth: 360 }}>
          Declaration: We declare that this credit note shows the actual value of the adjustment described and that all particulars are true and correct.
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginTop: 30, borderTop: '1px solid #333', paddingTop: 4 }}>Authorised Signatory</div>
          <div style={{ fontSize: 10, color: '#666' }}>For {seller?.legal_name || 'Legend of Toys'}</div>
        </div>
      </div>
    </div>
  );
}

export default function CreditNotePrintPage() {
  return <Suspense fallback={<div style={{ padding: 40 }}><Spinner /></div>}><CreditNoteInner /></Suspense>;
}
