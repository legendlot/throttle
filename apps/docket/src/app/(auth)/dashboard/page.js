'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { AlertTriangle, Clock, List, Check, RefreshCw, Lock } from 'lucide-react';
import { EmptyState } from '../../../components/ui/index.js';
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

  if (denied) return <div className="screen"><EmptyState icon={Lock} title="No access" body="You don’t have access to this dashboard." /></div>;
  if (loading) return <Spinner />;
  if (!stats) return null;
  const linkSuffix = spaceId ? `&space=${spaceId}` : '';
  const go = (href) => () => router.push(href);
  const rowKeys = (href) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(href); } };

  const byStatus = STATUSES.map(s => ({ key: s.key, label: s.label, color: s.color, n: Number(stats.by_status?.[s.key] || 0) }));
  const statusTotal = byStatus.reduce((a, b) => a + b.n, 0);
  const openTotal = byStatus.filter(s => s.key !== 'done' && s.key !== 'abandoned').reduce((a, b) => a + b.n, 0);
  const byTeam = (stats.by_department || []).map(r => ({ name: r.dept_name, id: r.dept_id, open: Number(r.open || 0), done: Number(r.done || 0), overdue: Number(r.overdue || 0) }));
  const byPerson = (stats.by_person || []).map(r => ({ name: r.emp_name, id: r.emp_id, open: Number(r.open || 0), done: Number(r.done || 0), overdue: Number(r.overdue || 0), last_seen: r.last_seen || null }));

  return (
    <div className="screen dash">
      <p className="dash-lede">{spaceName ? `${spaceName} · space task review.` : 'Org-wide task review. General space.'}</p>

      <div className="kpi-row">
        <Kpi icon={AlertTriangle} label="Overdue" value={stats.overdue} accent="var(--overdue)" onClick={go(`/tasks?overdue=1${linkSuffix}`)} />
        <Kpi icon={Clock} label="Due ≤ 7 days" value={stats.due_soon} accent="var(--st-blocked)" />
        <Kpi icon={List} label="Open" value={openTotal} />
        <Kpi icon={Check} label="Done (30d)" value={stats.completed_30d} accent="var(--st-done)" />
        <Kpi icon={RefreshCw} label="Revised" value={stats.revised} accent="var(--st-blocked)" onClick={go(`/tasks?revised=1${linkSuffix}`)} />
      </div>

      <section className="dash-card">
        <div className="dash-card-h">Status distribution <span className="dash-card-n">{statusTotal}</span></div>
        <div className="stbar" role="img" aria-label={byStatus.map(s => `${s.label} ${s.n}`).join(', ')}>
          {statusTotal === 0 ? <i className="stbar-empty" /> : byStatus.filter(s => s.n > 0).map(s => (
            <i key={s.key} title={`${s.label} · ${s.n}`} style={{ flexGrow: s.n, background: s.color }} />
          ))}
        </div>
        <ul className="stlegend">
          {byStatus.map(s => (
            <li key={s.key} className={s.n ? '' : 'zero'}>
              <span className="dot" style={{ background: s.color }} />
              <span className="stlegend-l">{s.label}</span>
              <span className="stlegend-n">{s.n}</span>
              <span className="stlegend-p">{statusTotal ? Math.round(s.n / statusTotal * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="dash-card">
        <div className="dash-card-h">By team <span className="dash-card-n">{byTeam.length}</span></div>
        <div className="dtable-wrap">
          <table className="dtable">
            <thead><tr><th>Team</th><th className="num">Open</th><th className="num">Done</th><th className="num">Overdue</th></tr></thead>
            <tbody>
              {byTeam.length === 0 && <tr><td colSpan={4} className="dtable-none">No tasks yet.</td></tr>}
              {byTeam.map(r => {
                const href = `/tasks?department_id=${r.id}${linkSuffix}`;
                return (
                  <tr key={r.id || r.name} className="clickable" tabIndex={0} onClick={go(href)} onKeyDown={rowKeys(href)}>
                    <td><span className="dtable-name"><span className="dot" style={{ background: personColor(r.id || r.name) }} />{r.name || '—'}</span></td>
                    <td className="num">{r.open}</td><td className="num">{r.done}</td>
                    <td className={'num' + (r.overdue ? ' over' : '')}>{r.overdue}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dash-card">
        <div className="dash-card-h">By person · owner workload <span className="dash-card-n">{byPerson.length}</span></div>
        <div className="dtable-wrap">
          <table className="dtable">
            <thead><tr><th>Person</th><th className="num">Open</th><th className="num">Done</th><th className="num">Overdue</th><th className="dt-seen">Last seen</th><th className="dt-load">Load</th></tr></thead>
            <tbody>
              {byPerson.length === 0 && <tr><td colSpan={6} className="dtable-none">No tasks yet.</td></tr>}
              {byPerson.map(r => {
                const total = Math.max(1, r.open + r.done);
                const ls = lastSeen(r.last_seen);
                const href = `/tasks?employee_id=${r.id}${linkSuffix}`;
                return (
                  <tr key={r.id || r.name} className="clickable" tabIndex={0} onClick={go(href)} onKeyDown={rowKeys(href)}>
                    <td><span className="dtable-name"><Avatar name={r.name} size={22} />{r.name || '—'}</span></td>
                    <td className="num">{r.open}</td><td className="num">{r.done}</td>
                    <td className={'num' + (r.overdue ? ' over' : '')}>{r.overdue}</td>
                    <td className="dt-seen" title={r.last_seen ? new Date(r.last_seen).toLocaleString('en-IN') : 'No activity recorded'} style={{ color: ls.color }}>{ls.label}</td>
                    <td className="dt-load"><div className="load"><div className="load-done" style={{ width: (r.done / total * 100) + '%' }} /><div className="load-open" style={{ width: (r.open / total * 100) + '%' }} /></div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// "Last seen" label + colour by ELAPSED time: minutes → hours → days (rolls over at 60m / 24h).
// green = within a day, normal ≤ a week, muted beyond, faint = never.
function lastSeen(iso) {
  if (!iso) return { label: 'never', color: 'var(--text-4)' };
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return { label: 'just now', color: 'var(--st-done)' };
  if (mins < 60) return { label: `${mins}m ago`, color: 'var(--st-done)' };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { label: `${hrs}h ago`, color: 'var(--st-done)' };
  const days = Math.floor(hrs / 24);
  return { label: `${days}d ago`, color: days <= 7 ? 'var(--text-2)' : 'var(--text-4)' };
}

// A stat tile: a card on the elevation system; a <button> when it links to a filtered list.
function Kpi({ icon: Ic, label, value, accent, onClick }) {
  const inner = (<>
    <span className="kpi-top"><Ic size={13} aria-hidden />{label}</span>
    <span className="kpi-val" style={{ color: accent || 'var(--text-1)' }}>{Number(value || 0)}</span>
  </>);
  return onClick
    ? <button type="button" className="kpi clickable" onClick={onClick}>{inner}</button>
    : <div className="kpi">{inner}</div>;
}
