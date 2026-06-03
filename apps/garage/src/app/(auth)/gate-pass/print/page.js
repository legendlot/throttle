'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { DIRECTION_LABEL, purposeLabel } from '../../../../lib/gatePass.js';

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: '#777' }}>Loading…</div>}>
      <PrintContent />
    </Suspense>
  );
}

function fmtTs(ts) { if (!ts) return ''; try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return String(ts); } }
function fmtDate(d) { if (!d) return ''; try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return String(d); } }

function PrintContent() {
  const { session } = useAuth();
  const params = useSearchParams();
  const id = params?.get('id');
  const [gp, setGp] = useState(null);
  const [company, setCompany] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const [g, addrs] = await Promise.all([
          garageFetch('getGatePass', { id }, session),
          garageFetch('getCompanyAddresses', {}, session),
        ]);
        if (cancelled) return;
        setGp(g);
        const list = Array.isArray(addrs) ? addrs : [];
        setCompany(list.find((a) => a.is_default_delivery) || list[0] || null);
      } catch (e) { if (!cancelled) setError(e.message || 'Failed to load'); }
    })();
    return () => { cancelled = true; };
  }, [session, id]);

  useEffect(() => {
    if (gp?.id) { const t = setTimeout(() => { try { window.print(); } catch {} }, 500); return () => clearTimeout(t); }
  }, [gp]);

  if (!id) return <div style={{ padding: 40, color: '#c33' }}>Missing id.</div>;
  if (error) return <div style={{ padding: 40, color: '#c33' }}>{error}</div>;
  if (!gp?.id) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const isVoid = gp.status === 'void';
  const cell = { border: '1px solid #000', padding: '6px 8px', fontSize: 12, verticalAlign: 'top' };
  const keyCell = { ...cell, width: 150, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, background: '#f0f0f0' };

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body * { visibility: hidden !important; }
          .gp-print, .gp-print * { visibility: visible !important; }
          .gp-print { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; max-width: 100% !important; margin: 0 !important; box-shadow: none !important; }
          .no-print { display: none !important; }
        }
        .gp-print, .gp-print * { color: #000; font-family: Arial, Helvetica, sans-serif; }
        .gp-print { background: #fff; max-width: 210mm; margin: 0 auto; padding: 14mm; box-shadow: 0 0 24px rgba(0,0,0,0.15); position: relative; }
        .gp-print table { width: 100%; border-collapse: collapse; }
      `}</style>

      <div className="no-print" style={{ background: '#f3f3f3', padding: 8, textAlign: 'right' }}>
        <button onClick={() => window.print()} style={{ padding: '6px 14px', cursor: 'pointer' }}>Print</button>
        <button onClick={() => window.close()} style={{ padding: '6px 14px', marginLeft: 6, cursor: 'pointer' }}>Close</button>
      </div>

      <div className="gp-print">
        {isVoid && (
          <div style={{ position: 'absolute', top: '42%', left: 0, right: 0, textAlign: 'center', fontSize: 90, fontWeight: 800, color: 'rgba(222,42,42,0.18)', transform: 'rotate(-22deg)', letterSpacing: 8, pointerEvents: 'none' }}>VOID</div>
        )}

        {/* Header: logo left, company right */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, borderBottom: '2px solid #000', paddingBottom: 10 }}>
          <img src="/lot-logo.png" alt="Logo" style={{ width: 76, height: 76, objectFit: 'contain' }} />
          <div style={{ textAlign: 'right', fontSize: 11, lineHeight: 1.4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{company?.legal_name || 'Legend of Toys'}</div>
            {company?.line1 && <div>{company.line1}</div>}
            {company?.line2 && <div>{company.line2}</div>}
            <div>{[company?.city, company?.state, company?.pincode].filter(Boolean).join(', ')}</div>
            {company?.gstin && <div>GSTIN: {company.gstin}</div>}
          </div>
        </div>

        <h1 style={{ fontSize: 17, textTransform: 'uppercase', textAlign: 'center', letterSpacing: 3, textDecoration: 'underline', margin: '14px 0 4px' }}>Gate Pass</h1>
        <div style={{ textAlign: 'center', fontSize: 12, marginBottom: 12 }}>
          <strong>{DIRECTION_LABEL[gp.direction] || gp.direction}</strong> — entry/exit record
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 10 }}>
          <span><strong>Gate Pass No:</strong> {gp.gate_pass_no}</span>
          <span><strong>Date &amp; Time:</strong> {fmtTs(gp.gate_datetime)}</span>
        </div>

        <table>
          <tbody>
            <tr><td style={keyCell}>Direction</td><td style={cell}>{DIRECTION_LABEL[gp.direction] || gp.direction}</td><td style={keyCell}>Purpose</td><td style={cell}>{purposeLabel(gp.direction, gp.purpose)}</td></tr>
            <tr><td style={keyCell}>Vehicle No</td><td style={cell}>{gp.vehicle_no || '—'}</td><td style={keyCell}>No. of Boxes</td><td style={cell}>{gp.box_count ?? '—'}</td></tr>
            <tr><td style={keyCell}>Driver / Person</td><td style={cell}>{gp.person_name || '—'}</td><td style={keyCell}>Phone</td><td style={cell}>{gp.person_phone || '—'}</td></tr>
            <tr><td style={keyCell}>Transporter / Courier</td><td style={cell}>{gp.transporter_name || '—'}</td><td style={keyCell}>Party ({gp.direction === 'inbound' ? 'From' : 'To'})</td><td style={cell}>{gp.party_name || '—'}</td></tr>
            <tr><td style={keyCell}>Reference No</td><td style={cell}>{gp.reference_no || '—'}</td><td style={keyCell}>Returnable</td><td style={cell}>{gp.is_returnable ? `Yes${gp.expected_return_date ? ` (by ${fmtDate(gp.expected_return_date)})` : ''}` : 'No'}</td></tr>
            <tr><td style={keyCell}>Material / Contents</td><td style={cell} colSpan={3}>{gp.material_description || '—'}</td></tr>
            <tr><td style={keyCell}>Remarks</td><td style={cell} colSpan={3}>{gp.remarks || '—'}</td></tr>
          </tbody>
        </table>

        {(gp.documents || []).length > 0 && (
          <div style={{ marginTop: 10, fontSize: 11 }}>
            <strong>Attached documents:</strong> {gp.documents.map((d) => d.file_name || d.storage_path).join(', ')}
          </div>
        )}

        {/* Signature lines */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 60, fontSize: 11 }}>
          {['Security', 'Authorised By', 'Driver / Person'].map((s) => (
            <div key={s} style={{ width: '30%', borderTop: '1px solid #000', paddingTop: 4, textAlign: 'center' }}>{s}</div>
          ))}
        </div>

        <div style={{ marginTop: 20, fontSize: 9, color: '#666', textAlign: 'center' }}>
          Printed {fmtTs(new Date().toISOString())} · {gp.gate_pass_no}{isVoid ? ' · VOID' : ''}
        </div>
      </div>
    </>
  );
}
