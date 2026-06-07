'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState, useToast, Combobox } from '@throttle/ui';
import { Search, ChevronRight, ChevronDown, Link2, MessageSquare, Plus, Check, X, Flag, AlertTriangle, SlidersHorizontal, Hash, Settings2, Lock, BarChart2 } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { DatePicker } from '../../../components/DatePicker.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { SpaceSettings } from '../../../components/SpaceSettings.js';
import { STATUSES, SETTABLE_STATUSES, PRIORITIES, effectiveDeadline, isOverdue } from '../../../lib/tasks.js';
import { fmtDate } from '../../../lib/format.js';
import { useHotkey } from '../../../lib/hotkeys.js';

// Shared column widths so the Grid (tinted tray) and the active board line up exactly.
// Title has no width → it absorbs the remaining space (table-layout: fixed).
const COLS = [
  { w: 54 },   // ID
  {},          // Title (flex)
  { w: 118 },  // Team
  { w: 118 },  // Program
  { w: 116 },  // Owner (first name; full on hover)
  { w: 92 },   // Collaborators
  { w: 116 },  // Status
  { w: 92 },   // Pri  (wide enough for the edit combobox so it can't overflow into Deadline)
  { w: 150 },  // Deadline
  { w: 50 },   // Meta
];
const ROW_PAD = 12; // horizontal inset shared by the tray and the board so columns align

export default function TasksPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const search = useSearchParams();

  // Current space (ClickUp-style): ?space=<id> scopes the whole list; absent = General.
  const spaceParam = search.get('space');
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});      // group collapse (group-by)
  const [expanded, setExpanded] = useState({});        // sub-task expand (lifted from TaskTable so Expand/Collapse-all can drive it)
  const [sortKey, setSortKey] = useState(null);        // null = server order; else a column key
  const [sortDir, setSortDir] = useState('asc');

  // Structured filters (server-side) — live in the filter popover.
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [priority, setPriority] = useState('');
  const [programId, setProgramId] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [revised, setRevised] = useState(false);
  const [mine, setMine] = useState(false);
  const [groupBy, setGroupBy] = useState('none');
  // Text search (client-side, instant) + UI state.
  const [q, setQ] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [drawerId, setDrawerId] = useState(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);
  const teamOpts = useMemo(() => departments.map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  // Program cell options carry a "none" sentinel so a selection can clear the program
  // (the Combobox emits onChange(null) mid-type, which we must ignore — see Program cell).
  const programOpts = useMemo(() => programs.map(p => ({ value: p.id, label: p.name })), [programs]);
  const programCellOpts = useMemo(() => [{ value: '', label: '— No program —' }, ...programOpts], [programOpts]);
  const statusOpts = STATUSES.map(s => ({ value: s.key, label: s.label }));
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const statusCellOpts = [...SETTABLE_STATUSES.map(s => ({ value: s.key, label: s.label })), { value: 'abandoned', label: 'Abandon…' }];
  const groupOpts = [{ value: 'none', label: 'No grouping' }, { value: 'person', label: 'Group by owner' }, { value: 'department', label: 'Group by team' }, { value: 'program', label: 'Group by program' }];

  const currentSpace = useMemo(() => spaces.find(s => s.id === spaceId) || null, [spaces, spaceId]);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getDepartments', {}, session).catch(() => []),
      docketopsGet('getEmployees', {}, session).catch(() => []),
      docketopsGet('getPrograms', {}, session).catch(() => []),
      docketopsGet('getSpaces', {}, session).catch(() => []),
    ]).then(([d, e, p, s]) => { setDepartments(d || []); setEmployees(e || []); setPrograms(p || []); setSpaces(s || []); });
  }, [session]);

  // The sidebar "New space" item routes to ?space=new — open the create modal for it.
  useEffect(() => { setNewSpaceOpen(spaceParam === 'new'); }, [spaceParam]);

  // `c` → focus Quick Capture (the new-task input), mirroring `/` → focus search.
  // Suspended while a drawer/modal covers the page so it can't steal focus behind it.
  useHotkey('c', () => {
    const el = document.querySelector('[data-create-primary]');
    if (el) { try { el.focus(); el.select?.(); } catch { /* ignore */ } }
  }, { enabled: !drawerId && !newSpaceOpen && !spaceSettingsOpen });

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {
        space_id: spaceId, status, department_id: departmentId, employee_id: employeeId, priority,
        program_id: programId, overdue: overdue ? '1' : '', revised: revised ? '1' : '', lens: mine ? 'mine' : '',
      };
      const r = await docketopsGet('getTasks', params, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, spaceId, status, departmentId, employeeId, priority, programId, overdue, revised, mine, showToast]);
  useEffect(() => { load(); }, [load]);

  function refreshSpaces() {
    docketopsGet('getSpaces', {}, session).then(s => setSpaces(s || [])).catch(() => {});
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:spaces-changed'));
  }

  // Client-side multi-token search: every whitespace token must match somewhere in
  // task_no / title / owner / team / creator / collaborator names.
  const tokens = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const matchesQuery = useCallback((t) => {
    if (!tokens.length) return true;
    const hay = [t.task_no, t.title, t.owner_name, t.department_name, t.creator_name,
      ...(t.collaborators || []).map(c => c.full_name)].filter(Boolean).join(' ').toLowerCase();
    return tokens.every(tok => hay.includes(tok));
  }, [tokens]);

  const activeFilterCount = [status, departmentId, employeeId, priority, programId].filter(Boolean).length
    + [overdue, revised, mine].filter(Boolean).length;
  function clearFilters() {
    setStatus(''); setDepartmentId(''); setEmployeeId(''); setPriority(''); setProgramId('');
    setOverdue(false); setRevised(false); setMine(false);
  }

  function patchRow(id, patch) { setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t))); }
  async function saveField(task, field, value) {
    try {
      if (field === 'status') {
        await docketopsPost('changeStatus', { id: task.id, status: value }, session);
        patchRow(task.id, { status: value });
      } else if (field === 'title') {
        // Title is never nulled — caller validates non-empty before calling.
        await docketopsPost('updateTask', { id: task.id, title: value }, session);
        patchRow(task.id, { title: value });
      } else {
        await docketopsPost('updateTask', { id: task.id, [field]: value || null }, session);
        const patch = { [field]: value || null };
        if (field === 'owner_employee_id') patch.owner_name = empMap[value] || null;
        if (field === 'department_id') patch.department_name = deptMap[value] || null;
        if (field === 'program_id') patch.program = programs.find(p => p.id === value) || null;
        patchRow(task.id, patch);
      }
    } catch (e) { showToast(e.message || 'Save failed', 'error'); load(); }
  }
  // Inline "create on type": a Program name not in the list is created, then assigned.
  // NB: patch the row with the freshly-created `prog` object directly — NOT via
  // saveField, whose `programs.find()` runs against the render-time closure that does
  // not yet contain `prog` (setPrograms is async), so it would null the cell and the
  // new program name wouldn't show until a reload.
  async function createAndAssignProgram(task, name) {
    try {
      const prog = await docketopsPost('createProgram', { name }, session);
      setPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog].sort((a, b) => a.name.localeCompare(b.name)));
      await docketopsPost('updateTask', { id: task.id, program_id: prog.id }, session);
      patchRow(task.id, { program_id: prog.id, program: prog });
    } catch (e) { showToast(e.message || 'Failed to add program', 'error'); load(); }
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
    // Inherit team + owner from the parent (editable afterwards).
    try {
      await docketopsPost('createSubtask', { parent_task_id: task.id, title, department_id: task.department_id || null, owner_employee_id: task.owner_employee_id || null }, session);
      await load(); showToast('Sub-task added', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function addCollab(task, employeeId) {
    if (!employeeId) return;
    try { await docketopsPost('addCollaborator', { id: task.id, employee_id: employeeId }, session); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function removeCollab(task, employeeId) {
    try { await docketopsPost('removeCollaborator', { id: task.id, employee_id: employeeId }, session); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  // Children grouped by parent (from the full visible set) so a parent row can expand
  // its sub-tasks inline. Computed off all tasks, independent of the search filter.
  const childrenByParent = useMemo(() => {
    const m = {};
    for (const t of tasks) { if (t.parent_task_id) (m[t.parent_task_id] = m[t.parent_task_id] || []).push(t); }
    return m;
  }, [tasks]);

  // Column sort (client-side, over the loaded rows). null sortKey = server order.
  const statusRank = useMemo(() => Object.fromEntries(STATUSES.map((s, i) => [s.key, i])), []);
  const sortFn = useCallback((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === 'desc' ? -1 : 1;
    const val = (t) => {
      switch (sortKey) {
        case 'task_no': return Number(String(t.task_no || '').replace(/\D/g, '')) || 0;
        case 'title': return (t.title || '').toLowerCase();
        case 'department_name': return (t.department_name || '').toLowerCase();
        case 'program': return (t.program?.name || '').toLowerCase();
        case 'owner_name': return (t.owner_name || '').toLowerCase();
        case 'status': return statusRank[t.status] ?? 99;
        case 'priority': return t.priority || 'P9';   // P0<P1<P2<P3 sorts naturally
        case 'deadline': return effectiveDeadline(t) || '9999';   // ISO sorts lexically; no-date last
        default: return 0;
      }
    };
    const av = val(a), bv = val(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  }, [sortKey, sortDir, statusRank]);
  function onSort(key) {
    if (sortKey === key) { if (sortDir === 'asc') setSortDir('desc'); else { setSortKey(null); setSortDir('asc'); } }
    else { setSortKey(key); setSortDir('asc'); }
  }

  const topLevel = useMemo(() => tasks.filter(t => !t.parent_task_id && matchesQuery(t)), [tasks, matchesQuery]);
  const gridRows = useMemo(() => topLevel.filter(t => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id)).sort(sortFn), [topLevel, sortFn]);
  const boardRows = useMemo(() => topLevel.filter(t => !(t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id))).sort(sortFn), [topLevel, sortFn]);

  // Parents that actually have sub-tasks → drive Expand all / Collapse all.
  const parentIds = useMemo(() => topLevel.filter(t => (t.child_count || 0) > 0 || (childrenByParent[t.id] || []).length).map(t => t.id), [topLevel, childrenByParent]);
  function expandAll() { setExpanded(Object.fromEntries(parentIds.map(id => [id, true]))); }
  function collapseAll() { setExpanded({}); }

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: boardRows }];
    const keyOf = (t) => groupBy === 'person' ? (t.owner_name || 'Unassigned')
      : groupBy === 'program' ? (t.program?.name || 'No program')
      : (t.department_name || 'No team');
    const m = new Map();
    for (const t of boardRows) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }));
  }, [boardRows, groupBy]);

  const rowProps = { saveField, abandonInline, reviseInline, addSubtask, addCollab, removeCollab, childrenByParent, openDrawer: setDrawerId, teamOpts, empOpts, statusCellOpts, prioOpts, programCellOpts, createAndAssignProgram, expanded, setExpanded, sortFn, sort: { key: sortKey, dir: sortDir }, onSort };

  return (
    <div>
      {/* Space header — only when inside a private space (General needs no header). */}
      {currentSpace && currentSpace.is_private && (
        <div style={spaceHeader}>
          <span style={spaceTitle}><Lock size={13} style={{ color: 'var(--docket-accent)' }} /> {currentSpace.name}</span>
          <button className="dk-press" style={spaceGear} title="Space dashboard" onClick={() => router.push('/dashboard?space=' + currentSpace.id)}>
            <BarChart2 size={14} />
          </button>
          {currentSpace.is_owner && (
            <button className="dk-press" style={spaceGear} title="Space settings" onClick={() => setSpaceSettingsOpen(true)}>
              <Settings2 size={14} />
            </button>
          )}
        </div>
      )}

      <QuickCapture session={session} spaceId={spaceId} onCreated={load} showToast={showToast} />

      {/* Search + a single Filter button (consolidates the old 9-control bar). */}
      <div style={controlBar}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 460 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)', zIndex: 1 }} />
          <input data-search-primary value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks, owners, DKT-no…  ( / )" style={{ ...finput, paddingLeft: 30 }} />
          {q && <button onClick={() => setQ('')} style={searchClear} title="Clear search"><X size={13} /></button>}
        </div>
        {parentIds.length > 0 && (
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button className="dk-press" style={clearBtn} onClick={expandAll} title="Expand all sub-tasks"><ChevronDown size={13} /> Expand all</button>
            <button className="dk-press" style={clearBtn} onClick={collapseAll} title="Collapse all sub-tasks"><ChevronRight size={13} /> Collapse all</button>
          </div>
        )}
        <div style={{ position: 'relative' }}>
          <button className="dk-press" style={filterBtn(filterOpen || activeFilterCount > 0)} onClick={() => setFilterOpen(o => !o)}>
            <SlidersHorizontal size={13} /> Manage{activeFilterCount > 0 && <span style={countBadge}>{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <FilterPopover
              onClose={() => setFilterOpen(false)}
              {...{ status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId, priority, setPriority,
                programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine, groupBy, setGroupBy,
                statusOpts, teamOpts, empOpts, prioOpts, programOpts, groupOpts, activeFilterCount, clearFilters }}
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
                THE GRID · NEEDS SETUP <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {gridRows.length}</span>
                <span style={trayHint}>add an owner and deadline to move onto the board</span>
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

      {newSpaceOpen && (
        <NewSpaceModal session={session} showToast={showToast}
          onClose={() => { setNewSpaceOpen(false); if (spaceParam === 'new') router.push('/tasks'); }}
          onCreated={(id) => { refreshSpaces(); router.push('/tasks?space=' + id); }} />
      )}
      {spaceSettingsOpen && currentSpace && (
        <SpaceSettings space={currentSpace} session={session} employees={employees} showToast={showToast}
          onClose={() => setSpaceSettingsOpen(false)}
          onChanged={() => { refreshSpaces(); }}
          onArchived={() => { setSpaceSettingsOpen(false); refreshSpaces(); router.push('/tasks'); }} />
      )}
    </div>
  );
}

function NewSpaceModal({ session, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function create() {
    const n = name.trim(); if (!n || saving) return;
    setSaving(true);
    try { const r = await docketopsPost('createSpace', { name: n }, session); onCreated(r.id); }
    catch (e) { showToast(e.message || 'Failed to create space', 'error'); setSaving(false); }
  }
  return (
    <div style={modalBackdrop} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} style={modalCard}>
        <div style={modalTitle}><Lock size={14} style={{ color: 'var(--docket-accent)' }} /> New space</div>
        <p style={modalHint}>A private space — only members you add can see its tasks (even admins can’t, unless added).</p>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Space name (e.g. Skunkworks)"
          onKeyDown={e => { if (e.key === 'Enter') create(); }} style={{ ...finput, marginTop: 4 }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="dk-press" style={clearBtn} onClick={onClose}>Cancel</button>
          <button className="dk-press" style={{ ...createBtn, opacity: name.trim() && !saving ? 1 : 0.5 }} disabled={!name.trim() || saving} onClick={create}>
            {saving ? '…' : 'Create space'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterPopover({ onClose, status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId,
  priority, setPriority, programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine, groupBy, setGroupBy,
  statusOpts, teamOpts, empOpts, prioOpts, programOpts, groupOpts, activeFilterCount, clearFilters }) {
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
        <label style={fpLabel}>Program</label>
        <Combobox value={programId} options={programOpts} onChange={setProgramId} placeholder="Any program" allowClear style={finput} />
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

function TaskTable({ rows, childrenByParent, saveField, abandonInline, reviseInline, addSubtask, addCollab, removeCollab, openDrawer, teamOpts, empOpts, statusCellOpts, prioOpts, programCellOpts, createAndAssignProgram, expanded, setExpanded, sortFn, sort, onSort }) {
  // Property cells (team/owner/status/priority) use whole-row edit mode so native
  // Tab walks them in order; comboboxes commit on Tab (commitOnTab). The title and
  // DKT-id open the drawer. Sub-tasks expand as indented rows under their parent
  // (collapsed by default); the "+" on a parent adds an indented sub-task inline.
  const [editRow, setEditRow] = useState(null);
  const [focusField, setFocusField] = useState(null);
  const [abandonFor, setAbandonFor] = useState(null);
  const [abandonReason, setAbandonReason] = useState('');
  // `expanded` + `setExpanded` are lifted to the page (Expand all / Collapse all drive them).
  const [addingFor, setAddingFor] = useState(null);
  const [subTitle, setSubTitle] = useState('');

  useEffect(() => {
    if (!editRow && !abandonFor) return;
    function onDown(e) {
      const rowId = editRow || abandonFor;
      const el = document.getElementById('dk-row-' + rowId);
      if (el && !el.contains(e.target)) { setEditRow(null); setAbandonFor(null); }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editRow, abandonFor]);

  function startEdit(t, field) {
    if (!t._can_edit || t.status === 'abandoned') return;
    setFocusField(field); setEditRow(t.id);
  }
  function toggleExpand(id) { setExpanded(s => ({ ...s, [id]: !s[id] })); }
  function startAddSub(parent) { setSubTitle(''); setAddingFor(parent.id); setExpanded(s => ({ ...s, [parent.id]: true })); }
  function submitSub(parent) { const v = subTitle.trim(); if (!v) return; addSubtask(parent, v); setSubTitle(''); setAddingFor(null); }

  function renderRow(t, isChild) {
    const od = isOverdue(t);
    const ed = !!t._can_edit && t.status !== 'abandoned';
    const isEdit = editRow === t.id;
    const kids = childrenByParent[t.id] || [];
    const hasKids = !isChild && ((t.child_count || 0) > 0 || kids.length > 0);
    const isOpen = !!expanded[t.id];
    // A sub-task is one level under its parent — clicking it opens the PARENT
    // task (which lists all its sub-tasks), not a standalone child view.
    const drawerTarget = isChild ? (t.parent_task_id || t.id) : t.id;
    const Disp = ({ field, children }) => (
      <span onClick={() => startEdit(t, field)}
        className={ed ? 'dk-editable' : undefined}
        role={ed ? 'button' : undefined} tabIndex={ed ? 0 : undefined}
        onKeyDown={ed ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(t, field); } }) : undefined}
        style={{ cursor: ed ? 'pointer' : 'default', display: 'inline-block', minWidth: 24 }}>{children}</span>
    );
    return (
      <tr key={t.id} id={'dk-row-' + t.id} className="dk-task-row"
        tabIndex={ed ? 0 : undefined}
        onKeyDown={e => {
          if (e.key === 'Escape') { setEditRow(null); setAbandonFor(null); return; }
          // Keyboard nav only when the row itself (not an inner field) is focused.
          if (e.target !== e.currentTarget) return;
          if (ed && !isEdit && e.key === 'Enter') { e.preventDefault(); startEdit(t, 'title'); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const list = Array.from(document.querySelectorAll('tr.dk-task-row[tabindex="0"]'));
            const i = list.indexOf(e.currentTarget);
            const next = e.key === 'ArrowDown' ? list[i + 1] : list[i - 1];
            next?.focus();
          }
        }}>
        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {/* Sub-tasks read as nested items, not standalone tasks — no top-level ID;
              the indent + branch glyph in the title carries the nesting. */}
          {isChild ? null : <button className="dk-idlink" style={idBtn} onClick={() => openDrawer(t.id)} title="Open task">{t.task_no}</button>}
        </td>

        <td style={{ ...td, color: 'var(--text-1)', fontWeight: 500 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0, paddingLeft: isChild ? 22 : 0 }}>
            {isChild ? <span style={branchGlyph}>↳</span>
              : (hasKids
                ? <button style={chevronBtn} onClick={() => toggleExpand(t.id)} title={isOpen ? 'Hide sub-tasks' : 'Show sub-tasks'}>{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                : <span style={{ width: 13, flexShrink: 0 }} />)}
            {isEdit && ed
              ? <input autoFocus={focusField === 'title'} defaultValue={t.title} placeholder="Title…" style={{ ...cellInput, flex: 1, minWidth: 0 }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.title) saveField(t, 'title', v); }} />
              : <span className={ed ? undefined : 'dk-idlink'} onClick={() => (ed ? startEdit(t, 'title') : openDrawer(drawerTarget))}
                  title={ed ? 'Click to rename · DKT-id opens the panel' : undefined}
                  style={{ cursor: ed ? 'text' : 'pointer', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title}{t.revised_deadline && <span style={flag}>revised</span>}
                </span>}
            {hasKids && <span style={kidCount}>{t.child_done}/{t.child_count}</span>}
            {!isChild && ed && <button className="dk-subadd dk-press" style={subAddBtn} title="Add sub-task" onClick={() => startAddSub(t)}><Plus size={12} /></button>}
          </span>
        </td>

        <td style={td}>
          {isEdit && ed ? <div style={editWrap}><Combobox autoFocus={focusField === 'department_id'} value={t.department_id || ''} options={teamOpts} placeholder="Team…" commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'department_id', v); }} /></div>
            : <Disp field="department_id">{t.department_name || <Muted>set team</Muted>}</Disp>}
        </td>
        <td style={td}>
          {/* Program: pick from the global list OR type a new name + Enter to create it.
              The Combobox emits onChange(null) while typing → ignore it; act only on a
              real option (the "— No program —" sentinel clears). */}
          {isEdit && ed ? <div style={editWrap}><Combobox autoFocus={focusField === 'program_id'} value={t.program_id || ''} options={programCellOpts} placeholder="Program…" allowClear={false} commitOnTab style={cellInput}
              onChange={(v, opt) => { if (!opt) return; if (!opt.value) saveField(t, 'program_id', null); else saveField(t, 'program_id', opt.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { const text = (e.target.value || '').trim(); if (text && !programCellOpts.some(o => o.label.toLowerCase() === text.toLowerCase())) { e.preventDefault(); createAndAssignProgram(t, text); } } }} /></div>
            : <Disp field="program_id">{t.program ? <span style={programChip}>{t.program.name}</span> : <Muted>set program</Muted>}</Disp>}
        </td>
        <td style={{ ...td, whiteSpace: 'nowrap' }}>
          {isEdit && ed ? <div style={editWrap}><Combobox autoFocus={focusField === 'owner_employee_id'} value={t.owner_employee_id || ''} options={empOpts} placeholder="Owner…" commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'owner_employee_id', v); }} /></div>
            : <Disp field="owner_employee_id">{t.owner_name ? <span title={t.owner_name}>{firstName(t.owner_name)}</span> : <Muted>set owner</Muted>}</Disp>}
        </td>
        <td style={td}>
          <CollaboratorsCell task={t} editable={ed} empOpts={empOpts} onAdd={addCollab} onRemove={removeCollab} openDrawer={openDrawer} drawerTarget={drawerTarget} />
        </td>
        <td style={td}>
          {/* position:relative anchors the abandon popover to this cell — without it the
              absolute popover resolves against the viewport (it appeared bottom-left). */}
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            {isEdit && ed ? <div style={editWrap}><Combobox autoFocus={focusField === 'status'} value={t.status} options={statusCellOpts} placeholder="Status…" allowClear={false} commitOnTab style={cellInput} onChange={(v, opt) => { if (!opt) return; if (v === 'abandoned') { setAbandonReason(''); setAbandonFor(t.id); } else saveField(t, 'status', v); }} /></div>
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
          </span>
        </td>
        <td style={td}>
          {isEdit && ed ? <div style={editWrap}><Combobox autoFocus={focusField === 'priority'} value={t.priority} options={prioOpts} placeholder="Priority…" allowClear={false} commitOnTab style={cellInput} onChange={(v, opt) => { if (opt) saveField(t, 'priority', v); }} /></div>
            : <Disp field="priority"><PriorityBadge priority={t.priority} /></Disp>}
        </td>

        <td style={td}>
          <DeadlineCell task={t} editable={ed} od={od} onFirstSet={(iso) => saveField(t, 'deadline', iso)} onRevise={reviseInline} />
        </td>

        <td style={{ ...td, color: 'var(--text-4)', cursor: 'pointer' }} onClick={() => openDrawer(drawerTarget)}>
          <span style={meta}>
            {t.doc_count > 0 && <span title="documents"><Link2 size={12} /> {t.doc_count}</span>}
            {t.comment_count > 0 && <span title="comments"><MessageSquare size={12} /> {t.comment_count}</span>}
          </span>
        </td>
      </tr>
    );
  }

  return (
    // overflow must stay visible so the inline popovers (date picker, collaborator
    // manager, abandon, combobox dropdowns) float over the rows instead of being
    // clipped to a sliver by the scroll container.
    <div style={{ overflow: 'visible' }}>
      <table style={table}>
        <colgroup>{COLS.map((c, i) => <col key={i} style={c.w ? { width: c.w } : undefined} />)}</colgroup>
        <thead><tr>
          <SortTh label="ID" k="task_no" sort={sort} onSort={onSort} />
          <SortTh label="Title" k="title" sort={sort} onSort={onSort} />
          <SortTh label="Team" k="department_name" sort={sort} onSort={onSort} />
          <SortTh label="Program" k="program" sort={sort} onSort={onSort} />
          <SortTh label="Owner" k="owner_name" sort={sort} onSort={onSort} />
          <th style={th}>People</th>
          <SortTh label="Status" k="status" sort={sort} onSort={onSort} />
          <SortTh label="Pri" k="priority" sort={sort} onSort={onSort} />
          <SortTh label="Deadline" k="deadline" sort={sort} onSort={onSort} />
          <th style={th}></th>
        </tr></thead>
        <tbody>
          {rows.flatMap(t => {
            const out = [renderRow(t, false)];
            if (expanded[t.id]) {
              (childrenByParent[t.id] || []).slice().sort(sortFn).forEach(c => out.push(renderRow(c, true)));
              if (addingFor === t.id) {
                out.push(
                  <tr key={'add-' + t.id} className="dk-task-row">
                    <td style={td}></td>
                    <td style={td} colSpan={9}>
                      <span style={subRow}>
                        <span style={branchGlyph}>↳</span>
                        <input autoFocus value={subTitle} onChange={e => setSubTitle(e.target.value)} placeholder="Sub-task title, Enter to add…" style={subRowInput}
                          onKeyDown={e => { if (e.key === 'Enter') submitSub(t); if (e.key === 'Escape') setAddingFor(null); }} />
                        <button className="dk-press" style={subAddConfirm} disabled={!subTitle.trim()} onClick={() => submitSub(t)} title="Add"><Check size={13} /></button>
                        <button style={popBtnGhost} onClick={() => setAddingFor(null)} title="Cancel"><X size={13} /></button>
                      </span>
                    </td>
                  </tr>
                );
              }
            }
            return out;
          })}
        </tbody>
      </table>
    </div>
  );
}

// Clickable sortable column header: click cycles asc → desc → off (server order).
function SortTh({ label, k, sort, onSort }) {
  const active = sort?.key === k;
  return (
    <th style={{ ...th, cursor: 'pointer', userSelect: 'none', color: active ? 'var(--text-1)' : undefined }}
      onClick={() => onSort && onSort(k)} title={`Sort by ${label}`}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {label}
        <span style={{ fontSize: 9, opacity: active ? 1 : 0.3 }}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </span>
    </th>
  );
}

function Muted({ children }) { return <span style={{ color: 'var(--text-placeholder)', fontStyle: 'italic' }}>{children}</span>; }

function firstName(name) { return name ? name.trim().split(/\s+/)[0] : ''; }
function initials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function Avatars({ list }) {
  const shown = list.slice(0, 3);
  const extra = list.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((c, i) => <span key={c.employee_id || c.id || i} style={{ ...avatar, marginLeft: i ? -7 : 0, zIndex: 5 - i }}>{initials(c.full_name)}</span>)}
      {extra > 0 && <span style={{ ...avatar, marginLeft: -7, background: 'var(--surface-3)', color: 'var(--text-2)' }}>+{extra}</span>}
    </span>
  );
}
// People cell: overlapping initial pills (hover = names). When editable, click opens a
// small manager popover to add (Combobox) or remove collaborators inline.
function CollaboratorsCell({ task, editable, empOpts, onAdd, onRemove, openDrawer, drawerTarget }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const list = task.collaborators || [];
  useEffect(() => {
    if (!open) return;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const addable = empOpts.filter(o => o.value !== task.owner_employee_id && !list.some(c => c.employee_id === o.value));
  const names = list.map(c => c.full_name || '—').join(', ');
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span title={names || undefined} onClick={editable ? () => setOpen(o => !o) : () => openDrawer(drawerTarget ?? task.id)} style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
        {list.length > 0 && <Avatars list={list} />}
        {editable
          ? <span style={{ ...addPill, marginLeft: list.length ? -7 : 0 }}><Plus size={11} /></span>
          : (list.length === 0 && <span style={{ color: 'var(--text-4)' }}>—</span>)}
      </span>
      {open && (
        <div style={collabPop} onMouseDown={e => e.stopPropagation()}>
          <div style={popLabel}>Collaborators</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {list.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>None yet</span>}
            {list.map(c => <span key={c.employee_id} style={collabChip}>{c.full_name || c.employee_id}<X size={11} style={{ cursor: 'pointer' }} onClick={() => onRemove(task, c.employee_id)} /></span>)}
          </div>
          <Combobox value="" options={addable} onChange={(v) => { if (v) onAdd(task, v); }} placeholder="Add collaborator…" allowClear={false} style={cellInput} />
        </div>
      )}
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
    ? (editable ? <span onClick={start} style={{ cursor: 'pointer', color: 'var(--text-placeholder)', fontStyle: 'italic' }}>set date</span> : <span style={{ color: 'var(--text-4)' }}>—</span>)
    : <span onClick={editable ? start : undefined} style={{ cursor: editable ? 'pointer' : 'default', color: od ? 'var(--state-error-fg)' : 'var(--text-2)', fontWeight: od ? 600 : 400 }}>{fmtDate(eff)}</span>;

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {trigger}
      {od && <span style={odFlag}><AlertTriangle size={9} /> overdue</span>}
      {open && (
        <div style={popoverRight} onMouseDown={e => e.stopPropagation()}>
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

function QuickCapture({ session, spaceId, onCreated, showToast }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    // Quick-captured tasks land in the space currently being viewed (General if none).
    try { await docketopsPost('createTask', { title: t, space_id: spaceId || undefined }, session); setTitle(''); await onCreated(); ref.current?.focus(); }
    catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div style={addRow}>
      <Plus size={16} style={{ color: 'var(--docket-accent)', flexShrink: 0 }} />
      <input ref={ref} data-create-primary value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder="Add a task. Type a title and press Enter; it lands in The Grid to finish later…  ( c )"
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
// NOTE: no `overflow: hidden` here — it would clip the in-cell popovers (date picker,
// collaborator manager, abandon) to the row height. Title truncation is handled by the
// title cell's own inner span instead.
const td = { padding: '7px 10px', fontSize: 13, color: 'var(--text-2)', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const cellInput = { background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '4px 6px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
// Edit-mode combobox wrapper: fill the cell's column exactly so the dropdown can't
// overflow into the next column (was a fixed minWidth that bled under Deadline).
const editWrap = { width: '100%' };
const groupHead = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)', padding: '8px 0', marginBottom: 4 };
const flag = { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--state-warning-fg)', background: 'var(--state-warning-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase' };
const odFlag = { display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--state-error-fg)', background: 'var(--state-error-bg)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', fontWeight: 600 };
const meta = { display: 'inline-flex', gap: 10, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11 };
const avatar = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 'var(--radius-full)', background: 'var(--docket-accent)', color: 'var(--accent-fg)', fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', border: '1.5px solid var(--bg)', flexShrink: 0 };
const idBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer', transition: 'color var(--duration-fast) var(--ease-out)' };
const clearBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
const subAddBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, background: 'var(--accent-bg)', color: 'var(--docket-accent)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', flexShrink: 0 };
const chevronBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, background: 'transparent', color: 'var(--text-3)', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', flexShrink: 0, padding: 0 };
const branchGlyph = { color: 'var(--text-4)', fontSize: 12, flexShrink: 0, width: 13, textAlign: 'center' };
const kidCount = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px', flexShrink: 0 };
const addPill = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 'var(--radius-full)', background: 'transparent', color: 'var(--text-3)', border: '1px dashed var(--border-2)', flexShrink: 0 };
const collabPop = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, width: 240, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const collabChip = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)', padding: '2px 8px', fontSize: 11, color: 'var(--text-1)' };
const subRow = { display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', maxWidth: 480, paddingLeft: 22 };
const subRowInput = { flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 9px', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const subAddConfirm = { display: 'inline-flex', alignItems: 'center', background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '5px 8px', cursor: 'pointer' };
const popover = { position: 'absolute', top: '100%', left: 0, zIndex: 20, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, minWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' };
const popoverRight = { ...popover, left: 'auto', right: 0 };
const popLabel = { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const popBtnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnDanger = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--state-error)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font-cond)', textTransform: 'uppercase' };
const popBtnGhost = { display: 'inline-flex', alignItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', cursor: 'pointer' };
function toggleBtn(on) {
  return { background: on ? 'var(--docket-accent)' : 'var(--surface-2)', color: on ? 'var(--accent-fg)' : 'var(--text-3)', border: `1px solid ${on ? 'var(--docket-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 12px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.05em' };
}

const spaceHeader = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 };
const spaceTitle = { display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-cond)', fontSize: 17, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text-1)' };
const spaceGear = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'var(--surface-2)', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const programChip = { display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom', fontSize: 11, color: 'var(--docket-accent)', background: 'var(--accent-bg)', border: '1px solid rgba(242,205,26,0.22)', borderRadius: 'var(--radius-full)', padding: '1px 9px' };
const createBtn = { background: 'var(--docket-accent)', color: 'var(--accent-fg)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '7px 16px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh', zIndex: 80 };
const modalCard = { width: 420, maxWidth: '92vw', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-lg)', padding: 18, boxShadow: '0 18px 50px rgba(0,0,0,0.5)' };
const modalTitle = { display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-cond)', fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)' };
const modalHint = { fontSize: 12, color: 'var(--text-3)', margin: '6px 0 0', lineHeight: 1.5 };
