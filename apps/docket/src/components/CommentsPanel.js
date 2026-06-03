'use client';
import { useState } from 'react';
import { useAuth } from '@throttle/auth';
import { useToast } from '@throttle/ui';
import { docketopsPost } from '../lib/docketopsFetch.js';
import { fmtDateTime } from '../lib/format.js';

export function CommentsPanel({ task, session, onChange }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editBody, setEditBody] = useState('');
  const comments = task.comments || [];

  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    try { await docketopsPost('addComment', { id: task.id, body }, session); setBody(''); await onChange(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function saveEdit(id) {
    setBusy(true);
    try { await docketopsPost('editComment', { comment_id: id, body: editBody }, session); setEditId(null); await onChange(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function del(id) {
    if (!confirm('Delete this comment?')) return;
    try { await docketopsPost('deleteComment', { comment_id: id }, session); await onChange(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        {comments.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>No comments yet.</div>}
        {comments.map(c => (
          <div key={c.id} style={comment}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>{c.author_name || 'User'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-4)' }}>
                {fmtDateTime(c.created_at)}{c.edited_at ? ' · edited' : ''}
              </span>
            </div>
            {editId === c.id ? (
              <div>
                <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={2} style={input} />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button style={btnPrimary} onClick={() => saveEdit(c.id)} disabled={busy}>Save</button>
                  <button style={btnGhost} onClick={() => setEditId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{c.body}</div>
                {c.author_user_id === user?.id && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    <button style={linkBtn} onClick={() => { setEditId(c.id); setEditBody(c.body); }}>Edit</button>
                    <button style={linkBtn} onClick={() => del(c.id)}>Delete</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} placeholder="Add a comment…" style={input} disabled={busy} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button style={{ ...btnPrimary, opacity: busy || !body.trim() ? 0.6 : 1 }} onClick={add} disabled={busy || !body.trim()}>Comment</button>
      </div>
    </div>
  );
}

const comment = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' };
const input = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', resize: 'vertical' };
const btnPrimary = { borderRadius: 'var(--radius-sm)', padding: '6px 14px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--docket-accent)', color: '#1f1f1f', border: '1px solid var(--docket-accent)' };
const btnGhost = { borderRadius: 'var(--radius-sm)', padding: '6px 14px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border)' };
const linkBtn = { background: 'none', border: 'none', color: 'var(--text-3)', fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' };
