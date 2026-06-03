'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Plus, Search, ChevronRight, ChevronDown, Link2, MessageSquare, GitBranch } from 'lucide-react';
import { docketopsGet } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../../../lib/tasks.js';
import { fmtDate } from '../../../lib/format.js';

export default function TasksPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});

  // filters
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [priority, setPriority] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [revised, setRevised] = useState(false);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState('none');

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
    ]).then(([d, e]) => { setDepartments(d || []); setEmployees(e || []); });
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {
        status, department_id: departmentId, employee_id: employeeId, priority,
        overdue: overdue ? '1' : '', revised: revised ? '1' : '', lens: mine ? 'mine' : '',
        q: q.trim(),
      };
      const r = await docketopsGet('getTasks', params, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, status, departmentId, employeeId, priority, overdue, revised, mine, q, showToast]);
  useEffect(() => { load(); }, [load]);

  // Only top-level tasks in the main list (sub-tasks show on their parent detail).
  const topLevel = useMemo(() => tasks.filter(t => !t.parent_task_id), [tasks]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: topLevel }];
    const keyOf = (t) => groupBy === 'person'
      ? (t.owner_name || '— Unassigned —')
      : (t.department_name || '— No department —');
    const m = new Map();
    for (const t of topLevel) {
      const k = keyOf(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }));
  }, [topLevel, groupBy]);

  return (
    <div>
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={h1}>Tasks</h1>
          <p style={sub}>{(perms?.docket_view_all || perms?.docket_admin) ? 'All org tasks.' : 'Your tasks, your collaborations, and your team’s tasks.'}</p>
        </div>
        <button style={btnPrimary} onClick={() => router.push('/tasks/new')}><Plus size={14} /> New Task</button>
      </div>

      {/* filter bar */}
      <div style={filterBar}>
        <div style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title / DKT-no…" style={{ ...input, paddingLeft: 28 }} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={input}>
          <option value="">All statuses</option>
          {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select value={departmentId} onChange={e => setDepartmentId(e.target.value)} style={input}>
          <option value="">All teams</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={input}>
          <option value="">Anyone</option>
          {employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value)} style={input}>
          <option value="">All priorities</option>
          {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.short}</option>)}
        </select>
        <select value={groupBy} onChange={e => setGroupBy(e.target.value)} style={input}>
          <option value="none">No grouping</option>
          <option value="person">Group by person</option>
          <option value="department">Group by team</option>
        </select>
        <button style={toggleBtn(mine)}    onClick={() => setMine(m => !m)}>My tasks</button>
        <button style={toggleBtn(overdue)} onClick={() => setOverdue(o => !o)}>Overdue</button>
        <button style={toggleBtn(revised)} onClick={() => setRevised(r => !r)}>Revised</button>
      </div>

      {loading ? <Spinner /> : topLevel.length === 0 ? (
        <EmptyState title="No tasks" subtitle="Nothing matches these filters yet." />
      ) : (
        groups.map(g => (
          <div key={g.key} style={{ marginBottom: g.label ? 18 : 0 }}>
            {g.label && (
              <div style={groupHead} onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}>
                {collapsed[g.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {g.label} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {g.rows.length}</span>
              </div>
            )}
            {!collapsed[g.key] && (
              <div style={{ overflowX: 'auto' }}>
                <table style={table}>
                  <thead><tr>
                    <th style={th}>ID</th><th style={th}>Title</th><th style={th}>Team</th>
                    <th style={th}>Owner</th><th style={th}>Assignee</th><th style={th}>Status</th>
                    <th style={th}>Pri</th><th style={th}>Deadline</th><th style={th}></th>
                  </tr></thead>
                  <tbody>
                    {g.rows.map(t => {
                      const od = isOverdue(t);
                      return (
                        <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/tasks/detail/?id=${t.id}`)}>
                          <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', fontSize: 11 }}>{t.task_no}</td>
                          <td style={{ ...td, color: 'var(--text-1)', fontWeight: 500 }}>
                            {t.title}
                            {t.revised_deadline && <span title="Deadline revised" style={flag}>revised</span>}
                          </td>
                          <td style={td}>{t.department_name || '—'}</td>
                          <td style={td}>{t.owner_name || '—'}</td>
                          <td style={td}>{t.assignee_name || '—'}</td>
                          <td style={td}><StatusBadge status={t.status} /></td>
                          <td style={td}><PriorityBadge priority={t.priority} /></td>
                          <td style={{ ...td, color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>
                            {fmtDate(effectiveDeadline(t))}
                          </td>
                          <td style={{ ...td, color: 'var(--text-4)' }}>
                            <span style={meta}>
                              {t.child_count > 0 && <span title="sub-tasks"><GitBranch size={12} /> {t.child_done}/{t.child_count}</span>}
                              {t.doc_count > 0 && <span title="documents"><Link2 size={12} /> {t.doc_count}</span>}
                              {t.comment_count > 0 && <span title="comments"><MessageSquare size={12} /> {t.comment_count}</span>}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4 };
const filterBar = { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' };
const input = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none' };
const table = { width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const th = { textAlign: 'left', padding: '8px 12px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '9px 12px', fontSize: 13, color: 'var(--text-2)', borderBottom: '1px solid var(--border)' };
const groupHead = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 4 };
const flag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const meta = { display: 'inline-flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '7px 14px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em', background: 'var(--docket-accent)', color: '#1f1f1f', border: '1px solid var(--docket-accent)' };
function toggleBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? '#1f1f1f' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}
