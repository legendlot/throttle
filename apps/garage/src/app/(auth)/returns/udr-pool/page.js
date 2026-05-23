'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3600000);
  return `${hrs}h`;
}

export default function UdrPoolPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [pool, setPool] = useState([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(null); // bucket being marked issued
  const [drilldown, setDrilldown] = useState(null); // currently-opened bucket

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnPools', {}, session);
      setPool(data?.udr || []);
    } catch (e) {
      showToast(e.message || 'Failed to load UDR pool', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const totalCount = useMemo(() => pool.reduce((s, b) => s + (b.count || 0), 0), [pool]);

  async function markIssued(bucket) {
    setIssuing(bucket);
    try {
      // Pull the units in this bucket, then mark them issued
      const unitsRes = await garageFetch('getReturnPoolUnits', {
        disposition: 'udr',
        product: bucket.product || '',
        model:   bucket.model   || '',
        color:   bucket.color   || '',
      }, session);
      const units = Array.isArray(unitsRes) ? unitsRes : (unitsRes?.data || []);
      const ids = units.map(u => u.return_unit_id).filter(Boolean);
      if (!ids.length) {
        showToast('No units to mark', 'warning');
        return;
      }
      await workerFetch('markReturnUnitIssued', { return_unit_ids: ids }, session);
      showToast(`Marked ${ids.length} units as issued`, 'success');
      load();
    } catch (e) {
      showToast(e.message || 'Failed to mark issued', 'error');
    } finally {
      setIssuing(null);
    }
  }

  if (perms && !perms.returns) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  return (
    <div>
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
        <div style={{ ...panelStyle, marginBottom: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>UDR Pending</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--cond)', color: '#4ade80' }}>{totalCount}</div>
        </div>
        <div style={{ ...panelStyle, marginBottom: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Distinct Products</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--cond)' }}>{pool.length}</div>
        </div>
        <div style={{ ...panelStyle, marginBottom: 0, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Oldest in Pool</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--cond)' }}>
            {pool.length ? formatAge(pool.map(b => b.oldest_at).filter(Boolean).sort()[0]) : '—'}
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>UDR Pool — aggregated by product / model / colour</span>
          <button style={btnSecondary} onClick={load}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : pool.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              ✓ No UDR units pending. Scan returns at the RET_IN station with disposition = UDR to populate.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Model</th>
                <th style={tableThStyle}>Colour</th>
                <th style={tableThStyle}>Count</th>
                <th style={tableThStyle}>Oldest</th>
                <th style={tableThStyle}>Sample UPCs</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {pool.map((b) => {
                  const key = `${b.product}|${b.model}|${b.color}`;
                  const isIssuing = issuing && issuing.product === b.product && issuing.model === b.model && issuing.color === b.color;
                  return (
                    <tr key={key}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tableTdStyle}>{b.model || '—'}</td>
                      <td style={tableTdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#4ade80' }}>{b.count}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatAge(b.oldest_at)}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {(b.sample_units || []).slice(0, 3).join(', ')}
                        {(b.sample_units || []).length > 3 ? `, +${b.sample_units.length - 3}` : ''}
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        <button
                          style={{ ...btnPrimary, opacity: isIssuing ? 0.5 : 1 }}
                          disabled={!!isIssuing}
                          onClick={() => markIssued(b)}
                        >
                          {isIssuing ? 'Marking…' : 'Mark Issued to Production →'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
          Workflow: store hands the units to production → production scans each unit at PKG_OUT with its LOT-XXXXXXXX-E batch label → unit re-enters dispatch as legitimate return.
        </div>
      </div>
    </div>
  );
}
