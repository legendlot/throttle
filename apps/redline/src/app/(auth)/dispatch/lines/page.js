'use client';
import { useCallback, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Panel } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../../layout.js';

function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

// ── Dispatch Line Cards ──────────────────────────────────────
function DispatchLineCards({ lines }) {
  if (!lines || !lines.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>🚚 No dispatch activity today</div>;
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

        const statStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 };
        const valStyle  = (color) => ({ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, color: color || 'var(--t1)', lineHeight: 1 });
        const lblStyle  = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase' };

        return (
          <div key={l.line} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 16 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.04em' }}>{l.line || '—'}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', marginTop: 4 }}>
                  {channels.length
                    ? channels.join(', ')
                    : <span style={{ color: 'var(--t3)' }}>No channel activity</span>}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 700, color: 'var(--yellow)' }}>
                  {fmt((l.pack_count || 0) + (l.alloc_count || 0) + (l.dtk_count || 0) + (l.dout_count || 0))}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 2, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Total scans</div>
              </div>
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 14, marginTop: 14 }}>
              <div style={statStyle}>
                <div style={valStyle('var(--t1)')}>{fmt(l.alloc_count)}</div>
                <div style={lblStyle}>Alloc</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--t1)')}>{fmt(l.dtk_count)}</div>
                <div style={lblStyle}>DTK</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--yellow)')}>{fmt(l.pack_count)}</div>
                <div style={lblStyle}>Pack</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--green)')}>{fmt(l.dout_count)}</div>
                <div style={lblStyle}>Dout</div>
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', paddingTop: 10, borderTop: '1px solid var(--border)', letterSpacing: '0.04em' }}>
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
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>No operator data</div>;
  }

  const sorted = [...ops].sort((a, b) => (Number(b.total_scans) || 0) - (Number(a.total_scans) || 0));
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Operator', 'Line', 'Alloc', 'DTK', 'Pack', 'Dout', 'Total'].map(h => (
              <th key={h} style={h === 'Operator' || h === 'Line' ? thStyle : { ...thStyle, textAlign: 'right' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, idx) => (
            <tr key={idx}>
              <td style={tdStyle}>{o.operator_name || '—'}</td>
              <td style={{ ...tdStyle, color: 'var(--yellow)', fontWeight: 600 }}>{o.line || '—'}</td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(o.alloc_count)}</td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(o.dtk_count)}</td>
              <td style={{ ...tdStyle, color: 'var(--yellow)', textAlign: 'right' }}>{fmt(o.pack_count)}</td>
              <td style={{ ...tdStyle, color: 'var(--green)', textAlign: 'right' }}>{fmt(o.dout_count)}</td>
              <td style={{ ...tdStyle, color: 'var(--t1)', fontWeight: 700, textAlign: 'right' }}>{fmt(o.total_scans)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' }}>
        {label}
      </h2>
      {children}
    </section>
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
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 4, padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 13, color: '#ff7070', marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      <Section label="Dispatch Line Performance">
        <DispatchLineCards lines={lines} />
      </Section>

      <Section label="Operator Output">
        <Panel padding={0}>
          <OperatorTable ops={operators} />
        </Panel>
      </Section>
    </div>
  );
}
