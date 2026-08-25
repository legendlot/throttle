'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { Link2, X, ExternalLink } from 'lucide-react';
import { docketopsPost } from '../lib/docketopsFetch.js';

export function DocLinksPanel({ task, session, canEdit, onChange }) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const docs = task.documents || [];
  const validUrl = /^https?:\/\//i.test(url.trim());

  async function add() {
    if (!validUrl) return;
    setBusy(true);
    try { await docketopsPost('addDocument', { id: task.id, title: title.trim() || null, url: url.trim() }, session); setTitle(''); setUrl(''); await onChange(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function remove(documentId) {
    try { await docketopsPost('removeDocument', { document_id: documentId }, session); await onChange(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  return (
    <div>
      {docs.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>No document links.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {docs.map(d => (
          <div key={d.id} style={row}>
            <Link2 size={13} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
            <a href={d.url} target="_blank" rel="noreferrer" style={{ flex: 1, fontSize: 13, color: 'var(--state-info-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.title || d.url} <ExternalLink size={11} />
            </a>
            <X size={14} style={{ cursor: 'pointer', color: 'var(--text-4)', flexShrink: 0 }} onClick={() => remove(d.id)} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Label (optional)" style={{ ...input, flex: '1 1 110px', minWidth: 0 }} disabled={busy} />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" style={{ ...input, flex: '2 1 140px', minWidth: 0 }} disabled={busy} />
        <button style={{ ...btn, opacity: busy || !validUrl ? 0.6 : 1 }} onClick={add} disabled={busy || !validUrl}>Add link</button>
      </div>
    </div>
  );
}

const row = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px' };
const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none' };
const btn = { borderRadius: 'var(--radius-sm)', padding: '6px 14px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', whiteSpace: 'nowrap' };
