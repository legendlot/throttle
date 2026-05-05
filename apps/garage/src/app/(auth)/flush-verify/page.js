'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { FlushVerifyPanel } from '../../../components/flush/FlushVerifyPanel.js';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function formatDisplayDate(raw) {
  if (!raw) return '—';
  const str = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return str.slice(0, 10);
}

export default function FlushVerifyPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [verifyFlushId, setVerifyFlushId] = useState(null);

  const loadQueue = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getFlushes', { status: 'Pending Verification' }, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load pending flushes', 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  function handleVerified() {
    setVerifyFlushId(null);
    loadQueue();
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Flush Verify
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Store verifies line flushes raised by production.
        </p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Pending Flushes {rows.length > 0 && <span style={{ color: 'var(--yellow)', marginLeft: 6 }}>({rows.length})</span>}</span>
          <button style={btnSecondary} onClick={loadQueue} disabled={loading}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              No pending flushes — all clear ✓
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={tableThStyle}>Flush ID</th>
                  <th style={tableThStyle}>Date</th>
                  <th style={tableThStyle}>Run / Type</th>
                  <th style={tableThStyle}>Line</th>
                  <th style={tableThStyle}>Shift</th>
                  <th style={tableThStyle}>Parts</th>
                  <th style={tableThStyle}>Raised By</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.flush_id}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.flush_id}</td>
                    <td style={tableTdStyle}>{formatDisplayDate(r.flush_date)}</td>
                    <td style={tableTdStyle}>{r.run_no || r.wo_no || 'Standalone'}</td>
                    <td style={tableTdStyle}>{r.line_no || '—'}</td>
                    <td style={tableTdStyle}>{r.shift || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.line_count || r.parts_count || 0}</td>
                    <td style={tableTdStyle}>{r.raised_by || '—'}</td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button
                        style={btnPrimary}
                        onClick={() => setVerifyFlushId(r.flush_id)}
                      >
                        VERIFY →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {verifyFlushId && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Verify {verifyFlushId}</span>
            <button
              onClick={() => setVerifyFlushId(null)}
              style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--t2)', cursor: 'pointer', borderRadius: 3, padding: '4px 10px', fontSize: 12 }}
            >
              ✕ Close
            </button>
          </div>
          <FlushVerifyPanel
            flushId={verifyFlushId}
            onClose={() => setVerifyFlushId(null)}
            onVerified={handleVerified}
          />
        </div>
      )}
    </div>
  );
}
