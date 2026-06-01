'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, Chip, useListNav } from '@throttle/ui';
import { UserPlus } from 'lucide-react';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import StatusBadge from '../../../components/StatusBadge.js';

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'on_leave', label: 'On Leave' },
  { id: 'notice', label: 'Notice' },
  { id: 'exited', label: 'Exited' },
  { id: 'all', label: 'All' },
];

export default function PeoplePage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [depts, setDepts] = useState([]);
  const [dept, setDept] = useState('');
  const [loading, setLoading] = useState(false);
  const { focusedIdx, setFocusedIdx } = useListNav(rows.length, (i) => {
    const r = rows[i]; if (r) router.push(`/people/detail/?id=${r.id}`);
  });

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getDepartments', {}, session).then(d => setDepts(d.departments || [])).catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    const params = { status: tab, limit: 1000 };
    if (search) params.search = search;
    if (dept) params.department_id = dept;
    podiumopsGet('getEmployees', params, session)
      .then(r => setRows(r.employees || []))
      .finally(() => setLoading(false));
  }, [tab, search, dept, session]);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={h1}>Directory</h1>
        {perms?.podium_hr && (
          <button onClick={() => router.push('/people/new')} style={newBtn}>
            <UserPlus size={15} strokeWidth={2.25} /> New Person
          </button>
        )}
      </header>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map(t => <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Chip>)}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input data-search-primary placeholder="Search name, code, title, email…" value={search} onChange={e => setSearch(e.target.value)} style={inputStyle(280)} />
        <select value={dept} onChange={e => setDept(e.target.value)} style={inputStyle(180)}>
          <option value="">All departments</option>
          {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
                <th style={th}>Code</th><th style={th}>Name</th><th style={th}>Title</th>
                <th style={th}>Department</th><th style={th}>Manager</th><th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No results</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.id} onClick={() => router.push(`/people/detail/?id=${r.id}`)} onMouseEnter={() => setFocusedIdx(i)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)', background: focusedIdx === i ? 'var(--surface-2)' : 'transparent', outline: focusedIdx === i ? '2px solid var(--podium-accent)' : 'none', outlineOffset: '-2px' }}>
                  <td style={td}><span style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>{r.employee_code}</span></td>
                  <td style={td}>{r.full_name}{r.preferred_name && <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 6 }}>({r.preferred_name})</span>}</td>
                  <td style={td}>{r.job_title || '—'}</td>
                  <td style={td}>{r.department?.name || '—'}</td>
                  <td style={td}>{r.manager?.full_name || '—'}</td>
                  <td style={td}><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const newBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
function inputStyle(w) { return { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, width: w }; }
