'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast } from '@throttle/ui';
import { Search, ChevronRight, ChevronDown, Link2, MessageSquare, GitBranch, Plus, Check, X } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { STATUSES, SETTABLE_STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../../../lib/tasks.js';
import { fmtDate, toLocalInput } from '../../../lib/format.js';

export default function TasksPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [me, setMe] = useState(null);
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

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
      docketopsGet('getMe', {}, session).catch(() => null),
    ]).then(([d, e, m]) => { setDepartments(d || []); setEmployees(e || []); setMe(m); });
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {
        status, department_id: departmentId, employee_id: employeeId, priority,
        overdue: overdue ? '1' : '', revised: revised ? '1' : '', lens: mine ? 'mine' : '', q: q.trim(),
      };
      const r = await docketopsGet('getTasks', params, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, status, departmentId, employeeId, priority, overdue, revised, mine, q, showToast]);
  useEffect(() => { load(); }, [load]);

  function patchRow(id, patch) { setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t))); }

  // Inline field save for an existing row.
  async function saveField(task, field, value) {
    try {
      if (field === 'status') {
        await docketopsPost('changeStatus', { id: task.id, status: value }, session);
        patchRow(task.id, { status: value });
      } else {
        await docketopsPost('updateTask', { id: task.id, [field]: value || null }, session);
        const patch = { [field]: value || null };
        if (field === 'owner_employee_id') patch.owner_name = empMap[value] || null;
        if (field === 'assignee_employee_id') patch.assignee_name = empMap[value] || null;
        if (field === 'department_id') patch.department_name = deptMap[value] || null;
        patchRow(task.id, patch);
      }
    } catch (e) { showToast(e.message || 'Save failed', 'error'); load(); }
  }
  async function abandonInline(task) {
    const reason = window.prompt('Reason for abandoning this task (logged):');
    if (!reason || !reason.trim()) return;
    try { await docketopsPost('abandonTask', { id: task.id, reason: reason.trim() }, session); patchRow(task.id, { status: 'abandoned' }); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function reviseInline(task, newDeadline, reason) {
    try {
      await docketopsPost('reviseDeadline', { id: task.id, new_deadline: new Date(newDeadline).toISOString(), reason }, session);
      patchRow(task.id, { revised_deadline: new Date(newDeadline).toISOString() });
      showToast('Deadline revised', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  const topLevel = useMemo(() => tasks.filter(t => !t.parent_task_id), [tasks]);
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: topLevel }];
    const keyOf = (t) => groupBy === 'person' ? (t.owner_name || '— Unassigned —') : (t.department_name || '— No team —');
    const m = new Map();
    for (const t of topLevel) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }));
  }, [topLevel, groupBy]);

  const empOpts = [{ value: '', label: '—' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))];
  const deptOpts = departments.map(d => ({ value: d.id, label: d.name }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.short }));

  return (
    <div>
      <style>{`.dk-cell:hover .dk-edithint{opacity:1}`}</style>
      <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={h1}>Tasks</h1>
          <p style={sub}>{(perms?.docket_view_all || perms?.docket_admin) ? 'All org tasks. Click any cell to edit.' : 'Your tasks, collaborations, and your team’s. Click any cell to edit.'}</p>
        </div>
      </div>

      {/* inline quick-add */}
      <AddRow me={me} departments={departments} employees={employees} session={session}
        onCreated={load} showToast={showToast} />

      {/* filter bar */}
      <div style={filterBar}>
        <div style={{ position: 'relative', flex: '1 1 180px' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title / DKT-no…" style={{ ...finput, paddingLeft: 28, width: '100%' }} />
        </div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={finput}>
          <option value="">All statuses</option>{STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select value={departmentId} onChange={e => setDepartmentId(e.target.value)} style={finput}>
          <option value="">All teams</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} style={finput}>
          <option value="">Anyone</option>{employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select>
        <select value={priority} onChange={e => setPriority(e.target.value)} style={finput}>
          <option value="">All priorities</option>{PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.short}</option>)}
        </select>
        <select value={groupBy} onChange={e => setGroupBy(e.target.value)} style={finput}>
          <option value="none">No grouping</option><option value="person">Group by person</option><option value="department">Group by team</option>
        </select>
        <button style={toggleBtn(mine)} onClick={() => setMine(m => !m)}>My tasks</button>
        <button style={toggleBtn(overdue)} onClick={() => setOverdue(o => !o)}>Overdue</button>
        <button style={toggleBtn(revised)} onClick={() => setRevised(r => !r)}>Revised</button>
      </div>

      {loading ? <Spinner /> : topLevel.length === 0 ? (
        <EmptyState title="No tasks" subtitle="Add one above, or adjust the filters." />
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
                      const ed = !!t._can_edit && t.status !== 'abandoned';
                      return (
                        <tr key={t.id}>
                          <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            <span style={{ color: 'var(--text-3)', cursor: 'pointer' }} onClick={() => router.push(`/tasks/detail/?id=${t.id}`)}>{t.task_no}</span>
                          </td>
                          <td style={{ ...td, color: 'var(--text-1)', fontWeight: 500, minWidth: 220 }}>
                            <Cell editable={ed} type="text" value={t.title}
                              display={<>{t.title}{t.revised_deadline && <span style={flag}>revised</span>}</>}
                              onSave={(v) => v && saveField(t, 'title', v)} />
                          </td>
                          <td style={td}><Cell editable={ed} type="select" value={t.department_id || ''} options={deptOpts}
                            display={t.department_name || '—'} onSave={(v) => saveField(t, 'department_id', v)} /></td>
                          <td style={td}><Cell editable={ed} type="select" value={t.owner_employee_id || ''} options={empOpts.slice(1)}
                            display={t.owner_name || '—'} onSave={(v) => saveField(t, 'owner_employee_id', v)} /></td>
                          <td style={td}><Cell editable={ed} type="select" value={t.assignee_employee_id || ''} options={empOpts}
                            display={t.assignee_name || '—'} onSave={(v) => saveField(t, 'assignee_employee_id', v)} /></td>
                          <td style={td}>
                            {ed ? <StatusSelect value={t.status} onChange={(v) => v === 'abandoned' ? abandonInline(t) : saveField(t, 'status', v)} />
                                : <StatusBadge status={t.status} />}
                          </td>
                          <td style={td}><Cell editable={ed} type="select" value={t.priority} options={prioOpts}
                            display={<PriorityBadge priority={t.priority} />} onSave={(v) => saveField(t, 'priority', v)} /></td>
                          <td style={{ ...td, minWidth: 130 }}>
                            <DeadlineCell task={t} editable={ed} od={od} onRevise={reviseInline} />
                          </td>
                          <td style={{ ...td, color: 'var(--text-4)', cursor: 'pointer' }} onClick={() => router.push(`/tasks/detail/?id=${t.id}`)}>
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

// ── inline quick-add row ────────────────────────────────────────────────────
function AddRow({ me, departments, employees, session, onCreated, showToast }) {
  const [title, setTitle] = useState('');
  const [dept, setDept] = useState('');
  const [owner, setOwner] = useState('');
  const [assignee, setAssignee] = useState('');
  const [prio, setPrio] = useState('P2');
  const [deadline, setDeadline] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef(null);

  // Prefill team + owner from the signed-in user once loaded.
  useEffect(() => {
    if (me) { if (me.department_id) setDept(d => d || me.department_id); if (me.employee_id) setOwner(o => o || me.employee_id); }
  }, [me]);

  const ready = title.trim() && dept && owner && deadline;
  async function add() {
    if (!ready) { showToast('Title, team, owner and deadline are required', 'error'); return; }
    setSaving(true);
    try {
      await docketopsPost('createTask', {
        title: title.trim(), department_id: dept, owner_employee_id: owner,
        assignee_employee_id: assignee || null, priority: prio, deadline: new Date(deadline).toISOString(),
      }, session);
      setTitle(''); setAssignee(''); setPrio('P2'); setDeadline('');
      await onCreated();
      titleRef.current?.focus();
    } catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div style={addRow}>
      <Plus size={15} style={{ color: 'var(--docket-accent)', flexShrink: 0 }} />
      <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && ready) add(); }}
        placeholder="Add a task — type a title…" style={{ ...ainput, flex: '2 1 220px' }} disabled={saving} />
      <select value={dept} onChange={e => setDept(e.target.value)} style={ainput} disabled={saving} title="Team">
        <option value="">Team…</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select value={owner} onChange={e => setOwner(e.target.value)} style={ainput} disabled={saving} title="Owner">
        <option value="">Owner…</option>{employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
      </select>
      <select value={assignee} onChange={e => setAssignee(e.target.value)} style={ainput} disabled={saving} title="Assignee">
        <option value="">Assignee…</option>{employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
      </select>
      <select value={prio} onChange={e => setPrio(e.target.value)} style={{ ...ainput, width: 64 }} disabled={saving} title="Priority">
        {PRIORITIES.map(p => <option key={p.key} value={p.key}>{p.short}</option>)}
      </select>
      <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} style={{ ...ainput, width: 188 }} disabled={saving} title="Deadline (required, locked once created)" />
      <button style={{ ...addBtn, opacity: ready && !saving ? 1 : 0.5 }} onClick={add} disabled={!ready || saving}>
        {saving ? '…' : 'Add'}
      </button>
    </div>
  );
}

// ── generic click-to-edit cell ──────────────────────────────────────────────
function Cell({ editable, type, value, options, display, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  if (!editable) return <span>{display}</span>;
  if (!editing) {
    return <span className="dk-cell" onClick={() => setEditing(true)}
      style={{ cursor: 'pointer', display: 'inline-block', minWidth: 20, borderBottom: '1px dotted transparent' }}
      onMouseEnter={e => (e.currentTarget.style.borderBottomColor = 'var(--border-2)')}
      onMouseLeave={e => (e.currentTarget.style.borderBottomColor = 'transparent')}>{display}</span>;
  }
  if (type === 'select') {
    return <select autoFocus value={draft} style={cellInput}
      onChange={e => { setEditing(false); if (e.target.value !== (value ?? '')) onSave(e.target.value); }}
      onBlur={() => setEditing(false)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>;
  }
  return <input autoFocus value={draft} style={cellInput}
    onChange={e => setDraft(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); } if (e.key === 'Escape') setEditing(false); }}
    onBlur={() => { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); }} />;
}

function StatusSelect({ value, onChange }) {
  const s = STATUSES.find(x => x.key === value) || STATUSES[0];
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...cellInput, color: s.color, fontWeight: 700, fontFamily: 'var(--font-cond)', textTransform: 'uppercase', fontSize: 11, letterSpacing: '0.04em' }}>
      {SETTABLE_STATUSES.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      <option value="abandoned">Abandon…</option>
    </select>
  );
}

// Deadline shows effective date; click → inline date+reason popover (audited revise).
function DeadlineCell({ task, editable, od, onRevise }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  function start() { setDate(toLocalInput(effectiveDeadline(task))); setReason(''); setOpen(true); }
  async function save() {
    if (!date || !reason.trim()) return;
    await onRevise(task, date, reason.trim());
    setOpen(false);
  }
  const label = <span style={{ color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>{fmtDate(effectiveDeadline(task))}</span>;
  if (!editable) return label;
  return (
    <span style={{ position: 'relative' }}>
      <span className="dk-cell" onClick={start} style={{ cursor: 'pointer' }} title="Revise deadline (reason required, logged)">{label}</span>
      {open && (
        <div style={popover} onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Revise deadline</div>
          <input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} style={{ ...cellInput, width: '100%', marginBottom: 6 }} />
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (logged)" style={{ ...cellInput, width: '100%', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button style={popBtnGhost} onClick={() => setOpen(false)}><X size={13} /></button>
            <button style={{ ...popBtnPrimary, opacity: date && reason.trim() ? 1 : 0.5 }} onClick={save} disabled={!date || !reason.trim()}><Check size={13} /> Revise</button>
          </div>
        </div>
      )}
    </span>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4 };
const addRow = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '8px 12px', marginBottom: 14 };
const ainput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontSize: 12, outline: 'none', fontFamily: 'inherit' };
const addBtn = { background: 'var(--docket-accent)', color: '#1f1f1f', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '6px 16px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const filterBar = { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' };
const finput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none' };
const table = { width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const th = { textAlign: 'left', padding: '8px 12px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '7px 12px', fontSize: 13, color: 'var(--text-2)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const cellInput = { background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 13, outline: 'none', fontFamily: 'inherit', maxWidth: 200 };
const groupHead = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 4 };
const flag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const meta = { display: 'inline-flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 };
const popover = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, width: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const popBtnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--docket-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnGhost = { display: 'inline-flex', alignItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', cursor: 'pointer' };
function toggleBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? '#1f1f1f' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}
