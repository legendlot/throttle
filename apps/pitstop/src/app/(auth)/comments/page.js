'use client';
/* ════════════════════════════════════════════════════════════
   Post Comments (S322) — public IG comments, worked like a queue.
   Its own page, not a tab in /inbox: the grouping unit is a POST, not a person,
   and the actions are moderation (hide/delete on a PUBLIC surface) rather than
   conversation. Folding it into the DM inbox would muddy both.

   ⚠️ Fed by the csops POLLER (syncIgComments), not the webhook. The IG app is
   subscribed to `messages` only, so no comment webhook is delivered — the
   ingestion branch exists and is dormant. Comments therefore land within ~10
   minutes, not instantly, and the banner below says so rather than letting an
   agent think the queue is live.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import {
  Instagram, ExternalLink, Send, EyeOff, Eye, Trash2, Check, RotateCcw,
  UserPlus, RefreshCw, MessageSquare,
} from 'lucide-react';
import { csopsGet, csopsPost } from '../../../lib/csopsFetch.js';
import { fmtIstShort } from '../../../lib/datetime.js';

const STATES = [
  { id: 'open',   label: 'Open' },
  { id: 'closed', label: 'Done' },
  { id: 'all',    label: 'All' },
];
const TABS = [
  { id: '',           label: 'All' },
  { id: 'mine',       label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' },
];

export default function CommentsPage() {
  const { session, user, perms } = useAuth();
  const canManage = !!perms?.cs_ticket_manage;
  const canDelete = !!perms?.cs_ticket_admin;

  const [state, setState] = useState('open');
  const [tab, setTab] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ open: null, unassigned: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selId, setSelId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const d = await csopsGet('getPostComments', { state, tab, q }, session);
      setRows(d?.comments || []);
      setCounts(d?.counts || { open: null, unassigned: null });
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, state, tab, q]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  // 60s, not the inbox's 15s: the feed behind this page only refreshes every 10 minutes,
  // so a faster poll would be pure load for a list that cannot have changed.
  useEffect(() => {
    if (!session) return undefined;
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [session, load]);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    try { setDetail(await csopsGet('getCommentThread', { id }, session)); }
    catch (e) { setError(e.message); }
  }, [session]);
  useEffect(() => { setReply(''); setConfirmDel(false); loadDetail(selId); }, [selId, loadDetail]);

  async function act(action, payload, { refreshDetail = true } = {}) {
    if (busy) return;
    setBusy(true);
    try {
      await csopsPost(action, payload, session);
      await load();
      if (refreshDetail && selId) await loadDetail(selId);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function sendReply() {
    const t = reply.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await csopsPost('replyToComment', { comment_id: selId, text: t }, session);
      setReply('');
      await load(); await loadDetail(selId);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function syncNow() {
    setSyncing(true);
    try { await csopsPost('syncCommentsNow', {}, session); await load(); setError(null); }
    catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }

  const sel = detail?.comment || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Control row — mirrors the inbox command bar so the two screens feel like siblings. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Seg options={STATES} value={state} onChange={setState} />
        <Seg options={TABS} value={tab} onChange={setTab} />
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search comment or handle…"
          style={{ ...inputStyle, minWidth: 220 }}
        />
        <span style={{ flex: 1 }} />
        {counts.open != null && (
          <span style={pill}>{counts.open} open · {counts.unassigned} unassigned</span>
        )}
        <button onClick={syncNow} disabled={syncing} style={{ ...btnGhost, opacity: syncing ? 0.5 : 1 }}
          title="Pull the latest comments from Instagram now instead of waiting for the 10-minute sync">
          <RefreshCw size={13} /> {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {/* ⚠️ Says WHY it can lag. An agent who believes this is live would read a 9-minute-old
          queue as "nothing new", which is the failure mode this whole screen exists to fix. */}
      <div style={noteBar}>
        <MessageSquare size={13} />
        Instagram comments sync every 10 minutes. Replies you post here appear on the post immediately.
      </div>

      {error && <div style={errBar}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 12, flex: 1, minHeight: 0 }}>
        {/* List */}
        <div style={{ ...panel, overflowY: 'auto' }}>
          {loading ? <div style={{ padding: 24 }}><Spinner /></div>
            : rows.length === 0
              ? <EmptyState title="Nothing here" message={state === 'open' ? 'No open comments.' : 'No comments match.'} />
              : rows.map((c) => (
                <button key={c.id} onClick={() => setSelId(c.id)} style={{
                  ...rowStyle,
                  background: c.id === selId ? 'var(--surface-3)' : 'transparent',
                  borderLeft: `2px solid ${c.id === selId ? 'var(--accent)' : 'transparent'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <Instagram size={12} style={{ color: '#d946ef', flexShrink: 0 }} />
                    <strong style={{ fontSize: 12, color: 'var(--t1)' }}>{c.from_handle || 'unknown'}</strong>
                    {c.status === 'hidden' && <span style={{ ...tinyTag, color: '#d97706' }}>hidden</span>}
                    {c.parent_comment_id && <span style={{ ...tinyTag, color: 'var(--t3)' }}>reply</span>}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: 'var(--t3)' }}>{fmtIstShort(c.posted_at)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.body || '—'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                    {c.replied_at && <span style={{ ...tinyTag, color: '#16a34a' }}>replied</span>}
                    <span style={{ fontSize: 10, color: 'var(--t3)' }}>
                      {c.assigned_agent_name || 'unassigned'}
                    </span>
                  </div>
                </button>
              ))}
        </div>

        {/* Detail */}
        <div style={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!sel ? <EmptyState title="Pick a comment" message="Select a comment to read it in context and reply." />
            : (
              <>
                <div style={{ padding: 12, borderBottom: '1px solid var(--border-1)' }}>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 4 }}>
                    On post {sel.post?.caption
                      ? `“${String(sel.post.caption).slice(0, 70)}${String(sel.post.caption).length > 70 ? '…' : ''}”`
                      : sel.post?.platform_post_id}
                  </div>
                  {sel.post?.permalink && (
                    <a href={sel.post.permalink} target="_blank" rel="noreferrer"
                      style={{ fontSize: 11, color: 'var(--accent)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <ExternalLink size={11} /> View on Instagram
                    </a>
                  )}
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: 12, background: 'var(--surface-2)' }}>
                  <Bubble c={sel} />
                  {(detail?.replies || []).map((r) => <Bubble key={r.id} c={r} indent />)}
                </div>

                <div style={{ borderTop: '1px solid var(--border-1)', padding: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button style={btnGhost} disabled={busy || !canManage}
                    onClick={() => act('assignComment', { comment_id: sel.id, agent_id: sel.assigned_agent_id === user?.id ? null : user?.id })}>
                    <UserPlus size={13} /> {sel.assigned_agent_id === user?.id ? 'Release' : 'Claim'}
                  </button>
                  <button style={btnGhost} disabled={busy || !canManage}
                    onClick={() => act('setCommentState', { comment_id: sel.id, state: sel.comment_state === 'open' ? 'closed' : 'open' })}>
                    {sel.comment_state === 'open' ? <><Check size={13} /> Done</> : <><RotateCcw size={13} /> Reopen</>}
                  </button>
                  <button style={btnGhost} disabled={busy || !canManage}
                    onClick={() => act('setCommentStatus', { comment_id: sel.id, status: sel.status === 'hidden' ? 'visible' : 'hidden' })}>
                    {sel.status === 'hidden' ? <><Eye size={13} /> Unhide</> : <><EyeOff size={13} /> Hide</>}
                  </button>
                  {/* ⚠️ Delete is irreversible on Instagram and gated to cs_ticket_admin, so it
                      asks twice and says what it does — Hide is the reversible sibling. */}
                  {canDelete && (confirmDel
                    ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--bad-fg, #dc2626)' }}>Delete from Instagram permanently?</span>
                        <button style={{ ...btnGhost, color: '#dc2626', borderColor: '#dc2626' }} disabled={busy}
                          onClick={() => { setConfirmDel(false); act('setCommentStatus', { comment_id: sel.id, status: 'deleted' }); }}>
                          Yes, delete
                        </button>
                        <button style={btnGhost} onClick={() => setConfirmDel(false)}>Cancel</button>
                      </span>
                    )
                    : <button style={btnGhost} disabled={busy} onClick={() => setConfirmDel(true)}><Trash2 size={13} /> Delete</button>
                  )}
                </div>

                <div style={{ borderTop: '1px solid var(--border-1)', padding: 10, display: 'flex', gap: 8 }}>
                  <input value={reply} onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                    placeholder={sel.status === 'deleted' ? 'This comment was deleted on Instagram' : 'Reply publicly on the post…'}
                    disabled={!canManage || sel.status === 'deleted'}
                    style={{ ...inputStyle, flex: 1 }} />
                  <button onClick={sendReply} disabled={busy || !canManage || !reply.trim() || sel.status === 'deleted'}
                    style={{ ...btnPrimary, opacity: (busy || !reply.trim() || sel.status === 'deleted') ? 0.5 : 1 }}>
                    <Send size={13} /> Reply
                  </button>
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ c, indent }) {
  const out = c.direction === 'outbound';
  return (
    <div style={{ marginLeft: indent ? 24 : 0, marginBottom: 8 }}>
      <div style={{
        padding: '8px 12px', borderRadius: 10, maxWidth: '90%',
        background: out ? 'rgba(22,163,74,0.12)' : 'var(--surface-1)',
        border: `1px solid ${out ? 'rgba(22,163,74,0.25)' : 'var(--border-1)'}`,
        opacity: c.status === 'deleted' ? 0.5 : 1,
      }}>
        <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 3 }}>
          {out ? 'L.O.T' : (c.from_handle || 'unknown')} · {fmtIstShort(c.posted_at)}
          {c.status === 'hidden' && ' · hidden'}
          {c.status === 'deleted' && ' · deleted'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'pre-wrap' }}>{c.body || '—'}</div>
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border-1)', borderRadius: 6, overflow: 'hidden' }}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{
          padding: '5px 10px', fontSize: 12, border: 'none', cursor: 'pointer',
          background: value === o.id ? 'var(--accent)' : 'transparent',
          color: value === o.id ? '#fff' : 'var(--t2)',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

const panel = { background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, minHeight: 0 };
const rowStyle = {
  display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
  border: 'none', borderBottom: '1px solid var(--border-1)', cursor: 'pointer',
};
const inputStyle = {
  padding: '6px 10px', fontSize: 13, borderRadius: 6,
  border: '1px solid var(--border-1)', background: 'var(--surface-2)', color: 'var(--t1)',
};
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
  background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
  fontWeight: 600, fontSize: 13, cursor: 'pointer',
};
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
  background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border-1)',
  borderRadius: 6, fontSize: 12, cursor: 'pointer',
};
const pill = { fontSize: 11, color: 'var(--t3)', padding: '3px 8px', borderRadius: 999, background: 'var(--surface-2)' };
const tinyTag = { fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 };
const noteBar = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
  background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 6,
  fontSize: 11, color: 'var(--t2)',
};
const errBar = { padding: '8px 12px', background: 'rgba(220,38,38,0.10)', borderRadius: 6, fontSize: 12, color: '#dc2626' };
