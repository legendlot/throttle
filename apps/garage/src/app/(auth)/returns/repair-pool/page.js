'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, useEscapeClose } from '@throttle/ui';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnPrimary       = { background: '#f59e0b', border: '1px solid #f59e0b', borderRadius: 3, padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };

function formatAge(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3600000);
  return `${hrs}h`;
}

export default function RepairPoolPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [pool, setPool] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalBucket, setModalBucket] = useState(null);
  const [modalQty, setModalQty] = useState(0);
  const [modalLine, setModalLine] = useState('L1');
  const [modalNotes, setModalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEscapeClose(!!modalBucket && !submitting, () => setModalBucket(null));

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnPools', {}, session);
      setPool(data?.repair || []);
    } catch (e) {
      showToast(e.message || 'Failed to load Repair pool', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const totalCount = useMemo(() => pool.reduce((s, b) => s + (b.count || 0), 0), [pool]);

  function openModal(b) {
    setModalBucket(b);
    setModalQty(b.count || 0);
    setModalLine('L1');
    setModalNotes('');
  }

  async function submitRepairRun() {
    if (!modalBucket) return;
    if (!modalQty || modalQty < 1) { showToast('Qty must be ≥ 1', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('assignToRepairRun', {
        product: modalBucket.product,
        model:   modalBucket.model,
        color:   modalBucket.color,
        qty:     parseInt(modalQty, 10),
        line:    modalLine,
        notes:   modalNotes || null,
      }, session);
      const d = res?.data || res;
      showToast(`Repair run ${d?.run_no || ''} created — ${d?.units_linked || 0} units linked`, 'success');
      setModalBucket(null);
      load();
    } catch (e) {
      showToast(e.message || 'Failed to create repair run', 'error');
    } finally {
      setSubmitting(false);
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
          <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Repair Pending</div>
          <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--cond)', color: '#ffaa33' }}>{totalCount}</div>
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
          <span>Repair Pool — aggregated by product / model / colour</span>
          <button style={btnSecondary} onClick={load}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : pool.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
              ✓ No units pending repair. Scan returns at RET_IN with disposition = REPAIR to populate.
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
                {pool.map((b) => (
                  <tr key={`${b.product}|${b.model}|${b.color}`}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                    <td style={tableTdStyle}>{b.model || '—'}</td>
                    <td style={tableTdStyle}>{b.color || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#ffaa33' }}>{b.count}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatAge(b.oldest_at)}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                      {(b.sample_units || []).slice(0, 3).join(', ')}
                      {(b.sample_units || []).length > 3 ? `, +${b.sample_units.length - 3}` : ''}
                    </td>
                    <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                      <button style={btnPrimary} onClick={() => openModal(b)}>
                        Schedule Repair Run →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
          Workflow: select units → create repair run → store issues parts → REPAIR scanner station runs REP_PASS / REP_SCRAP.
        </div>
      </div>

      {/* Modal */}
      {modalBucket && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => !submitting && setModalBucket(null)}
        >
          <div style={{ ...panelStyle, marginBottom: 0, minWidth: 360, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={panelHeaderStyle}>
              <span>Schedule Repair Run</span>
              <button style={btnSecondary} disabled={submitting} onClick={() => setModalBucket(null)}>✕</button>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ marginBottom: 12, fontFamily: 'var(--mono)', fontSize: 12 }}>
                <div style={{ color: 'var(--t3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Product</div>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 16, fontWeight: 700 }}>{modalBucket.product} {modalBucket.model && <span style={{ color: 'var(--t3)' }}> · {modalBucket.model}</span>} {modalBucket.color && <span style={{ color: 'var(--t3)' }}> · {modalBucket.color}</span>}</div>
                <div style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4 }}>Available in pool: {modalBucket.count}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Qty for this run</div>
                  <input type="number" min="1" max={modalBucket.count} value={modalQty} onChange={(e) => setModalQty(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} />
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Repair line</div>
                  <select value={modalLine} onChange={(e) => setModalLine(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                    <option value="L1">L1</option>
                    <option value="L2">L2</option>
                    <option value="L3">L3</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Notes (optional)</div>
                  <input type="text" value={modalNotes} onChange={(e) => setModalNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button style={btnSecondary} disabled={submitting} onClick={() => setModalBucket(null)}>Cancel</button>
                <button style={btnPrimary} disabled={submitting || !modalQty || modalQty < 1} onClick={submitRepairRun}>
                  {submitting ? 'Creating…' : 'Create Repair Run'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
