'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { labelOf, EMPLOYMENT_TYPES, tenure } from '../../../lib/format.js';

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
  const recent = [...active]
    .filter(e => e.date_joined)
    .sort((a, b) => (b.date_joined || '').localeCompare(a.date_joined || ''))
    .slice(0, 6);

  // upcoming work anniversaries (within 30 days) — needs date_joined
  const anniv = upcoming(active, 'date_joined');
  const bdays = upcoming(active, 'date_of_birth');

  return (
    <div>
      <h1 style={h1}>Dashboard</h1>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        <Tile label="Headcount" value={active.length} accent />
        <Tile label="Departments" value={depts.length} />
        <Tile label="On Leave" value={byStatus.on_leave || 0} />
        <Tile label="Notice" value={byStatus.notice || 0} />
        <Tile label="Exited" value={byStatus.exited || 0} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <Card title="By Department">
          {depts.length === 0 ? <Empty /> : depts
            .slice().sort((a, b) => (b.headcount || 0) - (a.headcount || 0))
            .map(d => (
              <Row key={d.id} label={d.name} value={d.headcount || 0} />
            ))}
        </Card>

        <Card title="By Employment Type">
          {Object.keys(byType).length === 0 ? <Empty /> : Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => <Row key={k} label={labelOf(EMPLOYMENT_TYPES, k)} value={v} />)}
        </Card>

        <Card title="Recent Joiners">
          {recent.length === 0 ? <Empty /> : recent.map(e => (
            <ClickRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)}
              label={e.full_name} sub={e.job_title} value={tenure(e.date_joined)} />
          ))}
        </Card>

        <Card title="Upcoming Work Anniversaries">
          {anniv.length === 0 ? <Empty text="None in the next 30 days" /> : anniv.map(e => (
            <ClickRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)}
              label={e.full_name} sub={e.job_title} value={e._when} />
          ))}
        </Card>

        <Card title="Upcoming Birthdays">
          {bdays.length === 0 ? <Empty text="None in the next 30 days" /> : bdays.map(e => (
            <ClickRow key={e.id} onClick={() => router.push(`/people/detail/?id=${e.id}`)}
              label={e.full_name} sub={e.job_title} value={e._when} />
          ))}
        </Card>
      </div>
    </div>
  );
}

function tally(arr, keyFn) {
  const o = {};
  for (const x of arr) { const k = keyFn(x); o[k] = (o[k] || 0) + 1; }
  return o;
}
// nearest upcoming month-day for a date field, within 30 days
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

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 };
function Tile({ label, value, accent }) {
  return (
    <div style={{ flex: '1 1 130px', minWidth: 120, background: accent ? 'var(--accent-bg)' : 'var(--surface)', border: `1px solid ${accent ? 'var(--podium-green)' : 'var(--border)'}`, borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: accent ? 'var(--podium-green)' : 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-cond)', marginTop: 2 }}>{value}</div>
    </div>
  );
}
function Card({ title, children }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}><span>{label}</span><span style={{ fontWeight: 600 }}>{value}</span></div>;
}
function ClickRow({ label, sub, value, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
      <span><span>{label}</span>{sub && <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 6 }}>{sub}</span>}</span>
      <span style={{ color: 'var(--podium-green)', fontSize: 12, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
function Empty({ text = 'No data' }) { return <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '6px 0' }}>{text}</div>; }
