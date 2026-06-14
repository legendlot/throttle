'use client';
/* Board — production kanban + table, drag-to-move between stages, task
   drawer (move / submit / approve / deliver + comment thread). Live tasks
   from the brand schema; stage moves via updateTaskStage; comments via
   getTaskActivity / addComment. Ported from board.jsx; seed fallback. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card, Pill, Avatar, ProductTag, PrimaryBtn } from '@/components/throttle/ui';
import { STAGES, PRIORITY, DTYPE, TASKS, TEAM, stageByVal, teamById, taskTag } from '@/lib/throttleData';
import { fetchUsers, fetchTasks, fetchTaskActivity, postComment, moveTaskStage, relAge } from '@/lib/throttleApi';

const NEXT = {
  backlog:     [{ to: 'in_sprint',   label: 'Add to sprint', kind: 'primary' }],
  in_sprint:   [{ to: 'in_progress', label: 'Start work',    kind: 'primary' }, { to: 'backlog', label: 'Send to backlog', kind: 'ghost' }],
  in_progress: [{ to: 'in_review',   label: 'Submit for review', kind: 'primary' }, { to: 'ext_blocked', label: 'Mark blocked', kind: 'ghost' }],
  ext_blocked: [{ to: 'in_progress', label: 'Unblock',       kind: 'primary' }],
  in_review:   [{ to: 'approved',    label: 'Approve',       kind: 'primary' }, { to: 'in_progress', label: 'Request changes', kind: 'ghost' }],
  approved:    [{ to: 'delivered',   label: 'Deliver',       kind: 'primary' }],
  delivered:   [{ to: 'done',        label: 'Mark done',     kind: 'primary' }],
};
const newReq = () => window.dispatchEvent(new CustomEvent('throttle:newreq'));

function TaskCard({ task, onOpen }) {
  const pr = PRIORITY[task.priority] || PRIORITY.medium;
  const dueTone = task.age === 'crit' ? 'var(--bad-fg)' : task.age === 'warn' ? 'var(--warn-fg)' : 'var(--t3)';
  return (
    <div className="t-card t-task" draggable
      onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => onOpen(task)}
      style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
        borderTop: `2px solid ${pr.color}`, padding: '10px 12px 11px', cursor: 'pointer', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>{taskTag(task.num)}</span>
          <span style={{ fontSize: 10.5, color: 'var(--t4)', fontFamily: 'var(--font-display)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{DTYPE[task.type] || task.type}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {task.blocked && <span title={task.blocked} style={{ color: 'var(--warn-fg)', display: 'flex' }}><Icon name="alert" size={13} /></span>}
          {task.age && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dueTone }} />}
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--t1)', lineHeight: 1.4, margin: '0 0 10px', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{task.title}</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <ProductTag code={task.product} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {task.due && <span className="num" style={{ fontSize: 11, color: dueTone, fontWeight: task.age ? 600 : 400 }}>{task.due}</span>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <Avatar id={task.ownerId} name={task.ownerName} initial={task.ownerInitial} size={21} />
            {task.collabs > 0 && <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>+{task.collabs}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Column({ stage, tasks, onOpen, onDropTask, over, setOver }) {
  return (
    <div style={{ width: 252, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%' }}
      onDragOver={e => { e.preventDefault(); setOver(stage.value); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(o => o === stage.value ? null : o); }}
      onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); onDropTask(id, stage.value); setOver(null); }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 4px 11px', flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: stage.color }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: stage.color }}>{stage.label}</span>
        <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '1px 8px', borderRadius: 999, fontWeight: 600 }}>{tasks.length}</span>
      </div>
      <div className="t-col-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '4px', borderRadius: 'var(--r-sm)', transition: 'background .12s, box-shadow .12s',
        background: over === stage.value ? 'var(--surface-2)' : 'transparent',
        boxShadow: over === stage.value ? 'inset 0 0 0 1px var(--border-3)' : 'none' }}>
        {tasks.map(t => <TaskCard key={t.id} task={t} onOpen={onOpen} />)}
        {tasks.length === 0 && <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--t4)', fontSize: 11.5 }}>{over === stage.value ? 'Drop here' : 'Empty'}</div>}
      </div>
    </div>
  );
}

function TaskDrawer({ task, onClose, onMove, session }) {
  const [comment, setComment] = useState('');
  const [comments, setComments] = useState(null); // null = loading/seed
  const [posting, setPosting] = useState(false);

  useEffect(() => { setComment(''); setComments(null); }, [task?.id]);
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
  const ownerName = task.ownerName || teamById[task.ownerId]?.name || 'Owner';
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
        window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg: 'Comment failed: ' + (e.message || 'error'), tone: 'bad', icon: 'alert' } }));
      }
      setPosting(false);
    } else {
      setComments(c => [...(c || []), { who: 'You', t: 'now', text }]);
    }
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
              <div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>Assignees</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Avatar id={task.ownerId} name={task.ownerName} initial={task.ownerInitial} size={24} />
                <span style={{ fontSize: 13, color: 'var(--t2)' }}>{ownerName.split(' ')[0]}{task.collabs > 0 ? ` +${task.collabs}` : ''}</span>
              </div>
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

function BoardScreen() {
  const { session } = useAuth();
  const [tasks, setTasks] = useState(TASKS);
  const [usersById, setUsersById] = useState(teamById);
  const [members, setMembers] = useState(() => TEAM.filter(t => t.role === 'member'));
  const [view, setView] = useState('kanban');
  const [person, setPerson] = useState(null);
  const [selected, setSelected] = useState(null);
  const [over, setOver] = useState(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const usersRes = await fetchUsers(session);
      const byId = usersRes?.byId || {};
      const t = await fetchTasks(session, byId);
      if (cancelled) return;
      if (usersRes?.list?.length) {
        setUsersById(byId);
        setMembers(usersRes.list.filter(u => u.role === 'member' || u.role === 'lead'));
      }
      if (t) { setTasks(t); setLive(true); }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const move = async (id, stage) => {
    const prevTasks = tasks;
    setTasks(prev => prev.map(t => t.id === id ? { ...t, stage } : t));
    setSelected(prev => prev && prev.id === id ? { ...prev, stage } : prev);
    if (live && session) {
      try { await moveTaskStage(session, id, stage, stage === 'ext_blocked' ? 'Flagged from the board' : undefined); }
      catch (e) {
        setTasks(prevTasks);
        window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg: 'Move failed: ' + (e.message || 'not allowed'), tone: 'bad', icon: 'alert' } }));
      }
    }
  };

  useEffect(() => {
    const open = id => { const f = tasks.find(t => t.id === id) || (id === 'review' && tasks.find(t => t.stage === 'in_review')); if (f) setSelected(f); };
    if (typeof window !== 'undefined' && window.__throttleOpenTask) { open(window.__throttleOpenTask); delete window.__throttleOpenTask; }
    const onEvt = e => { open(e.detail); if (typeof window !== 'undefined') delete window.__throttleOpenTask; };
    window.addEventListener('throttle:opentask', onEvt);
    return () => window.removeEventListener('throttle:opentask', onEvt);
  }, [tasks]);

  const visible = person ? tasks.filter(t => t.ownerId === person) : tasks;
  const reviewCount = visible.filter(t => t.stage === 'in_review').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexShrink: 0, flexWrap: 'wrap' }}>
        <span className="eyebrow" style={{ padding: 0 }}>{visible.length} active</span>
        {reviewCount > 0 && <Pill tone="info" dot>{reviewCount} awaiting review</Pill>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button onClick={() => setPerson(null)} className="t-chip" data-on={person === null}>All</button>
            {members.map(m => (
              <button key={m.id} onClick={() => setPerson(m.id)} className="t-chip" data-on={person === m.id} title={m.name}>{m.name.split(' ')[0]}</button>
            ))}
          </div>
          <div style={{ display: 'flex', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 2 }}>
            {['kanban', 'table'].map(v => (
              <button key={v} onClick={() => setView(v)} style={{ padding: '6px 13px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase', borderRadius: 4, border: 'none', cursor: 'pointer',
                background: view === v ? 'var(--surface-3)' : 'transparent', color: view === v ? 'var(--t1)' : 'var(--t3)' }}>{v}</button>
            ))}
          </div>
          <PrimaryBtn icon="plus" onClick={newReq}>New request</PrimaryBtn>
        </div>
      </div>

      {view === 'kanban' ? (
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 14, height: '100%', minWidth: 'max-content', paddingBottom: 4 }}>
            {STAGES.map(s => <Column key={s.value} stage={s} over={over} setOver={setOver} onOpen={setSelected} onDropTask={move} tasks={visible.filter(t => t.stage === s.value)} />)}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <Card pad={0}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-ui)' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Task', 'Stage', 'Priority', 'Product', 'Owner', 'Due'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '11px 14px', fontFamily: 'var(--font-display)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {visible.map((t, i) => {
                  const stt = stageByVal[t.stage] || { label: t.stage, color: 'var(--t3)' };
                  const pr = PRIORITY[t.priority] || PRIORITY.medium;
                  return (
                    <tr key={t.id} className="t-row" onClick={() => setSelected(t)} style={{ borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{taskTag(t.num)}</span>
                          <span style={{ fontSize: 13, color: 'var(--t1)' }}>{t.title}</span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: stt.color }} />{stt.label}</span></td>
                      <td style={{ padding: '10px 14px' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: pr.color }} />{pr.label}</span></td>
                      <td style={{ padding: '10px 14px' }}><ProductTag code={t.product} /></td>
                      <td style={{ padding: '10px 14px' }}><Avatar id={t.ownerId} name={t.ownerName} initial={t.ownerInitial} size={22} /></td>
                      <td style={{ padding: '10px 14px' }}><span className="num" style={{ fontSize: 12, color: t.age === 'crit' ? 'var(--bad-fg)' : t.age === 'warn' ? 'var(--warn-fg)' : 'var(--t3)' }}>{t.due || '—'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      <TaskDrawer task={selected} onClose={() => setSelected(null)} onMove={move} session={session} />
    </div>
  );
}

export default function BoardPage() {
  return <AppShell route="board"><BoardScreen /></AppShell>;
}
