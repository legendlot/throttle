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

function bucketKey(b) {
  return `${b.product || ''}|${b.model || ''}|${b.color || ''}`;
}

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
  // Map of bucketKey → { ...bucket, qty }
  const [selected, setSelected] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [modalLine, setModalLine] = useState('L1');
  const [modalNotes, setModalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEscapeClose(modalOpen && !submitting, () => setModalOpen(false));

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

  const totalCount  = useMemo(() => pool.reduce((s, b) => s + (b.count || 0), 0), [pool]);
  const selectedRows = useMemo(() => Object.values(selected), [selected]);
  const selectedUnits = useMemo(
    () => selectedRows.reduce((s, b) => s + (parseInt(b.qty, 10) || 0), 0),
    [selectedRows]
  );

  function toggleBucket(b) {
    const key = bucketKey(b);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = { ...b, qty: b.count || 1 };
      }
      return next;
    });
  }
  function updateSelectedQty(key, qty) {
    setSelected((prev) => ({ ...prev, [key]: { ...prev[key], qty } }));
  }
  function removeSelected(key) {
    setSelected((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  function clearSelection() {
    setSelected({});
  }
  function openModal() {
    if (selectedRows.length === 0) {
      showToast('Select at least one bucket', 'error');
      return;
    }
    setModalLine('L1');
    setModalNotes('');
    setModalOpen(true);
  }

  async function submitRepairRun() {
    if (selectedRows.length === 0) return;
    const lines = selectedRows.map((b) => ({
      product: b.product,
      model:   b.model,
      color:   b.color,
      qty:     parseInt(b.qty, 10) || 0,
    })).filter((l) => l.qty > 0);
    if (!lines.length) { showToast('All qty values are 0', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('assignToRepairRun', {
        lines,
        line:  modalLine,
        notes: modalNotes || null,
      }, session);
      const d = res?.data || res;
      const bucketCount = (d?.buckets || lines).length;
      showToast(
        `Repair run ${d?.run_no || ''} created — ${d?.units_linked || 0} unit${(d?.units_linked || 0) === 1 ? '' : 's'} across ${bucketCount} variant${bucketCount === 1 ? '' : 's'}`,
        'success'
      );
      setModalOpen(false);
      clearSelection();
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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {selectedRows.length > 0 && (
              <>
                <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  {selectedRows.length} bucket{selectedRows.length === 1 ? '' : 's'} · {selectedUnits} unit{selectedUnits === 1 ? '' : 's'}
                </span>
                <button style={btnSecondary} onClick={clearSelection}>Clear</button>
                <button style={btnPrimary} onClick={openModal}>Schedule Selected ({selectedRows.length}) →</button>
              </>
            )}
            <button style={btnSecondary} onClick={load}>↻ Refresh</button>
          </div>
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
                <th style={{ ...tableThStyle, width: 36 }}></th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Model</th>
                <th style={tableThStyle}>Colour</th>
                <th style={tableThStyle}>Count</th>
                <th style={tableThStyle}>Oldest</th>
                <th style={tableThStyle}>Sample UPCs</th>
              </tr></thead>
              <tbody>
                {pool.map((b) => {
                  const key = bucketKey(b);
                  const isSel = !!selected[key];
                  return (
                    <tr
                      key={key}
                      style={{ cursor: 'pointer', background: isSel ? 'rgba(245,158,11,.08)' : undefined }}
                      onClick={() => toggleBucket(b)}
                    >
                      <td style={tableTdStyle}>
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleBucket(b)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ cursor: 'pointer' }}
                        />
                      </td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', fontWeight: 700 }}>{b.product || '—'}</td>
                      <td style={tableTdStyle}>{b.model || '—'}</td>
                      <td style={tableTdStyle}>{b.color || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontWeight: 700, color: '#ffaa33' }}>{b.count}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatAge(b.oldest_at)}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {(b.sample_units || []).slice(0, 3).join(', ')}
                        {(b.sample_units || []).length > 3 ? `, +${b.sample_units.length - 3}` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
          Workflow: select one or more buckets → schedule repair run → store issues parts → REPAIR scanner station runs REP_PASS / REP_SCRAP.
        </div>
      </div>

      {/* Modal — multi-bucket review + line picker + submit */}
      {modalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => !submitting && setModalOpen(false)}
        >
          <div style={{ ...panelStyle, marginBottom: 0, minWidth: 520, maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div style={panelHeaderStyle}>
              <span>Schedule Repair Run — {selectedRows.length} variant{selectedRows.length === 1 ? '' : 's'}</span>
              <button style={btnSecondary} disabled={submitting} onClick={() => setModalOpen(false)}>✕</button>
            </div>
            <div style={{ padding: 16, overflowY: 'auto' }}>
              <div style={{ marginBottom: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                Editable qty per variant. Total units: <strong style={{ color: '#ffaa33' }}>{selectedUnits}</strong>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
                <thead><tr>
                  <th style={tableThStyle}>Variant</th>
                  <th style={tableThStyle}>Available</th>
                  <th style={tableThStyle}>Qty for run</th>
                  <th style={{ ...tableThStyle, width: 30 }}></th>
                </tr></thead>
                <tbody>
                  {selectedRows.map((b) => {
                    const key = bucketKey(b);
                    return (
                      <tr key={key}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--cond)', whiteSpace: 'normal' }}>
                          {b.product}
                          {b.model && <span style={{ color: 'var(--t3)' }}> · {b.model}</span>}
                          {b.color && <span style={{ color: 'var(--t3)' }}> · {b.color}</span>}
                        </td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{b.count}</td>
                        <td style={tableTdStyle}>
                          <input
                            type="number"
                            min="0"
                            max={b.count}
                            value={b.qty}
                            onChange={(e) => updateSelectedQty(key, e.target.value)}
                            style={{ ...inputStyle, width: 80, fontFamily: 'var(--mono)' }}
                          />
                        </td>
                        <td style={tableTdStyle}>
                          <button onClick={() => removeSelected(key)} style={{ background: 'transparent', border: '1px solid var(--border)', color: '#ff7070', cursor: 'pointer', fontSize: 11, borderRadius: 3, padding: '2px 6px' }}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Repair line</div>
                  <select value={modalLine} onChange={(e) => setModalLine(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                    <option value="L1">L1</option>
                    <option value="L2">L2</option>
                    <option value="L3">L3</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Notes (optional)</div>
                  <input type="text" value={modalNotes} onChange={(e) => setModalNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button style={btnSecondary} disabled={submitting} onClick={() => setModalOpen(false)}>Cancel</button>
                <button style={btnPrimary} disabled={submitting || selectedUnits < 1} onClick={submitRepairRun}>
                  {submitting ? 'Creating…' : `Create Run · ${selectedUnits} unit${selectedUnits === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
