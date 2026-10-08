'use client';
import { Card } from './shared.js';

export function NotesCard({ data, note, setNote, addNote }) {
  return (
    <Card title="Notes">
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={note} onChange={(ev) => setNote(ev.target.value)}
          placeholder="Add a note…"
          onKeyDown={(ev) => { if (ev.key === 'Enter') addNote(); }}
          style={{
            flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13,
          }}
        />
        <button onClick={addNote} style={{
          padding: '8px 14px', background: 'var(--surface-3)', color: 'var(--text-1)',
          border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
        }}>Add</button>
      </div>
      {data.notes.length === 0 ? <div style={{ color: 'var(--text-3)' }}>No notes yet.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.notes.map(n => (
            <div key={n.id} style={{ padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>
                {new Date(n.created_at).toLocaleString()}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
