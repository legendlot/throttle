'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { labelOf, EMPLOYMENT_TYPES, tenure } from '../../../lib/format.js';
import { Avatar, KpiTile, card, cardLabel } from '../../../components/ui.js';

const BAR_COLS = ['#F2CD1A', '#9fb0ff', '#4ade80', '#fb923c', '#fbbf24', '#ff8a8a'];

export default function DashboardPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [emps, setEmps] = useState(null);
  const [depts, setDepts] = useState([]);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      podiumopsGet('getEmployees', { status: 'all', limit: 2000 }, session),
      podiumopsGet('getDepartments', {}, session).catch(() => ({ departments: [] })),
    ]).then(([e, d]) => { setEmps(e.employees || []); setDepts(d.departments || []); });
  }, [session]);

  if (!emps) return <Spinner />;

  const active = emps.filter(e => e.status === 'active');
  const byStatus = tally(emps, e => e.status);
  const byType = tally(active, e => e.employment_type || 'unknown');
  const newCount = active.filter(e => withinDays(e.date_joined, 30)).length;

  const recent = [...active]
    .filter(e => e.date_joined)
    .sort((a, b) => (b.date_joined || '').localeCompare(a.date_joined || ''))
    .slice(0, 6);
  const anniv = upcoming(active, 'date_joined');
  const bdays = upcoming(active, 'date_of_birth');

  const deptRows = depts.slice().sort((a, b) => (b.headcount || 0) - (a.headcount || 0));
  const maxHc = Math.max(1, ...deptRows.map(d => d.headcount || 0));
  const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const typeMax = Math.max(1, ...typeRows.map(([, v]) => v));

  return (
    <div>
      {/* KPI rail */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <KpiTile label="Headcount" value={active.length} sub={newCount ? `+${newCount} this month` : 'steady'} subColor="var(--green-bright)" stripe />
        <KpiTile label="Departments" value={depts.length} sub={`${deptRows.filter(d => (d.headcount || 0) > 0).length} active`} />
        <KpiTile label="On Leave" value={byStatus.on_leave || 0} sub={(byStatus.on_leave || 0) ? 'currently away' : 'none'} subColor="var(--warn-fg)" />
        <KpiTile label="Notice" value={byStatus.notice || 0} sub={(byStatus.notice || 0) ? 'serving notice' : 'none'} subColor="var(--bad-fg)" />
        <KpiTile label="New · 30d" value={newCount} sub={newCount ? 'onboarding' : 'none'} subColor="var(--green-bright)" />
      </div>

      {/* Card grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <div style={card}>
          <div style={cardLabel}>By Department</div>
          {deptRows.length === 0 ? <Empty /> : deptRows.map((d, i) => (
            <Bar key={d.id} label={d.name} value={d.headcount || 0} pct={Math.round((d.headcount || 0) / maxHc * 100)} color={BAR_COLS[i % BAR_COLS.length]} />
          ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Recent Joiners</div>
          {recent.length === 0 ? <Empty /> : recent.map(e => (
            <div key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)}
              style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
              <Avatar name={e.full_name} photoUrl={e.photo_url} tintKey={e.id} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{e.full_name}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)' }}>{e.job_title || '—'}</div>
              </div>
              <span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{tenure(e.date_joined)}</span>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>By Employment Type</div>
          {typeRows.length === 0 ? <Empty /> : typeRows.map(([k, v], i) => (
            <Bar key={k} label={labelOf(EMPLOYMENT_TYPES, k)} value={v} pct={Math.round(v / typeMax * 100)} color={BAR_COLS[(i + 1) % BAR_COLS.length]} />
          ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Upcoming Anniversaries</div>
          {anniv.length === 0 ? <Empty text="None in the next 30 days" /> : anniv.map(e => (
            <WhenRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)} name={e.full_name} title={e.job_title} when={e._when} />
          ))}
        </div>

        <div style={card}>
          <div style={cardLabel}>Upcoming Birthdays</div>
          {bdays.length === 0 ? <Empty text="None in the next 30 days" /> : bdays.map(e => (
            <WhenRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)} name={e.full_name} title={e.job_title} when={e._when} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Bar({ label, value, pct, color }) {
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--t-body)' }}>{label}</span>
        <span className="num" style={{ color: 'var(--t3)' }}>{value}</span>
      </div>
      <div style={{ height: 5, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}
function WhenRow({ name, title, when, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
      <span style={{ color: 'var(--t-body)' }}>{name}{title && <span style={{ color: 'var(--t4)', fontSize: 11, marginLeft: 6 }}>{title}</span>}</span>
      <span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{when}</span>
    </div>
  );
}
function Empty({ text = 'No data' }) { return <div style={{ color: 'var(--t3)', fontSize: 12, padding: '6px 0' }}>{text}</div>; }

function tally(arr, keyFn) { const o = {}; for (const x of arr) { const k = keyFn(x); o[k] = (o[k] || 0) + 1; } return o; }
function withinDays(d, n) {
  if (!d) return false;
  const dt = new Date(d); if (isNaN(dt)) return false;
  const days = Math.round((Date.now() - dt.getTime()) / 86400000);
  return days >= 0 && days <= n;
}
function upcoming(arr, field) {
  const now = new Date();
  const out = [];
  for (const e of arr) {
    if (!e[field]) continue;
    const d = new Date(e[field]);
    if (isNaN(d)) continue;
    const next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
    if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next.setFullYear(now.getFullYear() + 1);
    const days = Math.round((next - now) / 86400000);
    if (days >= 0 && days <= 30) out.push({ ...e, _days: days, _when: days === 0 ? 'Today' : `in ${days}d` });
  }
  return out.sort((a, b) => a._days - b._days).slice(0, 6);
}
