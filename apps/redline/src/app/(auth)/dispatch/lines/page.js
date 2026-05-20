'use client';
import { useCallback, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../../layout.js';

function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

// ── Dispatch Line Cards ──────────────────────────────────────
function DispatchLineCards({ lines }) {
  if (!lines || !lines.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>🚚 No dispatch activity today</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {lines.map(l => {
        const firstScan = l.first_scan_at
          ? new Date(l.first_scan_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
          : null;
        const lastScan = l.last_scan_at
          ? new Date(l.last_scan_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
          : null;

        const channels = Array.isArray(l.active_channels) ? l.active_channels : [];

        const statStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 };
        const valStyle  = (color) => ({ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: color || 'var(--t1)' });
        const lblStyle  = { fontSize: 9, color: 'var(--t3)', letterSpacing: '0.12em', textTransform: 'uppercase' };

        return (
          <div key={l.line} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{l.line || '—'}</div>
                <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 2 }}>
                  {channels.length
                    ? channels.join(', ')
                    : <span style={{ color: 'var(--t3)' }}>No channel activity</span>}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--yellow)' }}>
                  {fmt((l.pack_count || 0) + (l.alloc_count || 0) + (l.dtk_count || 0) + (l.dout_count || 0))}
                </div>
                <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 1, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total scans</div>
              </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 10, marginTop: 12 }}>
              <div style={statStyle}>
                <div style={valStyle('var(--t1)')}>{fmt(l.alloc_count)}</div>
                <div style={lblStyle}>ALLOC</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--t1)')}>{fmt(l.dtk_count)}</div>
                <div style={lblStyle}>DTK</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--yellow)')}>{fmt(l.pack_count)}</div>
                <div style={lblStyle}>PACK</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--green)')}>{fmt(l.dout_count)}</div>
                <div style={lblStyle}>DOUT</div>
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--t3)', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <span>{fmt(l.active_operators)} operators</span>
              <span>
                {firstScan && <>⏱ {firstScan}</>}
                {lastScan && lastScan !== firstScan && <> → {lastScan}</>}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Operator Output Table ────────────────────────────────────
function OperatorTable({ ops }) {
  if (!ops || !ops.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No operator data</div>;
  }

  const sorted = [...ops].sort((a, b) => (Number(b.total_scans) || 0) - (Number(a.total_scans) || 0));
  const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '9px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Operator', 'Line', 'ALLOC', 'DTK', 'PACK', 'DOUT', 'Total'].map(h => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, idx) => (
            <tr key={idx}>
              <td style={{ ...tdStyle, color: 'var(--t1)' }}>{o.operator_name || '—'}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{o.line || '—'}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(o.alloc_count)}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(o.dtk_count)}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{fmt(o.pack_count)}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{fmt(o.dout_count)}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t1)', fontWeight: 700 }}>{fmt(o.total_scans)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 12 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// ── Dispatch Lines Page ──────────────────────────────────────
export default function DispatchLinesPage() {
  const { session }                         = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [lines,     setLines]     = useState([]);
  const [operators, setOperators] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  const loadAll = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const today = todayStr();
      const data = await garageFetch('getDispatchLineView', { date: today }, session);
      setLines(data?.dispatch_lines || []);
      setOperators(data?.operator_stats || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadAll, 30000, !session);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 20 }}>
          {error}
        </div>
      )}

      <Section label="Dispatch Line Performance">
        <DispatchLineCards lines={lines} />
      </Section>

      <Section label="Operator Output">
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          <OperatorTable ops={operators} />
        </div>
      </Section>
    </div>
  );
}
