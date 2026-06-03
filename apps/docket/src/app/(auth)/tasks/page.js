'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast, Combobox } from '@throttle/ui';
import { Search, ChevronRight, ChevronDown, Link2, MessageSquare, GitBranch, Plus, Check, X, Flag, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { DatePicker } from '../../../components/DatePicker.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { STATUSES, SETTABLE_STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../../../lib/tasks.js';
import { fmtDate } from '../../../lib/format.js';

// Shared column widths so the Grid (tinted tray) and the active board line up exactly.
// Title has no width → it absorbs the remaining space (table-layout: fixed).
const COLS = [
  { w: 60 },   // ID
  {},          // Title (flex)
  { w: 128 },  // Team
  { w: 140 },  // Owner
  { w: 104 },  // Collaborators
  { w: 118 },  // Status
  { w: 60 },   // Pri
  { w: 156 },  // Deadline
  { w: 64 },   // Meta
];
const ROW_PAD = 12; // horizontal inset shared by the tray and the board so columns align

export default function TasksPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});

  // Structured filters (server-side) — live in the filter popover.
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [priority, setPriority] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [revised, setRevised] = useState(false);
  const [mine, setMine] = useState(false);
  const [groupBy, setGroupBy] = useState('none');
  // Text search (client-side, instant) + UI state.
  const [q, setQ] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [drawerId, setDrawerId] = useState(null);

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);
  const teamOpts = useMemo(() => departments.map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const statusOpts = STATUSES.map(s => ({ value: s.key, label: s.label }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const statusCellOpts = [...SETTABLE_STATUSES.map(s => ({ value: s.key, label: s.label })), { value: 'abandoned', label: 'Abandon…' }];
  const groupOpts = [{ value: 'none', label: 'No grouping' }, { value: 'person', label: 'Group by owner' }, { value: 'department', label: 'Group by team' }];

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
      };
      const r = await docketopsGet('getTasks', params, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, status, departmentId, employeeId, priority, overdue, revised, mine, showToast]);
  useEffect(() => { load(); }, [load]);

  // Client-side multi-token search: every whitespace token must match somewhere in
  // task_no / title / owner / team / creator / collaborator names.
  const tokens = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const matchesQuery = useCallback((t) => {
    if (!tokens.length) return true;
    const hay = [t.task_no, t.title, t.owner_name, t.department_name, t.creator_name,
      ...(t.collaborators || []).map(c => c.full_name)].filter(Boolean).join(' ').toLowerCase();
    return tokens.every(tok => hay.includes(tok));
  }, [tokens]);

  const activeFilterCount = [status, departmentId, employeeId, priority].filter(Boolean).length
    + [overdue, revised, mine].filter(Boolean).length;
  function clearFilters() {
    setStatus(''); setDepartmentId(''); setEmployeeId(''); setPriority('');
    setOverdue(false); setRevised(false); setMine(false);
  }

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
        if (field === 'department_id') patch.department_name = deptMap[value] || null;
        patchRow(task.id, patch);
      }
    } catch (e) { showToast(e.message || 'Save failed', 'error'); load(); }
  }
  async function abandonInline(task, reason) {
    if (!reason || !reason.trim()) return;
    try { await docketopsPost('abandonTask', { id: task.id, reason: reason.trim() }, session); patchRow(task.id, { status: 'abandoned' }); showToast('Task abandoned', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function reviseInline(task, newDeadlineIso, reason) {
    try {
      await docketopsPost('reviseDeadline', { id: task.id, new_deadline: newDeadlineIso, reason }, session);
      patchRow(task.id, { revised_deadline: newDeadlineIso });
      showToast('Deadline revised', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function addSubtask(task, title) {
    try { await docketopsPost('createSubtask', { parent_task_id: task.id, title }, session); patchRow(task.id, { child_count: (task.child_count || 0) + 1 }); showToast('Sub-task added', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  const topLevel = useMemo(() => tasks.filter(t => !t.parent_task_id && matchesQuery(t)), [tasks, matchesQuery]);
  const gridRows = useMemo(() => topLevel.filter(t => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id)), [topLevel]);
  const boardRows = useMemo(() => topLevel.filter(t => !(t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id))), [topLevel]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: boardRows }];
    const keyOf = (t) => groupBy === 'person' ? (t.owner_name || '— Unassigned —') : (t.department_name || '— No team —');
    const m = new Map();
    for (const t of boardRows) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }));
  }, [boardRows, groupBy]);

  const rowProps = { saveField, abandonInline, reviseInline, addSubtask, openDrawer: setDrawerId, teamOpts, empOpts, statusCellOpts, prioOpts };

  return (
    <div>
      <QuickCapture session={session} onCreated={load} showToast={showToast} />

      {/* Search + a single Filter button (consolidates the old 9-control bar). */}
      <div style={controlBar}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 460 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)', zIndex: 1 }} />
          <input data-search-primary value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks, owners, DKT-no…  ( / )" style={{ ...finput, paddingLeft: 30 }} />
          {q && <button onClick={() => setQ('')} style={searchClear} title="Clear search"><X size={13} /></button>}
        </div>
        <div style={{ position: 'relative' }}>
          <button className="dk-press" style={filterBtn(filterOpen || activeFilterCount > 0)} onClick={() => setFilterOpen(o => !o)}>
            <SlidersHorizontal size={13} /> Filter{activeFilterCount > 0 && <span style={countBadge}>{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <FilterPopover
              onClose={() => setFilterOpen(false)}
              {...{ status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId, priority, setPriority,
                overdue, setOverdue, revised, setRevised, mine, setMine, groupBy, setGroupBy,
                statusOpts, teamOpts, empOpts, prioOpts, groupOpts, activeFilterCount, clearFilters }}
            />
          )}
        </div>
      </div>

      {loading && tasks.length === 0 ? <Spinner /> : (topLevel.length === 0 ? (
        (q || activeFilterCount > 0) ? (
          <div style={{ textAlign: 'center', padding: '8px 16px 4px' }}>
            <EmptyState title="No tasks match" message="Try a different search or widen the filters." />
            {(activeFilterCount > 0) && <button className="dk-press" style={{ ...clearBtn, marginTop: 8 }} onClick={clearFilters}><X size={12} /> Clear filters</button>}
          </div>
        ) : (
          <EmptyState title="No tasks" message="Type a title above and hit Enter to capture your first one." />
        )
      ) : (
        <div style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto', transition: 'opacity var(--duration-default) var(--ease-out)' }}>
          {/* THE GRID — tinted inbox tray for captured-but-incomplete tasks */}
          {gridRows.length > 0 && (
            <div style={tray}>
              <div style={trayHead}>
                <Flag size={13} style={{ color: 'var(--docket-accent)' }} />
                NEEDS SETUP <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {gridRows.length}</span>
                <span style={trayHint}>add an owner + deadline to move onto the board</span>
              </div>
              <TaskTable rows={gridRows} {...rowProps} />
            </div>
          )}
          {/* ACTIVE BOARD */}
          {boardRows.length > 0 && (
            <div style={{ padding: `0 ${ROW_PAD}px` }}>
              {groupBy === 'none' && gridRows.length > 0 && <div style={boardLabel}>Active</div>}
              {groups.map(g => (
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
            </div>
          )}
        </div>
      ))}

      {drawerId && (
        <TaskDrawer id={drawerId} session={session} departments={departments} employees={employees}
          onClose={() => setDrawerId(null)} onMutated={load} />
      )}
    </div>
  );
}

function FilterPopover({ onClose, status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId,
  priority, setPriority, overdue, setOverdue, revised, setRevised, mine, setMine, groupBy, setGroupBy,
  statusOpts, teamOpts, empOpts, prioOpts, groupOpts, activeFilterCount, clearFilters }) {
  const ref = useRef(null);
  useEffect(() => {
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} style={filterPop}>
      <div style={fpGroup}>
        <label style={fpLabel}>Status</label>
        <Combobox value={status} options={statusOpts} onChange={setStatus} placeholder="Any status" allowClear style={finput} />
      </div>
      <div style={fpGroup}>
        <label style={fpLabel}>Team</label>
        <Combobox value={departmentId} options={teamOpts} onChange={setDepartmentId} placeholder="Any team" allowClear style={finput} />
      </div>
      <div style={fpGroup}>
        <label style={fpLabel}>Owner</label>
        <Combobox value={employeeId} options={empOpts} onChange={setEmployeeId} placeholder="Anyone" allowClear style={finput} />
      </div>
      <div style={fpGroup}>
        <label style={fpLabel}>Priority</label>
        <Combobox value={priority} options={prioOpts} onChange={setPriority} placeholder="Any priority" allowClear style={finput} />
      </div>
      <div style={fpGroup}>
        <label style={fpLabel}>Group by</label>
        <Combobox value={groupBy} options={groupOpts} onChange={(v) => setGroupBy(v || 'none')} placeholder="No grouping" allowClear={false} style={finput} />
      </div>
      <div style={{ ...fpGroup, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <button className="dk-press" style={toggleBtn(mine)} onClick={() => setMine(m => !m)}>My tasks</button>
        <button className="dk-press" style={toggleBtn(overdue)} onClick={() => setOverdue(o => !o)}>Overdue</button>
        <button className="dk-press" style={toggleBtn(revised)} onClick={() => setRevised(r => !r)}>Revised</button>
      </div>
      {activeFilterCount > 0 && (
        <button className="dk-press" style={{ ...clearBtn, width: '100%', justifyContent: 'center', marginTop: 4 }} onClick={clearFilters}><X size={12} /> Clear all filters</button>
      )}
    </div>
  );
}

function TaskTable({ rows, saveField, abandonInline, reviseInline, addSubtask, openDrawer, teamOpts, empOpts, statusCellOpts, prioOpts }) {
  // Property cells (team/owner/status/priority) use whole-row edit mode so native
  // Tab walks them in order; comboboxes commit on Tab (commitOnTab). The title and
  // DKT-id open the drawer (Notion model: name opens the peek, properties edit inline).
  const [editRow, setEditRow] = useState(null);
  const [focusField, setFocusField] = useState(null);
  const [abandonFor, setAbandonFor] = useState(null);
  const [abandonReason, setAbandonReason] = useState('');
  const [subFor, setSubFor] = useState(null);
  const [subTitle, setSubTitle] = useState('');

  useEffect(() => {
    if (!editRow && !abandonFor && !subFor) return;
    function onDown(e) {
      const rowId = editRow || abandonFor || subFor;
      const el = document.getElementById('dk-row-' + rowId);
      if (el && !el.contains(e.target)) { setEditRow(null); setAbandonFor(null); setSubFor(null); }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editRow, abandonFor, subFor]);

  function startEdit(t, field) {
    if (!t._can_edit || t.status === 'abandoned') return;
    setFocusField(field); setEditRow(t.id);
  }

  return (
    <div style={{ overflow: editRow || abandonFor || subFor ? 'visible' : 'auto' }}>
      <table style={table}>
        <colgroup>{COLS.map((c, i) => <col key={i} style={c.w ? { width: c.w } : undefined} />)}</colgroup>
        <thead><tr>
          <th style={th}>ID</th><th style={th}>Title</th><th style={th}>Team</th>
          <th style={th}>Owner</th><th style={th}>People</th><th style={th}>Status</th>
          <th style={th}>Pri</th><th style={th}>Deadline</th><th style={th}></th>
        </tr></thead>
        <tbody>
          {rows.map(t => {
            const od = isOverdue(t);
            const ed = !!t._can_edit && t.status !== 'abandoned';
            const isEdit = editRow === t.id;
            const Disp = ({ field, children }) => (
              <span onClick={() => startEdit(t, field)}
                className={ed ? 'dk-editable' : undefined}
                role={ed ? 'button' : undefined} tabIndex={ed ? 0 : undefined}
                onKeyDown={ed ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(t, field); } }) : undefined}
                style={{ cursor: ed ? 'pointer' : 'default', display: 'inline-block', minWidth: 24 }}>{children}</span>
            );
            return (
              <tr key={t.id} id={'dk-row-' + t.id} className="dk-task-row" onKeyDown={e => { if (e.key === 'Escape') { setEditRow(null); setAbandonFor(null); setSubFor(null); } }}>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <button className="dk-idlink" style={idBtn} onClick={() => openDrawer(t.id)} title="Open task">{t.task_no}</button>
                </td>

                <td style={{ ...td, color: 'var(--text-1)', fontWeight: 500 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative', maxWidth: '100%' }}>
                    <span className="dk-idlink" onClick={() => openDrawer(t.id)} style={{ cursor: 'pointer' }}>
                      {t.title}{t.revised_deadline && <span style={flag}>revised</span>}
                    </span>
                    {ed && <button className="dk-subadd dk-press" style={subAddBtn} title="Add sub-task" onClick={() => { setSubTitle(''); setSubFor(t.id); }}><Plus size={12} /></button>}
                    {subFor === t.id && (
                      <span style={subPop} onMouseDown={e => e.stopPropagation()}>
                        <GitBranch size={12} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                        <input autoFocus value={subTitle} onChange={e => setSubTitle(e.target.value)} placeholder="Sub-task title…" style={subInput}
                          onKeyDown={e => { if (e.key === 'Enter' && subTitle.trim()) { addSubtask(t, subTitle.trim()); setSubFor(null); } if (e.key === 'Escape') setSubFor(null); }} />
                        <button className="dk-press" style={subAddConfirm} disabled={!subTitle.trim()} onClick={() => { addSubtask(t, subTitle.trim()); setSubFor(null); }}><Check size={12} /></button>
                      </span>
                    )}
                  </span>
                </td>

                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 120 }}><Combobox autoFocus={focusField === 'department_id'} value={t.department_id || ''} options={teamOpts} placeholder="Team…" commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'department_id', v); }} /></div>
                    : <Disp field="department_id">{t.department_name || <Muted>set team</Muted>}</Disp>}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 130 }}><Combobox autoFocus={focusField === 'owner_employee_id'} value={t.owner_employee_id || ''} options={empOpts} placeholder="Owner…" commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'owner_employee_id', v); }} /></div>
                    : <Disp field="owner_employee_id">{t.owner_name || <Muted>set owner</Muted>}</Disp>}
                </td>
                <td style={td}>
                  <span style={{ cursor: 'pointer' }} onClick={() => openDrawer(t.id)}><Collaborators list={t.collaborators} /></span>
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 130 }}><Combobox autoFocus={focusField === 'status'} value={t.status} options={statusCellOpts} placeholder="Status…" allowClear={false} commitOnTab style={cellInput} onChange={(v, opt) => { if (!opt) return; if (v === 'abandoned') { setAbandonReason(''); setAbandonFor(t.id); } else saveField(t, 'status', v); }} /></div>
                    : (ed ? <Disp field="status"><StatusBadge status={t.status} /></Disp> : <StatusBadge status={t.status} />)}
                  {abandonFor === t.id && (
                    <div style={popover} onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
                      <div style={popLabel}>Abandon task</div>
                      <input autoFocus value={abandonReason} onChange={e => setAbandonReason(e.target.value)} placeholder="Reason (required, logged)" style={{ ...cellInput, width: '100%', marginBottom: 8 }}
                        onKeyDown={e => { if (e.key === 'Enter' && abandonReason.trim()) { abandonInline(t, abandonReason.trim()); setAbandonFor(null); } if (e.key === 'Escape') setAbandonFor(null); }} />
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button style={popBtnGhost} onClick={() => setAbandonFor(null)}><X size={13} /></button>
                        <button className="dk-press" style={{ ...popBtnDanger, opacity: abandonReason.trim() ? 1 : 0.5 }} disabled={!abandonReason.trim()} onClick={() => { abandonInline(t, abandonReason.trim()); setAbandonFor(null); }}><Check size={13} /> Abandon</button>
                      </div>
                    </div>
                  )}
                </td>
                <td style={td}>
                  {isEdit && ed ? <div style={{ minWidth: 120 }}><Combobox autoFocus={focusField === 'priority'} value={t.priority} options={prioOpts} placeholder="Priority…" allowClear={false} commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'priority', v); }} /></div>
                    : <Disp field="priority"><PriorityBadge priority={t.priority} /></Disp>}
                </td>

                <td style={td}>
                  <DeadlineCell task={t} editable={ed} od={od} onFirstSet={(iso) => saveField(t, 'deadline', iso)} onRevise={reviseInline} />
                </td>

                <td style={{ ...td, color: 'var(--text-4)', cursor: 'pointer' }} onClick={() => openDrawer(t.id)}>
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

function initials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function Collaborators({ list }) {
  if (!list || !list.length) return <span style={{ color: 'var(--text-4)' }}>—</span>;
  const shown = list.slice(0, 3);
  const extra = list.length - shown.length;
  const names = list.map(c => c.full_name || '—').join(', ');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }} title={names}>
      {shown.map((c, i) => <span key={c.id || i} style={{ ...avatar, marginLeft: i ? -6 : 0, zIndex: 5 - i }}>{initials(c.full_name)}</span>)}
      {extra > 0 && <span style={{ ...avatar, marginLeft: -6, background: 'var(--surface-3)', color: 'var(--text-2)' }}>+{extra}</span>}
    </span>
  );
}

// Deadline cell: no-deadline → "set date" (DatePicker, no reason); set → date with
// click-to-revise (DatePicker + required reason, audited — RULE-DOCKET-001).
function DeadlineCell({ task, editable, od, onFirstSet, onRevise }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const ref = useRef(null);
  const eff = effectiveDeadline(task);

  useEffect(() => {
    if (!open) return;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function start() { setDraft(eff); setReason(''); setOpen(true); }
  async function commit() {
    if (!draft) return;
    if (task.deadline) { if (!reason.trim()) return; await onRevise(task, draft, reason.trim()); }
    else { await onFirstSet(draft); }
    setOpen(false);
  }

  const trigger = !eff
    ? (editable ? <span onClick={start} style={{ cursor: 'pointer', color: 'var(--text-4)', fontStyle: 'italic' }}>set date</span> : <span style={{ color: 'var(--text-4)' }}>—</span>)
    : <span onClick={editable ? start : undefined} style={{ cursor: editable ? 'pointer' : 'default', color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>{fmtDate(eff)}</span>;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {trigger}
      {od && <span style={odFlag}><AlertTriangle size={9} /> overdue</span>}
      {open && (
        <div style={popover} onMouseDown={e => e.stopPropagation()}>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          {task.deadline && <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required, logged)" style={{ ...cellInput, width: '100%', marginTop: 8 }} />}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
            <button style={popBtnGhost} onClick={() => setOpen(false)}><X size={13} /></button>
            <button className="dk-press" style={{ ...popBtnPrimary, opacity: (draft && (!task.deadline || reason.trim())) ? 1 : 0.5 }} disabled={!draft || (!!task.deadline && !reason.trim())} onClick={commit}><Check size={13} /> {task.deadline ? 'Revise' : 'Set'}</button>
          </div>
        </div>
      )}
    </span>
  );
}

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
        placeholder="Add a task — type a title and press Enter (it lands under Needs Setup to fill in later)…"
        style={{ ...ainput, flex: 1 }} disabled={saving} />
      <button className="dk-press" style={{ ...addBtn, opacity: title.trim() && !saving ? 1 : 0.5 }} onClick={add} disabled={!title.trim() || saving}>
        {saving ? '…' : 'Add'}
      </button>
    </div>
  );
}

const addRow = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '9px 14px', marginBottom: 12 };
const ainput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const addBtn = { background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '8px 18px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };

const controlBar = { display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' };
const finput = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontSize: 12, outline: 'none', width: '100%' };
const searchClear = { position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', display: 'inline-flex', padding: 2 };
function filterBtn(active) {
  return { display: 'inline-flex', alignItems: 'center', gap: 6, background: active ? 'var(--accent-bg)' : 'var(--surface-2)', color: active ? 'var(--docket-accent)' : 'var(--text-2)', border: `1px solid ${active ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
}
const countBadge = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 16, height: 16, padding: '0 4px', background: 'var(--docket-accent)', color: 'var(--accent-fg)', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700 };
const filterPop = { position: 'absolute', top: '100%', right: 0, zIndex: 40, marginTop: 6, width: 240, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: 10 };
const fpGroup = { display: 'flex', flexDirection: 'column', gap: 4 };
const fpLabel = { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 };

const tray = { background: 'var(--accent-bg)', border: '1px solid rgba(242,205,26,0.22)', borderLeft: '2px solid var(--docket-accent)', borderRadius: 'var(--radius-md)', padding: `6px ${ROW_PAD}px 10px`, marginBottom: 20 };
const trayHead = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '6px 0 8px' };
const trayHint = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 };
const boardLabel = { fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-3)', padding: '4px 0 8px' };

const table = { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' };
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const td = { padding: '7px 10px', fontSize: 13, color: 'var(--text-2)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis' };
const cellInput = { background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const groupHead = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 4 };
const flag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const odFlag = { display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--state-error-fg)', background: 'var(--state-error-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', fontWeight: 600 };
const meta = { display: 'inline-flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 };
const avatar = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 'var(--radius-full)', background: 'var(--docket-accent)', color: 'var(--accent-fg)', fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', border: '1.5px solid var(--bg)', flexShrink: 0 };
const idBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', transition: 'color var(--duration-fast) var(--ease-out)' };
const clearBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
const subAddBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, background: 'var(--surface-2)', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', flexShrink: 0 };
const subPop = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: '6px 8px', width: 300, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const subInput = { flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 12, outline: 'none', fontFamily: 'inherit' };
const subAddConfirm = { display: 'inline-flex', alignItems: 'center', background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 8px', cursor: 'pointer' };
const popover = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, minWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const popLabel = { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const popBtnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnDanger = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--state-error)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnGhost = { display: 'inline-flex', alignItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', cursor: 'pointer' };
function toggleBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? 'var(--accent-fg)' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}
