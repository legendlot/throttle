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
import { TaskDrawer } from '@/components/throttle/TaskDrawer';
import { STAGES, PRIORITY, DTYPE, TASKS, TEAM, stageByVal, teamById, taskTag } from '@/lib/throttleData';
import { fetchUsers, fetchTasks, moveTaskStage } from '@/lib/throttleApi';

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

function BoardScreen() {
  const { session, role, brandUser } = useAuth();
  // Logged in → show real data or empty; seed only in the no-session dev preview.
  const [tasks, setTasks] = useState(session ? [] : TASKS);
  const [usersById, setUsersById] = useState(session ? {} : teamById);
  const [members, setMembers] = useState(session ? [] : TEAM.filter(t => t.role === 'member'));
  const [view, setView] = useState('kanban');
  const [person, setPerson] = useState(null);
  const [selected, setSelected] = useState(null);
  const [over, setOver] = useState(null);

  // Reusable loader — also called after assign/abandon to refresh the board.
  // reselectId keeps the drawer open on the freshly-loaded copy of that task
  // (e.g. after an owner change); if the task left the board it closes.
  const reload = React.useCallback(async (reselectId) => {
    if (!session) return;
    const usersRes = await fetchUsers(session);
    const byId = usersRes?.byId || {};
    const t = await fetchTasks(session, byId);
    if (usersRes?.list?.length) {
      setUsersById(byId);
      setMembers(usersRes.list.filter(u => u.role === 'member' || u.role === 'lead'));
    }
    const list = t || [];
    setTasks(list);
    if (reselectId) setSelected(list.find(x => x.id === reselectId) || null);
  }, [session]);

  useEffect(() => { reload(); }, [reload]);

  const move = async (id, stage) => {
    const prevTasks = tasks;
    setTasks(prev => prev.map(t => t.id === id ? { ...t, stage } : t));
    setSelected(prev => prev && prev.id === id ? { ...prev, stage } : prev);
    if (session) {
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

      <TaskDrawer task={selected} onClose={() => setSelected(null)} onMove={move} session={session}
        members={members} role={role} meId={brandUser?.id} onChanged={reload} />
    </div>
  );
}

export default function BoardPage() {
  return <AppShell route="board"><BoardScreen /></AppShell>;
}
