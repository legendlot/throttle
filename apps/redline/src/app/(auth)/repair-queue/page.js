'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, StatusBadge } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

// Map unit status → StatusBadge variant.
const STATUS_MAP = {
  qc_fail:         { variant: 'error',   label: 'QC Fail',   icon: '✗' },
  rto_in:          { variant: 'warning', label: 'RTO In',    icon: '⚠' },
  scrapped_repair: { variant: 'neutral', label: 'Scrapped' },
};

function RepairStatusBadge({ status }) {
  const meta = STATUS_MAP[status] || { variant: 'neutral', label: status || '—' };
  return <StatusBadge variant={meta.variant} icon={meta.icon}>{meta.label}</StatusBadge>;
}

// ── Common styles ────────────────────────────────────────────
const refreshBtnStyle = { padding: '7px 12px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer' };
const sectionLabel = { margin: 0, fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' };
const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <h2 style={sectionLabel}>Repair Queue — Awaiting Repair Run</h2>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', letterSpacing: '0.04em' }}>
          Total: <span style={{ color: 'var(--yellow)', fontWeight: 700 }}>{fmt(grandTotal)}</span> units
        </span>
        <button style={refreshBtnStyle} onClick={load} disabled={loading}>↻ Refresh</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 4, padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 13, color: '#ff7070', marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      {/* Table */}
      <Panel padding={0}>
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
                        <td colSpan={4} style={{ padding: '10px 14px', fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.04em' }}>
                          {p}
                        </td>
                        <td style={{ padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--yellow)', fontWeight: 700, textAlign: 'right' }}>
                          {fmt(productTotal)}
                        </td>
                      </tr>
                      {productRows.map((r, i) => (
                        <tr key={`${p}-${i}`}>
                          <td style={{ ...tdStyle, color: 'var(--t3)', paddingLeft: 32 }}>—</td>
                          <td style={tdStyle}>{r.model || '—'}</td>
                          <td style={{ ...tdStyle, color: 'var(--t2)' }}>{r.color || '—'}</td>
                          <td style={tdStyle}><RepairStatusBadge status={r.status} /></td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.count)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Footer note */}
      <div style={{ marginTop: 14, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', letterSpacing: '0.04em' }}>
        Units available for repair — grouped by product. Create runs in the Store system.
      </div>
    </div>
  );
}
