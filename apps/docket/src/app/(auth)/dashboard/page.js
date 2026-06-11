'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { AlertTriangle, Clock, List, Check, RefreshCw } from 'lucide-react';
import { docketopsGet } from '../../../lib/docketopsFetch.js';
import { STATUSES } from '../../../lib/tasks.js';
import { Avatar, personColor } from '../../../components/primitives.js';

export default function DashboardPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const search = useSearchParams();
  const spaceId = search.get('space') || '';
  const [stats, setStats] = useState(null);
  const [spaceName, setSpaceName] = useState('');
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setDenied(false);
    try { setStats(await docketopsGet('getDashboard', { space_id: spaceId }, session)); }
    catch (e) {
      if (/forbidden/i.test(e.message || '')) setDenied(true);
      else showToast(e.message || 'Failed to load dashboard', 'error');
    }
    finally { setLoading(false); }
  }, [session, spaceId, showToast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!session || !spaceId) { setSpaceName(''); return; }
    docketopsGet('getSpaces', {}, session).then(s => setSpaceName((s || []).find(x => x.id === spaceId)?.name || '')).catch(() => {});
  }, [session, spaceId]);

  if (denied) return <div style={{ color: 'var(--text-3)' }}>You don’t have access to this dashboard.</div>;
  if (loading) return <Spinner />;
  if (!stats) return null;
  const linkSuffix = spaceId ? `&space=${spaceId}` : '';

  const byStatus = STATUSES.map(s => ({ key: s.key, label: s.label, color: s.color, n: Number(stats.by_status?.[s.key] || 0) }));
  const maxStatus = Math.max(1, ...byStatus.map(s => s.n));
  const openTotal = byStatus.filter(s => s.key !== 'done' && s.key !== 'abandoned').reduce((a, b) => a + b.n, 0);
  const byTeam = (stats.by_department || []).map(r => ({ name: r.dept_name, id: r.dept_id, open: Number(r.open || 0), done: Number(r.done || 0), overdue: Number(r.overdue || 0) }));
  const byPerson = (stats.by_person || []).map(r => ({ name: r.emp_name, id: r.emp_id, open: Number(r.open || 0), done: Number(r.done || 0), overdue: Number(r.overdue || 0), last_seen: r.last_seen || null }));

  return (
    <div className="screen">
      <div className="screen-head"><p>{spaceName ? `${spaceName} · space task review.` : 'Org-wide task review. General space.'}</p></div>

      <div className="kpi-row">
        <Kpi icon={AlertTriangle} label="Overdue" value={stats.overdue} accent="var(--overdue)" onClick={() => router.push(`/tasks?overdue=1${linkSuffix}`)} />
        <Kpi icon={Clock} label="Due ≤ 7 days" value={stats.due_soon} accent="var(--st-blocked)" />
        <Kpi icon={List} label="Open" value={openTotal} />
        <Kpi icon={Check} label="Done (30d)" value={stats.completed_30d} accent="var(--st-done)" />
        <Kpi icon={RefreshCw} label="Revised" value={stats.revised} accent="var(--st-blocked)" onClick={() => router.push(`/tasks?revised=1${linkSuffix}`)} />
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-h">Status distribution</div>
          <div className="bars">
            {byStatus.map(s => (
              <div key={s.key} className="bar-row">
                <span className="bar-label">{s.label}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: (s.n / maxStatus * 100) + '%', background: s.color }} /></div>
                <span className="bar-n">{s.n}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-h">By team</div>
          <table className="dtable">
            <thead><tr><th>Team</th><th className="num">Open</th><th className="num">Done</th><th className="num">Overdue</th></tr></thead>
            <tbody>
              {byTeam.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--text-3)' }}>No tasks yet.</td></tr>}
              {byTeam.map(r => (
                <tr key={r.id || r.name} className="clickable" onClick={() => router.push(`/tasks?department_id=${r.id}${linkSuffix}`)}>
                  <td><span className="chip soft"><span className="dot" style={{ background: personColor(r.id || r.name) }} />{r.name || '—'}</span></td>
                  <td className="num">{r.open}</td><td className="num">{r.done}</td>
                  <td className="num" style={{ color: r.overdue ? 'var(--overdue)' : 'var(--text-2)', fontWeight: r.overdue ? 600 : 400 }}>{r.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-h">By person · owner workload</div>
        <table className="dtable">
          <thead><tr><th>Person</th><th className="num">Open</th><th className="num">Done</th><th className="num">Overdue</th><th>Last seen</th><th style={{ width: '28%' }}>Load</th></tr></thead>
          <tbody>
            {byPerson.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-3)' }}>No tasks yet.</td></tr>}
            {byPerson.map(r => {
              const total = Math.max(1, r.open + r.done);
              const ls = lastSeen(r.last_seen);
              return (
                <tr key={r.id || r.name} className="clickable" onClick={() => router.push(`/tasks?employee_id=${r.id}${linkSuffix}`)}>
                  <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}><Avatar name={r.name} size={24} />{r.name || '—'}</span></td>
                  <td className="num">{r.open}</td><td className="num">{r.done}</td>
                  <td className="num" style={{ color: r.overdue ? 'var(--overdue)' : 'var(--text-2)', fontWeight: r.overdue ? 600 : 400 }}>{r.overdue}</td>
                  <td title={r.last_seen ? new Date(r.last_seen).toLocaleString('en-IN') : 'No activity recorded'} style={{ fontSize: 12.5, color: ls.color }}>{ls.label}</td>
                  <td><div className="load"><div className="load-done" style={{ width: (r.done / total * 100) + '%' }} /><div className="load-open" style={{ width: (r.open / total * 100) + '%' }} /></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// "Last seen" label + colour, by IST calendar day. green=today, normal=recent, muted=stale, faint=never.
function lastSeen(iso) {
  if (!iso) return { label: 'never', color: 'var(--text-4)' };
  const istDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  const today = istDay(new Date());
  const seen = istDay(new Date(iso));
  const diff = Math.round((new Date(today + 'T00:00:00Z') - new Date(seen + 'T00:00:00Z')) / 86400000);
  if (diff <= 0) return { label: 'today', color: 'var(--st-done)' };
  if (diff === 1) return { label: 'yesterday', color: 'var(--text-2)' };
  if (diff <= 7) return { label: `${diff}d ago`, color: 'var(--text-2)' };
  return { label: `${diff}d ago`, color: 'var(--text-4)' };
}

function Kpi({ icon: Ic, label, value, accent, onClick }) {
  return (
    <div className={'kpi' + (onClick ? ' clickable' : '')} onClick={onClick}>
      <div className="kpi-top"><Ic className="ic" />{label}</div>
      <div className="kpi-val" style={{ color: accent || 'var(--text-1)' }}>{Number(value || 0)}</div>
    </div>
  );
}
