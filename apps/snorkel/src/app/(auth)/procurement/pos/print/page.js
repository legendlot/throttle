'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { computeTax } from '@/lib/poTax';

// Wrap useSearchParams in Suspense for static-export prerender (BUG-009 pattern).
export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: '#777' }}>Loading…</div>}>
      <PrintPOContent />
    </Suspense>
  );
}

function formatPONumber(po_number, raised_date) {
  if (!po_number) return '';
  const seq = String(po_number).split('-').pop() || '';
  const ym  = (raised_date || '').replace(/-/g, '').substring(0, 6);
  const n   = String(parseInt(seq, 10) || 0).padStart(3, '0');
  if (!ym) return `LOT/PO/${n}`;
  return `LOT/PO/${ym}/${n}`;
}

function formatDdMmYyyy(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = dt.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function currencySymbol(curr) {
  if (curr === 'INR') return '₹';
  if (curr === 'USD') return '$';
  if (curr === 'RMB' || curr === 'CNY') return '¥';
  return curr ? curr + ' ' : '';
}

function fmtMoney(n, curr) {
  const v = Number(n) || 0;
  const sym = currencySymbol(curr);
  return `${sym}${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


function PrintPOContent() {
  const { session } = useAuth();
  const searchParams = useSearchParams();
  const poNumber = searchParams?.get('po_number') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session || !poNumber) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await garageFetch('getPrintPOData', { po_number: poNumber }, session);
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load PO');
      }
    })();
    return () => { cancelled = true; };
  }, [session, poNumber]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => { try { window.print(); } catch {} }, 500);
    return () => clearTimeout(t);
  }, [data]);

  if (!poNumber) return <div style={{ padding: 40, color: '#c33' }}>Missing po_number query parameter.</div>;
  if (error)     return <div style={{ padding: 40, color: '#c33' }}>{error}</div>;
  if (!data)     return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const { po, vendor, company, deliveryAddress, lines, prepared_by_name } = data;
  // China financial-strip — worker sets _china_restricted=true when caller lacks
  // procurement_china on a China-sourced PO. Print renders as a "Receiving Copy"
  // with all unit_price / line_total / tax / payment_terms fields omitted.
  const chinaRestricted = !!data._china_restricted;
  const tax = chinaRestricted
    ? { showGst: false, isCgstSgst: false, halfRate: 0, fullRate: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, grand: 0 }
    : computeTax(lines || [], po.currency, vendor?.gstin || null, company?.gstin || null);
  const formattedPo = formatPONumber(po.po_number, po.raised_date);

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 15mm; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          /* Nuclear hide: hide everything, then reveal only the PO document */
          body * { visibility: hidden !important; }
          .po-print, .po-print * { visibility: visible !important; }
          /* Lift the PO document to page top so hidden ancestors don't reserve space */
          .po-print {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
          }
          .no-print { display: none !important; }
        }
        .po-print, .po-print * {
          color: #000;
          font-family: Arial, Helvetica, sans-serif;
        }
        .po-print {
          background: #fff;
          color: #000;
          max-width: 210mm;
          margin: 0 auto;
          padding: 16mm 14mm;
          box-shadow: 0 0 24px rgba(0,0,0,0.15);
        }
        .po-print h1, .po-print h2, .po-print h3 { margin: 0; }
        .po-print table { width: 100%; border-collapse: collapse; }
        .po-print table.lines th, .po-print table.lines td {
          border: 1px solid #000;
          padding: 6px 8px;
          font-size: 11px;
          vertical-align: top;
        }
        .po-print table.lines th { background: #f0f0f0; font-weight: 700; text-align: left; }
        .po-print .num { text-align: right; font-variant-numeric: tabular-nums; }
        .po-print .center { text-align: center; }
        .po-print hr { border: none; border-top: 1px solid #000; margin: 10px 0; }
      `}</style>

      <div className="no-print" style={{ background: '#f3f3f3', padding: 8, textAlign: 'right' }}>
        <button onClick={() => window.print()} style={{ padding: '6px 14px', cursor: 'pointer' }}>Print</button>
        <button onClick={() => window.close()} style={{ padding: '6px 14px', marginLeft: 6, cursor: 'pointer' }}>Close</button>
      </div>

      <div className="po-print">
        {/* Header: logo left, company-right */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <img src="/lot-logo.png" alt="Logo" style={{ width: 80, height: 80, objectFit: 'contain' }} />
          <div style={{ textAlign: 'right', fontSize: 11, lineHeight: 1.4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{company?.legal_name || ''}</div>
            <div>{company?.line1}</div>
            {company?.line2 && <div>{company.line2}</div>}
            <div>{[company?.city, company?.state, company?.pincode].filter(Boolean).join(', ')}</div>
            {company?.phone && <div>{company.phone}</div>}
            {company?.email && <div>{company.email}</div>}
            {company?.gstin && <div>GSTIN: {company.gstin}</div>}
          </div>
        </div>

        <h1 style={{ fontSize: 16, textTransform: 'uppercase', textAlign: 'center', letterSpacing: 2, textDecoration: 'underline', marginTop: 14, marginBottom: 10 }}>
          Purchase Order
        </h1>

        {/* PO number + date row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
          <span><strong>PO Number:</strong> {formattedPo}</span>
          <span><strong>Date:</strong> {formatDdMmYyyy(po.raised_date)}</span>
        </div>
        {po.revision > 0 && (
          <div style={{ fontSize: 11, marginBottom: 8 }}>
            <strong>Revision:</strong> {po.revision}
          </div>
        )}
        {chinaRestricted && (
          <div style={{
            border: '1px solid #000', padding: '6px 10px', marginBottom: 10,
            fontSize: 11, fontWeight: 700, textAlign: 'center', textTransform: 'uppercase',
          }}>
            Receiving Copy — financial details restricted to procurement
          </div>
        )}

        <hr />

        {/* Vendor + Company two-column */}
        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr>
              <td style={{ width: '50%', verticalAlign: 'top', paddingRight: 14, fontSize: 11, lineHeight: 1.45 }}>
                <div style={{ fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', fontSize: 10 }}>To: Vendor / Supplier</div>
                <div style={{ fontWeight: 700 }}>{vendor?.vendor_name || po.vendor_name}</div>
                {vendor?.address && <div style={{ whiteSpace: 'pre-line' }}>{vendor.address}</div>}
                {vendor?.contact_name && <div>Attn: {vendor.contact_name}</div>}
                {vendor?.contact_phone && <div>{vendor.contact_phone}</div>}
                {vendor?.gstin && <div>GSTIN: {vendor.gstin}</div>}
              </td>
              <td style={{ width: '50%', verticalAlign: 'top', paddingLeft: 14, fontSize: 11, lineHeight: 1.45, borderLeft: '1px solid #000' }}>
                <div style={{ fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', fontSize: 10 }}>Company Name</div>
                <div style={{ fontWeight: 700 }}>{company?.legal_name}</div>
                <div>{company?.line1}</div>
                {company?.line2 && <div>{company.line2}</div>}
                <div>{[company?.city, company?.state, company?.pincode].filter(Boolean).join(', ')}</div>
                {company?.gstin && <div>GSTIN: {company.gstin}</div>}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Line items table */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Order Details</div>
        <table className="lines">
          <thead>
            <tr>
              <th className="center" style={{ width: 30 }}>S.No</th>
              <th>Particulars</th>
              {tax.showGst && <th style={{ width: 60 }}>HSN</th>}
              {tax.showGst && <th className="num" style={{ width: 50 }}>GST %</th>}
              <th className="num" style={{ width: 60 }}>Qty</th>
              <th style={{ width: 50 }}>Unit</th>
              {!chinaRestricted && <th className="num" style={{ width: 80 }}>Rate</th>}
              {!chinaRestricted && <th className="num" style={{ width: 100 }}>Amount</th>}
            </tr>
          </thead>
          <tbody>
            {(lines || []).map((l, i) => {
              const amount = parseFloat(l.total_value || (parseFloat(l.qty_ordered) || 0) * (parseFloat(l.unit_price) || 0));
              return (
                <tr key={l.id ?? i}>
                  <td className="center">{i + 1}</td>
                  <td>{l.description || l.part_code || ''}</td>
                  {tax.showGst && <td>{l.hsn_code || ''}</td>}
                  {tax.showGst && <td className="num">{l.gst_percent != null ? `${parseFloat(l.gst_percent)}%` : ''}</td>}
                  <td className="num">{Number(l.qty_ordered || 0).toLocaleString('en-IN')}</td>
                  <td>{l.unit || ''}</td>
                  {!chinaRestricted && <td className="num">{l.unit_price != null ? fmtMoney(l.unit_price, po.currency) : ''}</td>}
                  {!chinaRestricted && <td className="num">{fmtMoney(amount, po.currency)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Tax summary, right-aligned. Hidden entirely for China-restricted prints. */}
        {!chinaRestricted && (
        <table style={{ marginTop: 10 }}>
          <tbody>
            <tr>
              <td style={{ width: '60%' }}></td>
              <td style={{ width: '40%' }}>
                <table style={{ width: '100%', fontSize: 11 }}>
                  <tbody>
                    <tr>
                      <td>Total Taxable Value</td>
                      <td className="num">{fmtMoney(tax.taxable, po.currency)}</td>
                    </tr>
                    {tax.showGst && tax.isCgstSgst && (
                      <>
                        <tr>
                          <td>CGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</td>
                          <td className="num">{fmtMoney(tax.cgst, po.currency)}</td>
                        </tr>
                        <tr>
                          <td>SGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</td>
                          <td className="num">{fmtMoney(tax.sgst, po.currency)}</td>
                        </tr>
                      </>
                    )}
                    {tax.showGst && !tax.isCgstSgst && (
                      <tr>
                        <td>IGST {tax.fullRate > 0 ? `@ ${tax.fullRate}%` : ''}</td>
                        <td className="num">{fmtMoney(tax.igst, po.currency)}</td>
                      </tr>
                    )}
                    <tr style={{ fontWeight: 700, fontSize: 12, borderTop: '2px solid #000' }}>
                      <td style={{ borderTop: '1px solid #000', paddingTop: 4 }}>Grand Total</td>
                      <td className="num" style={{ borderTop: '1px solid #000', paddingTop: 4 }}>{fmtMoney(tax.grand, po.currency)}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
        )}

        {/* Delivery address + notes block */}
        <div style={{ marginTop: 16, fontSize: 11, lineHeight: 1.45 }}>
          <div style={{ fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', fontSize: 10 }}>Delivery Address</div>
          {deliveryAddress ? (
            <>
              <div>{deliveryAddress.legal_name}</div>
              <div>{deliveryAddress.line1}</div>
              {deliveryAddress.line2 && <div>{deliveryAddress.line2}</div>}
              <div>{[deliveryAddress.city, deliveryAddress.state, deliveryAddress.pincode].filter(Boolean).join(', ')}</div>
            </>
          ) : <div>—</div>}
          {po.notes && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', fontSize: 10 }}>Notes</div>
              <div style={{ whiteSpace: 'pre-line' }}>{po.notes}</div>
            </div>
          )}
        </div>

        {/* Prepared-by footer. ⚠️ This used to be `pageBreakBefore: 'always'` — "signature
            block on its own page" — which forced a SECOND PAGE carrying nothing but
            "Prepared by: <name>" on every single-page PO. Found 2026-09-04 (S344) when the
            same markup was rendered to a real PDF and the blank page became obvious; it had
            been in every printed PO until then. Now it simply follows the content and is
            kept intact if a genuinely long PO does break across pages.
            ⚠️ Mirrored in snorkelops-worker/src/index.js `poPrintHtml` — change both. */}
        <div style={{ pageBreakInside: 'avoid', marginTop: 28 }}>
          <table style={{ marginTop: 40 }}>
            <tbody>
              <tr>
                <td style={{ width: '60%', verticalAlign: 'bottom', fontSize: 11 }}></td>
                <td style={{ width: '40%', verticalAlign: 'bottom', fontSize: 11, textAlign: 'right' }}>
                  <div style={{ marginBottom: 4 }}>Prepared by:</div>
                  <div style={{ fontWeight: 700 }}>{prepared_by_name || po.raised_by || ''}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
