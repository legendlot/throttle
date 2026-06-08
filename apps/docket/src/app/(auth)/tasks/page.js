'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import {
  Search, X, Plus, Check, Ban, ListFilter, Layers, List, Rows3, Inbox,
  ChevronRight, ChevronDown, Calendar, AlertTriangle, Link2, MessageSquare,
  Lock, Settings2, LayoutDashboard, ListChecks,
} from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { DatePicker } from '../../../components/DatePicker.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { SpaceSettings } from '../../../components/SpaceSettings.js';
import { Avatar, AvatarRow, Popover, OptionList, firstName, personColor, deadlineState, relDeadline, fmtShortDate } from '../../../components/primitives.js';
import { STATUSES, STATUS_MAP, SETTABLE_STATUSES, PRIORITIES, effectiveDeadline } from '../../../lib/tasks.js';
import { useHotkey } from '../../../lib/hotkeys.js';
import { useChrome } from '../../../lib/chrome.js';

// Task(flex) · Owner(150) · Status(132) · Pri(76) · Deadline(140) · meta(46)
const GRID_COLS = 'minmax(230px,1fr) 150px 132px 76px 140px 46px';

export default function TasksPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setCount } = useChrome();
  const router = useRouter();
  const search = useSearchParams();

  const spaceParam = search.get('space');
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';
  const lensParam = search.get('lens');

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [expanded, setExpanded] = useState({});
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  // Structured filters (server-side).
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [priority, setPriority] = useState('');
  const [programId, setProgramId] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [revised, setRevised] = useState(false);
  const [mine, setMine] = useState(lensParam === 'mine');
  const [groupBy, setGroupBy] = useState('none');
  const [density, setDensity] = useState('roomy');

  const [q, setQ] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [groupMenu, setGroupMenu] = useState(false);
  const [drawerId, setDrawerId] = useState(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const searchRef = useRef(null);

  // `lens=mine` (sidebar "My tasks") drives the mine filter; absent → off.
  useEffect(() => { setMine(lensParam === 'mine'); }, [lensParam]);

  // Sticky density.
  useEffect(() => { try { const d = localStorage.getItem('docket.density'); if (d) setDensity(d); } catch { /* ignore */ } }, []);
  function chooseDensity(d) { setDensity(d); try { localStorage.setItem('docket.density', d); } catch { /* ignore */ } }

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);
  const teamCellOpts = useMemo(() => [{ value: '', label: '— No team —' }, ...departments.map(d => ({ value: d.id, label: d.name, dot: personColor(d.id) }))], [departments]);
  const ownerCellOpts = useMemo(() => [{ value: '', label: '— Unassigned —' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))], [employees]);
  const prioOpts = PRIORITIES.map(p => ({ value: p.key, label: p.label }));
  const teamOpts = useMemo(() => departments.map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const programOpts = useMemo(() => programs.map(p => ({ value: p.id, label: p.name })), [programs]);
  const programCellOpts = useMemo(() => [{ value: '', label: '— No program —' }, ...programOpts], [programOpts]);

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

  useEffect(() => { setNewSpaceOpen(spaceParam === 'new'); }, [spaceParam]);

  useHotkey('c', (e) => {
    const el = document.querySelector('[data-create-primary]');
    if (!el) return;
    e.preventDefault();
    try { el.focus(); el.select?.(); } catch { /* ignore */ }
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
    try {
      await docketopsPost('createSubtask', { parent_task_id: task.id, title, department_id: task.department_id || null, owner_employee_id: task.owner_employee_id || null }, session);
      await load(); showToast('Sub-task added', 'success');
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function addCollab(task, employeeIdToAdd) {
    if (!employeeIdToAdd) return;
    try { await docketopsPost('addCollaborator', { id: task.id, employee_id: employeeIdToAdd }, session); await load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  // Children grouped by parent (off the full set), so a parent can expand inline.
  const childrenByParent = useMemo(() => {
    const m = {};
    for (const t of tasks) { if (t.parent_task_id) (m[t.parent_task_id] = m[t.parent_task_id] || []).push(t); }
    return m;
  }, [tasks]);

  const statusRank = useMemo(() => Object.fromEntries(STATUSES.map((s, i) => [s.key, i])), []);
  const sortFn = useCallback((a, b) => {
    if (!sortKey) return 0;
    const dir = sortDir === 'desc' ? -1 : 1;
    const val = (t) => {
      switch (sortKey) {
        case 'title': return (t.title || '').toLowerCase();
        case 'owner_name': return (t.owner_name || '').toLowerCase();
        case 'status': return statusRank[t.status] ?? 99;
        case 'priority': return t.priority || 'P9';
        case 'deadline': return effectiveDeadline(t) || '9999';
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
  const needsSetup = (t) => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id);
  const gridRows = useMemo(() => topLevel.filter(needsSetup).sort(sortFn), [topLevel, sortFn]);
  const boardRows = useMemo(() => topLevel.filter(t => !needsSetup(t)).sort(sortFn), [topLevel, sortFn]);

  // Publish the visible count to the topbar; clear it when leaving the board.
  useEffect(() => { setCount?.(topLevel.length); return () => setCount?.(null); }, [topLevel.length, setCount]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, rows: boardRows }];
    const keyOf = (t) => groupBy === 'person' ? (t.owner_name || 'Unassigned')
      : groupBy === 'program' ? (t.program?.name || 'No program')
      : groupBy === 'status' ? (STATUS_MAP[t.status]?.label || t.status)
      : (t.department_name || 'No team');
    const m = new Map();
    for (const t of boardRows) { const k = keyOf(t); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    const colorOf = (label) => groupBy === 'status' ? (STATUSES.find(s => s.label === label)?.color || 'var(--text-4)')
      : groupBy === 'person' ? personColor(label)
      : groupBy === 'department' ? personColor(label)
      : 'var(--text-4)';
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, rows]) => ({ key: label, label, color: colorOf(label), rows }));
  }, [boardRows, groupBy, statusRank]);

  // ---- global keyboard: f/g popovers + arrow-into-first-row ----
  useEffect(() => {
    function focusRow(dir) {
      const rows = [...document.querySelectorAll('.board .row[tabindex="0"]')];
      if (!rows.length) return;
      (dir > 0 ? rows[0] : rows[rows.length - 1]).focus();
    }
    function onKey(e) {
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (drawerId) return;
      if (e.key === 'f') { e.preventDefault(); setFilterOpen(o => !o); }
      else if (e.key === 'g') { e.preventDefault(); setGroupMenu(m => !m); }
      else if ((e.key === 'ArrowDown' || e.key === 'j') && !ae?.classList?.contains('row')) { e.preventDefault(); focusRow(1); }
      else if ((e.key === 'ArrowUp' || e.key === 'k') && !ae?.classList?.contains('row')) { e.preventDefault(); focusRow(-1); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerId]);

  const rowCtx = {
    saveField, abandonInline, reviseInline, addSubtask, addCollab, childrenByParent,
    openDrawer: setDrawerId, teamCellOpts, ownerCellOpts, prioOpts, empOpts, expanded, setExpanded, sortFn,
  };

  const groupOpts = [
    { value: 'none', label: 'No grouping' }, { value: 'person', label: 'Owner' },
    { value: 'department', label: 'Team' }, { value: 'status', label: 'Status' }, { value: 'program', label: 'Program' },
  ];
  const groupLabel = { none: 'Group', person: 'By owner', department: 'By team', status: 'By status', program: 'By program' }[groupBy];

  return (
    <div data-density={density}>
      {/* Space actions (private space) — title + lock now live in the topbar. */}
      {currentSpace && currentSpace.is_private && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
          <button className="dr-icon" title="Space dashboard" onClick={() => router.push('/dashboard?space=' + currentSpace.id)}><LayoutDashboard size={15} /></button>
          {currentSpace.is_owner && (
            <button className="dr-icon" title="Space settings" onClick={() => setSpaceSettingsOpen(true)}><Settings2 size={15} /></button>
          )}
        </div>
      )}

      <QuickCapture session={session} spaceId={spaceId} onCreated={load} showToast={showToast} />

      <div className="toolbar">
        <div className="search">
          <Search className="ic" />
          <input data-search-primary ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks, owners, DKT-no…" />
          {!q && <span className="kbd">/</span>}
        </div>
        <div style={{ position: 'relative' }}>
          <button className={'tool' + (groupBy !== 'none' ? ' on' : '')} onClick={() => setGroupMenu(m => !m)}>
            <Layers className="ic" /> {groupLabel}
          </button>
          {groupMenu && (
            <Popover open onClose={() => setGroupMenu(false)} width={180}>
              <OptionList label="Group by" value={groupBy} options={groupOpts} onPick={(v) => { setGroupBy(v); setGroupMenu(false); }} />
            </Popover>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button className={'tool' + (activeFilterCount > 0 ? ' on' : '')} onClick={() => setFilterOpen(o => !o)}>
            <ListFilter className="ic" /> Filter {activeFilterCount > 0 && <span className="badge">{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <FilterPop onClose={() => setFilterOpen(false)}
              {...{ status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId, priority, setPriority,
                programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine,
                teamOpts, empOpts, programOpts, activeFilterCount, clearFilters }} />
          )}
        </div>
        <div className="seg">
          <button className={density === 'compact' ? 'on' : ''} title="Compact" onClick={() => chooseDensity('compact')}><List /></button>
          <button className={density === 'roomy' ? 'on' : ''} title="Roomy" onClick={() => chooseDensity('roomy')}><Rows3 /></button>
        </div>
      </div>

      {loading && tasks.length === 0 ? <Spinner /> : (
        topLevel.length === 0 ? (
          <div className="empty-state">
            <div className="ei"><ListChecks size={24} /></div>
            <h3>{(q || activeFilterCount) ? 'No tasks match' : 'All clear'}</h3>
            <p>{(q || activeFilterCount) ? 'Try a different search or widen the filters.' : 'Capture a task above to get started.'}</p>
            {activeFilterCount > 0 && <button className="fp-clear" style={{ width: 'auto', margin: '14px auto 0' }} onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : (
          <div style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto', transition: 'opacity var(--base) var(--ease)' }}>
            <GridZone rows={gridRows} ctx={rowCtx} />

            {boardRows.length > 0 && (
              <div className="board-scroll"><div className="board">
                <div className="cols" style={{ '--grid-cols': GRID_COLS }}>
                  <ColHead k="title" label="Task" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <ColHead k="owner_name" label="Owner" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <ColHead k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <ColHead k="priority" label="Pri" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <ColHead k="deadline" label="Deadline" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <span className="ch" style={{ justifyContent: 'flex-end' }} />
                </div>
                {groups.map(g => (
                  <div key={g.key} className="group">
                    {g.label && (
                      <div className={'group-head' + (collapsedGroups[g.key] ? ' collapsed' : '')} onClick={() => setCollapsedGroups(c => ({ ...c, [g.key]: !c[g.key] }))}>
                        <span className="chev"><ChevronDown size={15} /></span>
                        {g.color && <span className="gdot" style={{ background: g.color }} />}
                        <span className="gl">{g.label}</span>
                        <span className="gc">{g.rows.length}</span>
                      </div>
                    )}
                    {!collapsedGroups[g.key] && (
                      <div className="rows">
                        {g.rows.flatMap(task => {
                          const kids = (childrenByParent[task.id] || []);
                          const hasKids = (task.child_count || 0) > 0 || kids.length > 0;
                          const isOpen = !!expanded[task.id];
                          const out = [<TaskRow key={task.id} task={task} ctx={rowCtx} hasKids={hasKids} expanded={isOpen} />];
                          if (hasKids && isOpen) kids.slice().sort(sortFn).forEach(c => out.push(<TaskRow key={c.id} task={c} ctx={rowCtx} isChild />));
                          return out;
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div></div>
            )}
          </div>
        )
      )}

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

/* ---------------- Sortable column header ---------------- */
function ColHead({ k, label, sortKey, sortDir, onSort, style }) {
  const active = sortKey === k;
  return (
    <span className={'ch' + (active ? ' sorted' : '')} style={style} onClick={() => onSort(k)}>
      {label}<span className="ar">{active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </span>
  );
}

/* ---------------- Editable select cell ---------------- */
function EditableSelect({ editable, value, options, searchable, onPick, children, empty, align = 'left', width = 210 }) {
  const [open, setOpen] = useState(false);
  if (!editable) return <span style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>{children}</span>;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', maxWidth: '100%' }}>
      <span className={'editable' + (empty ? ' empty' : '')} onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>
        <span className="tx">{children}</span>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} width={width} align={align}>
        <OptionList options={options} value={value} searchable={searchable} onPick={(v, o) => { onPick(v, o); setOpen(false); }} />
      </Popover>
    </span>
  );
}

/* ---------------- Status cell (settable + abandon) ---------------- */
function StatusCell({ task, editable, onSet, onAbandon }) {
  const [open, setOpen] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const [reason, setReason] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open && !abandon) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setAbandon(false); } }
    function key(e) { if (e.key === 'Escape') { setOpen(false); setAbandon(false); } }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open, abandon]);
  if (!editable) return <StatusBadge status={task.status} />;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <StatusBadge status={task.status} onClick={(e) => { e.stopPropagation(); setOpen(o => !o); setAbandon(false); }} />
      {open && !abandon && (
        <div className="pop" style={{ top: 'calc(100% + 5px)', left: 0, width: 190 }} onMouseDown={e => e.stopPropagation()}>
          {SETTABLE_STATUSES.map(s => (
            <button key={s.key} className={'menu-item' + (task.status === s.key ? ' active' : '')} onClick={() => { onSet(s.key); setOpen(false); }}>
              <span className="si" style={{ background: s.color }} />{s.label}
              {task.status === s.key && <span className="ck"><Check size={14} /></span>}
            </button>
          ))}
          <div style={{ height: 1, background: 'var(--border)', margin: '5px 4px' }} />
          <button className="menu-item" style={{ color: 'var(--st-abandon)' }} onClick={() => { setAbandon(true); setReason(''); }}>
            <Ban size={14} /> Abandon…
          </button>
        </div>
      )}
      {abandon && (
        <div className="pop" style={{ top: 'calc(100% + 5px)', left: 0, width: 230, padding: 12 }} onMouseDown={e => e.stopPropagation()}>
          <div className="menu-label" style={{ padding: '0 0 6px' }}>Abandon task</div>
          <input className="reason-input" style={{ marginTop: 0 }} placeholder="Reason (required, logged)" autoFocus value={reason} onChange={e => setReason(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && reason.trim()) { onAbandon(reason.trim()); setAbandon(false); setOpen(false); } }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setAbandon(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={!reason.trim()} onClick={() => { onAbandon(reason.trim()); setAbandon(false); setOpen(false); }}>Abandon</button>
          </div>
        </div>
      )}
    </span>
  );
}

/* ---------------- Deadline cell ---------------- */
function DeadlineCell({ task, editable, onFirstSet, onRevise }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const ref = useRef(null);
  const eff = effectiveDeadline(task);
  const st = deadlineState(task);
  useEffect(() => {
    if (!open) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function key(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  function start(e) { e.stopPropagation(); setDraft(eff); setReason(''); setOpen(true); }
  async function commit() {
    if (!draft) return;
    if (task.deadline) { if (!reason.trim()) return; await onRevise(task, draft, reason.trim()); }
    else { await onFirstSet(draft); }
    setOpen(false);
  }
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span className={'deadline ' + (eff ? st : 'empty')} onClick={editable ? start : undefined} style={{ cursor: editable ? 'pointer' : 'default' }}>
        {eff ? (st === 'over' ? <AlertTriangle /> : <Calendar />) : null}
        {eff ? relDeadline(eff) : (editable ? 'set date' : '—')}
      </span>
      {task.revised_deadline && <span className="rev-flag">rev</span>}
      {open && (
        <div className="pop" style={{ top: 'calc(100% + 5px)', right: 0, width: 'auto', padding: 12 }} onMouseDown={e => e.stopPropagation()}>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          {task.deadline && <input className="reason-input" placeholder="Reason (required, logged)" value={reason} onChange={e => setReason(e.target.value)} />}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!draft || (!!task.deadline && !reason.trim())} onClick={commit}><Check size={13} /> {task.deadline ? 'Revise' : 'Set'}</button>
          </div>
        </div>
      )}
    </span>
  );
}

/* ---------------- Task row ---------------- */
function TaskRow({ task, ctx, isChild, hasKids, expanded }) {
  const { saveField, abandonInline, reviseInline, addSubtask, addCollab, openDrawer, teamCellOpts, ownerCellOpts, prioOpts, empOpts, setExpanded } = ctx;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const done = task.status === 'done';
  const collabs = (task.collaborators || []).map(c => c.full_name).filter(Boolean);
  const [adding, setAdding] = useState(false);
  const [subTitle, setSubTitle] = useState('');
  const [collabOpen, setCollabOpen] = useState(false);
  const collabRef = useRef(null);

  useEffect(() => {
    if (!collabOpen) return;
    function down(e) { if (collabRef.current && !collabRef.current.contains(e.target)) setCollabOpen(false); }
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [collabOpen]);

  const toggleExpand = () => setExpanded(s => ({ ...s, [task.id]: !s[task.id] }));
  const startAddSub = () => { setSubTitle(''); setAdding(true); setExpanded(s => ({ ...s, [task.id]: true })); };
  const submitSub = () => { const v = subTitle.trim(); if (!v) return; addSubtask(task, v); setSubTitle(''); setAdding(false); };

  const addableCollabs = empOpts.filter(o => o.value !== task.owner_employee_id && !(task.collaborators || []).some(c => c.employee_id === o.value));

  const cls = ['row', isChild ? 'sub' : '', done ? 'done' : '',
    !isChild && task.priority === 'P0' ? 'p0' : '', !isChild && task.priority === 'P1' ? 'p1' : ''].filter(Boolean).join(' ');

  return (
    <>
      <div className={cls} style={{ '--grid-cols': GRID_COLS }} tabIndex={isChild ? undefined : 0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') { e.preventDefault(); openDrawer(isChild ? (task.parent_task_id || task.id) : task.id); }
          else if ((e.key === 'x' || e.key === ' ') && ed) { e.preventDefault(); saveField(task, 'status', done ? 'not_started' : 'done'); }
          else if (e.key === 's' && ed && !isChild) { e.preventDefault(); startAddSub(); }
          else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const r = [...document.querySelectorAll('.board .row[tabindex="0"]')]; const n = r[r.indexOf(e.currentTarget) + 1]; n && n.focus(); }
          else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const r = [...document.querySelectorAll('.board .row[tabindex="0"]')]; const n = r[r.indexOf(e.currentTarget) - 1]; n && n.focus(); }
          else if ((e.key === 'ArrowRight' || e.key === 'l') && hasKids && !expanded) { e.preventDefault(); toggleExpand(); }
          else if ((e.key === 'ArrowLeft' || e.key === 'h') && hasKids && expanded) { e.preventDefault(); toggleExpand(); }
        }}>
        {/* Title */}
        <span className="cell cell-title">
          {isChild ? <span className="branch"><ChevronRight size={12} style={{ transform: 'rotate(45deg)' }} /></span>
            : (hasKids
              ? <button className={'expand' + (expanded ? ' open' : '')} onClick={(e) => { e.stopPropagation(); toggleExpand(); }}><ChevronRight size={14} /></button>
              : <span className="expand-spacer" />)}
          <button className={'check' + (done ? ' checked' : '')} title={done ? 'Mark not done' : 'Mark done'}
            disabled={!ed} onClick={(e) => { e.stopPropagation(); saveField(task, 'status', done ? 'not_started' : 'done'); }}>
            {done && <Check size={12} />}
          </button>
          {!isChild && <span className="cell-id" title="Open" onClick={(e) => { e.stopPropagation(); openDrawer(task.id); }}>{task.task_no}</span>}
          <span className="ttl" onClick={() => openDrawer(isChild ? (task.parent_task_id || task.id) : task.id)}>{task.title}</span>
          {task.revised_deadline && <span className="rev-flag">rev</span>}
          {hasKids && <span className="kid-count">{task.child_done ?? 0}/{task.child_count ?? 0}</span>}
          {!isChild && (
            <span className="inline-meta">
              <EditableSelect editable={ed} value={task.department_id || ''} options={teamCellOpts} searchable empty={!task.department_name}
                onPick={(v) => saveField(task, 'department_id', v)}>
                {task.department_name
                  ? <span className="chip" style={{ maxWidth: 120 }}><span className="dot" style={{ background: personColor(task.department_id) }} /><span className="lbl">{task.department_name}</span></span>
                  : (ed ? <span className="chip add">team</span> : null)}
              </EditableSelect>
            </span>
          )}
          {!isChild && ed && <button className="subadd" title="Add sub-task" onClick={(e) => { e.stopPropagation(); startAddSub(); }}><Plus size={13} /></button>}
        </span>

        {/* Owner + collaborators */}
        <span className="cell cell-owner">
          <EditableSelect editable={ed} value={task.owner_employee_id || ''} options={ownerCellOpts} searchable empty={!task.owner_name} width={220}
            onPick={(v) => saveField(task, 'owner_employee_id', v)}>
            {task.owner_name
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}><Avatar name={task.owner_name} size={22} /><span className="name">{firstName(task.owner_name)}</span></span>
              : (ed ? 'assign' : '—')}
          </EditableSelect>
          {collabs.length > 0 && (
            <span style={{ marginLeft: 4 }} title={collabs.join(', ')}>
              <AvatarRow names={collabs} size={20} onClick={() => openDrawer(isChild ? (task.parent_task_id || task.id) : task.id)} />
            </span>
          )}
          {!isChild && ed && (
            <span ref={collabRef} style={{ position: 'relative', display: 'inline-flex', marginLeft: collabs.length ? 4 : 0 }}>
              <button className="add-collab" title="Add collaborator" onClick={(e) => { e.stopPropagation(); setCollabOpen(o => !o); }}><Plus size={12} /></button>
              <Popover open={collabOpen} onClose={() => setCollabOpen(false)} width={220}>
                <OptionList options={addableCollabs} searchable onPick={(v) => { addCollab(task, v); setCollabOpen(false); }} />
              </Popover>
            </span>
          )}
        </span>

        {/* Status */}
        <span className="cell">
          <StatusCell task={task} editable={ed} onSet={(s) => saveField(task, 'status', s)} onAbandon={(r) => abandonInline(task, r)} />
        </span>

        {/* Priority */}
        <span className="cell">
          <EditableSelect editable={ed} value={task.priority} options={prioOpts} width={180} onPick={(v) => saveField(task, 'priority', v)}>
            <PriorityBadge priority={task.priority} />
          </EditableSelect>
        </span>

        {/* Deadline */}
        <span className="cell">
          <DeadlineCell task={task} editable={ed} onFirstSet={(iso) => saveField(task, 'deadline', iso)} onRevise={reviseInline} />
        </span>

        {/* Meta */}
        <span className="cell cell-meta" onClick={() => openDrawer(isChild ? (task.parent_task_id || task.id) : task.id)}>
          {task.doc_count > 0 && <span className="m" title="documents"><Link2 />{task.doc_count}</span>}
          {task.comment_count > 0 && <span className="m" title="comments"><MessageSquare />{task.comment_count}</span>}
        </span>
      </div>

      {adding && (
        <div className="row" style={{ '--grid-cols': '1fr' }}>
          <span className="cell" style={{ paddingLeft: 40, gap: 6 }}>
            <span className="branch"><ChevronRight size={12} style={{ transform: 'rotate(45deg)' }} /></span>
            <input autoFocus value={subTitle} onChange={e => setSubTitle(e.target.value)} placeholder="Sub-task title, Enter to add…"
              className="cell-input" style={{ maxWidth: 460 }}
              onKeyDown={e => { if (e.key === 'Enter') submitSub(); if (e.key === 'Escape') setAdding(false); }} />
            <button className="btn btn-primary" disabled={!subTitle.trim()} onClick={submitSub}><Check size={13} /></button>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}><X size={13} /></button>
          </span>
        </div>
      )}
    </>
  );
}

/* ---------------- The Grid (triage) ---------------- */
function GridZone({ rows, ctx }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!rows.length) return null;
  return (
    <div className={'grid-zone' + (collapsed ? ' collapsed' : '')}>
      <div className="grid-head" onClick={() => setCollapsed(c => !c)}>
        <span className="flag"><Inbox /></span>
        <span className="ttl">The Grid</span>
        <span className="cnt">{rows.length}</span>
        <span className="hint">needs an owner and a deadline to hit the board</span>
        <span className="chev"><ChevronDown size={16} /></span>
      </div>
      <div className="grid-body">
        {rows.map(task => <GridCard key={task.id} task={task} ctx={ctx} />)}
      </div>
    </div>
  );
}

function GridCard({ task, ctx }) {
  const { saveField, openDrawer, ownerCellOpts } = ctx;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const done = task.status === 'done';
  return (
    <div className="gcard">
      <button className={'check' + (done ? ' checked' : '')} disabled={!ed} style={{ marginRight: 2 }}
        onClick={() => saveField(task, 'status', done ? 'not_started' : 'done')}>{done && <Check size={12} />}</button>
      <span className="gtitle" onClick={() => openDrawer(task.id)} style={{ cursor: 'pointer' }}>
        <div className="t">{task.title}</div>
        <div className="id">{task.task_no}</div>
      </span>
      <PriorityBadge priority={task.priority} />
      <span className="gsetup">
        <NeedChip task={task} kind="owner" ed={ed} ownerOpts={ownerCellOpts} saveField={saveField} />
        <NeedChip task={task} kind="deadline" ed={ed} saveField={saveField} />
      </span>
    </div>
  );
}

function NeedChip({ task, kind, ed, ownerOpts, saveField }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const ref = useRef(null);
  const set = kind === 'owner' ? !!task.owner_employee_id : !!task.deadline;
  useEffect(() => {
    if (!open) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function key(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const label = kind === 'owner'
    ? (set ? firstName(task.owner_name) : 'Owner')
    : (set ? fmtShortDate(task.deadline) : 'Deadline');
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className={'need-chip' + (set ? ' set' : '')} disabled={!ed} onClick={() => ed && setOpen(o => !o)}>
        {set ? <Check /> : <Plus />}{label}
      </button>
      {open && kind === 'owner' && (
        <div className="pop" style={{ top: 'calc(100% + 5px)', left: 0, width: 210 }} onMouseDown={e => e.stopPropagation()}>
          <OptionList options={ownerOpts} value={task.owner_employee_id || ''} searchable onPick={(v) => { saveField(task, 'owner_employee_id', v); setOpen(false); }} />
        </div>
      )}
      {open && kind === 'deadline' && (
        <div className="pop" style={{ top: 'calc(100% + 5px)', left: 0, width: 'auto', padding: 12 }} onMouseDown={e => e.stopPropagation()}>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!draft} onClick={() => { saveField(task, 'deadline', draft); setOpen(false); }}><Check size={13} /> Set</button>
          </div>
        </div>
      )}
    </span>
  );
}

/* ---------------- Filter popover ---------------- */
function FilterPop({ onClose, status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId,
  priority, setPriority, programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine,
  teamOpts, empOpts, programOpts, activeFilterCount, clearFilters }) {
  const ref = useRef(null);
  useEffect(() => {
    function down(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function key(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const Sel = ({ label, value, set, any, options }) => (
    <div className="fp-grp">
      <div className="fp-lbl">{label}</div>
      <select className="date-input" value={value || ''} onChange={e => set(e.target.value || '')} style={{ cursor: 'pointer' }}>
        <option value="">{any}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
  return (
    <div ref={ref} className="filter-pop" onMouseDown={e => e.stopPropagation()}>
      <Sel label="Status" value={status} set={setStatus} any="Any status" options={STATUSES.map(s => ({ value: s.key, label: s.label }))} />
      <Sel label="Team" value={departmentId} set={setDepartmentId} any="Any team" options={teamOpts} />
      <Sel label="Owner" value={employeeId} set={setEmployeeId} any="Anyone" options={empOpts} />
      <Sel label="Priority" value={priority} set={setPriority} any="Any priority" options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))} />
      <Sel label="Program" value={programId} set={setProgramId} any="Any program" options={programOpts} />
      <div className="fp-grp">
        <div className="fp-lbl">Quick</div>
        <div className="fp-toggles">
          <button className={'fp-toggle' + (mine ? ' on' : '')} onClick={() => setMine(m => !m)}>My tasks</button>
          <button className={'fp-toggle' + (overdue ? ' on' : '')} onClick={() => setOverdue(o => !o)}>Overdue</button>
          <button className={'fp-toggle' + (revised ? ' on' : '')} onClick={() => setRevised(r => !r)}>Revised</button>
        </div>
      </div>
      {activeFilterCount > 0 && <button className="fp-clear" onClick={clearFilters}>Clear all filters</button>}
    </div>
  );
}

/* ---------------- Quick capture ---------------- */
function QuickCapture({ session, spaceId, onCreated, showToast }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try { await docketopsPost('createTask', { title: t, space_id: spaceId || undefined }, session); setTitle(''); await onCreated(); showToast('Captured to The Grid', 'success'); ref.current?.focus(); }
    catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div className="capture">
      <Plus className="plus" />
      <input ref={ref} data-create-primary value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder="Capture a task. Type a title, press Enter — it lands in The Grid to finish later.   ( c )"
        disabled={saving} />
      <button className="go" onClick={add} disabled={!title.trim() || saving}>{saving ? '…' : 'Add'}</button>
    </div>
  );
}

/* ---------------- New space modal ---------------- */
function NewSpaceModal({ session, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
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
    <div className="backdrop" style={{ alignItems: 'flex-start', justifyContent: 'center' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 420, maxWidth: '92vw', marginTop: '14vh', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', padding: 18, boxShadow: 'var(--shadow-pop)' }} onMouseDown={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--f-display)', fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-1)' }}>
          <Lock size={14} style={{ color: 'var(--accent)' }} /> New space
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '6px 0 12px', lineHeight: 1.5 }}>A private space — only members you add can see its tasks (even admins can’t, unless added).</p>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Space name (e.g. Skunkworks)" className="date-input"
          onKeyDown={e => { if (e.key === 'Enter') create(); }} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || saving} onClick={create}>{saving ? '…' : 'Create space'}</button>
        </div>
      </div>
    </div>
  );
}
