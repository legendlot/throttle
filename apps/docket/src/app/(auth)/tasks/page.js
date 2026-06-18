'use client';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import {
  Search, X, Plus, Check, Ban, ListFilter, Layers, List, Rows3, Inbox,
  ChevronRight, ChevronDown, Calendar, AlertTriangle, Link2, MessageSquare,
  Lock, Settings2, LayoutDashboard, ListChecks, Archive, CheckSquare, Users, Flag, Tag,
} from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { StatusBadge } from '../../../components/StatusBadge.js';
import { PriorityBadge } from '../../../components/PriorityBadge.js';
import { DatePicker } from '../../../components/DatePicker.js';
import { TaskDrawer } from '../../../components/TaskDrawer.js';
import { SpaceSettings } from '../../../components/SpaceSettings.js';
import { Avatar, AvatarRow, Popover, AnchoredPopover, OptionList, firstName, personColor, deadlineState, relDeadline, fmtShortDate } from '../../../components/primitives.js';
import { STATUSES, STATUS_MAP, SETTABLE_STATUSES, PRIORITIES, effectiveDeadline } from '../../../lib/tasks.js';
import { useHotkey } from '../../../lib/hotkeys.js';
import { useChrome } from '../../../lib/chrome.js';

// Task(flex) · Owner(150) · Status(132) · Pri(76) · Deadline(140) · meta(46)
const GRID_COLS = 'minmax(230px,1fr) 150px 132px 76px 140px 46px';
// Program mode adds a Space column (rows span spaces): Task · Space(130) · Owner · Status · Pri · Deadline · meta
const PROGRAM_GRID_COLS = 'minmax(230px,1fr) 130px 150px 132px 76px 140px 46px';

export default function TasksPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setCount } = useChrome();
  const router = useRouter();
  const search = useSearchParams();

  const spaceParam = search.get('space');
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';
  const lensParam = search.get('lens');
  const viewProgramId = search.get('program') || '';
  const inProgramMode = !!viewProgramId;
  // My-tasks mode: cross-space list of tasks I own/collaborate on, split into two sections.
  const mineMode = lensParam === 'mine' && !spaceId && !inProgramMode;
  const crossSpace = inProgramMode || mineMode;
  const gridCols = crossSpace ? PROGRAM_GRID_COLS : GRID_COLS;

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
  const [archiveDone, setArchiveDone] = useState(false); // per-person view pref (sticky)

  const [q, setQ] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [groupMenu, setGroupMenu] = useState(false);
  const [drawerId, setDrawerId] = useState(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const searchRef = useRef(null);

  // Reset selection when the primary view changes (switching space/program/my-tasks)
  // so a bulk action can never land on tasks from a different context.
  useEffect(() => { setSelected(new Set()); setSelectMode(false); }, [spaceId, viewProgramId, mineMode]);

  // `lens=mine` (sidebar "My tasks") drives the mine filter; absent → off.
  useEffect(() => { setMine(lensParam === 'mine'); }, [lensParam]);

  // Sticky view preferences (per person, per device — same model as sidebar collapse).
  useEffect(() => {
    try {
      const d = localStorage.getItem('docket.density'); if (d) setDensity(d);
      const a = localStorage.getItem('docket.archiveDone'); if (a != null) setArchiveDone(a === '1');
    } catch { /* ignore */ }
  }, []);
  function chooseDensity(d) { setDensity(d); try { localStorage.setItem('docket.density', d); } catch { /* ignore */ } }
  function toggleArchiveDone() { setArchiveDone(v => { const n = !v; try { localStorage.setItem('docket.archiveDone', n ? '1' : '0'); } catch { /* ignore */ } return n; }); }

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
      const common = {
        status, department_id: departmentId, employee_id: employeeId, priority,
        overdue: overdue ? '1' : '', revised: revised ? '1' : '', lens: mine ? 'mine' : '',
      };
      // My-tasks: cross-space owner+collaborator list. Program mode: cross-space aggregation
      // of one program's tasks. Otherwise the normal single-space board.
      const r = mineMode
        ? await docketopsGet('getMyTasks', {
            status, department_id: departmentId, priority, program_id: programId,
            overdue: overdue ? '1' : '', revised: revised ? '1' : '',
          }, session)
        : inProgramMode
          ? await docketopsGet('getProgramTasks', { program_id: viewProgramId, ...common }, session)
          : await docketopsGet('getTasks', { space_id: spaceId, program_id: programId, ...common }, session);
      setTasks(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load tasks', 'error'); }
    finally { setLoading(false); }
  }, [session, mineMode, inProgramMode, viewProgramId, spaceId, status, departmentId, employeeId, priority, programId, overdue, revised, mine, showToast]);
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
  // When "Archive done tasks" is on, done children are hidden from the active expand too.
  const childrenByParent = useMemo(() => {
    const m = {};
    for (const t of tasks) { if (t.parent_task_id && !(archiveDone && t.status === 'done')) (m[t.parent_task_id] = m[t.parent_task_id] || []).push(t); }
    return m;
  }, [tasks, archiveDone]);

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
  // "Archive done tasks" (per-person toggle): when ON, done top-level tasks leave the
  // active board into the collapsed Archived section; when OFF they stay on the board.
  const activeTop = useMemo(() => archiveDone ? topLevel.filter(t => t.status !== 'done') : topLevel, [topLevel, archiveDone]);
  const archivedRows = useMemo(() => archiveDone ? topLevel.filter(t => t.status === 'done').sort(sortFn) : [], [topLevel, archiveDone, sortFn]);
  const needsSetup = (t) => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id);
  const gridRows = useMemo(() => activeTop.filter(needsSetup).sort(sortFn), [activeTop, sortFn]);
  const boardRows = useMemo(() => activeTop.filter(t => !needsSetup(t)).sort(sortFn), [activeTop, sortFn]);

  // My-tasks mode: flat list (incl. sub-tasks) split by relation. "Assigned to me" = owner;
  // "Collaborating" = everything else (collaborator-only). Search applies; no Grid/nesting.
  const mineMatched = useMemo(() => (mineMode ? tasks.filter(matchesQuery) : []), [mineMode, tasks, matchesQuery]);
  const mineOwner = useMemo(() => mineMatched.filter(t => t._relation === 'owner').sort(sortFn), [mineMatched, sortFn]);
  const mineCollab = useMemo(() => mineMatched.filter(t => t._relation !== 'owner').sort(sortFn), [mineMatched, sortFn]);

  // ---- bulk selection (works in Grid + board + my-tasks; only editable tasks are selectable) ----
  const selectableIds = useMemo(() => {
    const pool = mineMode ? [...mineOwner, ...mineCollab] : [...gridRows, ...boardRows];
    return pool.filter(t => t._can_edit && t.status !== 'abandoned').map(t => t.id);
  }, [mineMode, mineOwner, mineCollab, gridRows, boardRows]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
  const toggleSelect = useCallback((id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  function clearSelection() { setSelected(new Set()); }
  function toggleSelectAll() {
    setSelected(s => {
      const n = new Set(s);
      if (selectableIds.length && selectableIds.every(id => s.has(id))) selectableIds.forEach(id => n.delete(id));
      else selectableIds.forEach(id => n.add(id));
      return n;
    });
  }
  async function applyBulk(field, value, reason) {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const res = await docketopsPost('bulkUpdateTasks', { ids, field, value, reason }, session);
      const updated = res?.updated ?? 0, skipped = res?.skipped ?? 0;
      showToast(`Updated ${updated}${skipped ? ` · skipped ${skipped}` : ''}`, updated ? 'success' : 'info');
      clearSelection();
      await load();
    } catch (e) { showToast(e.message || 'Bulk update failed', 'error'); }
  }

  // Publish the visible count to the topbar; clear it when leaving the board.
  const headerCount = mineMode ? (mineOwner.length + mineCollab.length) : activeTop.length;
  useEffect(() => { setCount?.(headerCount); return () => setCount?.(null); }, [headerCount, setCount]);

  // Program mode: smart default space for new tasks = the space this program already lives
  // in most (programs live in private spaces; General is rarely used). Falls back to General.
  const programDefaultSpace = useMemo(() => {
    if (!inProgramMode) return '';
    const counts = {};
    for (const t of tasks) { if (t.space_id) counts[t.space_id] = (counts[t.space_id] || 0) + 1; }
    let best = '', n = -1;
    for (const [sid, c] of Object.entries(counts)) { if (c > n) { n = c; best = sid; } }
    if (best) return best;
    const general = spaces.find(s => !s.is_private);
    return general ? general.id : (spaces[0]?.id || '');
  }, [inProgramMode, tasks, spaces]);

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
    gridCols, showSpace: crossSpace,
    selectMode, selected, toggleSelect,
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

      {inProgramMode
        ? <ProgramCapture session={session} programId={viewProgramId} spaces={spaces} defaultSpaceId={programDefaultSpace} onCreated={load} showToast={showToast} />
        : mineMode
          ? <QuickCapture session={session} assignSelf onCreated={load} showToast={showToast}
              placeholder="Add a task to your list. Type a title, press Enter — it's assigned to you.   ( c )" />
          : <QuickCapture session={session} spaceId={spaceId} onCreated={load} showToast={showToast} />}

      <div className="toolbar">
        <div className="search">
          <Search className="ic" />
          <input data-search-primary ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks, owners, DKT-no…" />
          {!q && <span className="kbd">/</span>}
        </div>
        {!mineMode && (
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
        )}
        <div style={{ position: 'relative' }}>
          <button className={'tool' + (activeFilterCount > 0 ? ' on' : '')} onClick={() => setFilterOpen(o => !o)}>
            <ListFilter className="ic" /> Filter {activeFilterCount > 0 && <span className="badge">{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <FilterPop onClose={() => setFilterOpen(false)} hideProgramFilter={inProgramMode}
              hideOwnerFilter={mineMode} hideMineToggle={mineMode}
              {...{ status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId, priority, setPriority,
                programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine,
                teamOpts, empOpts, programOpts, activeFilterCount, clearFilters }} />
          )}
        </div>
        <button className={'tool' + (selectMode ? ' on' : '')} onClick={() => setSelectMode(m => { if (m) clearSelection(); return !m; })}
          title="Select multiple tasks to update them in bulk">
          <CheckSquare className="ic" /> Select
        </button>
        {selectMode && selectableIds.length > 0 && (
          <button className="tool" onClick={toggleSelectAll}>
            <span className={'sel-box' + (allSelected ? ' on' : '')}>{allSelected && <Check size={11} />}</span>
            {allSelected ? 'Clear all' : 'Select all'}{selected.size > 0 && <span className="badge">{selected.size}</span>}
          </button>
        )}
        {!mineMode && (
          <button className={'tool' + (archiveDone ? ' on' : '')} onClick={toggleArchiveDone}
            title={archiveDone ? 'Done tasks are archived — click to show them on the board' : 'Archive done tasks into a collapsed section'}>
            <Archive className="ic" /> {archiveDone ? 'Done archived' : 'Archive done'}
          </button>
        )}
        <div className="seg">
          <button className={density === 'compact' ? 'on' : ''} title="Compact" onClick={() => chooseDensity('compact')}><List /></button>
          <button className={density === 'roomy' ? 'on' : ''} title="Roomy" onClick={() => chooseDensity('roomy')}><Rows3 /></button>
        </div>
      </div>

      {loading && tasks.length === 0 ? <Spinner /> : (
        (mineMode ? (mineOwner.length + mineCollab.length) === 0 : topLevel.length === 0) ? (
          <div className="empty-state">
            <div className="ei"><ListChecks size={24} /></div>
            <h3>{(q || activeFilterCount) ? 'No tasks match' : (mineMode ? 'Nothing assigned to you' : 'All clear')}</h3>
            <p>{(q || activeFilterCount) ? 'Try a different search or widen the filters.' : (mineMode ? 'Tasks you own or collaborate on — across every space — show up here.' : 'Capture a task above to get started.')}</p>
            {activeFilterCount > 0 && <button className="fp-clear" style={{ width: 'auto', margin: '14px auto 0' }} onClick={clearFilters}>Clear filters</button>}
          </div>
        ) : mineMode ? (
          <div style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto', transition: 'opacity var(--base) var(--ease)' }}>
            <MineSection title="Assigned to me" rows={mineOwner} ctx={rowCtx} gridCols={gridCols}
              sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <MineSection title="Collaborating" rows={mineCollab} ctx={rowCtx} gridCols={gridCols}
              sortKey={sortKey} sortDir={sortDir} onSort={onSort} collapsible />
          </div>
        ) : (
          <div style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto', transition: 'opacity var(--base) var(--ease)' }}>
            <GridZone rows={gridRows} ctx={rowCtx} />

            {boardRows.length > 0 && (
              <div className="board-scroll"><div className="board">
                <div className="cols" style={{ '--grid-cols': gridCols }}>
                  <ColHead k="title" label="Task" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  {inProgramMode && <span className="ch">Space</span>}
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

            <ArchivedZone rows={archivedRows} ctx={rowCtx} />
          </div>
        )
      )}

      {selectMode && selected.size > 0 && (
        <BulkBar count={selected.size} onClear={clearSelection} onApply={applyBulk}
          ownerOpts={ownerCellOpts} prioOpts={prioOpts} programOpts={programCellOpts} />
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
      <AnchoredPopover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="right">
        <DatePicker value={draft} onChange={setDraft} autoFocus />
        {task.deadline && <input className="reason-input" placeholder="Reason (required, logged)" value={reason} onChange={e => setReason(e.target.value)} />}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={!draft || (!!task.deadline && !reason.trim())} onClick={commit}><Check size={13} /> {task.deadline ? 'Revise' : 'Set'}</button>
        </div>
      </AnchoredPopover>
    </span>
  );
}

/* ---------------- Task row ---------------- */
function TaskRow({ task, ctx, isChild, hasKids, expanded }) {
  const { saveField, abandonInline, reviseInline, addSubtask, addCollab, openDrawer, teamCellOpts, ownerCellOpts, prioOpts, empOpts, setExpanded, gridCols, showSpace, selectMode, selected, toggleSelect } = ctx;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const isSel = !!selected?.has(task.id);
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

  const cls = ['row', isChild ? 'sub' : '', done ? 'done' : '', isSel ? 'selected' : '',
    !isChild && task.priority === 'P0' ? 'p0' : '', !isChild && task.priority === 'P1' ? 'p1' : ''].filter(Boolean).join(' ');

  return (
    <>
      <div className={cls} style={{ '--grid-cols': gridCols }} tabIndex={isChild ? undefined : 0}
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
          {selectMode && (ed
            ? <button className={'sel-box' + (isSel ? ' on' : '')} title="Select task" onClick={(e) => { e.stopPropagation(); toggleSelect(task.id); }}>{isSel && <Check size={11} />}</button>
            : <span className="sel-box disabled" title="You can only bulk-edit tasks you own" />)}
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

        {/* Space (program mode only — rows span spaces) */}
        {showSpace && (
          <span className="cell" onClick={() => openDrawer(isChild ? (task.parent_task_id || task.id) : task.id)}>
            <span className="chip" style={{ maxWidth: 118 }} title={task.space_name || 'General'}>
              <span className="dot" style={{ background: personColor(task.space_id) }} />
              <span className="lbl">{task.space_name || 'General'}</span>
            </span>
          </span>
        )}

        {/* Owner + collaborators */}
        <span className="cell cell-owner">
          <EditableSelect editable={ed} value={task.owner_employee_id || ''} options={ownerCellOpts} searchable empty={!task.owner_name} width={220}
            onPick={(v) => saveField(task, 'owner_employee_id', v)}>
            {task.owner_name
              ? <Avatar name={task.owner_name} size={22} title={task.owner_name} />
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
  const { saveField, openDrawer, ownerCellOpts, selectMode, selected, toggleSelect } = ctx;
  const ed = !!task._can_edit && task.status !== 'abandoned';
  const done = task.status === 'done';
  const isSel = !!selected?.has(task.id);
  return (
    <div className={'gcard' + (isSel ? ' selected' : '')}>
      {selectMode && (ed
        ? <button className={'sel-box' + (isSel ? ' on' : '')} title="Select task" onClick={() => toggleSelect(task.id)}>{isSel && <Check size={11} />}</button>
        : <span className="sel-box disabled" title="You can only bulk-edit tasks you own" />)}
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
  const label = kind === 'owner'
    ? (set ? firstName(task.owner_name) : 'Owner')
    : (set ? fmtShortDate(task.deadline) : 'Deadline');
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button className={'need-chip' + (set ? ' set' : '')} disabled={!ed} onClick={() => ed && setOpen(o => !o)}>
        {set ? <Check /> : <Plus />}{label}
      </button>
      {kind === 'owner' && (
        <Popover open={open} onClose={() => setOpen(false)} width={210}>
          <OptionList options={ownerOpts} value={task.owner_employee_id || ''} searchable onPick={(v) => { saveField(task, 'owner_employee_id', v); setOpen(false); }} />
        </Popover>
      )}
      {kind === 'deadline' && (
        <AnchoredPopover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
          <DatePicker value={draft} onChange={setDraft} autoFocus />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!draft} onClick={() => { saveField(task, 'deadline', draft); setOpen(false); }}><Check size={13} /> Set</button>
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}

/* ---------------- Archived (collapsed bottom section) ---------------- */
function ArchivedZone({ rows, ctx }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div className={'archived-zone' + (open ? ' open' : '')}>
      <div className="archived-head" onClick={() => setOpen(o => !o)}>
        <span className="chev"><ChevronRight size={15} /></span>
        <Archive size={14} />
        <span className="ttl">Archived</span>
        <span className="cnt">{rows.length}</span>
      </div>
      {open && (
        <div className="archived-body">
          {rows.map(t => <ArchivedRow key={t.id} task={t} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ task, ctx }) {
  const { openDrawer, saveField } = ctx;
  const ed = !!task._can_edit;
  return (
    <div className="archived-row">
      <button className="ar-check" disabled={!ed} title={ed ? 'Mark not done (return to the board)' : undefined}
        onClick={() => ed && saveField(task, 'status', 'not_started')}><Check size={11} /></button>
      <span className="ar-id" onClick={() => openDrawer(task.id)}>{task.task_no}</span>
      <span className="ar-ttl" onClick={() => openDrawer(task.id)}>{task.title}</span>
      {task.owner_name && <Avatar name={task.owner_name} size={18} title={task.owner_name} />}
    </div>
  );
}

/* ---------------- My-tasks section (cross-space, flat) ---------------- */
function MineSection({ title, rows, ctx, gridCols, sortKey, sortDir, onSort, collapsible }) {
  const [open, setOpen] = useState(true);
  if (collapsible && !rows.length) return null;
  return (
    <div className="mine-section">
      <div className={'mine-head' + (collapsible ? ' clickable' : '')} onClick={collapsible ? () => setOpen(o => !o) : undefined}>
        {collapsible && <span className={'chev' + (open ? '' : ' closed')}><ChevronDown size={15} /></span>}
        <span className="ms-ttl">{title}</span>
        <span className="ms-cnt">{rows.length}</span>
      </div>
      {(!collapsible || open) && (
        rows.length ? (
          <div className="board-scroll"><div className="board">
            <div className="cols" style={{ '--grid-cols': gridCols }}>
              <ColHead k="title" label="Task" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <span className="ch">Space</span>
              <ColHead k="owner_name" label="Owner" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <ColHead k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <ColHead k="priority" label="Pri" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <ColHead k="deadline" label="Deadline" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <span className="ch" style={{ justifyContent: 'flex-end' }} />
            </div>
            <div className="rows">
              {rows.map(t => <TaskRow key={t.id} task={t} ctx={ctx} hasKids={false} expanded={false} />)}
            </div>
          </div></div>
        ) : <div className="mine-empty">Nothing here yet.</div>
      )}
    </div>
  );
}

/* ---------------- Bulk action bar (floating) ---------------- */
function BulkBar({ count, onClear, onApply, ownerOpts, prioOpts, programOpts }) {
  const [menu, setMenu] = useState(null); // owner | status | priority | program | deadline
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) close(); }
    function key(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  function close() { setMenu(null); setDraft(null); setReason(''); }
  function go(field, value, r) { onApply(field, value, r); close(); }
  const toggle = (m) => { setDraft(null); setReason(''); setMenu(cur => (cur === m ? null : m)); };

  return (
    <div className="bulk-bar" ref={ref} onMouseDown={e => e.stopPropagation()}>
      <span className="bb-count"><CheckSquare size={15} /> {count} selected</span>
      <div className="bb-sep" />
      <div className="bb-actions">
        {/* Owner */}
        <div className="bb-item">
          <button className={'bb-btn' + (menu === 'owner' ? ' on' : '')} onClick={() => toggle('owner')}><Users size={14} /> Owner</button>
          {menu === 'owner' && <div className="pop bb-pop"><OptionList options={ownerOpts} searchable onPick={(v) => go('owner_employee_id', v)} /></div>}
        </div>
        {/* Status */}
        <div className="bb-item">
          <button className={'bb-btn' + (menu === 'status' ? ' on' : '')} onClick={() => toggle('status')}><Check size={14} /> Status</button>
          {menu === 'status' && (
            <div className="pop bb-pop" style={{ width: 190 }}>
              {SETTABLE_STATUSES.map(s => (
                <button key={s.key} className="menu-item" onClick={() => go('status', s.key)}>
                  <span className="si" style={{ background: s.color }} />{s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Priority */}
        <div className="bb-item">
          <button className={'bb-btn' + (menu === 'priority' ? ' on' : '')} onClick={() => toggle('priority')}><Flag size={14} /> Priority</button>
          {menu === 'priority' && (
            <div className="pop bb-pop" style={{ width: 160 }}>
              {prioOpts.map(p => <button key={p.value} className="menu-item" onClick={() => go('priority', p.value)}>{p.label}</button>)}
            </div>
          )}
        </div>
        {/* Deadline */}
        <div className="bb-item">
          <button className={'bb-btn' + (menu === 'deadline' ? ' on' : '')} onClick={() => toggle('deadline')}><Calendar size={14} /> Deadline</button>
          {menu === 'deadline' && (
            <div className="pop bb-pop" style={{ width: 248, padding: 10 }}>
              <DatePicker value={draft} onChange={setDraft} autoFocus />
              <input className="reason-input" placeholder="Reason (required if any already has a deadline)" value={reason} onChange={e => setReason(e.target.value)} />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
                <button className="btn btn-ghost" onClick={close}>Cancel</button>
                <button className="btn btn-primary" disabled={!draft} onClick={() => go('deadline', draft, reason.trim() || undefined)}><Check size={13} /> Set</button>
              </div>
            </div>
          )}
        </div>
        {/* Program */}
        <div className="bb-item">
          <button className={'bb-btn' + (menu === 'program' ? ' on' : '')} onClick={() => toggle('program')}><Tag size={14} /> Program</button>
          {menu === 'program' && <div className="pop bb-pop"><OptionList options={programOpts} searchable onPick={(v) => go('program_id', v)} /></div>}
        </div>
      </div>
      <button className="bb-clear" onClick={onClear}><X size={14} /> Clear</button>
    </div>
  );
}

/* ---------------- Filter popover ---------------- */
function FilterPop({ onClose, status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId,
  priority, setPriority, programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine,
  teamOpts, empOpts, programOpts, activeFilterCount, clearFilters, hideProgramFilter, hideOwnerFilter, hideMineToggle }) {
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
      {!hideOwnerFilter && <Sel label="Owner" value={employeeId} set={setEmployeeId} any="Anyone" options={empOpts} />}
      <Sel label="Priority" value={priority} set={setPriority} any="Any priority" options={PRIORITIES.map(p => ({ value: p.key, label: p.label }))} />
      {!hideProgramFilter && <Sel label="Program" value={programId} set={setProgramId} any="Any program" options={programOpts} />}
      <div className="fp-grp">
        <div className="fp-lbl">Quick</div>
        <div className="fp-toggles">
          {!hideMineToggle && <button className={'fp-toggle' + (mine ? ' on' : '')} onClick={() => setMine(m => !m)}>My tasks</button>}
          <button className={'fp-toggle' + (overdue ? ' on' : '')} onClick={() => setOverdue(o => !o)}>Overdue</button>
          <button className={'fp-toggle' + (revised ? ' on' : '')} onClick={() => setRevised(r => !r)}>Revised</button>
        </div>
      </div>
      {activeFilterCount > 0 && <button className="fp-clear" onClick={clearFilters}>Clear all filters</button>}
    </div>
  );
}

/* ---------------- Quick capture ---------------- */
function QuickCapture({ session, spaceId, onCreated, showToast, assignSelf, placeholder }) {
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await docketopsPost('createTask', { title: t, space_id: spaceId || undefined, assign_self: assignSelf || undefined }, session);
      setTitle(''); await onCreated();
      showToast(assignSelf ? 'Added to your list' : 'Captured to The Grid', 'success'); ref.current?.focus();
    }
    catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div className="capture">
      <Plus className="plus" />
      <input ref={ref} data-create-primary value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder={placeholder || 'Capture a task. Type a title, press Enter — it lands in The Grid to finish later.   ( c )'}
        disabled={saving} />
      <button className="go" onClick={add} disabled={!title.trim() || saving}>{saving ? '…' : 'Add'}</button>
    </div>
  );
}

/* ---------------- Program quick capture (auto-tags the program) ---------------- */
function ProgramCapture({ session, programId, spaces, defaultSpaceId, onCreated, showToast }) {
  const [title, setTitle] = useState('');
  const [spaceId, setSpaceId] = useState(defaultSpaceId || '');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  // Re-sync the default space once the program's tasks load (default is computed from them).
  useEffect(() => { setSpaceId(prev => prev || defaultSpaceId || ''); }, [defaultSpaceId]);
  async function add() {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await docketopsPost('createTask', { title: t, space_id: spaceId || undefined, program_id: programId }, session);
      setTitle('');
      await onCreated();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed')); // refresh sidebar count
      showToast('Added to program', 'success');
      ref.current?.focus();
    } catch (e) { showToast(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  }
  return (
    <div className="capture">
      <Plus className="plus" />
      <input ref={ref} data-create-primary value={title} onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') add(); }}
        placeholder="Add a task to this program. Type a title, press Enter — it's tagged automatically.   ( c )"
        disabled={saving} />
      <select className="capture-space" value={spaceId} onChange={e => setSpaceId(e.target.value)} title="Space this task lives in" disabled={saving}>
        {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
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
