'use client';
import { Card } from './shared.js';

const fmtStamp = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function NotesCard({ data, note, setNote, addNote }) {
  return (
    <Card title="Notes" className="ig-up" style={{ animationDelay: '80ms' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={note} onChange={(ev) => setNote(ev.target.value)}
          placeholder="Add a note…"
          onKeyDown={(ev) => { if (ev.key === 'Enter') addNote(); }}
          style={{
            flex: 1, minWidth: 0, height: 40, background: 'var(--input)', color: 'var(--text-1)',
            border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)',
            padding: '0 12px', fontFamily: 'var(--font-ui)', fontSize: 14, outline: 'none',
          }}
        />
        <button type="button" onClick={addNote} style={{
          height: 40, padding: '0 16px', background: 'var(--text-1)', color: 'var(--bg)',
          border: 'none', borderRadius: 'var(--r-ctl)',
          fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
        }}>Add</button>
      </div>
      {data.notes.length === 0 ? <div style={{ color: 'var(--text-4)', fontSize: 14 }}>No notes yet.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Newest first (worker order); keyed by id, so only a just-added note mounts and pops in. */}
          {data.notes.map(n => (
            <div key={n.id} className="ig-pop" style={{ padding: '10px 12px', background: 'var(--bg)', borderRadius: 12 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)', marginBottom: 4 }}>
                {fmtStamp(n.created_at)}{n.actor_name ? ` · ${n.actor_name}` : ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
