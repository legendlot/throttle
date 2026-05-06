'use client';
import { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { EmptyState, Spinner } from '@throttle/ui';

const panelStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 4, marginBottom: 16, overflow: 'hidden',
};
const panelHdrStyle = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
};
const rowStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 16px', borderBottom: '1px solid rgba(42,42,42,.5)',
  fontSize: 12,
};

export default function AlertsPage() {
  const { session } = useAuth();
  const [reorderFlags,  setReorderFlags]  = useState([]);
  const [submittedRuns, setSubmittedRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!session) return;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [flagsData, runsData] = await Promise.all([
          garageFetch('getDashboard', {}, session).then(d => d?.reorder_flags || []),
          garageFetch('getProductionRuns', { status: 'submitted' }, session).then(d => Array.isArray(d) ? d : []),
        ]);
        setReorderFlags(flagsData);
        setSubmittedRuns(runsData);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [session]);

  if (loading) return <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>;
  if (error)   return <div style={{ padding: 24 }}><EmptyState message={error} /></div>;

  const total = reorderFlags.length + submittedRuns.length;

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{
          fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900,
          textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0,
        }}>
          Alerts
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          {total === 0
            ? 'All clear — no active alerts.'
            : `${total} active alert${total === 1 ? '' : 's'} require attention.`}
        </p>
      </div>

      <div style={panelStyle}>
        <div style={panelHdrStyle}>
          <span>🔴 Reorder Flags</span>
          <span style={{ color: reorderFlags.length > 0 ? 'var(--red)' : 'var(--green)', fontFamily: 'var(--mono)' }}>
            {reorderFlags.length}
          </span>
        </div>
        {reorderFlags.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--green)', fontSize: 12 }}>
            ✅ No reorder flags
          </div>
        ) : (
          reorderFlags.map((r, i) => (
            <div
              key={i}
              style={{ ...rowStyle, borderBottom: i < reorderFlags.length - 1 ? rowStyle.borderBottom : 'none' }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{r.part_name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                  {r.part_code} · {r.product || '—'}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--red)', textAlign: 'right' }}>
                <div>{r.closing_stock ?? 0} on hand</div>
                <div style={{ fontSize: 10, color: 'var(--t3)' }}>reorder at {r.reorder_level ?? 0}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={panelStyle}>
        <div style={panelHdrStyle}>
          <span>⏳ Submitted Runs — Awaiting Issue</span>
          <span style={{ color: submittedRuns.length > 0 ? 'var(--yellow)' : 'var(--green)', fontFamily: 'var(--mono)' }}>
            {submittedRuns.length}
          </span>
        </div>
        {submittedRuns.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--green)', fontSize: 12 }}>
            ✅ No runs waiting for issue
          </div>
        ) : (
          submittedRuns.map((r, i) => (
            <div
              key={i}
              style={{ ...rowStyle, borderBottom: i < submittedRuns.length - 1 ? rowStyle.borderBottom : 'none' }}
            >
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--yellow)' }}>
                  {r.run_no}
                </div>
                <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 2 }}>
                  {r.product} · {r.units} units
                </div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                {r.run_date || '—'}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
