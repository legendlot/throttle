'use client';
/* Sprints — active summary, burndown, velocity, per-person load, all-sprints
   timeline + a drag-to-plan planner that commits real backlog tasks into the
   active sprint (addTaskToSprint).

   Real-data rule: with a session, everything is real or an honest empty state —
   no seed, no invented story-points/capacity. Burndown draws the ideal
   trajectory (committed → 0) plus the real current-remaining marker (there is
   no daily-snapshot series to plot a fake actual line). Seed renders only in
   the no-session dev preview. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card, Pill, Avatar, ProductTag, PrimaryBtn, SectionHead, TONE } from '@/components/throttle/ui';
import { TaskDrawer } from '@/components/throttle/TaskDrawer';
import { toast } from '@/components/throttle/ToastHost';
import { SPRINTS, CAPACITY, PLAN_BACKLOG, DTYPE, PRIORITY, teamById, TEAM } from '@/lib/throttleData';
import { fetchSprints, fetchDashboardStats, fetchTeamWorkload, fetchUsers, fetchTasks, addTaskToSprint, moveTaskStage } from '@/lib/throttleApi';

function PlanCard({ task, where, onStage, onOpen }) {
  const pr = PRIORITY[task.priority] || PRIORITY.medium;
  return (
    <div draggable onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => onOpen(task)}
      className="t-card t-task" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
        borderLeft: `2px solid ${pr.color}`, padding: '10px 11px', cursor: 'pointer', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--t1)', lineHeight: 1.35, marginBottom: 6 }}>{task.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-display)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{DTYPE[task.type] || task.type}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProductTag code={task.product} />
              <Avatar id={task.ownerId} name={task.ownerName} initial={task.ownerInitial} size={20} />
            </div>
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onStage(task.id); }}
          title={where === 'backlog' ? 'Add to sprint' : 'Remove from sprint'} className="t-iconbtn"
          style={{ width: 26, height: 26, flexShrink: 0, color: 'var(--t3)' }}><Icon name={where === 'backlog' ? 'plus' : 'x'} size={14} /></button>
      </div>
    </div>
  );
}

function SprintPlanner({ onClose, sprint, backlog, usersById, members = [], role, canPlan, session, onCommitted, onTaskChanged }) {
  const [staged, setStaged] = useState([]); // task ids selected for commit
  const [over, setOver] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null); // task open in the drawer
  const byId = Object.fromEntries(backlog.map(t => [t.id, t]));
  const inSprint = staged.map(id => byId[id]).filter(Boolean);
  const available = backlog.filter(t => !staged.includes(t.id));

  // Keep the open drawer fresh after a reload (e.g. owner just changed).
  useEffect(() => { if (selected) { const fresh = byId[selected.id]; if (fresh) setSelected(fresh); } }, [backlog]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawerMove = async (id, stage) => {
    setSelected(prev => prev && prev.id === id ? { ...prev, stage } : prev);
    if (!session) return;
    try { await moveTaskStage(session, id, stage, stage === 'ext_blocked' ? 'Flagged from planner' : undefined); onTaskChanged?.(); }
    catch (e) { toast('Move failed: ' + (e.message || 'not allowed'), 'bad', 'alert'); }
  };

  const loadByPerson = {};
  inSprint.forEach(t => { const k = t.ownerId || 'unassigned'; loadByPerson[k] = (loadByPerson[k] || 0) + 1; });

  const add = id => setStaged(c => c.includes(id) ? c : [...c, id]);
  const remove = id => setStaged(c => c.filter(x => x !== id));
  const drop = (id, target) => { target === 'sprint' ? add(id) : remove(id); setOver(null); };

  const commit = async () => {
    if (!staged.length) { toast('Drag tasks in before committing.', 'warn', 'alert'); return; }
    if (!canPlan) { toast('Only leads and admins can plan sprints.', 'bad', 'alert'); return; }
    if (!sprint?.id || !session) { toast(`Sprint planned · ${staged.length} task${staged.length === 1 ? '' : 's'}`, 'ok', 'check'); onClose(); return; }
    setBusy(true);
    let ok = 0, fail = 0;
    for (const id of staged) {
      try { await addTaskToSprint(session, id, sprint.id); ok++; } catch (_) { fail++; }
    }
    setBusy(false);
    toast(fail ? `Committed ${ok}, ${fail} failed` : `Sprint ${sprint.shortId || ''} planned · ${ok} task${ok === 1 ? '' : 's'} committed`, fail ? 'warn' : 'ok', fail ? 'alert' : 'check');
    onCommitted && onCommitted();
    onClose();
  };

  const colHead = (title, count, sub) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 4px 11px', flexShrink: 0 }}>
      <span className="t-h3">{title}</span>
      <span className="num" style={{ fontSize: 11.5, color: 'var(--t2)', background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '1px 8px', borderRadius: 999, fontWeight: 600 }}>{count}</span>
      {sub && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--t4)' }}>{sub}</span>}
    </div>
  );
  const dropZone = (target, children, empty) => (
    <div className="t-col-scroll" onDragOver={e => { e.preventDefault(); setOver(target); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(o => o === target ? null : o); }}
      onDrop={e => { e.preventDefault(); drop(e.dataTransfer.getData('text/plain'), target); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, borderRadius: 'var(--r-sm)',
        background: over === target ? 'var(--surface-2)' : 'var(--bg-2)', border: '1px solid var(--border)',
        boxShadow: over === target ? 'inset 0 0 0 1px var(--border-3)' : 'none', transition: 'background .12s' }}>
      {children}
      {React.Children.count(children) === 0 && <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--t4)', fontSize: 12.5, padding: '20px' }}>{empty}</div>}
    </div>
  );

  const sid = sprint?.shortId || sprint?.id || 'sprint';
  const people = Object.keys(loadByPerson);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', maxWidth: 1240, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexShrink: 0, flexWrap: 'wrap' }}>
        <div>
          <button onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, padding: 0, marginBottom: 6, whiteSpace: 'nowrap' }}>
            <Icon name="chevronLeft" size={14} />Back to sprint</button>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: 0 }}>Plan {sid}</h1>
          <span className="eyebrow" style={{ padding: 0, marginTop: 5, display: 'block' }}>{sprint?.range || ''} · drag approved backlog in</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <PrimaryBtn icon="check" onClick={commit}>{busy ? 'Committing…' : 'Commit sprint'}</PrimaryBtn>
        </div>
      </div>

      <Card style={{ marginBottom: 16, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 28, color: 'var(--yellow)', lineHeight: 1 }}>{staged.length}</span>
              <span className="num" style={{ fontSize: 14, color: 'var(--t3)' }}>staged</span>
            </div>
            <div className="eyebrow" style={{ padding: 0, marginTop: 5 }}>{available.length} in backlog</div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ height: 12, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${backlog.length ? Math.min(100, (staged.length / backlog.length) * 100) : 0}%`, background: 'var(--yellow)', transition: 'width .2s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>{staged.length} of {backlog.length} backlog tasks staged</span>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>{people.length} {people.length === 1 ? 'person' : 'people'} loaded</span>
            </div>
          </div>
          {!canPlan && <Pill tone="warn" dot>View only — leads plan sprints</Pill>}
        </div>
      </Card>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 230px', gap: 14, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {colHead('Backlog', available.length, 'approved')}
          {dropZone('backlog', available.map(t => <PlanCard key={t.id} task={t} where="backlog" onStage={add} onOpen={setSelected} />), backlog.length ? 'All pulled in.' : 'Backlog is empty.')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {colHead(sid, inSprint.length, inSprint.length + ' tasks')}
          {dropZone('sprint', inSprint.map(t => <PlanCard key={t.id} task={t} where="sprint" onStage={remove} onOpen={setSelected} />), 'Drag tasks here to commit them.')}
        </div>
        <Card pad={0} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '13px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}><span className="t-h3">Load</span></div>
          <div style={{ padding: '8px 14px', overflowY: 'auto' }}>
            {people.length === 0 && <div style={{ padding: '14px 0', color: 'var(--t4)', fontSize: 12, textAlign: 'center' }}>Nothing staged.</div>}
            {people.map((uid, i) => {
              const u = usersById[uid] || teamById[uid];
              const load = loadByPerson[uid] || 0;
              return (
                <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <Avatar id={typeof uid === 'string' && uid.startsWith('u') ? uid : undefined} name={u?.name} initial={u?.initial} size={20} />
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u?.name?.split(' ')[0] || 'Unassigned'}</span>
                  <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 }}>{load}</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <TaskDrawer task={selected} onClose={() => setSelected(null)} onMove={drawerMove} session={session}
        members={members} role={role} onChanged={() => onTaskChanged?.()} />
    </div>
  );
}

function Burndown({ committed, done, todayFrac }) {
  const W = 560, H = 200, pad = { l: 28, r: 12, t: 14, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const N = 10;
  const maxV = Math.max(committed, 1);
  const remaining = Math.max(0, committed - done);
  const xs = i => pad.l + (i / (N - 1)) * iw;
  const ys = v => pad.t + (1 - v / maxV) * ih;
  const idealPath = Array.from({ length: N }, (_, i) => committed * (1 - i / (N - 1)))
    .map((v, i) => (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1)).join(' ');
  const todayIdx = Math.round(Math.max(0, Math.min(1, todayFrac)) * (N - 1));
  const actualPath = `M${xs(0).toFixed(1)} ${ys(committed).toFixed(1)} L${xs(todayIdx).toFixed(1)} ${ys(remaining).toFixed(1)}`;
  const gridVals = [0, Math.round(maxV / 2), maxV];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {gridVals.map(v => (
        <g key={v}>
          <line x1={pad.l} y1={ys(v)} x2={W - pad.r} y2={ys(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4" />
          <text x={pad.l - 7} y={ys(v) + 3} textAnchor="end" fontSize="9" fill="var(--t4)" fontFamily="var(--font-mono)">{v}</text>
        </g>
      ))}
      {['D1', '', '', '', 'Mid', '', '', '', '', 'End'].map((d, i) => d && <text key={i} x={xs(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--t4)" fontFamily="var(--font-mono)">{d}</text>)}
      <path d={idealPath} fill="none" stroke="var(--t4)" strokeWidth="1.5" strokeDasharray="4 4" />
      <path d={actualPath} fill="none" stroke="var(--yellow)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs(todayIdx)} cy={ys(remaining)} r="4" fill="var(--yellow)" stroke="var(--bg)" strokeWidth="2" />
    </svg>
  );
}

function VelocityCard({ sprints }) {
  const hist = sprints.filter(s => s.status !== 'planned').slice(0, 3).reverse();
  const closed = sprints.filter(s => s.status === 'closed');
  const avg = closed.length ? Math.round(closed.reduce((a, b) => a + (b.done || 0), 0) / closed.length) : 0;
  const maxC = Math.max(1, ...hist.map(s => s.committed || 0));
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="activity" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">Velocity</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, color: 'var(--yellow)' }}>{avg}</span>
          <span className="eyebrow" style={{ padding: 0 }}>avg done / sprint</span>
        </span>
      </div>
      {hist.length === 0 || hist.every(s => !s.committed) ? (
        <div style={{ padding: '34px 16px', textAlign: 'center', color: 'var(--t4)', fontSize: 12.5 }}>Not enough closed-sprint history yet.</div>
      ) : (
      <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, padding: '20px 22px 10px', height: 188, justifyContent: 'center' }}>
        {hist.map(s => (
          <div key={s.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
            <span className="num" style={{ fontSize: 12, color: 'var(--t1)', fontWeight: 700 }}>{s.done}<span style={{ color: 'var(--t4)', fontWeight: 400 }}>/{s.committed}</span></span>
            <div style={{ position: 'relative', width: 46, height: 120, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${((s.committed || 0) / maxC) * 100}%`, background: 'var(--p-wolf)', opacity: 0.3 }} />
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${((s.done || 0) / maxC) * 100}%`, background: s.status === 'active' ? 'var(--yellow)' : 'var(--ok-fg)' }} />
            </div>
            <span className="num" style={{ fontSize: 11, color: s.status === 'active' ? 'var(--yellow)' : 'var(--t3)', fontWeight: 600 }}>{s.shortId || s.id}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, padding: '8px 16px 14px', borderTop: '1px solid var(--border)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ok-fg)' }} />Done</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-wolf)', opacity: 0.5 }} />Committed</span>
      </div>
      </>
      )}
    </Card>
  );
}

function LoadPanel({ rows }) {
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="users" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">Workload this sprint</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ok-fg)' }} />Done</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-wolf)' }} />Assigned</span>
        </div>
      </div>
      <div style={{ padding: '8px 16px 14px' }}>
        {rows.length === 0 && <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--t4)', fontSize: 12.5 }}>No assignments in this sprint yet.</div>}
        {rows.map((c, i) => {
          const max = Math.max(1, c.committed);
          return (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: 168, flexShrink: 0 }}>
                <Avatar id={typeof c.id === 'string' && c.id.startsWith('u') ? c.id : undefined} name={c.name} initial={c.initial} size={24} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                  <div className="eyebrow" style={{ padding: 0, fontSize: 8.5 }}>{c.discipline}</div>
                </div>
              </div>
              <div style={{ flex: 1, position: 'relative', height: 12, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, width: '100%', background: 'var(--p-wolf)', opacity: 0.45 }} />
                <div style={{ position: 'absolute', inset: 0, width: `${(c.done / max) * 100}%`, background: 'var(--ok-fg)' }} />
              </div>
              <span className="num" style={{ fontSize: 12, color: 'var(--t2)', width: 56, textAlign: 'right' }}>{c.done}/{c.committed}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function SprintsScreen() {
  const { session, role } = useAuth();
  const live = !!session;
  const canPlan = role === 'admin' || role === 'lead' || !live;
  const [planning, setPlanning] = useState(false);
  const [sprints, setSprints] = useState(live ? [] : SPRINTS);
  const [stats, setStats] = useState(null);
  const [loadRows, setLoadRows] = useState(live ? [] : CAPACITY.map(c => { const u = teamById[c.id]; return { id: c.id, name: u.name, discipline: u.discipline, initial: u.initial, committed: c.committed, done: c.done }; }));
  const [backlog, setBacklog] = useState(live ? [] : PLAN_BACKLOG);
  const [usersById, setUsersById] = useState(teamById);
  const [members, setMembers] = useState(live ? [] : TEAM.filter(t => t.role === 'member' || t.role === 'lead'));
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onPlan = () => setPlanning(true);
    window.addEventListener('throttle:plansprint', onPlan);
    return () => window.removeEventListener('throttle:plansprint', onPlan);
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const usersRes = await fetchUsers(session);
      const byId = usersRes?.byId || {};
      const [s, st, wl, tasks] = await Promise.all([
        fetchSprints(session), fetchDashboardStats(session), fetchTeamWorkload(session), fetchTasks(session, byId),
      ]);
      if (cancelled) return;
      if (usersRes?.list?.length) { setUsersById(byId); setMembers(usersRes.list.filter(u => u.role === 'member' || u.role === 'lead')); }
      if (s) setSprints(s);
      if (st && typeof st.doneCount === 'number') setStats(st);
      if (wl?.rows?.length) {
        const agg = {};
        wl.rows.forEach(r => {
          const p = agg[r.id] || (agg[r.id] = { id: r.id, name: r.name, discipline: r.discipline || '', committed: 0, done: 0 });
          const n = Number(r.task_count) || 0;
          p.committed += n;
          if (r.stage === 'done' || r.stage === 'approved' || r.stage === 'delivered') p.done += n;
        });
        setLoadRows(Object.values(agg).filter(p => p.committed > 0).sort((a, b) => b.committed - a.committed));
      } else setLoadRows([]);
      if (tasks) setBacklog(tasks.filter(t => t.stage === 'backlog'));
    })();
    return () => { cancelled = true; };
  }, [session, reloadKey]);

  const active = sprints.find(s => s.status === 'active') || (live ? null : SPRINTS.find(s => s.status === 'active'));

  if (planning) {
    return <SprintPlanner onClose={() => setPlanning(false)} sprint={active || sprints.find(s => s.status === 'planned')}
      backlog={backlog} usersById={usersById} members={members} role={role} canPlan={canPlan} session={session}
      onCommitted={() => setReloadKey(k => k + 1)} onTaskChanged={() => setReloadKey(k => k + 1)} />;
  }

  if (live && !active) {
    return (
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <span className="eyebrow" style={{ padding: 0 }}>Sprints</span>
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: '7px 0 0' }}>No active sprint</h1>
          </div>
          {canPlan && <PrimaryBtn icon="target" onClick={() => setPlanning(true)}>Plan from backlog</PrimaryBtn>}
        </div>
        <Card><p style={{ color: 'var(--t3)', fontSize: 13, textAlign: 'center', margin: '24px 0' }}>There’s no active sprint right now. Plan one from the approved backlog to get going.</p></Card>
        {sprints.length > 0 && <AllSprints sprints={sprints} onPlan={() => setPlanning(true)} />}
      </div>
    );
  }

  const committed = stats ? (stats.totalEligible ?? active.committed) : active.committed;
  const done = stats ? (stats.doneCount ?? active.done) : active.done;
  const spill = stats ? (stats.spillovers ?? active.spill) : active.spill;
  const pct = committed ? Math.round((done / committed) * 100) : 0;
  const remaining = Math.max(0, committed - done);

  // days left + today-fraction from real sprint dates
  let daysLeft = 2, todayFrac = 0.8;
  if (active.startDate && active.endDate) {
    const start = new Date(active.startDate), end = new Date(active.endDate), now = new Date();
    const span = end - start;
    if (span > 0) { todayFrac = Math.max(0, Math.min(1, (now - start) / span)); daysLeft = Math.max(0, Math.ceil((end - now) / 8.64e7)); }
  }

  const STAT = [
    { label: 'Committed', value: committed, tone: 'info' },
    { label: 'Completed', value: done, tone: 'ok' },
    { label: 'Remaining', value: remaining, tone: 'warn' },
    { label: 'Spill risk', value: spill, tone: 'bad' },
    { label: 'Days left', value: daysLeft, tone: 'brand' },
  ];

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <span className="eyebrow" style={{ padding: 0 }}>{active.range} · Active</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: '7px 0 0' }}>{active.name}</h1>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {canPlan && <PrimaryBtn icon="target" kind="ghost" onClick={() => setPlanning(true)}>Plan from backlog</PrimaryBtn>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
        {STAT.map(s => {
          const t = TONE[s.tone];
          return (
            <Card key={s.label} style={{ borderTop: `2px solid ${t.fg}` }}>
              <div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, color: 'var(--t1)', lineHeight: 1 }}>{s.value}</div>
              <div className="eyebrow" style={{ padding: 0, marginTop: 9 }}>{s.label}</div>
            </Card>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, alignItems: 'stretch' }}>
        <Card>
          <SectionHead eyebrow={active.shortId || active.id} title="Burndown" style={{ marginBottom: 8 }}
            action={<div style={{ display: 'flex', gap: 16 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 14, height: 0, borderTop: '2px solid var(--yellow)' }} />Actual</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 14, height: 0, borderTop: '2px dashed var(--t4)' }} />Ideal</span>
            </div>} />
          <Burndown committed={committed} done={done} todayFrac={todayFrac} />
        </Card>
        <Card style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <div style={{ position: 'relative', width: 130, height: 130 }}>
            <svg width="130" height="130" viewBox="0 0 130 130">
              <circle cx="65" cy="65" r="56" fill="none" stroke="var(--surface-2)" strokeWidth="9" />
              <circle cx="65" cy="65" r="56" fill="none" stroke="var(--yellow)" strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 56 * pct / 100} ${2 * Math.PI * 56}`} transform="rotate(-90 65 65)" />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 34, color: 'var(--t1)', lineHeight: 1 }}>{pct}%</div>
                <div className="eyebrow" style={{ padding: 0, marginTop: 4 }}>Complete</div>
              </div>
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--t3)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            {done} of {committed} done · {remaining} to go.{spill ? ` On pace, ${spill} may spill.` : ''}</p>
        </Card>
      </div>

      <VelocityCard sprints={sprints} />
      <LoadPanel rows={loadRows} />
      <AllSprints sprints={sprints} onPlan={() => setPlanning(true)} />
    </div>
  );
}

function AllSprints({ sprints, onPlan }) {
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="calendar" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">All sprints</span>
      </div>
      <div>
        {sprints.map((s, i) => {
          const stTone = s.status === 'active' ? 'brand' : s.status === 'planned' ? 'info' : 'ok';
          const p = s.committed ? Math.round((s.done / s.committed) * 100) : 0;
          const isPlan = s.status === 'planned';
          return (
            <div key={s.id} onClick={() => isPlan && onPlan()} className="t-row" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 16px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: isPlan ? 'pointer' : 'default' }}>
              <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--t1)', width: 56 }}>{s.shortId || s.id}</span>
              <span className="num" style={{ fontSize: 12.5, color: 'var(--t3)', width: 130 }}>{s.range}</span>
              <Pill tone={stTone} dot>{s.status === 'active' ? 'Active' : isPlan ? 'Planned' : 'Closed'}</Pill>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, maxWidth: 240, height: 6, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
                  <div style={{ width: `${p}%`, height: '100%', background: s.status === 'active' ? 'var(--yellow)' : 'var(--ok-fg)' }} /></div>
                {s.committed > 0 && !isPlan && <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{s.done}/{s.committed}{s.spill ? ` · ${s.spill} spill` : ''}</span>}
                {isPlan && <span className="num" style={{ fontSize: 11.5, color: 'var(--t4)' }}>tap to plan</span>}
              </div>
              <Icon name="chevronRight" size={15} style={{ color: 'var(--t4)' }} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function SprintsPage() {
  return <AppShell route="sprints"><SprintsScreen /></AppShell>;
}
