'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3600000);
  return `${hrs}h`;
}

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '14px 16px',
};

const kpiLabelStyle = {
  fontSize: 10,
  color: 'var(--t3)',
  fontFamily: 'var(--mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 4,
};

const kpiValueStyle = {
  fontSize: 30,
  fontWeight: 700,
  fontFamily: 'var(--cond)',
  lineHeight: 1,
};

const panelHeader = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)',
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--t2)',
};

const thStyle = {
  padding: '8px 12px',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--t3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  fontWeight: 600,
  textAlign: 'left',
};
const tdStyle = {
  padding: '8px 12px',
  fontSize: 12,
  borderBottom: '1px solid rgba(42,42,42,.6)',
  whiteSpace: 'nowrap',
};

// ── Returns Page (Redline — read-only) ────────────────────────
export default function ReturnsPage() {
  const { session } = useAuth();

  const [pools,    setPools]    = useState({ udr: [], repair: [] });
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const loadPools = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const data = await garageFetch('getReturnPools', {}, session);
      setPools({
        udr:    Array.isArray(data?.udr)    ? data.udr    : [],
        repair: Array.isArray(data?.repair) ? data.repair : [],
      });
    } catch (e) {
      setError(e.message || 'Failed to load return pools');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { loadPools(); }, [loadPools]);

  // Auto-refresh every 60s — floor view
  useEffect(() => {
    if (!session) return;
    const t = setInterval(loadPools, 60000);
    return () => clearInterval(t);
  }, [loadPools, session]);

  const udrTotal    = useMemo(() => pools.udr.reduce((s, b) => s + (b.count || 0), 0), [pools.udr]);
  const repairTotal = useMemo(() => pools.repair.reduce((s, b) => s + (b.count || 0), 0), [pools.repair]);
  const oldestUdr   = useMemo(() => pools.udr.map(b => b.oldest_at).filter(Boolean).sort()[0], [pools.udr]);
  const oldestRep   = useMemo(() => pools.repair.map(b => b.oldest_at).filter(Boolean).sort()[0], [pools.repair]);

  if (error) {
    return <EmptyState title="Failed to load" subtitle={error} />;
  }

  return (
    <div>
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <div style={cardStyle}>
          <div style={kpiLabelStyle}>UDR Pending</div>
          <div style={{ ...kpiValueStyle, color: '#4ade80' }}>{udrTotal}</div>
        </div>
        <div style={cardStyle}>
          <div style={kpiLabelStyle}>Repair Pending</div>
          <div style={{ ...kpiValueStyle, color: '#ffaa33' }}>{repairTotal}</div>
        </div>
        <div style={cardStyle}>
          <div style={kpiLabelStyle}>Oldest UDR</div>
          <div style={kpiValueStyle}>{formatAge(oldestUdr)}</div>
        </div>
        <div style={cardStyle}>
          <div style={kpiLabelStyle}>Oldest Repair</div>
          <div style={kpiValueStyle}>{formatAge(oldestRep)}</div>
        </div>
      </div>

      {/* Two-column pool view */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* UDR Pool */}
        <div style={{ ...cardStyle, padding: 0 }}>
          <div style={panelHeader}>
            <span style={{ color: '#4ade80' }}>UDR Pool — Re-dispatch via PKG_OUT</span>
            <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>{pools.udr.length} groups</span>
          </div>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : pools.udr.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              ✓ Pool empty
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Model</th>
                  <th style={thStyle}>Colour</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Oldest</th>
                </tr></thead>
                <tbody>
                  {pools.udr.map((b) => (
                    <tr key={`udr-${b.product}-${b.model}-${b.color}`}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tdStyle}>{b.model || '—'}</td>
                      <td style={tdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80', textAlign: 'right' }}>{b.count}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)', textAlign: 'right' }}>{formatAge(b.oldest_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Repair Pool */}
        <div style={{ ...cardStyle, padding: 0 }}>
          <div style={panelHeader}>
            <span style={{ color: '#ffaa33' }}>Repair Pool — Awaiting Run</span>
            <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>{pools.repair.length} groups</span>
          </div>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : pools.repair.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
              ✓ Pool empty
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Model</th>
                  <th style={thStyle}>Colour</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Oldest</th>
                </tr></thead>
                <tbody>
                  {pools.repair.map((b) => (
                    <tr key={`rep-${b.product}-${b.model}-${b.color}`}>
                      <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tdStyle}>{b.model || '—'}</td>
                      <td style={tdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#ffaa33', textAlign: 'right' }}>{b.count}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)', textAlign: 'right' }}>{formatAge(b.oldest_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--t3)', textAlign: 'center' }}>
        Auto-refreshes every 60s. To take action, use Garage → Returns.
      </div>
    </div>
  );
}
