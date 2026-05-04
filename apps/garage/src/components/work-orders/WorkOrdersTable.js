'use client';
import { useMemo } from 'react';
import { Spinner } from '@throttle/ui';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
};
const th = {
  padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '3px 10px', fontFamily: 'var(--mono)', fontSize: 10,
  textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer',
};

const STATUS_TONES = {
  Open: { bg: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  'Pending Rework': { bg: 'rgba(33,60,226,.2)', color: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  Cancelled: { bg: 'rgba(222,42,42,.15)', color: '#ff7070', border: 'rgba(222,42,42,.25)' },
  Rejected: { bg: 'rgba(222,42,42,.15)', color: '#ff7070', border: 'rgba(222,42,42,.25)' },
  Complete: { bg: 'rgba(34,197,94,.12)', color: '#4ade80', border: 'rgba(34,197,94,.2)' },
};

function StatusBadge({ status }) {
  const tone = STATUS_TONES[status] || { bg: 'rgba(80,80,80,.2)', color: '#888', border: 'rgba(80,80,80,.3)' };
  return (
    <span
      style={{
        display: 'inline-block', padding: '2px 7px', borderRadius: 2,
        fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase',
        background: tone.bg, color: tone.color, border: `1px solid ${tone.border}`,
      }}
    >
      {status || '—'}
    </span>
  );
}

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export function WorkOrdersTable({ orders, loading, onCancel }) {
  const openCount = useMemo(
    () => (orders || []).filter((o) => o.status === 'Open' || o.status === 'Pending Rework').length,
    [orders],
  );

  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>Open Ad Hoc Requests</span>
        <span
          style={{
            fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 2,
            background: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: '1px solid rgba(242,205,26,.2)',
          }}
        >
          {openCount} open
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>WO No.</th>
              <th style={th}>Date</th>
              <th style={th}>Type</th>
              <th style={th}>Product</th>
              <th style={th}>Variant</th>
              <th style={th}>Colour</th>
              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
              <th style={th}>Line</th>
              <th style={th}>Status</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: 'center' }}>
                  <Spinner size="sm" />
                </td>
              </tr>
            ) : (orders || []).length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
                  No open work orders
                </td>
              </tr>
            ) : (
              orders.map((o) => {
                const canCancel = o.status === 'Open' || o.status === 'Pending Rework';
                return (
                  <tr key={o.wo_no}>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{o.wo_no}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDate(o.date)}</td>
                    <td style={td}>
                      <span
                        style={{
                          padding: '2px 6px', borderRadius: 2, fontFamily: 'var(--mono)',
                          fontSize: 9, textTransform: 'uppercase', letterSpacing: '.04em',
                          background: 'rgba(33,60,226,.2)', color: '#7b93ff',
                          border: '1px solid rgba(33,60,226,.3)',
                        }}
                      >
                        Ad Hoc
                      </span>
                    </td>
                    <td style={td}>{o.product || '—'}</td>
                    <td style={td}>{o.variant || '—'}</td>
                    <td style={td}>{o.colour || '—'}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                      {o.qty != null ? o.qty : '—'}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{o.line_no || '—'}</td>
                    <td style={td}><StatusBadge status={o.status} /></td>
                    <td style={td}>
                      {canCancel && (
                        <button style={btnSec} onClick={() => onCancel(o)}>Cancel</button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
