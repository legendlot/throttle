'use client';
// TaskView right pane: Comments · History, with the comment composer docked at the
// bottom. Same writes as the old CommentsPanel — addComment {id, body}, editComment
// {comment_id, body}, deleteComment {comment_id} — and the same author-only edit/delete.
// History is the shared read-only HistoryPanel (append-only task_history).
import { forwardRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { useToast } from '@throttle/ui';
import { AtSign, UserPlus } from 'lucide-react';
import { docketopsPost } from '../../lib/docketopsFetch.js';
import { fmtDateTime } from '../../lib/format.js';
import { Avatar } from '../primitives.js';
import { Button } from '../ui/index.js';
import { HistoryPanel } from '../HistoryPanel.js';

export const TaskActivity = forwardRef(function TaskActivity({ task, session, onChange, tab, setTab, onSetOwner }, composerRef) {
  const { user } = useAuth();
  const { showToast } = useToast();
  // Abandoned = read-only, comments included (worker refuses them since functionality F1 / G3).
  const locked = task?.status === 'abandoned';
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
    <div className="tv-activity">
      <div className="tv-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'comments'} className={'tv-tab' + (tab === 'comments' ? ' on' : '')} onClick={() => setTab('comments')}>
          Comments{comments.length ? <span className="tv-tab-n">{comments.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'history'} className={'tv-tab' + (tab === 'history' ? ' on' : '')} onClick={() => setTab('history')}>History</button>
      </div>

      <div className="tv-feed">
        {tab === 'history' ? <HistoryPanel task={task} /> : comments.length === 0 ? (
          <div className="tv-feed-empty">
            <div className="tv-feed-empty-t">No comments yet</div>
            <div className="tv-feed-empty-s">Start the conversation on this task.</div>
            {!locked && <div className="tv-suggest">
              <button type="button" className="tv-suggest-chip" onClick={() => composerRef?.current?.focus()}><AtSign size={13} />Mention a teammate</button>
              {onSetOwner && <button type="button" className="tv-suggest-chip" onClick={onSetOwner}><UserPlus size={13} />Set an owner</button>}
            </div>}
          </div>
        ) : comments.map(c => (
          <div key={c.id} className="tv-comment">
            <Avatar name={c.author_name || 'User'} size={24} />
            <div className="tv-comment-main">
              <div className="tv-comment-h">
                <span className="tv-comment-a">{c.author_name || 'User'}</span>
                <span className="tv-comment-t">{fmtDateTime(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
              </div>
              {editId === c.id && !locked ? (
                <div>
                  <textarea className="tv-input" value={editBody} onChange={e => setEditBody(e.target.value)} rows={2} />
                  <div className="tl-pop-actions">
                    <Button variant="ghost" size="sm" onClick={() => setEditId(null)}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={() => saveEdit(c.id)} disabled={busy}>Save</Button>
                  </div>
                </div>
              ) : <>
                <div className="tv-comment-b">{c.body}</div>
                {c.author_user_id === user?.id && !locked && (
                  <div className="tv-comment-acts">
                    <button type="button" onClick={() => { setEditId(c.id); setEditBody(c.body); }}>Edit</button>
                    <button type="button" onClick={() => del(c.id)}>Delete</button>
                  </div>
                )}
              </>}
            </div>
          </div>
        ))}
      </div>

      {tab === 'comments' && locked && (
        <div className="tv-composer tv-hint">This task is abandoned — reactivate it to comment.</div>
      )}
      {tab === 'comments' && !locked && (
        <div className="tv-composer">
          <textarea ref={composerRef} className="tv-input" value={body} onChange={e => setBody(e.target.value)} rows={2} disabled={busy}
            placeholder="Write a comment…" aria-label="Write a comment"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }} />
          <div className="tv-composer-acts">
            <span className="tv-hint">⌘ Enter to post</span>
            <Button variant={body.trim() ? 'primary' : 'neutral'} size="sm" onClick={add} disabled={busy || !body.trim()} loading={busy}>Comment</Button>
          </div>
        </div>
      )}
    </div>
  );
});
