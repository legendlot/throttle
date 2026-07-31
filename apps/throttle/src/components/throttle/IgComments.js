'use client';
/* Social Tier 2 — the IG comment thread for one published post, with inline reply.
   Read via throttleops getIgComments, reply via replyIgComment. Nothing is cached:
   comments live on Meta permanently, so a local copy would only add staleness and a
   moderation-lag bug (a comment deleted on IG would linger here).

   ⚠️ The error path is the important one. The Pitstop-messaging app carries
   instagram_business_manage_comments, but Meta bakes scopes into a token at MINT
   time and META_IG_TOKEN was minted for DMs — so a missing scope is possible and
   comes back as a 403 whose message explains the re-mint. That message is shown
   verbatim rather than collapsed into an empty list, because "no comments" on a
   post with 70 of them is the one outcome that would waste someone's afternoon. */
import React, { useState, useEffect, useCallback } from 'react';
import { fetchIgComments, replyIgComment } from '@/lib/throttleApi';
import { toast } from '@/components/throttle/ToastHost';

function when(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return iso; }
}

function Comment({ c, session, canReply, onReplied }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    setBusy(true);
    try {
      await replyIgComment(session, c.id, msg);
      toast('Reply posted to Instagram', 'success');
      setText(''); setOpen(false); onReplied();
    } catch (e) {
      toast(e?.message || 'Reply failed', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--t1)' }}>@{c.username || 'unknown'}</span>
        <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{when(c.timestamp)}</span>
        {c.like_count > 0 && <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>♥ {c.like_count}</span>}
        {c.hidden && <span style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--t4)' }}>hidden</span>}
      </div>
      <div style={{ fontSize: 13, color: 'var(--t2)', marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.text || '—'}</div>

      {(c.replies || []).length > 0 && (
        <div style={{ marginTop: 7, marginLeft: 14, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
          {c.replies.map(r => (
            <div key={r.id} style={{ marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>@{r.username || 'unknown'}</span>
              <span className="num" style={{ fontSize: 10, color: 'var(--t4)', marginLeft: 6 }}>{when(r.timestamp)}</span>
              <div style={{ fontSize: 12.5, color: 'var(--t3)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.text || '—'}</div>
            </div>
          ))}
        </div>
      )}

      {canReply && (open ? (
        <div style={{ marginTop: 7, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <textarea rows={2} value={text} autoFocus maxLength={2200}
            onChange={e => setText(e.target.value)}
            placeholder={`Reply publicly to @${c.username || 'this comment'}…`}
            style={{ flex: 1, fontSize: 12.5, padding: '6px 8px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--t1)', resize: 'vertical', fontFamily: 'inherit' }} />
          <button className="t-chip" disabled={busy || !text.trim()} onClick={send}
            style={{ opacity: (busy || !text.trim()) ? 0.5 : 1, cursor: (busy || !text.trim()) ? 'not-allowed' : 'pointer' }}>
            {busy ? '…' : 'Send'}
          </button>
          <button className="t-chip" onClick={() => { setOpen(false); setText(''); }}>Cancel</button>
        </div>
      ) : (
        <button className="t-chip" onClick={() => setOpen(true)} style={{ marginTop: 6 }}>Reply</button>
      ))}
    </div>
  );
}

export default function IgComments({ session, igMediaId, canReply, expectedCount }) {
  const [state, setState] = useState({ loading: true, error: null, comments: [] });

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const d = await fetchIgComments(session, igMediaId);
      setState({ loading: false, error: null, comments: d?.comments || [] });
    } catch (e) {
      setState({ loading: false, error: e?.message || 'Could not load comments', comments: [] });
    }
  }, [session, igMediaId]);
  useEffect(() => { if (igMediaId) load(); }, [igMediaId, load]);

  if (state.loading) return <div style={{ fontSize: 12, color: 'var(--t4)', padding: '8px 0' }}>Loading comments from Instagram…</div>;

  if (state.error) return (
    <div style={{ fontSize: 12, color: 'var(--t2)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
      <strong style={{ color: 'var(--red, #ff7070)' }}>Instagram would not return comments.</strong>{'\n'}{state.error}
      <div style={{ marginTop: 8 }}><button className="t-chip" onClick={load}>Retry</button></div>
    </div>
  );

  if (!state.comments.length) return (
    <div style={{ fontSize: 12, color: 'var(--t4)', padding: '8px 0' }}>
      No comments returned.
      {expectedCount > 0 && (
        <> ⚠️ The synced count says <strong style={{ color: 'var(--t2)' }}>{expectedCount}</strong>, so this is
        more likely a permission or deletion issue than an empty thread — check the token scope before assuming.</>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>
          {state.comments.length} comment{state.comments.length === 1 ? '' : 's'}
          {expectedCount > 0 && state.comments.length !== expectedCount && ` · synced count ${expectedCount}`}
        </span>
        <button className="t-chip" onClick={load}>Refresh</button>
      </div>
      {state.comments.map(c => <Comment key={c.id} c={c} session={session} canReply={canReply} onReplied={load} />)}
    </div>
  );
}
