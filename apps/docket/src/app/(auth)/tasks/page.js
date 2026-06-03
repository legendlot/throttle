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
        if (field === 'deadline') patch.deadline = value || null;
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
  // The Grid = quick-captured tasks not yet ready to launch (no owner OR no deadline).
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
        <p style={sub}>{(perms?.docket_view_all || perms?.docket_admin) ? 'All org tasks. Type a title + Enter to capture; click any cell to edit.' : 'Your tasks, collaborations, and your team’s. Type a title + Enter to capture; click any cell to edit.'}</p>
      </div>

      {/* quick-capture: title + Enter → The Grid */}
      <QuickCapture session={session} onCreated={load} showToast={showToast} />

      {/* filter bar (all searchable comboboxes) */}
      <div style={filterBar}>
        <div style={{ position: 'relative', flex: '1 1 180px', minWidth: 160 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-3)', zIndex: 1 }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search title / DKT-no…" style={{ ...finput, paddingLeft: 28, width: '100%' }} />
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
          {/* The Grid */}
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

          {/* The board */}
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
  return (
    <div style={{ overflowX: 'auto' }}>
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
                <td style={td}><Cell editable={ed} type="combo" value={t.department_id || ''} options={teamOpts}
                  placeholder="Team…" display={t.department_name || <Muted>set team</Muted>} onSave={(v) => saveField(t, 'department_id', v)} /></td>
                <td style={td}><Cell editable={ed} type="combo" value={t.owner_employee_id || ''} options={empOpts}
                  placeholder="Owner…" display={t.owner_name || <Muted>set owner</Muted>} onSave={(v) => saveField(t, 'owner_employee_id', v)} /></td>
                <td style={td}><Cell editable={ed} type="combo" value={t.assignee_employee_id || ''} options={empOpts}
                  placeholder="Assignee…" display={t.assignee_name || <Muted>—</Muted>} onSave={(v) => saveField(t, 'assignee_employee_id', v)} /></td>
                <td style={td}>
                  {ed ? <Cell editable type="combo" value={t.status} options={statusCellOpts} placeholder="Status…"
                          display={<StatusBadge status={t.status} />}
                          onSave={(v) => v === 'abandoned' ? abandonInline(t) : saveField(t, 'status', v)} />
                      : <StatusBadge status={t.status} />}
                </td>
                <td style={td}><Cell editable={ed} type="combo" value={t.priority} options={prioOpts} placeholder="Priority…"
                  display={<PriorityBadge priority={t.priority} />} onSave={(v) => v && saveField(t, 'priority', v)} /></td>
                <td style={{ ...td, minWidth: 130 }}>
                  <DeadlineCell task={t} editable={ed} od={od} onSet={(date) => saveField(t, 'deadline', new Date(date).toISOString())} onRevise={reviseInline} />
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

// ── quick-capture: a single title field → The Grid ──────────────────────────
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

// ── generic click-to-edit cell (text or searchable combobox) ────────────────
function Cell({ editable, type, value, options, display, onSave, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  if (!editable) return <span>{display}</span>;
  if (!editing) {
    return <span onClick={() => setEditing(true)}
      style={{ cursor: 'pointer', display: 'inline-block', minWidth: 24, borderBottom: '1px dotted transparent' }}
      onMouseEnter={e => (e.currentTarget.style.borderBottomColor = 'var(--border-2)')}
      onMouseLeave={e => (e.currentTarget.style.borderBottomColor = 'transparent')}>{display}</span>;
  }
  if (type === 'combo') {
    return <div style={{ minWidth: 150 }}><Combobox autoFocus value={draft} options={options} placeholder={placeholder} style={cellInput}
      onChange={(v) => { setEditing(false); if (v !== (value ?? '')) onSave(v); }}
      onBlur={() => setEditing(false)} /></div>;
  }
  return <input autoFocus value={draft} style={cellInput}
    onChange={e => setDraft(e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); } if (e.key === 'Escape') setEditing(false); }}
    onBlur={() => { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); }} />;
}

// Deadline: first-time set is a plain date (becomes the immutable original);
// once set, editing opens a date+reason popover (audited revise — RULE-DOCKET-001).
function DeadlineCell({ task, editable, od, onSet, onRevise }) {
  const [setting, setSetting] = useState(false);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const hasDeadline = !!task.deadline;

  if (!hasDeadline) {
    if (!editable) return <span style={{ color: 'var(--text-4)' }}>—</span>;
    if (!setting) return <span onClick={() => { setDate(''); setSetting(true); }} style={{ cursor: 'pointer', color: 'var(--text-4)', fontStyle: 'italic' }}>set date</span>;
    return <input type="datetime-local" autoFocus value={date} style={{ ...cellInput, width: 180 }}
      onChange={e => setDate(e.target.value)}
      onKeyDown={e => { if (e.key === 'Escape') setSetting(false); if (e.key === 'Enter' && date) { setSetting(false); onSet(date); } }}
      onBlur={() => { setSetting(false); if (date) onSet(date); }} />;
  }

  const label = <span style={{ color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>{fmtDate(effectiveDeadline(task))}</span>;
  if (!editable) return label;
  async function save() { if (!date || !reason.trim()) return; await onRevise(task, date, reason.trim()); setOpen(false); }
  return (
    <span style={{ position: 'relative' }}>
      <span onClick={() => { setDate(toLocalInput(effectiveDeadline(task))); setReason(''); setOpen(true); }} style={{ cursor: 'pointer' }} title="Revise deadline (reason required, logged)">{label}</span>
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
