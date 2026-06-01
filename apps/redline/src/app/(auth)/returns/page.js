'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, KpiCard } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3600000);
  return `${hrs}h`;
}

const thStyle = {
  padding: '10px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--t3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  fontWeight: 600,
  textAlign: 'left',
};
const tdStyle = {
  padding: '10px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  borderBottom: '1px solid rgba(64,64,64,.5)',
  whiteSpace: 'nowrap',
  color: 'var(--t1)',
};

// ── Returns Page (Redline — read-only) ────────────────────────
export default function ReturnsPage() {
  const { session, perms } = useAuth();

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
    return <EmptyState message={`Failed to load: ${error}`} />;
  }

  return (
    <div>
      {/* KPI strip */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          Overview
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          <KpiCard label="UDR Pending"     value={udrTotal}        color={udrTotal > 0 ? 'green' : undefined} />
          <KpiCard label="Repair Pending"  value={repairTotal}     color={repairTotal > 0 ? 'orange' : undefined} />
          <KpiCard label="Oldest UDR"      value={formatAge(oldestUdr)} />
          <KpiCard label="Oldest Repair"   value={formatAge(oldestRep)} />
        </div>
      </section>

      {/* Two-column pool view */}
      <section>
        <h2 style={{ margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' }}>
          Pools
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* UDR Pool */}
          <Panel
            padding={0}
            header={<><span style={{ color: 'var(--green)' }}>● </span>UDR Pool — Re-dispatch via PKG_OUT</>}
            headerAction={<span>{pools.udr.length} groups</span>}
          >
            {loading ? (
              <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : pools.udr.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
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
                        <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700, color: 'var(--t1)' }}>{b.product || '—'}</td>
                        <td style={tdStyle}>{b.model || '—'}</td>
                        <td style={tdStyle}>{b.color || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--green)', textAlign: 'right' }}>{b.count}</td>
                        <td style={{ ...tdStyle, color: 'var(--t3)', textAlign: 'right' }}>{formatAge(b.oldest_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Repair Pool */}
          <Panel
            padding={0}
            header={<><span style={{ color: 'var(--orange)' }}>● </span>Repair Pool — Awaiting Run</>}
            headerAction={<span>{pools.repair.length} groups</span>}
          >
            {loading ? (
              <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : pools.repair.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
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
                        <td style={{ ...tdStyle, fontFamily: 'var(--cond)', fontWeight: 700, color: 'var(--t1)' }}>{b.product || '—'}</td>
                        <td style={tdStyle}>{b.model || '—'}</td>
                        <td style={tdStyle}>{b.color || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight: 700, color: 'var(--orange)', textAlign: 'right' }}>{b.count}</td>
                        <td style={{ ...tdStyle, color: 'var(--t3)', textAlign: 'right' }}>{formatAge(b.oldest_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </section>

      <div style={{ marginTop: 20, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textAlign: 'center', letterSpacing: '0.04em' }}>
        Auto-refreshes every 60s. To take action, use Garage → Returns.
      </div>
    </div>
  );
}
