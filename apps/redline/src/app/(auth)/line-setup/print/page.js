'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';

// PATTERN-016: static-export Next.js requires Suspense boundary around
// any component that calls useSearchParams.
export default function LineRosterPrintPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
      <PrintContent />
    </Suspense>
  );
}

const DEPT_ORDER = ['Prep', 'Assembly', 'QC', 'Packaging'];

function fmtPrintDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
  } catch { return d; }
}

function PrintContent() {
  const params = useSearchParams();
  const line = params.get('line') || '';
  const date = params.get('date') || '';
  const { session, user } = useAuth();
  const [roster, setRoster] = useState(null);
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!session || !line || !date) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await garageFetch('getLineRoster', { line, date }, session);
        const payload = res && res.line ? res : res?.data;
        if (!cancelled) setRoster(payload || null);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load roster');
      }
    })();
    return () => { cancelled = true; };
  }, [session, line, date]);

  useEffect(() => {
    if (!roster) return;
    const t = setTimeout(() => { try { window.print(); } catch {} }, 250);
    return () => clearTimeout(t);
  }, [roster]);

  if (error) return <div style={{ padding: 24, color: '#c00' }}>{error}</div>;
  if (!roster) return <div style={{ padding: 24 }}>Loading roster…</div>;

  const run = roster.run;
  const departments = roster.departments || [];

  return (
    <div className="po-print" style={{
      background: '#fff', color: '#000', minHeight: '100vh',
      padding: 16, fontFamily: 'system-ui, sans-serif',
    }}>
      <style jsx global>{`
        @page { size: A4 landscape; margin: 12mm; }
        @media print {
          body { background: #fff; }
          body * { visibility: hidden; }
          .po-print, .po-print * { visibility: visible; }
          .po-print { position: absolute; top: 0; left: 0; width: 100%; }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12,
        borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Shift Roster
          </div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Legend of Toys — Production</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          {run ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 900 }}>{run.product}</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>{run.run_no} · {run.status}</div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: '#666' }}>No run scheduled</div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: '0.04em' }}>
            LINE {line.replace(/^L/, '')}
          </div>
          <div style={{ fontSize: 12, marginTop: 2 }}>{fmtPrintDate(date)}</div>
        </div>
      </div>

      {/* Department sections */}
      {departments.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#666' }}>
          No line design or no stations to print.
        </div>
      ) : (
        DEPT_ORDER
          .map(name => departments.find(d => d.department === name))
          .filter(Boolean)
          .map(d => (
            <div key={d.department} style={{ marginBottom: 14, pageBreakInside: 'avoid' }}>
              <div style={{
                fontWeight: 800, fontSize: 13, letterSpacing: '0.04em',
                textTransform: 'uppercase', borderBottom: '1px solid #000',
                paddingBottom: 4, marginBottom: 8, display: 'flex', justifyContent: 'space-between',
              }}>
                <span>{d.department}</span>
                <span style={{ fontSize: 11, fontWeight: 600 }}>
                  {d.assigned_count}/{d.total_headcount} workers · {d.stations.length} stations
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {d.stations.map(s => (
                  <StationPrint key={s.id} station={s} />
                ))}
              </div>
            </div>
          ))
      )}

      {/* Footer */}
      <div style={{
        marginTop: 18, paddingTop: 8, borderTop: '1px solid #000',
        fontSize: 10, color: '#444', display: 'flex', justifyContent: 'space-between',
      }}>
        <span>Prepared by {user?.full_name || user?.email || '—'}</span>
        <span>{new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
      </div>

      <div className="no-print" style={{ marginTop: 20, textAlign: 'center' }}>
        <button onClick={() => window.print()} style={{
          background: '#000', color: '#fff', border: 'none',
          padding: '8px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>Print again</button>
      </div>
    </div>
  );
}

function StationPrint({ station }) {
  const slots = [];
  for (let i = 0; i < station.capacity; i++) {
    slots.push(station.assigned[i] || null);
  }
  return (
    <div style={{
      width: 156, minHeight: 78, border: '1px solid #000',
      padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 800 }}>
          {station.display_code}
        </span>
        <span style={{ fontSize: 10 }}>
          {station.capacity === 2 ? '👤👤' : '👤'}
        </span>
      </div>
      {slots.map((op, idx) => (
        op ? (
          <div key={idx} style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.1 }}>
            {op.name}
            <div style={{ fontSize: 9, fontWeight: 500, color: '#444', fontFamily: 'monospace' }}>
              {op.employee_id || ''}
            </div>
          </div>
        ) : (
          <div key={idx} style={{
            fontSize: 10, color: '#666', fontStyle: 'italic',
            border: '1px dashed #999', padding: '4px 6px', textAlign: 'center',
          }}>— VACANT —</div>
        )
      ))}
    </div>
  );
}
