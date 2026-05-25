'use client';
import { EmptyState } from './EmptyState.js';
import { Spinner } from './Spinner.js';

export function DataTable({ columns = [], rows = [], loading, emptyMessage = 'No data', renderCell }) {
  if (loading) {
    return <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>;
  }
  if (!rows.length) {
    return <EmptyState message={emptyMessage} />;
  }
  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 12, color: 'var(--t1)',
    }}>
      <thead>
        <tr style={{ background: 'var(--surface-2)' }}>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--t2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.id || i} style={{ background: i % 2 === 0 ? 'var(--surface)' : 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
            {columns.map((c) => (
              <td key={c.key} style={{ padding: '8px 12px', fontSize: 12, color: 'var(--t1)' }}>
                {renderCell ? renderCell(row, c) : row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
