'use client';
/**
 * /dispatch-challans/print?id=<uuid> — print-ready Delivery Challan.
 *
 * A4 portrait, black-on-white, mirrors the LOT_DC022.pdf reference layout:
 *   - Header: LOT logo (right) + company block
 *   - Title: DELIVERY CHALLAN (centered, all caps)
 *   - Company block (legal name + address + GSTIN of dispatcher)
 *   - Challan No / Date / Dispatched To / Dispatched From
 *   - Table: S.No · Description · HSN/SAC · Quantity · Unit · Rate · Amount
 *   - Footer: Taxable Value / GST / Total
 *   - E-Way Bill row appears when applicable
 *
 * Opens in a new tab; window.print() triggered after data loads.
 */
import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';

function inr(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d)) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 32 }}><Spinner /></div>}>
      <PrintInner />
    </Suspense>
  );
}

function PrintInner() {
  const params = useSearchParams();
  const id = params.get('id');
  const { session } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const printed = useRef(false);

  const load = useCallback(async () => {
    if (!id || !session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getDeliveryChallan', { id }, session);
      setData(r);
    } catch (e) {
      // surface in console; print won't proceed
      console.error(e);
    }
    setLoading(false);
  }, [id, session]);

  useEffect(() => { load(); }, [load]);

  // Auto-print once data is ready
  useEffect(() => {
    if (data && !printed.current) {
      printed.current = true;
      setTimeout(() => window.print(), 250);
    }
  }, [data]);

  if (!id) return <div style={{ padding: 32 }}>Missing id.</div>;
  if (loading) return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!data) return <div style={{ padding: 32 }}>Not found.</div>;

  const h = data.header;
  const lines = data.lines || [];

  return (
    <>
      <style jsx global>{`
        @page { size: A4; margin: 14mm 16mm; }
        body { background: #fff !important; color: #000 !important; overflow: visible !important; }
        @media screen {
          body { padding: 24px; }
          .doc { max-width: 800px; margin: 0 auto; background: #fff; padding: 32px; box-shadow: 0 0 0 1px #e5e5e5; }
        }
        @media print {
          /* Defeat the (auth) app-shell's viewport clipping (height:100dvh + overflow:hidden) */
          html, body { height: auto !important; overflow: visible !important; }
          /* Hide the whole app shell (sidebar + topbar + chrome); reveal ONLY the challan */
          body * { visibility: hidden !important; overflow: visible !important; height: auto !important; max-height: none !important; }
          .doc, .doc * { visibility: visible !important; }
          .no-print { display: none !important; }
          /* Pull the document to the page origin so it isn't offset by the (now-hidden) sidebar/topbar */
          .doc {
            position: absolute !important;
            left: 0 !important; top: 0 !important; width: 100% !important;
            box-shadow: none; padding: 0 !important;
          }
        }
        .doc, .doc * {
          color: #000 !important;
          font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif !important;
        }
      `}</style>

      <div className="no-print" style={{ position: 'fixed', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 50 }}>
        <button onClick={() => window.print()}
          style={{ background: '#000', color: '#fff', border: 'none', borderRadius: 4,
                   padding: '8px 16px', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13 }}>
          Print
        </button>
        <button onClick={() => window.close()}
          style={{ background: '#fff', color: '#000', border: '1px solid #ccc', borderRadius: 4,
                   padding: '8px 16px', cursor: 'pointer', fontFamily: 'sans-serif', fontSize: 13 }}>
          Close
        </button>
      </div>

      <div className="doc">
        {/* Top company strip */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
          <div style={{ width: 110 }}>
            {/* LOT logo - small SVG inline so print works offline */}
            <Logo />
          </div>
          <div style={{ textAlign: 'right', fontSize: 11, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600 }}>Fraternitas Ventures Private Limited</div>
            <div>No 938, 3rd Cross, 1st Block, HRBR Layout,</div>
            <div>Kalyanagar, Bangalore - 560043</div>
            <div>+91 98809 62323</div>
            <div>carecrew@legendoftoys.com</div>
          </div>
        </div>

        {/* Title */}
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 18, letterSpacing: '0.04em', marginBottom: 20 }}>
          DELIVERY CHALLAN
        </div>

        {/* Company block */}
        <div style={{ fontSize: 11, marginBottom: 18 }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Company Name:</div>
          <div style={{ fontWeight: 700 }}>{h.from_name}</div>
          <div style={{ whiteSpace: 'pre-line', marginBottom: 4 }}>{h.from_address}</div>
          {h.from_gstin && <div style={{ fontWeight: 700 }}>GSTIN : {h.from_gstin}</div>}
        </div>

        <Hr />

        {/* Meta block */}
        <div style={{ fontSize: 11, marginTop: 14, marginBottom: 18, lineHeight: 1.6 }}>
          <div><strong>Delivery Challan No.:</strong> {h.challan_no}</div>
          <div><strong>Date:</strong> {fmtDate(h.challan_date)}</div>
          <div>
            <strong>Dispatched To:</strong> {h.to_name ? <>{h.to_name}, </> : null}
            <span style={{ whiteSpace: 'pre-line' }}>{h.to_address}</span>
            {h.to_gstin && <> · <strong>GSTIN:</strong> {h.to_gstin}</>}
          </div>
          <div>
            <strong>Dispatched From:</strong> <span style={{ whiteSpace: 'pre-line' }}>{h.from_address}</span>
          </div>
          {h.purpose && <div><strong>Purpose:</strong> {h.purpose}</div>}
          {(h.transport_mode || h.vehicle_number || h.transporter_name) && (
            <div>
              <strong>Transport:</strong>{' '}
              {[h.transport_mode, h.vehicle_number, h.transporter_name].filter(Boolean).join(' · ')}
            </div>
          )}
          {h.ewb_required && (
            <div>
              <strong>E-Way Bill:</strong>{' '}
              {h.ewb_number
                ? <>{h.ewb_number}{h.ewb_date ? ` (dated ${fmtDate(h.ewb_date)})` : ''}</>
                : <em>To be generated — total ≥ ₹50,000 per GST Rule 138</em>}
            </div>
          )}
        </div>

        <Hr />

        {/* Lines */}
        <div style={{ fontWeight: 700, fontSize: 12, margin: '14px 0 8px' }}>Details of Goods Supplied</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <Pth align="left"   width={36}>S. No</Pth>
              <Pth align="left">Description of Goods</Pth>
              <Pth align="left"   width={90}>HSN/SAC Code</Pth>
              <Pth align="right"  width={70}>Quantity</Pth>
              <Pth align="left"   width={50}>Unit</Pth>
              <Pth align="right"  width={70}>Rate</Pth>
              <Pth align="right"  width={90}>Amount</Pth>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Ptd align="left">{l.serial_no}</Ptd>
                <Ptd align="left">
                  <div>{l.description}</div>
                  {l.ean && <div style={{ fontSize: 9, color: '#555' }}>EAN: {l.ean}</div>}
                </Ptd>
                <Ptd align="left">{l.hsn_code || '—'}</Ptd>
                <Ptd align="right">{Number(l.quantity)}</Ptd>
                <Ptd align="left">{l.unit || 'Pcs'}</Ptd>
                <Ptd align="right">{Number(l.rate)}</Ptd>
                <Ptd align="right">{inr(l.amount)}</Ptd>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ marginTop: 32, fontSize: 11 }}>
          <Totals label="Taxable Value" value={inr(h.subtotal)} />
          <Totals label={`GST @${Number(h.gst_rate)}%`} value={inr(h.gst_amount)} />
          <Totals label="Total"
            value={inr(h.total_amount)}
            qty={`${Number(h.total_quantity)} Pcs`}
            bold />
        </div>

        {h.notes && (
          <div style={{ marginTop: 22, fontSize: 10, color: '#444' }}>
            <strong>Notes:</strong> {h.notes}
          </div>
        )}

        {h.status === 'cancelled' && (
          <div style={{
            marginTop: 28, padding: 10, border: '2px solid #c00',
            color: '#c00', fontWeight: 700, fontSize: 12, textAlign: 'center', letterSpacing: '0.08em',
          }}>
            CANCELLED · {fmtDate(h.cancelled_at)}{h.cancelled_reason ? ` · ${h.cancelled_reason}` : ''}
          </div>
        )}

        <div style={{ marginTop: 48, fontSize: 9, color: '#666', textAlign: 'center' }}>
          This is a system-generated delivery challan. Total quantity {Number(h.total_quantity)}{' '}
          ({lines.length} line{lines.length === 1 ? '' : 's'}).
        </div>
      </div>
    </>
  );
}

function Hr() {
  return <div style={{ borderBottom: '1px solid #ddd' }} />;
}

function Pth({ children, align, width }) {
  return (
    <th style={{
      textAlign: align, padding: '6px 8px',
      borderBottom: '1px solid #999',
      fontWeight: 700, fontSize: 11,
      ...(width ? { width } : {}),
    }}>{children}</th>
  );
}
function Ptd({ children, align }) {
  return (
    <td style={{
      textAlign: align, padding: '8px 8px',
      borderBottom: '1px solid #e5e5e5',
      verticalAlign: 'top',
    }}>{children}</td>
  );
}
function Totals({ label, value, qty, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', gap: 24,
      padding: '5px 0', borderBottom: '1px solid #eee',
      fontWeight: bold ? 700 : 400,
    }}>
      <div style={{ flex: 1, paddingLeft: '50%' }}>{label}</div>
      {qty && <div style={{ width: 70, textAlign: 'right' }}>{qty}</div>}
      <div style={{ width: 110, textAlign: 'right' }}>{value}</div>
    </div>
  );
}

function Logo() {
  // Inline LOT logo — yellow on blue square, "LEGEND OF TOYS" wordmark
  // Compact version. The brand mark is bold + mechanical.
  return (
    <svg viewBox="0 0 120 120" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="120" height="120" rx="4" fill="#213CE2" />
      <text x="60" y="38" fontFamily="Helvetica, Arial, sans-serif" fontWeight="900" fontSize="24"
            textAnchor="middle" fill="#F2CD1A">LEGEND</text>
      <line x1="14" y1="50" x2="34" y2="50" stroke="#F2CD1A" strokeWidth="3" />
      <text x="60" y="72" fontFamily="Helvetica, Arial, sans-serif" fontWeight="900" fontSize="14"
            textAnchor="middle" fill="#F2CD1A">OF</text>
      <line x1="86" y1="50" x2="106" y2="50" stroke="#F2CD1A" strokeWidth="3" />
      <text x="60" y="100" fontFamily="Helvetica, Arial, sans-serif" fontWeight="900" fontSize="24"
            textAnchor="middle" fill="#F2CD1A">TOYS</text>
    </svg>
  );
}
