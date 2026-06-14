'use client';
/* Sprints — active summary, burndown, velocity, capacity, timeline + a
   drag-to-plan sprint planner. Active sprint numbers + the all-sprints
   list are live (worker getDashboardStats + brand.sprints); burndown /
   velocity / capacity are illustrative trends; the planner persists to
   localStorage (matching the prototype). Ported from sprints.jsx. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card, Pill, Avatar, ProductTag, PrimaryBtn, SectionHead, TONE } from '@/components/throttle/ui';
import { toast } from '@/components/throttle/ToastHost';
import {
  SPRINTS, BURNDOWN, CAPACITY, PLAN_BACKLOG, PLAN_CAPACITY, DTYPE, PRIORITY, teamById, lsGet, lsSet,
} from '@/lib/throttleData';
import { fetchSprints, fetchDashboardStats } from '@/lib/throttleApi';

const PLAN_TOTAL = Object.values(PLAN_CAPACITY).reduce((a, b) => a + b, 0);

function PlanCard({ task, where, onMove, dim }) {
  const pr = PRIORITY[task.priority] || PRIORITY.medium;
  return (
    <div draggable onDragStart={e => { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => onMove(task.id)}
      className="t-card t-task" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
        borderLeft: `2px solid ${pr.color}`, padding: '10px 11px', cursor: 'pointer', boxShadow: 'var(--card-shadow)', opacity: dim ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span className="num" title={`${task.est} points`} style={{ width: 24, height: 24, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)',
          border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, color: 'var(--yellow)', flexShrink: 0 }}>{task.est}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--t1)', lineHeight: 1.35, marginBottom: 6 }}>{task.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'var(--t4)', fontFamily: 'var(--font-display)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{DTYPE[task.type] || task.type}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProductTag code={task.product} />
              <Avatar id={task.ownerId} size={20} />
            </div>
          </div>
        </div>
        <span style={{ color: 'var(--t4)', display: 'flex', flexShrink: 0 }}><Icon name={where === 'backlog' ? 'plus' : 'x'} size={14} /></span>
      </div>
    </div>
  );
}

function SprintPlanner({ onClose, sprints }) {
  const [committed, setCommitted] = useState(() => lsGet('throttle_plan_s25', []));
  const [over, setOver] = useState(null);
  const byId = Object.fromEntries(PLAN_BACKLOG.map(t => [t.id, t]));
  const inSprint = committed.map(id => byId[id]).filter(Boolean);
  const backlog = PLAN_BACKLOG.filter(t => !committed.includes(t.id));

  const pts = inSprint.reduce((s, t) => s + t.est, 0);
  const loadByPerson = {};
  inSprint.forEach(t => { loadByPerson[t.ownerId] = (loadByPerson[t.ownerId] || 0) + t.est; });
  const overCommitted = pts > PLAN_TOTAL;
  const anyoneOver = Object.entries(loadByPerson).some(([id, v]) => v > (PLAN_CAPACITY[id] || 0));

  const add = id => setCommitted(c => c.includes(id) ? c : [...c, id]);
  const remove = id => setCommitted(c => c.filter(x => x !== id));
  const drop = (id, target) => { target === 'sprint' ? add(id) : remove(id); setOver(null); };

  const autoPlan = () => {
    const load = {}; const picked = [];
    const ordered = [...PLAN_BACKLOG].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]));
    let total = 0;
    for (const t of ordered) {
      const cap = PLAN_CAPACITY[t.ownerId] || 0;
      if ((load[t.ownerId] || 0) + t.est <= cap && total + t.est <= PLAN_TOTAL) {
        picked.push(t.id); load[t.ownerId] = (load[t.ownerId] || 0) + t.est; total += t.est;
      }
    }
    setCommitted(picked);
    toast(`Auto-planned · ${picked.length} tasks · ${total} of ${PLAN_TOTAL} pts`, 'info', 'zap');
  };
  const commit = () => {
    if (!committed.length) { toast('Add tasks before committing the sprint.', 'warn', 'alert'); return; }
    lsSet('throttle_plan_s25', committed);
    toast(`Sprint planned · ${committed.length} tasks · ${pts} pts committed`, 'ok', 'check');
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

  const sprint = (sprints || SPRINTS).find(s => s.status === 'planned') || { id: 'S-25', shortId: 'S-25', range: 'Jun 23 – Jul 4' };
  const sid = sprint.shortId || sprint.id;
  const meterColor = overCommitted ? 'var(--bad-fg)' : pts / PLAN_TOTAL > 0.9 ? 'var(--warn-fg)' : 'var(--yellow)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', maxWidth: 1240, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexShrink: 0, flexWrap: 'wrap' }}>
        <div>
          <button onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, padding: 0, marginBottom: 6, whiteSpace: 'nowrap' }}>
            <Icon name="chevronLeft" size={14} />Back to sprint</button>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: 0 }}>Plan {sid}</h1>
          <span className="eyebrow" style={{ padding: 0, marginTop: 5, display: 'block' }}>{sprint.range} · drag from backlog</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <PrimaryBtn icon="zap" kind="ghost" onClick={autoPlan}>Auto-plan</PrimaryBtn>
          <PrimaryBtn icon="check" onClick={commit}>Commit sprint</PrimaryBtn>
        </div>
      </div>

      <Card style={{ marginBottom: 16, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 28, color: meterColor, lineHeight: 1 }}>{pts}</span>
              <span className="num" style={{ fontSize: 14, color: 'var(--t3)' }}>/ {PLAN_TOTAL} pts</span>
            </div>
            <div className="eyebrow" style={{ padding: 0, marginTop: 5 }}>Committed · {committed.length} tasks</div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ height: 12, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${Math.min(100, (pts / PLAN_TOTAL) * 100)}%`, background: meterColor, transition: 'width .2s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>{overCommitted ? 'Over team capacity' : `${Math.round((pts / PLAN_TOTAL) * 100)}% of capacity`}</span>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>{PLAN_TOTAL} pts available</span>
            </div>
          </div>
          {(overCommitted || anyoneOver) && <Pill tone="bad" dot>{overCommitted ? 'Over capacity' : 'Someone overloaded'}</Pill>}
        </div>
      </Card>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 230px', gap: 14, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {colHead('Backlog', backlog.length, 'approved')}
          {dropZone('backlog', backlog.map(t => <PlanCard key={t.id} task={t} where="backlog" onMove={add} />), 'All pulled in.')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {colHead(sid, inSprint.length, pts + ' pts')}
          {dropZone('sprint', inSprint.map(t => <PlanCard key={t.id} task={t} where="sprint" onMove={remove} />), 'Drag tasks here to commit them.')}
        </div>
        <Card pad={0} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: '13px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}><span className="t-h3">Load</span></div>
          <div style={{ padding: '8px 14px', overflowY: 'auto' }}>
            {Object.keys(PLAN_CAPACITY).map((uid, i) => {
              const u = teamById[uid]; const load = loadByPerson[uid] || 0; const cap = PLAN_CAPACITY[uid];
              const ov = load > cap;
              return (
                <div key={uid} style={{ padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Avatar id={uid} size={20} />
                    <span style={{ flex: 1, fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u?.name.split(' ')[0]}</span>
                    <span className="num" style={{ fontSize: 11.5, color: ov ? 'var(--bad-fg)' : 'var(--t3)', fontWeight: 600 }}>{load}/{cap}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, (load / cap) * 100)}%`, height: '100%', background: ov ? 'var(--bad-fg)' : load === cap ? 'var(--warn-fg)' : 'var(--ok-fg)', transition: 'width .2s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Burndown() {
  const W = 560, H = 200, pad = { l: 28, r: 12, t: 14, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const { ideal, actual, days } = BURNDOWN;
  const maxV = 21;
  const xs = i => pad.l + (i / (ideal.length - 1)) * iw;
  const ys = v => pad.t + (1 - v / maxV) * ih;
  const idealPath = ideal.map((v, i) => (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1)).join(' ');
  const actualPts = actual.map((v, i) => v == null ? null : [xs(i), ys(v)]).filter(Boolean);
  const actualPath = actualPts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const todayIdx = actualPts.length - 1;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {[0, 7, 14, 21].map(v => (
        <g key={v}>
          <line x1={pad.l} y1={ys(v)} x2={W - pad.r} y2={ys(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray="2 4" />
          <text x={pad.l - 7} y={ys(v) + 3} textAnchor="end" fontSize="9" fill="var(--t4)" fontFamily="var(--font-mono)">{v}</text>
        </g>
      ))}
      {days.map((d, i) => d && <text key={i} x={xs(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--t4)" fontFamily="var(--font-mono)">{d}</text>)}
      <path d={idealPath} fill="none" stroke="var(--t4)" strokeWidth="1.5" strokeDasharray="4 4" />
      <path d={actualPath} fill="none" stroke="var(--yellow)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {actualPts[todayIdx] && <circle cx={actualPts[todayIdx][0]} cy={actualPts[todayIdx][1]} r="4" fill="var(--yellow)" stroke="var(--bg)" strokeWidth="2" />}
    </svg>
  );
}

function VelocityCard({ sprints }) {
  const all = sprints || SPRINTS;
  const hist = all.filter(s => s.status !== 'planned').slice(0, 3).reverse();
  const closed = all.filter(s => s.status === 'closed');
  const avg = Math.round(closed.reduce((a, b) => a + (b.done || 0), 0) / Math.max(1, closed.length));
  const maxC = Math.max(1, ...hist.map(s => s.committed || 0));
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="activity" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">Velocity</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, color: 'var(--yellow)' }}>{avg}</span>
          <span className="eyebrow" style={{ padding: 0 }}>avg tasks / sprint</span>
        </span>
      </div>
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ok-fg)' }} />Delivered</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-wolf)', opacity: 0.5 }} />Committed</span>
      </div>
    </Card>
  );
}

function SprintsScreen() {
  const { session } = useAuth();
  const [planning, setPlanning] = useState(false);
  const [sprints, setSprints] = useState(SPRINTS);
  const [stats, setStats] = useState(null);
  const plannedIds = lsGet('throttle_plan_s25', []);

  useEffect(() => {
    const onPlan = () => setPlanning(true);
    window.addEventListener('throttle:plansprint', onPlan);
    return () => window.removeEventListener('throttle:plansprint', onPlan);
  }, []);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const [s, st] = await Promise.all([fetchSprints(session), fetchDashboardStats(session)]);
      if (cancelled) return;
      if (s) setSprints(s);
      if (st && typeof st.doneCount === 'number') setStats(st);
    })();
    return () => { cancelled = true; };
  }, [session]);

  if (planning) return <SprintPlanner onClose={() => setPlanning(false)} sprints={sprints} />;

  const active = sprints.find(s => s.status === 'active') || SPRINTS.find(s => s.status === 'active');
  const committed = stats ? (stats.totalEligible ?? active.committed) : active.committed;
  const done = stats ? (stats.doneCount ?? active.done) : active.done;
  const spill = stats ? (stats.spillovers ?? active.spill) : active.spill;
  const pct = committed ? Math.round((done / committed) * 100) : 0;
  const remaining = Math.max(0, committed - done);
  const STAT = [
    { label: 'Committed', value: committed, tone: 'info' },
    { label: 'Completed', value: done, tone: 'ok' },
    { label: 'Remaining', value: remaining, tone: 'warn' },
    { label: 'Spill risk', value: spill, tone: 'bad' },
    { label: 'Days left', value: 2, tone: 'brand' },
  ];

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <span className="eyebrow" style={{ padding: 0 }}>{active.range} · Active</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: '7px 0 0' }}>{active.name}</h1>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <PrimaryBtn icon="target" kind="ghost" onClick={() => setPlanning(true)}>Plan from backlog</PrimaryBtn>
          <PrimaryBtn icon="check">Close sprint</PrimaryBtn>
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
          <Burndown />
        </Card>
        <Card style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <div style={{ position: 'relative', width: 130, height: 130 }}>
            <svg width="130" height="130" viewBox="0 0 130 130">
              <circle cx="65" cy="65" r="56" fill="none" stroke="var(--surface-2)" strokeWidth="9" />
              <circle cx="65" cy="65" r="56" fill="none" stroke="var(--yellow)" strokeWidth="9" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 56 * pct / 100} ${2 * Math.PI * 56}`} transform="rotate(-90 65 65)" />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', flexDirection: 'column' }}>
              <div style={{ textAlign: 'center' }}>
                <div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 34, color: 'var(--t1)', lineHeight: 1 }}>{pct}%</div>
                <div className="eyebrow" style={{ padding: 0, marginTop: 4 }}>Complete</div>
              </div>
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--t3)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            {done} of {committed} done · {remaining} to go.<br/>On pace, {spill} may spill.</p>
        </Card>
      </div>

      <VelocityCard sprints={sprints} />

      <Card pad={0}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="users" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">Capacity & commitment</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ok-fg)' }} />Done</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--p-wolf)' }} />Committed</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--surface-3)' }} />Capacity</span>
          </div>
        </div>
        <div style={{ padding: '8px 16px 14px' }}>
          {CAPACITY.map((c, i) => {
            const u = teamById[c.id];
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: 168, flexShrink: 0 }}>
                  <Avatar id={c.id} size={24} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 500 }}>{u.name}</div>
                    <div className="eyebrow" style={{ padding: 0, fontSize: 8.5 }}>{u.discipline}</div>
                  </div>
                </div>
                <div style={{ flex: 1, position: 'relative', height: 12, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, width: `${(c.committed / c.cap) * 100}%`, background: 'var(--p-wolf)', opacity: 0.5 }} />
                  <div style={{ position: 'absolute', inset: 0, width: `${(c.done / c.cap) * 100}%`, background: 'var(--ok-fg)' }} />
                </div>
                <span className="num" style={{ fontSize: 12, color: 'var(--t2)', width: 56, textAlign: 'right' }}>{c.done}/{c.committed} · {c.cap}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card pad={0}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="calendar" size={15} style={{ color: 'var(--t3)' }} /><span className="t-h3">All sprints</span>
        </div>
        <div>
          {sprints.map((s, i) => {
            const stTone = s.status === 'active' ? 'brand' : s.status === 'planned' ? 'info' : 'ok';
            const committedN = s.status === 'planned' && plannedIds.length ? plannedIds.length : s.committed;
            const p = committedN ? Math.round((s.done / committedN) * 100) : 0;
            const isPlan = s.status === 'planned';
            return (
              <div key={s.id} onClick={() => isPlan && setPlanning(true)} className="t-row" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 16px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}>
                <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14, color: 'var(--t1)', width: 56 }}>{s.shortId || s.id}</span>
                <span className="num" style={{ fontSize: 12.5, color: 'var(--t3)', width: 130 }}>{s.range}</span>
                <Pill tone={stTone} dot>{s.status === 'active' ? 'Active' : isPlan ? 'Planned' : 'Closed'}</Pill>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, maxWidth: 240, height: 6, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${p}%`, height: '100%', background: s.status === 'active' ? 'var(--yellow)' : 'var(--ok-fg)' }} /></div>
                  {committedN > 0 && !isPlan && <span className="num" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{s.done}/{committedN}{s.spill ? ` · ${s.spill} spill` : ''}</span>}
                  {isPlan && <span className="num" style={{ fontSize: 11.5, color: plannedIds.length ? 'var(--info-fg)' : 'var(--t4)' }}>{plannedIds.length ? `${plannedIds.length} planned · tap to edit` : 'tap to plan'}</span>}
                </div>
                <Icon name="chevronRight" size={15} style={{ color: 'var(--t4)' }} />
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

export default function SprintsPage() {
  return <AppShell route="sprints"><SprintsScreen /></AppShell>;
}
