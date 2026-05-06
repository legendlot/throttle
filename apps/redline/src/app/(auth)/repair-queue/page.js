'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

const STATUS_COLORS = {
  qc_fail:         'var(--red)',
  rto_in:          'var(--orange)',
  scrapped_repair: 'var(--t3)',
};

const STATUS_LABELS = {
  qc_fail:         'QC Fail',
  rto_in:          'RTO In',
  scrapped_repair: 'Scrapped',
};

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || 'var(--t3)';
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 2,
      letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
      fontFamily: 'var(--mono)', color, border: `1px solid ${color}`,
    }}>{STATUS_LABELS[status] || status || '—'}</span>
  );
}

// ── Common styles ────────────────────────────────────────────
const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
const sectionLabel = { fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)' };
const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

// ── Repair Queue Page ────────────────────────────────────────
export default function RepairQueuePage() {
  const { session } = useAuth();
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError(null);
    try {
      const data = await garageFetch('getRepairUnitsQueue', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load repair queue');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  // ── Group by product ─────────────────────────────────────
  const byProduct = {};
  for (const row of rows) {
    const p = row.product || '—';
    if (!byProduct[p]) byProduct[p] = [];
    byProduct[p].push(row);
  }
  const products = Object.keys(byProduct).sort();
  const grandTotal = rows.reduce((s, r) => s + (r.count || 0), 0);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={sectionLabel}>Repair Queue — Awaiting Repair Run</div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
          Total: <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(grandTotal)}</span> units
        </span>
        <button style={btnStyle} onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        {loading && rows.length === 0 ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : products.length === 0 ? (
          <EmptyState icon="🔧" message="No units awaiting repair" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Model</th>
                  <th style={thStyle}>Color</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const productRows = byProduct[p];
                  const productTotal = productRows.reduce((s, r) => s + (r.count || 0), 0);
                  return (
                    <Fragment key={p}>
                      <tr style={{ background: 'var(--surface2)' }}>
                        <td colSpan={4} style={{ padding: '10px 12px', fontSize: 12, fontWeight: 700, color: 'var(--t1)', fontFamily: 'var(--cond)', letterSpacing: '0.06em' }}>
                          {p}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--yellow)', fontWeight: 700, textAlign: 'right' }}>
                          {fmt(productTotal)}
                        </td>
                      </tr>
                      {productRows.map((r, i) => (
                        <tr key={`${p}-${i}`}>
                          <td style={{ ...tdStyle, color: 'var(--t3)', paddingLeft: 28 }}>—</td>
                          <td style={{ ...tdStyle, color: 'var(--t1)' }}>{r.model || '—'}</td>
                          <td style={{ ...tdStyle, color: 'var(--t2)' }}>{r.color || '—'}</td>
                          <td style={tdStyle}><StatusBadge status={r.status} /></td>
                          <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t1)', textAlign: 'right' }}>{fmt(r.count)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
        Units available for repair — grouped by product. Create runs in the Store system.
      </div>
    </div>
  );
}
