'use client';
/* Dashboard — the command view. Night Circuit hero, KPI cards w/ trend,
   "Needs you" queue, activity feed, team workload, deliverables shipped.
   KPI values + workload come from the worker; the queue is derived from
   live tasks + requests; everything falls back to seed when unauthenticated
   or a read fails. Layout/visuals ported verbatim from dashboard.jsx (dir b). */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon, Sparkline } from '@/components/throttle/Icon';
import { Card, Pill, Avatar, PrimaryBtn, TONE } from '@/components/throttle/ui';
import {
  KPIS, ACTIONS, ACTIVITY, WORKLOAD, OUTPUT, OUTPUT_COLS, taskTag, firstName,
} from '@/lib/throttleData';
import { fetchUsers, fetchTasks, fetchRequests, fetchDashboardStats, fetchTeamWorkload } from '@/lib/throttleApi';

function KpiCard({ k }) {
  const tone = TONE[k.tone] || TONE.info;
  const arrow = k.dir === 'up' ? 'arrowUp' : k.dir === 'down' ? 'arrowDown' : 'minus';
  const deltaColor = k.dir === 'flat' ? 'var(--t3)'
    : (k.key === 'overdue' || k.key === 'blocked') ? (k.dir === 'up' ? 'var(--bad-fg)' : 'var(--ok-fg)')
    : (k.dir === 'up' ? 'var(--ok-fg)' : 'var(--warn-fg)');
  return (
    <div className="t-card" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)', borderRadius: 'var(--card-radius)',
      boxShadow: 'var(--card-shadow)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)' }}>{k.label}</span>
        <Sparkline data={k.spark} color={tone.fg} w={52} h={18} />
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="num" style={{ fontSize: 32, fontWeight: 600, color: 'var(--t1)', lineHeight: 1 }}>{k.value}</span>
        <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700, color: deltaColor }}>
          <Icon name={arrow} size={12} />{k.delta}</span>
      </div>
    </div>
  );
}

function DashHero({ name, greeting, sub, reviewCount }) {
  return (
    <div style={{ position: 'relative', borderRadius: 'var(--card-radius)', overflow: 'hidden', border: '1px solid var(--card-bd)', minHeight: 230 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/throttle-hero-night.png" alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(12,12,14,0.92) 0%, rgba(12,12,14,0.72) 42%, rgba(12,12,14,0.28) 100%)' }} />
      <div style={{ position: 'relative', padding: '34px 34px 30px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: 230 }}>
        <span className="eyebrow" style={{ padding: 0, color: 'var(--yellow)' }}>{greeting}</span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 30, letterSpacing: '0.005em', color: '#fff',
          margin: '10px 0 8px', maxWidth: 560, lineHeight: 1.08 }}>OWN THE NIGHT, {firstName(name).toUpperCase()}</h1>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14.5, color: 'rgba(255,255,255,0.82)', margin: 0, maxWidth: 520 }}>{sub}</p>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <PrimaryBtn icon="check" onClick={() => window.dispatchEvent(new CustomEvent('throttle:opentask', { detail: 'review' }))}>Review queue · {reviewCount}</PrimaryBtn>
          <PrimaryBtn icon="plus" kind="ghost" onClick={() => window.dispatchEvent(new CustomEvent('throttle:newreq'))}>New request</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

function actOnQueueItem(a) {
  if (a.kind === 'request') { window.dispatchEvent(new CustomEvent('throttle:newreq')); return; }
  if (a.taskId) { window.dispatchEvent(new CustomEvent('throttle:opentask', { detail: a.taskId })); }
}

function ActionQueue({ actions }) {
  const KIND_ICON = { approve: 'check', request: 'inbox', blocked: 'alert', feedback: 'send' };
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="zap" size={15} style={{ color: 'var(--yellow)' }} />
          <span className="t-h3">Needs you</span>
        </div>
        <Pill tone="bad" dot>{actions.length} open</Pill>
      </div>
      <div>
        {actions.length === 0 && <div style={{ padding: '22px 16px', textAlign: 'center', color: 'var(--t4)', fontSize: 12.5 }}>Clean queue. Nothing waiting on you.</div>}
        {actions.map((a, i) => {
          const t = TONE[a.tone] || TONE.info;
          return (
            <div key={a.id} className="t-row" onClick={() => actOnQueueItem(a)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 16px',
              borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}>
              <span style={{ width: 30, height: 30, borderRadius: 'var(--r-sm)', background: t.bg, border: `1px solid ${t.bd}`,
                color: t.fg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={KIND_ICON[a.kind]} size={15} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: 'var(--t1)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.label}</div>
                <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{a.meta}</div>
              </div>
              <span className="num" style={{ fontSize: 11, color: 'var(--t4)', flexShrink: 0 }}>{a.age}</span>
              <Icon name="chevronRight" size={15} style={{ color: 'var(--t4)', flexShrink: 0 }} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ActivityFeed({ activity }) {
  const KIND = {
    review:  { c: 'var(--info-fg)',  i: 'eye' },
    approve: { c: 'var(--ok-fg)',    i: 'check' },
    block:   { c: 'var(--warn-fg)',  i: 'alert' },
    request: { c: 'var(--yellow)',   i: 'inbox' },
    deliver: { c: 'var(--p-shadow, #b46bff)', i: 'send' },
    start:   { c: 'var(--t3)',       i: 'box' },
  };
  return (
    <Card pad={0} style={{ height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="activity" size={15} style={{ color: 'var(--t3)' }} />
        <span className="t-h3">Activity</span>
        <span className="num" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t4)', whiteSpace: 'nowrap' }}>last 6h</span>
      </div>
      <div style={{ padding: '6px 16px 10px' }}>
        {activity.map((e, i) => {
          const k = KIND[e.kind] || KIND.start;
          const clickable = !!e.taskId;
          return (
            <div key={e.id} onClick={clickable ? () => window.dispatchEvent(new CustomEvent('throttle:opentask', { detail: e.taskId })) : undefined}
              className={clickable ? 't-act' : ''}
              style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--border)' : 'none',
                cursor: clickable ? 'pointer' : 'default', borderRadius: 4 }}>
              <span style={{ marginTop: 2, color: k.c, display: 'flex', flexShrink: 0 }}><Icon name={k.i} size={15} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.45, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{e.who}</span> {e.what} <span style={{ color: 'var(--t1)' }}>{e.target}</span>
                </div>
                <div className="num" style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.detail} · {e.t}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function WorkloadPanel({ workload }) {
  const max = Math.max(1, ...workload.map(p => p.total));
  const SEG = [
    { key: 'inProgress', color: 'var(--p-wolf, #6d83ff)', label: 'In progress' },
    { key: 'inReview',   color: 'var(--info-fg)',          label: 'In review' },
    { key: 'blocked',    color: 'var(--warn-fg)',          label: 'Blocked' },
    { key: 'queued',     color: 'var(--surface-3)',        label: 'Queued' },
  ];
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="users" size={15} style={{ color: 'var(--t3)' }} />
        <span className="t-h3">Team workload</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
          {SEG.map(s => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--t3)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />{s.label}</span>
          ))}
        </div>
      </div>
      <div style={{ padding: '6px 16px 14px' }}>
        {workload.map((p, i) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: 168, flexShrink: 0 }}>
              <Avatar id={typeof p.id === 'string' && p.id.startsWith('u') ? p.id : undefined} name={p.name} initial={p.initial} size={24} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                <div className="eyebrow" style={{ padding: 0, fontSize: 8.5 }}>{p.discipline}</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', background: 'var(--bg-2)' }}>
              {SEG.map(s => p[s.key] > 0 && (
                <div key={s.key} title={`${p[s.key]} ${s.label}`} style={{ width: `${(p[s.key] / max) * 100}%`, background: s.color }} />
              ))}
            </div>
            <span className="num" style={{ fontSize: 13, color: p.total > 4 ? 'var(--warn-fg)' : 'var(--t2)', fontWeight: 600, width: 24, textAlign: 'right' }}>{p.total}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OutputPanel() {
  const totals = OUTPUT_COLS.map(c => OUTPUT.reduce((s, r) => s + (r[c.key] || 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0);
  const dayTotals = OUTPUT.map(r => OUTPUT_COLS.reduce((s, c) => s + (r[c.key] || 0), 0));
  const maxDay = Math.max(...dayTotals);
  const COLORS = ['var(--yellow)', 'var(--p-wolf,#6d83ff)', 'var(--info-fg)', 'var(--ok-fg)', 'var(--p-shadow,#b46bff)', 'var(--warn-fg)'];
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <Icon name="film" size={15} style={{ color: 'var(--t3)' }} />
        <span className="t-h3">Deliverables shipped</span>
        <span className="num" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>this week · <span style={{ color: 'var(--t1)', fontWeight: 700 }}>{grand}</span></span>
      </div>
      <div style={{ padding: '18px 16px 10px', display: 'flex', alignItems: 'flex-end', gap: 18, height: 150 }}>
        {OUTPUT.map((r, i) => (
          <div key={r.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%', justifyContent: 'flex-end' }}>
            <div style={{ width: '100%', maxWidth: 46, display: 'flex', flexDirection: 'column-reverse', borderRadius: 4, overflow: 'hidden',
              height: `${(dayTotals[i] / maxDay) * 100}%`, minHeight: 6 }}>
              {OUTPUT_COLS.map((c, ci) => r[c.key] > 0 && (
                <div key={c.key} style={{ height: `${(r[c.key] / dayTotals[i]) * 100}%`, background: COLORS[ci] }} />
              ))}
            </div>
            <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{r.day}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', padding: '8px 16px 16px', borderTop: '1px solid var(--border)' }}>
        {OUTPUT_COLS.map((c, ci) => (
          <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--t3)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[ci] }} />{c.label}
            <span className="num" style={{ color: 'var(--t1)', fontWeight: 600 }}>{totals[ci]}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function DashboardScreen() {
  const { session, brandUser, user } = useAuth();
  const [kpis, setKpis] = useState(KPIS);
  const [actions, setActions] = useState(ACTIONS);
  const [workload, setWorkload] = useState(WORKLOAD);
  const [reviewCount, setReviewCount] = useState(2);
  const [greeting, setGreeting] = useState('');
  const name = brandUser?.name || user?.full_name || user?.email?.split('@')[0] || 'Meera Krishnan';

  useEffect(() => {
    const now = new Date();
    setGreeting(now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' +
      now.toLocaleString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase());
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const usersRes = await fetchUsers(session);
      const byId = usersRes?.byId || {};
      const [stats, wl, tasks, reqs] = await Promise.all([
        fetchDashboardStats(session), fetchTeamWorkload(session),
        fetchTasks(session, byId), fetchRequests(session, byId),
      ]);
      if (cancelled) return;

      if (stats && typeof stats.inReview === 'number') {
        setReviewCount(stats.inReview || 0);
        setKpis(KPIS.map(k => {
          if (k.key === 'in_review')  return { ...k, value: stats.inReview ?? k.value };
          if (k.key === 'overdue')    return { ...k, value: stats.overdue ?? k.value };
          if (k.key === 'blocked')    return { ...k, value: stats.extBlocked ?? k.value };
          if (k.key === 'completion') return { ...k, value: (stats.completionRate ?? 0) + '%' };
          if (k.key === 'spillover')  return { ...k, value: stats.spillovers ?? k.value };
          return k;
        }));
      }

      if (wl?.rows?.length) {
        const agg = {};
        wl.rows.forEach(r => {
          const p = agg[r.id] || (agg[r.id] = { id: r.id, name: r.name, discipline: r.discipline || '', initial: undefined, total: 0, inProgress: 0, inReview: 0, blocked: 0, queued: 0 });
          const n = Number(r.task_count) || 0;
          p.total += n;
          if (r.stage === 'in_progress') p.inProgress += n;
          else if (r.stage === 'in_review') p.inReview += n;
          else if (r.stage === 'ext_blocked') p.blocked += n;
          else if (r.stage === 'in_sprint' || r.stage === 'backlog') p.queued += n;
        });
        const rows = Object.values(agg).filter(p => p.total > 0).sort((a, b) => b.total - a.total);
        if (rows.length) setWorkload(rows);
      }

      if (tasks || reqs) {
        const q = [];
        (tasks || []).filter(t => t.stage === 'in_review').slice(0, 4).forEach(t =>
          q.push({ id: 'rev' + t.id, kind: 'approve', taskId: t.id, label: `${t.title} — awaiting your approval`, meta: `${taskTag(t.num)} · ${t.ownerName || 'team'} · ${t.priority}`, tone: t.priority === 'urgent' ? 'bad' : 'info', age: t.due || '' }));
        (reqs || []).filter(r => r.status === 'pending').slice(0, 3).forEach(r =>
          q.push({ id: 'req' + r.id, kind: 'request', label: `New request: ${r.title}`, meta: `From ${r.who}${r.items ? ` · ${r.items} deliverables` : ''}`, tone: 'warn', age: r.age }));
        (tasks || []).filter(t => t.stage === 'ext_blocked').slice(0, 2).forEach(t =>
          q.push({ id: 'blk' + t.id, kind: 'blocked', taskId: t.id, label: `${t.title} blocked${t.blocked ? ' — ' + t.blocked : ''}`, meta: `${taskTag(t.num)} · ${t.ownerName || 'team'}`, tone: 'warn', age: t.due || '' }));
        (tasks || []).filter(t => t.stage === 'delivered').slice(0, 2).forEach(t =>
          q.push({ id: 'dlv' + t.id, kind: 'feedback', taskId: t.id, label: `${t.title} delivered — close the loop`, meta: `${taskTag(t.num)} · awaiting requester feedback`, tone: 'ok', age: t.due || '' }));
        setActions(q.length ? q.slice(0, 6) : []);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const sub = `${kpis.find(k => k.key === 'in_review')?.value ?? 0} in review · ${kpis.find(k => k.key === 'overdue')?.value ?? 0} overdue · ${kpis.find(k => k.key === 'blocked')?.value ?? 0} blocked. ${reviewCount} ${reviewCount === 1 ? 'approval is' : 'approvals are'} waiting on you.`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1240, margin: '0 auto' }}>
      <DashHero name={name} greeting={greeting} sub={sub} reviewCount={reviewCount} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14 }}>
        {kpis.map(k => <KpiCard key={k.key} k={k} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 16, alignItems: 'start' }}>
        <ActionQueue actions={actions} />
        <ActivityFeed activity={ACTIVITY} />
      </div>
      <WorkloadPanel workload={workload} />
      <OutputPanel />
    </div>
  );
}

export default function DashboardPage() {
  return <AppShell route="dashboard"><DashboardScreen /></AppShell>;
}
