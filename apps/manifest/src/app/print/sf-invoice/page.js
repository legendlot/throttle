'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth, RequireAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { inr, fmtDate, amountInWords } from '../../../lib/numberToWords.js';
import { DOC_CSS, DocShell, Loading } from '../docShell.js';

function SfInvoiceInner() {
  const { session } = useAuth();
  const sp = useSearchParams();
  const id = sp.get('id');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!session || !id) return;
    try { setD(await garageFetch('getInvoiceDoc', { id }, session)); }
    catch (e) { setErr(e?.message || 'Failed to load'); }
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (d) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [d]);

  if (err) return <DocShell><div style={{ padding: 24, color: '#900' }}>{err}</div></DocShell>;
  if (!d) return <Loading />;

  const { seller, buyer, invoice, costLines, taxable, gst, commission, goods_total, grand_total } = d;
  const buyerAddr = [buyer.line1, buyer.line2, [buyer.city, buyer.state, buyer.pincode].filter(Boolean).join(', '), buyer.country].filter(Boolean);

  return (
    <DocShell>
      <div className="doc-title">TAX INVOICE</div>
      <table className="meta"><tbody>
        <tr>
          <td><span className="lbl">Invoice No.</span>{invoice.invoice_no}</td>
          <td><span className="lbl">Invoice Date</span>{fmtDate(invoice.invoice_date)}</td>
          <td><span className="lbl">Against Order</span>{invoice.order_no}{invoice.order_label ? ` · ${invoice.order_label}` : ''}</td>
        </tr>
      </tbody></table>

      <div className="parties">
        <div className="party">
          <div className="lbl">Seller</div>
          <div className="pname">{seller.name || 'Solve Factory'}</div>
          <div>Solve Factory{seller.code && seller.name !== 'Solve Factory' ? ` · ${seller.code}` : ''}</div>
        </div>
        <div className="party">
          <div className="lbl">Bill to</div>
          <div className="pname">{buyer.legal_name || 'Legend of Toys Pvt Ltd'}</div>
          {buyerAddr.map((l, i) => <div key={i}>{l}</div>)}
          {buyer.gstin && <div>GSTIN: {buyer.gstin}</div>}
        </div>
      </div>

      <table className="lines"><thead>
        <tr><th className="c-no">#</th><th>Particulars</th><th className="c-num">Amount (₹)</th></tr>
      </thead><tbody>
        {costLines.map((l, i) => (
          <tr key={i}><td className="c-no">{i + 1}</td><td>{l.label}</td><td className="c-num">{inr(l.amt)}</td></tr>
        ))}
      </tbody></table>

      <table className="totals"><tbody>
        <tr><td className="lbl">Taxable value</td><td className="c-num">{inr(taxable)}</td></tr>
        {gst.inr > 0 && <tr><td className="lbl">IGST{gst.percent ? ` @ ${gst.percent}%` : ''}</td><td className="c-num">{inr(gst.inr)}</td></tr>}
        <tr><td className="lbl">Goods total</td><td className="c-num">{inr(goods_total)}</td></tr>
        {commission && commission.inr > 0 && <tr><td className="lbl">SF commission @ {commission.rate}% (incl. GST)</td><td className="c-num">{inr(commission.inr)}</td></tr>}
        <tr className="grand"><td className="lbl">Grand total</td><td className="c-num">{inr(grand_total)}</td></tr>
      </tbody></table>

      <div className="words"><span className="lbl">Amount in words</span>{amountInWords(grand_total)}</div>
      <div className="foot">System-generated tax invoice · GST on goods shown as IGST (single line); commission is GST-inclusive.</div>
      <style>{DOC_CSS}</style>
    </DocShell>
  );
}

export default function Page() {
  return <RequireAuth><Suspense fallback={<Loading />}><SfInvoiceInner /></Suspense></RequireAuth>;
}
