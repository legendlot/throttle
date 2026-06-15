'use client';
/* Shared task drawer — used by the Board and the Sprint planner. Shows task
   meta, owner assignment, move-to-stage, reason-required abandon, and the
   comment thread. Owner/abandon hit the throttleops worker (assignTask /
   abandonTask); both are admin/lead-gated server-side, the UI mirrors that.
   Extracted from board/page.js (S135) so /sprints can reuse it. */
import React, { useState, useEffect } from 'react';
import { Icon } from '@/components/throttle/Icon';
import { Avatar, ProductTag } from '@/components/throttle/ui';
import { STAGES, PRIORITY, DTYPE, stageByVal, teamById, taskTag } from '@/lib/throttleData';
import { fetchTaskActivity, postComment, relAge, setTaskOwner, selfAssignOwner, abandonTask } from '@/lib/throttleApi';

const toast = (msg, tone = 'ok', icon) => window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg, tone, icon: icon || (tone === 'bad' ? 'alert' : 'check') } }));

// Per-stage primary/ghost footer actions.
export const NEXT = {
  backlog:     [{ to: 'in_sprint',   label: 'Add to sprint', kind: 'primary' }],
  in_sprint:   [{ to: 'in_progress', label: 'Start work',    kind: 'primary' }, { to: 'backlog', label: 'Send to backlog', kind: 'ghost' }],
  in_progress: [{ to: 'in_review',   label: 'Submit for review', kind: 'primary' }, { to: 'ext_blocked', label: 'Mark blocked', kind: 'ghost' }],
  ext_blocked: [{ to: 'in_progress', label: 'Unblock',       kind: 'primary' }],
  in_review:   [{ to: 'approved',    label: 'Approve',       kind: 'primary' }, { to: 'in_progress', label: 'Request changes', kind: 'ghost' }],
  approved:    [{ to: 'delivered',   label: 'Deliver',       kind: 'primary' }],
  delivered:   [{ to: 'done',        label: 'Mark done',     kind: 'primary' }],
};

export function TaskDrawer({ task, onClose, onMove, session, members = [], role, meId, onChanged }) {
  const [comment, setComment] = useState('');
  const [comments, setComments] = useState(null); // null = loading/seed
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');

  useEffect(() => { setComment(''); setComments(null); setAbandoning(false); setAbandonReason(''); }, [task?.id]);
  useEffect(() => {
    if (!task) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task, onClose]);
  useEffect(() => {
    if (!task || !session) return;
    let cancelled = false;
    (async () => {
      const act = await fetchTaskActivity(session, task.id);
      if (cancelled || !act) return;
      const rows = act.filter(a => a.event_type === 'comment' && a.payload?.comment)
        .map(a => ({ who: a.user?.name || 'Someone', t: relAge(a.created_at), text: a.payload.comment }));
      setComments(rows);
    })();
    return () => { cancelled = true; };
  }, [task, session]);

  if (!task) return null;
  const st = stageByVal[task.stage] || { label: task.stage, color: 'var(--t3)' };
  const pr = PRIORITY[task.priority] || PRIORITY.medium;
  const hasOwner = !!task.ownerId;
  const ownerName = hasOwner ? (task.ownerName || teamById[task.ownerId]?.name || 'Owner') : 'Unassigned';
  const canManage = role === 'admin' || role === 'lead';
  const isClosed = task.stage === 'done' || task.stage === 'abandoned';
  const actions = NEXT[task.stage] || [];
  const SEED_COMMENTS = [
    { who: ownerName, t: '2h ago', text: 'First pass uploaded. Went with the wet-tarmac grade on the hero frame.' },
    { who: 'Aarav Menon', t: '1h ago', text: 'Tighten the logo lockup, otherwise close. Push the yellow rim a touch.' },
  ];
  const shown = comments == null ? (session ? [] : SEED_COMMENTS) : comments;
  const meta = [
    ['Type', DTYPE[task.type] || task.type], ['Priority', pr.label, pr.color],
    ['Due', task.due || '—'], ['Sprint', task.sprintShort || 'S-24'],
  ];

  async function send() {
    const text = comment.trim();
    if (!text) return;
    setComment('');
    if (session) {
      setPosting(true);
      try {
        await postComment(session, task.id, text);
        const act = await fetchTaskActivity(session, task.id);
        if (act) setComments(act.filter(a => a.event_type === 'comment' && a.payload?.comment)
          .map(a => ({ who: a.user?.name || 'Someone', t: relAge(a.created_at), text: a.payload.comment })));
      } catch (e) {
        toast('Comment failed: ' + (e.message || 'error'), 'bad');
      }
      setPosting(false);
    } else {
      setComments(c => [...(c || []), { who: 'You', t: 'now', text }]);
    }
  }

  async function changeOwner(userId) {
    if (!userId || busy) return;
    if (!session) { toast('Sign in to assign an owner', 'bad'); return; }
    setBusy(true);
    try {
      await setTaskOwner(session, task.id, userId);
      const m = members.find(x => x.id === userId);
      toast(`Owner set to ${m ? m.name.split(' ')[0] : 'member'}`);
      onChanged?.(task.id);
    } catch (e) {
      toast('Could not set owner: ' + (e.message || 'not allowed'), 'bad');
    }
    setBusy(false);
  }

  async function assignSelf() {
    if (busy) return;
    if (!session) { toast('Sign in to assign yourself', 'bad'); return; }
    setBusy(true);
    try {
      await selfAssignOwner(session, task.id);
      toast('Assigned to you');
      onChanged?.(task.id);
    } catch (e) {
      toast('Could not assign: ' + (e.message || 'not allowed'), 'bad');
    }
    setBusy(false);
  }

  async function confirmAbandon() {
    const reason = abandonReason.trim();
    if (!reason) { toast('A reason is required to abandon', 'bad'); return; }
    if (busy) return;
    if (!session) { toast('Sign in to abandon a task', 'bad'); return; }
    setBusy(true);
    try {
      await abandonTask(session, task.id, reason);
      toast('Task abandoned');
      setAbandoning(false); setAbandonReason('');
      onChanged?.(task.id);
      onClose();
    } catch (e) {
      toast('Could not abandon: ' + (e.message || 'not allowed'), 'bad');
    }
    setBusy(false);
  }

  return (
    <div onClick={onClose} className="t-drawer-back" style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(8,8,10,0.55)',
      display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="t-drawer-panel" style={{ width: 'min(440px, 94vw)', height: '100%', background: 'var(--surface)',
        borderLeft: '1px solid var(--border-2)', boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span className="num" style={{ fontSize: 12, color: 'var(--yellow)', fontWeight: 600 }}>{taskTag(task.num)}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color }} />{st.label}</span>
          <button onClick={onClose} className="t-iconbtn" style={{ marginLeft: 'auto', width: 30, height: 30 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px' }}>
          <h2 style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 18, color: 'var(--t1)', lineHeight: 1.3, margin: '0 0 16px' }}>{task.title}</h2>
          {task.blocked && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 'var(--r-sm)',
            background: 'var(--warn-bg)', border: '1px solid var(--warn-bd)', color: 'var(--warn-fg)', fontSize: 12.5, marginBottom: 16 }}>
            <Icon name="alert" size={15} />{task.blocked}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px', marginBottom: 18 }}>
            {meta.map(([k, v, c]) => (
              <div key={k}>
                <div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>{k}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: 'var(--t1)' }}>
                  {c && <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />}{v}</div>
              </div>
            ))}
            <div>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>Product</div>
              <ProductTag code={task.product} size="lg" />
            </div>
            <div>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>Owner</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Avatar id={task.ownerId} name={task.ownerName} initial={hasOwner ? task.ownerInitial : '+'} size={24} />
                <span style={{ fontSize: 13, color: hasOwner ? 'var(--t2)' : 'var(--t4)' }}>{hasOwner ? ownerName.split(' ')[0] : 'Unassigned'}{task.collabs > 0 ? ` +${task.collabs}` : ''}</span>
              </div>
              {!isClosed && canManage && (
                <select value={task.ownerId || ''} disabled={busy}
                  onChange={e => changeOwner(e.target.value)}
                  style={{ marginTop: 7, width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)',
                    borderRadius: 'var(--r-sm)', padding: '6px 8px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5, outline: 'none', cursor: 'pointer' }}>
                  <option value="">{hasOwner ? 'Change owner…' : 'Set owner…'}</option>
                  {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
              {!isClosed && !canManage && !hasOwner && (
                <button onClick={assignSelf} disabled={busy} className="t-chip" style={{ marginTop: 7 }}>Assign to me</button>
              )}
            </div>
          </div>

          <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Brief</div>
          <p style={{ fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.6, margin: '0 0 20px' }}>
            {task.product ? `${task.product} ` : ''}deliverable for the current sprint. Match the brand book — dark-first, motorsport energy, no birthday-party context. Final files to the shared drive on approval.
          </p>

          <div className="eyebrow" style={{ padding: 0, marginBottom: 8 }}>Move to stage</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 22 }}>
            {STAGES.map(s => (
              <button key={s.value} onClick={() => onMove(task.id, s.value)} className="t-chip" data-on={s.value === task.stage}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, display: 'inline-block', marginRight: 6 }} />{s.label}
              </button>
            ))}
          </div>

          {!isClosed && canManage && (
            <div style={{ marginBottom: 22 }}>
              {!abandoning ? (
                <button onClick={() => setAbandoning(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                    background: 'transparent', color: 'var(--bad-fg)', border: '1px solid var(--bad-bd, var(--border-2))',
                    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  <Icon name="x" size={13} />Abandon task
                </button>
              ) : (
                <div style={{ padding: '12px', borderRadius: 'var(--r-sm)', background: 'var(--bad-bg, var(--surface-2))', border: '1px solid var(--bad-bd, var(--border-2))' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--t2)', marginBottom: 8 }}>Abandoning is permanent. A reason is required.</div>
                  <textarea value={abandonReason} onChange={e => setAbandonReason(e.target.value)} autoFocus rows={2}
                    placeholder="Why is this being abandoned?"
                    style={{ width: '100%', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '8px 10px',
                      color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                    <button onClick={confirmAbandon} disabled={busy || !abandonReason.trim()}
                      style={{ padding: '7px 14px', borderRadius: 'var(--r-sm)', cursor: busy || !abandonReason.trim() ? 'default' : 'pointer',
                        background: 'var(--bad-fg)', color: '#fff', border: 'none', opacity: busy || !abandonReason.trim() ? 0.5 : 1,
                        fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Confirm abandon</button>
                    <button onClick={() => { setAbandoning(false); setAbandonReason(''); }} className="t-chip">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="eyebrow" style={{ padding: 0, marginBottom: 10 }}>Activity</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
            {shown.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--t4)', margin: 0 }}>No comments yet.</p>}
            {shown.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-3)', border: '1px solid var(--border-2)',
                  display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10.5, color: 'var(--t2)', flexShrink: 0 }}>{c.who[0]}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)' }}>{c.who}</span>
                    <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{c.t}</span>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5, margin: '3px 0 0' }}>{c.text}</p>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} placeholder="Add a comment…"
              style={{ flex: 1, background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '9px 12px',
                color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' }} />
            <button onClick={send} disabled={posting} className="t-iconbtn" style={{ width: 38, height: 38, background: comment ? 'var(--yellow)' : 'var(--card-bg)', color: comment ? '#15140b' : 'var(--t3)', borderColor: comment ? 'var(--yellow)' : 'var(--border)' }}><Icon name="send" size={15} /></button>
          </div>
        </div>

        {actions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            {actions.map(a => (
              <button key={a.to} onClick={() => { onMove(task.id, a.to); if (a.kind === 'primary') onClose(); }} className="t-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase',
                  ...(a.kind === 'primary' ? { background: 'var(--yellow)', color: '#15140b', border: '1px solid var(--yellow)', flex: 1, justifyContent: 'center' }
                    : { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border-2)' }) }}>
                {a.kind === 'primary' && <Icon name="check" size={14} />}{a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
