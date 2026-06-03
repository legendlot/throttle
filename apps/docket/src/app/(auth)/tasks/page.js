'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast, Combobox } from '@throttle/ui';
import { Search, ChevronRight, ChevronDown, Link2, MessageSquare, GitBranch, Plus, Check, X, Flag } from 'lucide-react';
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
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});

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
  const teamOpts = useMemo(() => departments.map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const statusOpts = STATUSES.map(s => ({ value: s.key, label: s.label }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const statusCellOpts = [...SETTABLE_STATUSES.map(s => ({ value: s.key, label: s.label })), { value: 'abandoned', label: 'Abandon…' }];
  const groupOpts = [{ value: 'none', label: 'No grouping' }, { value: 'person', label: 'Group by person' }, { value: 'department', label: 'Group by team' }];

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
        overdue: overdue ? '1' : '', revised: revised ? '1' : '', lens: mine ? 'mine' : '', q: q.trim(),
      };
      const r = await docketopsGet('getTasks', params, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, status, departmentId, employeeId, priority, overdue, revised, mine, q, showToast]);
  useEffect(() => { load(); }, [load]);

  function patchRow(id, patch) { setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t))); }

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
  const gridRows = useMemo(() => topLevel.filter(t => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id)), [topLevel]);
  const boardRows = useMemo(() => topLevel.filter(t => !(t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id))), [topLevel]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: boardRows }];
    const keyOf = (t) => groupBy === 'person' ? (t.owner_name || '— Unassigned —') : (t.department_name || '— No team —');
    const m = new Map();
    for (const t of boardRows) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }));
  }, [boardRows, groupBy]);

  const rowProps = { saveField, abandonInline, reviseInline, router, teamOpts, empOpts, statusCellOpts, prioOpts };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h1 style={h1}>Tasks</h1>
        <p style={sub}>{(perms?.docket_view_all || perms?.docket_admin) ? 'All org tasks. Type a title + Enter to capture; “/” to search; click a row and Tab through the cells.' : 'Your tasks, collaborations, and your team’s. Type a title + Enter to capture; “/” to search; Tab through a row’s cells.'}</p>
      </div>

      <QuickCapture session={session} onCreated={load} showToast={showToast} />

      <div style={filterBar}>
        <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)', zIndex: 1 }} />
          <input data-search-primary value={q} onChange={e => setQ(e.target.value)} placeholder="Search title / DKT-no…  ( / )" style={{ ...finput, paddingLeft: 28, width: '100%' }} />
        </div>
        <div style={fw}><Combobox value={status} options={statusOpts} onChange={setStatus} placeholder="All statuses" allowClear style={finput} /></div>
        <div style={fw}><Combobox value={departmentId} options={teamOpts} onChange={setDepartmentId} placeholder="All teams" allowClear style={finput} /></div>
        <div style={fw}><Combobox value={employeeId} options={empOpts} onChange={setEmployeeId} placeholder="Anyone" allowClear style={finput} /></div>
        <div style={{ width: 130 }}><Combobox value={priority} options={prioOpts} onChange={setPriority} placeholder="All priorities" allowClear style={finput} /></div>
        <div style={{ width: 150 }}><Combobox value={groupBy} options={groupOpts} onChange={(v) => setGroupBy(v || 'none')} placeholder="Grouping" allowClear={false} style={finput} /></div>
        <button style={toggleBtn(mine)} onClick={() => setMine(m => !m)}>My tasks</button>
        <button style={toggleBtn(overdue)} onClick={() => setOverdue(o => !o)}>Overdue</button>
        <button style={toggleBtn(revised)} onClick={() => setRevised(r => !r)}>Revised</button>
      </div>

      {loading ? <Spinner /> : (topLevel.length === 0 ? (
        <EmptyState title="No tasks" subtitle="Type a title above and hit Enter to capture your first one." />
      ) : (
        <>
          {gridRows.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              <div style={gridHead}>
                <Flag size={14} style={{ color: 'var(--docket-accent)' }} />
                THE GRID <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {gridRows.length}</span>
                <span style={gridHint}>captured — add an owner + deadline to launch onto the board</span>
              </div>
              <TaskTable rows={gridRows} {...rowProps} />
            </div>
          )}
          {boardRows.length > 0 && groups.map(g => (
            <div key={g.key} style={{ marginBottom: g.label ? 18 : 0 }}>
              {g.label && (
                <div style={groupHead} onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}>
                  {collapsed[g.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {g.label} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {g.rows.length}</span>
                </div>
              )}
              {!collapsed[g.key] && <TaskTable rows={g.rows} {...rowProps} />}
            </div>
          ))}
        </>
      ))}
    </div>
  );
}

function TaskTable({ rows, saveField, abandonInline, reviseInline, router, teamOpts, empOpts, statusCellOpts, prioOpts }) {
  // Row-edit mode: clicking a cell makes the whole row's cells editable controls,
  // so native Tab walks title → team → owner → … in order. Exit on Escape / outside click.
  const [editRow, setEditRow] = useState(null);
  const [focusField, setFocusField] = useState(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [ddDraft, setDdDraft] = useState('');

  useEffect(() => {
    if (!editRow) return;
    function onDown(e) {
      const el = document.getElementById('dk-row-' + editRow);
      if (el && !el.contains(e.target)) setEditRow(null);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editRow]);

  function startEdit(t, field) {
    if (!t._can_edit || t.status === 'abandoned') return;
    setTitleDraft(t.title || '');
    setDdDraft(t.deadline ? toLocalInput(t.deadline) : '');
    setFocusField(field); setEditRow(t.id);
  }

  return (
    // While a row is in edit mode, let the wrapper overflow so combobox dropdowns
    // float out over the rows below instead of being clipped (overflow-x:auto also
    // clips vertically). Horizontal scroll resumes once editing ends.
    <div style={{ overflow: editRow ? 'visible' : 'auto' }}>
      <table style={table}>
        <thead><tr>
          <th style={th}>ID</th><th style={th}>Title</th><th style={th}>Team</th>
          <th style={th}>Owner</th><th style={th}>Assignee</th><th style={th}>Status</th>
          <th style={th}>Pri</th><th style={th}>Deadline</th><th style={th}></th>
        </tr></thead>
        <tbody>
          {rows.map(t => {
            const od = isOverdue(t);
            const ed = !!t._can_edit && t.status !== 'abandoned';
            const isEdit = editRow === t.id;
            const Disp = ({ field, children }) => (
              <span onClick={() => startEdit(t, field)}
                style={{ cursor: ed ? 'pointer' : 'default', display: 'inline-block', minWidth: 24, borderBottom: '1px dotted transparent' }}
                onMouseEnter={e => { if (ed) e.currentTarget.style.borderBottomColor = 'var(--border-2)'; }}
                onMouseLeave={e => (e.currentTarget.style.borderBottomColor = 'transparent')}>{children}</span>
            );
            return (
              <tr key={t.id} id={'dk-row-' + t.id} onKeyDown={e => { if (e.key === 'Escape') setEditRow(null); }}>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <span style={{ color: 'var(--text-3)', cursor: 'pointer' }} onClick={() => router.push(`/tasks/detail/?id=${t.id}`)}>{t.task_no}</span>
                </td>

                <td style={{ ...td, color: 'var(--text-1)', fontWeight: 500, minWidth: 220 }}>
                  {isEdit && ed ? (
                    <input autoFocus={focusField === 'title'} value={titleDraft} style={cellInput}
                      onChange={e => setTitleDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      onBlur={() => { const v = titleDraft.trim(); if (v && v !== t.title) saveField(t, 'title', v); }} />
                  ) : <Disp field="title">{t.title}{t.revised_deadline && <span style={flag}>revised</span>}</Disp>}
                </td>

                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 150 }}><Combobox autoFocus={focusField === 'department_id'} value={t.department_id || ''} options={teamOpts} placeholder="Team…" style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'department_id', v); }} /></div>
                    : <Disp field="department_id">{t.department_name || <Muted>set team</Muted>}</Disp>}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 150 }}><Combobox autoFocus={focusField === 'owner_employee_id'} value={t.owner_employee_id || ''} options={empOpts} placeholder="Owner…" style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'owner_employee_id', v); }} /></div>
                    : <Disp field="owner_employee_id">{t.owner_name || <Muted>set owner</Muted>}</Disp>}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 150 }}><Combobox autoFocus={focusField === 'assignee_employee_id'} value={t.assignee_employee_id || ''} options={empOpts} placeholder="Assignee…" allowClear style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'assignee_employee_id', v); }} /></div>
                    : <Disp field="assignee_employee_id">{t.assignee_name || <Muted>—</Muted>}</Disp>}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 140 }}><Combobox autoFocus={focusField === 'status'} value={t.status} options={statusCellOpts} placeholder="Status…" allowClear={false} style={cellInput} onChange={(v, opt) => { if (!opt) return; v === 'abandoned' ? abandonInline(t) : saveField(t, 'status', v); }} /></div>
                    : (ed ? <Disp field="status"><StatusBadge status={t.status} /></Disp> : <StatusBadge status={t.status} />)}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 130 }}><Combobox autoFocus={focusField === 'priority'} value={t.priority} options={prioOpts} placeholder="Priority…" allowClear={false} style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'priority', v); }} /></div>
                    : <Disp field="priority"><PriorityBadge priority={t.priority} /></Disp>}
                </td>

                <td style={{ ...td, minWidth: 130 }}>
                  {isEdit && ed && !t.deadline ? (
                    <input type="datetime-local" autoFocus={focusField === 'deadline'} value={ddDraft} style={{ ...cellInput, width: 180 }}
                      onChange={e => setDdDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      onBlur={() => { if (ddDraft) saveField(t, 'deadline', new Date(ddDraft).toISOString()); }} />
                  ) : <DeadlineDisplay task={t} editable={ed} od={od} onStartSet={() => startEdit(t, 'deadline')} onRevise={reviseInline} />}
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
  );
}

function Muted({ children }) { return <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>{children}</span>; }

function QuickCapture({ session, onCreated, showToast }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try { await docketopsPost('createTask', { title: t }, session); setTitle(''); await onCreated(); ref.current?.focus(); }
    catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div style={addRow}>
      <Plus size={16} style={{ color: 'var(--docket-accent)', flexShrink: 0 }} />
      <input ref={ref} value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder="Add a task — type a title and press Enter (it lands on The Grid to fill in later)…"
        style={{ ...ainput, flex: 1 }} disabled={saving} />
      <button style={{ ...addBtn, opacity: title.trim() && !saving ? 1 : 0.5 }} onClick={add} disabled={!title.trim() || saving}>
        {saving ? '…' : 'Add'}
      </button>
    </div>
  );
}

// Deadline display: no-deadline → "set date" (enters row edit on the deadline cell);
// set → date with click-to-revise (date+reason popover, audited — RULE-DOCKET-001).
function DeadlineDisplay({ task, editable, od, onStartSet, onRevise }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  if (!task.deadline && !task.revised_deadline) {
    if (!editable) return <span style={{ color: 'var(--text-4)' }}>—</span>;
    return <span onClick={onStartSet} style={{ cursor: 'pointer', color: 'var(--text-4)', fontStyle: 'italic' }}>set date</span>;
  }
  const label = <span style={{ color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>{fmtDate(effectiveDeadline(task))}</span>;
  if (!editable) return label;
  async function save() { if (!date || !reason.trim()) return; await onRevise(task, date, reason.trim()); setOpen(false); }
  return (
    <span style={{ position: 'relative' }}>
      <span onClick={() => { setDate(toLocalInput(effectiveDeadline(task))); setReason(''); setOpen(true); }} style={{ cursor: 'pointer' }} title="Revise deadline (reason required, logged)">{label}</span>
      {open && (
        <div style={popover} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
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
const addRow = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '9px 14px', marginBottom: 14 };
const ainput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const addBtn = { background: 'var(--docket-accent)', color: '#1f1f1f', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '8px 18px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const filterBar = { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' };
const fw = { width: 150 };
const finput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none', width: '100%' };
const table = { width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' };
const th = { textAlign: 'left', padding: '8px 12px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700 };
const td = { padding: '7px 12px', fontSize: 13, color: 'var(--text-2)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const cellInput = { background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const groupHead = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 4 };
const gridHead = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 6, borderBottom: '2px solid var(--docket-accent)' };
const gridHint = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 };
const flag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const meta = { display: 'inline-flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 };
const popover = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, width: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const popBtnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--docket-accent)', color: '#1f1f1f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnGhost = { display: 'inline-flex', alignItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', cursor: 'pointer' };
function toggleBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? '#1f1f1f' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}
