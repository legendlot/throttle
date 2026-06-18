'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth, RequireAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { rmb, fmtDate } from '../../../lib/numberToWords.js';
import { DOC_CSS, DocShell, Loading } from '../docShell.js';

function ChinaPoInner() {
  const { session } = useAuth();
  const sp = useSearchParams();
  const id = sp.get('id');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!session || !id) return;
    try { setD(await garageFetch('getPoDoc', { id }, session)); }
    catch (e) { setErr(e?.message || 'Failed to load'); }
  }, [session, id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (d) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [d]);

  if (err) return <DocShell><div style={{ padding: 24, color: '#900' }}>{err}</div></DocShell>;
  if (!d) return <Loading />;

  const { company, vendor, order, lines, totals } = d;
  const cur = order.currency === 'INR' ? '₹' : '¥';
  const money = (n) => cur + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compAddr = [company.line1, company.line2, [company.city, company.state, company.pincode].filter(Boolean).join(', '), company.country].filter(Boolean);

  return (
    <DocShell>
      <div className="doc-title">PURCHASE ORDER</div>
      <table className="meta"><tbody>
        <tr><td><span className="lbl">PO No.</span>{order.po_ref}</td><td><span className="lbl">Order</span>{order.order_no}{order.order_label ? ` · ${order.order_label}` : ''}</td><td><span className="lbl">Date</span>{fmtDate(order.created_at)}</td></tr>
      </tbody></table>

      <div className="parties">
        <div className="party">
          <div className="lbl">Buyer</div>
          <div className="pname">{company.legal_name || 'Legend of Toys Pvt Ltd'}</div>
          {compAddr.map((l, i) => <div key={i}>{l}</div>)}
          {company.gstin && <div>GSTIN: {company.gstin}</div>}
        </div>
        <div className="party">
          <div className="lbl">Supplier</div>
          <div className="pname">{vendor.vendor_name || vendor.vendor_code || '—'}</div>
          {vendor.address && <div>{vendor.address}</div>}
          <div>{[vendor.location, vendor.source_country].filter(Boolean).join(', ') || 'China'}</div>
          {vendor.vendor_code && <div>Vendor code: {vendor.vendor_code}</div>}
        </div>
      </div>

      <table className="lines"><thead>
        <tr><th className="c-no">#</th><th>Vendor code</th><th>Description</th><th className="c-num">Qty</th><th className="c-num">Unit price</th><th className="c-num">Amount</th></tr>
      </thead><tbody>
        {lines.length ? lines.map((l, i) => (
          <tr key={i}><td className="c-no">{i + 1}</td><td>{l.vendor_item_code}</td><td>{l.description}</td>
            <td className="c-num">{Number(l.qty).toLocaleString('en-US')} {l.unit}</td><td className="c-num">{money(l.unit_price)}</td><td className="c-num">{money(l.line_total)}</td></tr>
        )) : <tr><td colSpan={6} style={{ textAlign: 'center', color: '#888' }}>No line items</td></tr>}
      </tbody></table>

      <table className="totals"><tbody>
        <tr><td className="lbl">Subtotal</td><td className="c-num">{money(totals.subtotal)}</td></tr>
        <tr className="grand"><td className="lbl">Grand total ({order.currency || 'CNY'})</td><td className="c-num">{money(totals.grand)}</td></tr>
      </tbody></table>

      {order.incoterms && <div className="terms"><span className="lbl">Incoterms:</span> {order.incoterms}</div>}
      {order.notes && <div className="terms"><span className="lbl">Notes:</span> {order.notes}</div>}
      <div className="foot">System-generated purchase order · no signature required.</div>
      <style>{DOC_CSS}</style>
    </DocShell>
  );
}

export default function Page() {
  return <RequireAuth><Suspense fallback={<Loading />}><ChinaPoInner /></Suspense></RequireAuth>;
}
