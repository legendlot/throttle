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
      fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 12, color: '#ccc',
    }}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #333', color: '#888', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.id || i} style={{ borderBottom: '1px solid #1a1a1a' }}>
            {columns.map((c) => (
              <td key={c.key} style={{ padding: '6px 8px' }}>
                {renderCell ? renderCell(row, c) : row[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
