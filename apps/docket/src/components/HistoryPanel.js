'use client';
import { eventLabel } from '../lib/tasks.js';
import { fmtDateTime } from '../lib/format.js';

// Read-only audit trail (append-only docket.task_history). Deadline revisions,
// status changes, abandons, re-parents, etc. — the auditable record.
export function HistoryPanel({ task }) {
  const rows = task.history || [];
  if (rows.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No history yet.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {rows.map(h => (
        <div key={h.id} style={row}>
          <div style={{ flexShrink: 0, width: 150, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-4)' }}>
            {fmtDateTime(h.created_at)}
          </div>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{eventLabel(h.event_type)}</span>
            {(h.old_value || h.new_value) && (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {' '}{h.old_value ? <code style={code}>{h.old_value}</code> : null}
                {h.old_value && h.new_value ? ' → ' : ''}
                {h.new_value ? <code style={code}>{h.new_value}</code> : null}
              </span>
            )}
            {h.note && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, fontStyle: 'italic' }}>“{h.note}”</div>}
            <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>{h.actor_name || 'User'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const row = { display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' };
const code = { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px', color: 'var(--text-2)' };
