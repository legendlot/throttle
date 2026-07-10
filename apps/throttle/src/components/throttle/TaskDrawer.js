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
import { fetchTaskActivity, fetchTaskAttachments, fetchTaskBrief, postComment, relAge, setTaskOwner, selfAssignOwner, addCollaborator, abandonTask, submitForReview, approveWork, rejectWork } from '@/lib/throttleApi';

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
  const [reviewing, setReviewing] = useState(false);
  const [reviewLink, setReviewLink] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [attachments, setAttachments] = useState(null);
  const [brief, setBrief] = useState(null);

  useEffect(() => { setComment(''); setComments(null); setAbandoning(false); setAbandonReason(''); setReviewing(false); setReviewLink(''); setRejecting(false); setRejectFeedback(''); setAttachments(null); setBrief(null); }, [task?.id]);
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
      if (!cancelled && act) {
        const rows = act.filter(a => a.event_type === 'comment' && a.payload?.comment)
          .map(a => ({ who: a.user?.name || 'Someone', t: relAge(a.created_at), text: a.payload.comment }));
        setComments(rows);
      }
      const att = await fetchTaskAttachments(session, task.id);
      if (!cancelled) setAttachments(att || []);
      const br = task.requestId ? await fetchTaskBrief(session, task.requestId) : null;
      if (!cancelled) setBrief(br || { notes: null, reference: null, fields: [] });
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

  async function addCollab(userId) {
    if (!userId || busy) return;
    if (!session) { toast('Sign in to add a collaborator', 'bad'); return; }
    setBusy(true);
    try {
      await addCollaborator(session, task.id, userId);
      const m = members.find(x => x.id === userId);
      toast(`Added ${m ? m.name.split(' ')[0] : 'collaborator'}`);
      onChanged?.(task.id);
    } catch (e) {
      toast('Could not add collaborator: ' + (e.message || 'error'), 'bad');
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

  // Transitions that must NOT be bare stage moves — each has to hit a dedicated
  // worker action (records an attachment / approval / feedback + Slack). If routed
  // through onMove (updateTaskStage) those side-effects are silently skipped.
  const isDeferred = to =>
    (to === 'in_review' && task.stage !== 'in_review') ||               // submit-for-review (needs link)
    (task.stage === 'in_review' && to === 'approved') ||                // approveWork (records approval)
    (task.stage === 'in_review' && to === 'in_progress');               // rejectWork (feedback required)

  function handleMove(id, to) {
    if (task.stage === 'in_review' && to === 'approved') { doApprove(); return; }
    if (task.stage === 'in_review' && to === 'in_progress') { setRejecting(true); return; }
    if (to === 'in_review' && task.stage !== 'in_review') { setReviewing(true); return; }
    onMove(id, to);
  }

  async function doApprove() {
    if (busy) return;
    if (!session) { onMove(task.id, 'approved'); onClose(); return; }  // no-session dev preview
    setBusy(true);
    try {
      await approveWork(session, task.id);
      toast('Work approved');
      onChanged?.(task.id);
      onClose();
    } catch (e) {
      toast('Could not approve: ' + (e.message || 'not allowed'), 'bad');
    }
    setBusy(false);
  }

  async function confirmReject() {
    const fb = rejectFeedback.trim();
    if (!fb) { toast('Feedback is required to request changes', 'bad'); return; }
    if (busy) return;
    if (!session) { onMove(task.id, 'in_progress'); setRejecting(false); setRejectFeedback(''); onClose(); return; }
    setBusy(true);
    try {
      await rejectWork(session, task.id, fb);
      toast('Sent back for changes');
      setRejecting(false); setRejectFeedback('');
      onChanged?.(task.id);
      onClose();
    } catch (e) {
      toast('Could not request changes: ' + (e.message || 'not allowed'), 'bad');
    }
    setBusy(false);
  }

  async function confirmReview() {
    const link = reviewLink.trim();
    if (!link) { toast('A work link is required to submit for review', 'bad'); return; }
    if (busy) return;
    if (!session) { toast('Sign in to submit for review', 'bad'); return; }
    setBusy(true);
    try {
      await submitForReview(session, task.id, link);
      toast('Submitted for review');
      setReviewing(false); setReviewLink('');
      onChanged?.(task.id);
      onClose();
    } catch (e) {
      toast('Could not submit: ' + (e.message || 'error'), 'bad');
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

          {/* Collaborators — add contributors from the Board/Sprint drawer (mirrors the side panel) */}
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Collaborators</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: task.collabs > 0 ? 'var(--t2)' : 'var(--t4)' }}>
                {task.collabs > 0 ? `${task.collabs} added` : 'None'}
              </span>
              {!isClosed && members.filter(m => m.id !== task.ownerId).length > 0 && (
                <select value="" disabled={busy}
                  onChange={e => addCollab(e.target.value)}
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
                    padding: '6px 8px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 12.5, outline: 'none', cursor: 'pointer' }}>
                  <option value="">Add collaborator…</option>
                  {members.filter(m => m.id !== task.ownerId).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
            </div>
          </div>

          <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Brief</div>
          {brief == null ? (
            <p style={{ fontSize: 13, color: 'var(--t4)', margin: '0 0 20px' }}>Loading…</p>
          ) : (brief.notes || brief.fields.length > 0 || brief.reference) ? (
            <div style={{ margin: '0 0 20px' }}>
              {brief.notes && (
                <p style={{ fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.6, margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{brief.notes}</p>
              )}
              {brief.fields.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontSize: 13, lineHeight: 1.5 }}>
                  {brief.fields.map(f => (
                    <React.Fragment key={f.label}>
                      <span style={{ color: 'var(--t4)' }}>{f.label}</span>
                      <span style={{ color: 'var(--t2)' }}>{f.value}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
              {brief.reference && (/^https?:\/\//i.test(brief.reference)
                ? <a href={brief.reference} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12.5, color: 'var(--yellow)', textDecoration: 'none' }}>
                    <Icon name="link" size={13} />Reference</a>
                : <p style={{ fontSize: 13, color: 'var(--t4)', margin: '10px 0 0' }}>Reference: <span style={{ color: 'var(--t2)' }}>{brief.reference}</span></p>)}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--t4)', fontStyle: 'italic', margin: '0 0 20px' }}>No brief provided.</p>
          )}

          {attachments && attachments.length > 0 && (
            <>
              <div className="eyebrow" style={{ padding: 0, marginBottom: 8 }}>Submitted work</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 20 }}>
                {attachments.map(a => (
                  <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 'var(--r-sm)',
                      background: 'var(--bg-2)', border: '1px solid var(--border-2)', color: 'var(--t1)', textDecoration: 'none',
                      fontSize: 13, transition: 'border-color .15s' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--yellow)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-2)'}>
                    <Icon name="link" size={14} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label || a.url}</span>
                    <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{relAge(a.created_at)}</span>
                  </a>
                ))}
              </div>
            </>
          )}

          <div className="eyebrow" style={{ padding: 0, marginBottom: 8 }}>Move to stage</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 22 }}>
            {STAGES.map(s => (
              <button key={s.value} onClick={() => handleMove(task.id, s.value)} className="t-chip" data-on={s.value === task.stage}>
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

        {reviewing ? (
          <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Submit for review</div>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', marginBottom: 8 }}>Paste the link to your finished work (Drive, Figma, etc.) — required. The lead reviews this to approve.</div>
            <input value={reviewLink} onChange={e => setReviewLink(e.target.value)} autoFocus placeholder="https://…"
              onKeyDown={e => { if (e.key === 'Enter') confirmReview(); }}
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
                padding: '9px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <button onClick={confirmReview} disabled={busy || !reviewLink.trim()}
                style={{ flex: 1, justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 'var(--r-sm)',
                  cursor: busy || !reviewLink.trim() ? 'default' : 'pointer', background: 'var(--yellow)', color: '#15140b', border: '1px solid var(--yellow)',
                  opacity: busy || !reviewLink.trim() ? 0.5 : 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                <Icon name="check" size={14} />Submit for review</button>
              <button onClick={() => { setReviewing(false); setReviewLink(''); }} className="t-chip">Cancel</button>
            </div>
          </div>
        ) : rejecting ? (
          <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Request changes</div>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', marginBottom: 8 }}>Tell the owner what needs to change — required. Sends the task back to In Progress and notifies them.</div>
            <textarea value={rejectFeedback} onChange={e => setRejectFeedback(e.target.value)} autoFocus rows={3}
              placeholder="What needs changing before this can be approved?"
              style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
                padding: '9px 12px', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
              <button onClick={confirmReject} disabled={busy || !rejectFeedback.trim()}
                style={{ flex: 1, justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 'var(--r-sm)',
                  cursor: busy || !rejectFeedback.trim() ? 'default' : 'pointer', background: 'var(--yellow)', color: '#15140b', border: '1px solid var(--yellow)',
                  opacity: busy || !rejectFeedback.trim() ? 0.5 : 1, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                <Icon name="send" size={14} />Send back</button>
              <button onClick={() => { setRejecting(false); setRejectFeedback(''); }} className="t-chip">Cancel</button>
            </div>
          </div>
        ) : actions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            {actions.map(a => (
              <button key={a.to} onClick={() => { handleMove(task.id, a.to); if (a.kind === 'primary' && !isDeferred(a.to)) onClose(); }} className="t-btn"
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
