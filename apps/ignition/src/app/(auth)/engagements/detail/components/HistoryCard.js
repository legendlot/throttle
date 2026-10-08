'use client';
import { Card } from './shared.js';

export function HistoryCard({ data }) {
  return (
    <Card title="History">
      {data.history.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No history yet.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <th style={th}>When</th><th style={th}>Action</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Note</th>
          </tr></thead>
          <tbody>
            {data.history.map(h => (
              <tr key={h.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{new Date(h.created_at).toLocaleString()}</td>
                <td style={td}>{h.action}</td>
                <td style={td}>{h.stage_from || '—'}</td>
                <td style={td}>{h.stage_to || '—'}</td>
                <td style={td}>{h.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
const th = { padding: '6px 10px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, textAlign: 'left' };
const td = { padding: '6px 10px' };
