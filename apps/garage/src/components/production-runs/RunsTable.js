'use client';
import { useMemo } from 'react';
import { Spinner } from '@throttle/ui';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
};
const th = {
  padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const sel = {
  background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '3px 10px', fontFamily: 'var(--mono)', fontSize: 10,
  textTransform: 'uppercase', letterSpacing: 0.5, cursor: 'pointer',
};
const iconBtn = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
};

const FRESH_STATUS_COLOR = {
  Draft: 'var(--t3)',
  Submitted: 'var(--blue)',
  Issued: 'var(--yellow)',
  'In Progress': 'var(--yellow)',
  Completed: 'var(--green)',
  Rejected: 'var(--red)',
  Cancelled: 'var(--t3)',
};

const REPAIR_STATUS_COLOR = {
  planned: 'var(--t3)',
  active: 'var(--yellow)',
  completed: 'var(--green)',
  cancelled: 'var(--t3)',
};

const FRESH_STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'Draft', label: 'Draft' },
  { value: 'Submitted', label: 'Submitted' },
  { value: 'Issued', label: 'Issued' },
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Cancelled', label: 'Cancelled' },
];

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function formatIST(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getDate()).padStart(2, '0');
  const month = months[d.getMonth()];
  let hour = d.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${String(hour).padStart(2, '0')}:${min} ${ampm}`;
}

function formatVariants(run) {
  const variants = run.variants || run.wos || [];
  if (!Array.isArray(variants) || variants.length === 0) {
    const total = run.total_units || 0;
    return total ? `Common ×${total}` : '—';
  }
  const parts = variants.map((v) => {
    const name = v.variant || v.colour || 'Common';
    const e = v.qty_ecomm ?? null;
    const r = v.qty_retail ?? null;
    if (e != null || r != null) {
      return `${name} E:${e || 0}/R:${r || 0}`;
    }
    return `${name} ×${v.qty || 0}`;
  });
  return parts.join(', ');
}

export function RunsTable({
  runs,
  repairRuns,
  loading,
  filterStatus,
  onFilterChange,
  onRefresh,
  onSelectRun,
  onSelectRepairRun,
}) {
  const merged = useMemo(() => {
    const fresh = (runs || [])
      .filter((r) => !filterStatus || r.status === filterStatus)
      .map((r) => ({ ...r, _type: 'fresh', _sortKey: r.created_at || r.run_date || '' }));
    const repair = (repairRuns || []).map((r) => ({
      ...r,
      _type: 'repair',
      _sortKey: r.created_at || r.run_date || '',
    }));
    return [...fresh, ...repair].sort((a, b) => (a._sortKey < b._sortKey ? 1 : -1));
  }, [runs, repairRuns, filterStatus]);

  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>Recent Runs</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            style={sel}
            value={filterStatus}
            onChange={(e) => onFilterChange(e.target.value)}
          >
            {FRESH_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            style={iconBtn}
            onClick={onRefresh}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Run</th>
              <th style={th}>Run Date</th>
              <th style={th}>Submitted</th>
              <th style={th}>Product</th>
              <th style={th}>Variants</th>
              <th style={{ ...th, textAlign: 'right' }}>Units</th>
              <th style={th}>Line</th>
              <th style={th}>Type</th>
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
            ) : merged.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
                  No runs yet
                </td>
              </tr>
            ) : (
              merged.map((row) => {
                if (row._type === 'fresh') {
                  const variantStr = formatVariants(row);
                  return (
                    <tr key={`f-${row.run_no}`}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>
                        {row.run_no}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                        {formatDate(row.run_date)}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                        {formatIST(row.released_at)}
                      </td>
                      <td style={td}>{row.product || '—'}</td>
                      <td
                        style={{
                          ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                        title={variantStr}
                      >
                        {variantStr}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                        {row.total_units ?? 0}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                        {row.line_no || '—'}
                      </td>
                      <td style={td}>
                        {row.run_type === 'outsourced' ? (
                          <span>
                            <span style={{
                              padding: '1px 6px', borderRadius: 2,
                              background: 'rgba(245,158,11,.15)', color: '#fbbf24',
                              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.06em',
                              textTransform: 'uppercase',
                            }}>Outsourced</span>
                            {row.vendor?.vendor_name && (
                              <span style={{ marginLeft: 6, color: 'var(--t3)', fontSize: 11 }}>
                                {row.vendor.vendor_name}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--t3)' }}>In-House</span>
                        )}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: FRESH_STATUS_COLOR[row.status] || 'var(--t2)' }}>
                        {row.status || '—'}
                      </td>
                      <td style={td}>
                        <button style={btnSec} onClick={() => onSelectRun(row)}>View</button>
                      </td>
                    </tr>
                  );
                }
                // repair row
                const counts = row._counts || {};
                const variantsLabel = (counts.total ?? 0) === 0
                  ? 'No units yet'
                  : `${counts.in_repair ?? 0} in repair · ${counts.repaired ?? 0} done · ${counts.scrapped ?? 0} scrapped`;
                const repairStatus = (row.status || '').toLowerCase();
                return (
                  <tr key={`r-${row.id || row.run_no}`}>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>
                      {row.run_no}
                      <span
                        style={{
                          marginLeft: 8, padding: '1px 6px', borderRadius: 2,
                          background: 'rgba(80,80,80,.2)', color: 'var(--t2)',
                          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.06em',
                        }}
                      >
                        REPAIR
                      </span>
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                      {formatDate(row.run_date || row.created_at)}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                      {formatIST(row.created_at)}
                    </td>
                    <td style={{ ...td, color: 'var(--t3)' }}>—</td>
                    <td style={{ ...td, fontSize: 11, color: 'var(--t2)' }}>{variantsLabel}</td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right' }}>
                      {counts.total ?? 0}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                      {row.line || '—'}
                    </td>
                    <td style={{ ...td, color: 'var(--t3)' }}>—</td>
                    <td
                      style={{
                        ...td, fontFamily: 'var(--mono)',
                        color: REPAIR_STATUS_COLOR[repairStatus] || 'var(--t2)',
                      }}
                    >
                      {(row.status || '').toUpperCase() || '—'}
                    </td>
                    <td style={td}>
                      <button style={btnSec} onClick={() => onSelectRepairRun(row)}>View</button>
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
