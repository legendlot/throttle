'use client';
// /tasks — the orchestrator (ClickUp redesign P3 split). Owns data (load + writes),
// derived rows/groups, selection, hotkeys and the page modals. Rendering lives in
// components/tasks/: TasksChrome (views bar + toolbar), TaskListView (Grid · column
// header · groups · Archived), TaskRow, GroupHeader (+ foot capture), BulkBar;
// view state + its localStorage in useTaskViewState. Board view = KanbanBoard.
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, ListChecks } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { TaskView } from '../../../components/task/TaskView.js';
import { domTaskOrder } from '../../../components/task/taskViewMode.js';
import { useCommandSource } from '../../../lib/commandSources.js';
import { SpaceSettings } from '../../../components/SpaceSettings.js';
import { personColor } from '../../../components/primitives.js';
import { KanbanBoard } from '../../../components/KanbanBoard.js';
import { STATUSES, STATUS_MAP, PRIORITIES, effectiveDeadline } from '../../../lib/tasks.js';
import { useHotkey } from '../../../lib/hotkeys.js';
import { focusWhenReady } from '../../../lib/nav.js';
import { useChrome } from '../../../lib/chrome.js';
import { ViewsBar, TasksToolbar } from '../../../components/tasks/TasksChrome.js';
import { TaskListView } from '../../../components/tasks/TaskListView.js';
import { NewTaskCapture } from '../../../components/tasks/GroupHeader.js';
import { CaptureProvider } from '../../../components/tasks/QuickCapture.js';
import { GridTriage } from '../../../components/tasks/GridTriage.js';
import { BulkBar } from '../../../components/tasks/BulkBar.js';
import { ROW_SELECTOR } from '../../../components/tasks/TaskRow.js';
import { useTaskViewState, visibleColumns, COLUMNS } from '../../../components/tasks/useTaskViewState.js';
import { Button, EmptyState } from '../../../components/ui/index.js';

const GROUP_OPTS = [
  { value: 'none', label: 'No grouping' }, { value: 'person', label: 'Owner' },
  { value: 'department', label: 'Team' }, { value: 'status', label: 'Status' }, { value: 'program', label: 'Program' },
];
// Group axis → the createTask field a group-foot capture prefills (status included —
// createTask takes an initial status since functionality F1).
const GROUP_FIELD = { person: 'owner_employee_id', department: 'department_id', program: 'program_id', status: 'status' };

// IST calendar date 'YYYY-MM-DD' (My tasks "Today & overdue" boundary).
const istDateStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export default function TasksPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  // shellModalOpen: a layout-owned modal (sidebar ⋯ SpaceSettings, shortcuts sheet,
  // New program) is up — page hotkeys must not fire behind it.
  const { setCount, shellModalOpen, myEmployeeId } = useChrome();
  const router = useRouter();
  const search = useSearchParams();

  const spaceParam = search.get('space');
  const spaceId = spaceParam && spaceParam !== 'new' ? spaceParam : '';
  const lensParam = search.get('lens');
  const viewProgramId = search.get('program') || '';
  // `?task=<id>` opens that task in TaskView (deep link; also how full page hands back).
  const taskParam = search.get('task') || '';
  const inProgramMode = !!viewProgramId;
  // My-tasks mode: cross-space list of tasks I own / collaborate on / raised, in sections.
  const mineMode = lensParam === 'mine' && !spaceId && !inProgramMode;
  const crossSpace = inProgramMode || mineMode;

  const view = useTaskViewState({ lensParam });
  const { filters: f, groupBy, setGroupBy, density, chooseDensity, archiveDone, toggleArchiveDone, viewMode, chooseView, cardSize, chooseCardSize,
    showIds, toggleShowIds, subtaskMode, chooseSubtaskMode, cols, toggleColumn, moveColumn, resizeColumn, resetColumns,
    collapsed, toggleGroupCollapsed, setGroupsCollapsed } = view;
  const { status, departmentId, employeeId, priority, programId, overdue, revised, mine, q } = f;

  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const [filterOpen, setFilterOpen] = useState(false);
  const [groupMenu, setGroupMenu] = useState(false);
  const [subMenu, setSubMenu] = useState(false);          // toolbar Subtasks menu
  const [custOpen, setCustOpen] = useState(false);        // toolbar Customize menu
  const [colsOpen, setColsOpen] = useState(false);        // toolbar Columns menu
  const [newTaskMenuOpen, setNewTaskMenuOpen] = useState(false); // + Task split menu
  // New sub-task from the + Task menu: the last focused top-level row (a ref — j/k moves
  // focus constantly and must not re-render the page), and a one-shot request the
  // matching TaskRow picks up (it owns the inline sub-task input).
  const focusedRowRef = useRef(null);
  const [subRequest, setSubRequest] = useState(null);
  const [drawerId, setDrawerId] = useState(null);
  // F3 Grid triage: { queue: [id…] snapshotted in display order, skipped: N not editable } | null.
  const [triage, setTriage] = useState(null);
  // A task opened from the `?task=` link stays an overlay even if "full page" is the
  // remembered layout (fromLink) — otherwise Back from the full page would loop.
  const [linkTaskId, setLinkTaskId] = useState(null);
  useEffect(() => { if (taskParam) { setDrawerId(taskParam); setLinkTaskId(taskParam); } }, [taskParam]);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const searchRef = useRef(null);

  // Reset selection when the primary view changes (switching space/program/my-tasks)
  // so a bulk action can never land on tasks from a different context.
  useEffect(() => { setSelected(new Set()); setSelectMode(false); }, [spaceId, viewProgramId, mineMode]);

  const empMap = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e.full_name])), [employees]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map(d => [d.id, d.name])), [departments]);
  const teamCellOpts = useMemo(() => [{ value: '', label: '— No team —' }, ...departments.map(d => ({ value: d.id, label: d.name, dot: personColor(d.id) }))], [departments]);
  const ownerCellOpts = useMemo(() => [{ value: '', label: '— Unassigned —' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))], [employees]);
  const prioOpts = useMemo(() => PRIORITIES.map(p => ({ value: p.key, label: p.label })), []);
  const teamOpts = useMemo(() => departments.map(d => ({ value: d.id, label: d.name })), [departments]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);
  const programOpts = useMemo(() => programs.map(p => ({ value: p.id, label: p.name })), [programs]);
  const programCellOpts = useMemo(() => [{ value: '', label: '— No program —' }, ...programOpts], [programOpts]);
  const opts = useMemo(() => ({ teamCellOpts, ownerCellOpts, prioOpts, empOpts, programCellOpts }), [teamCellOpts, ownerCellOpts, prioOpts, empOpts, programCellOpts]);
  // F2 capture chips + @name tokens: the same people / options as the owner and priority cells.
  const captureCtx = useMemo(() => ({ people: employees, ownerOpts: ownerCellOpts, prioOpts }), [employees, ownerCellOpts, prioOpts]);

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

  // `c` → with a row focused, that row's group-foot capture (prefilled with the group's
  // value; the group is expanded first if collapsed); otherwise the un-prefilled top
  // "New task" capture.
  useHotkey('c', (e) => {
    const key = document.activeElement?.closest?.('.tl-group[data-group]')?.getAttribute('data-group');
    // Groups without a foot capture (Abandoned, My tasks' collab/raised) fall through to the top one.
    if (key && groups.find(g => g.key === key)?.capture) {
      e.preventDefault();
      toggleGroupCollapsed(key, false);
      focusWhenReady(`.tl-group[data-group="${CSS.escape(key)}"] [data-group-capture]`, { select: true, tries: 10 });
      return;
    }
    const el = document.querySelector('[data-create-primary]');
    if (!el) return;
    e.preventDefault();
    try { el.focus(); el.select?.(); } catch { /* ignore */ }
  }, { enabled: !drawerId && !newSpaceOpen && !spaceSettingsOpen && !shellModalOpen && !triage });

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

  // fetchSpaces only re-reads; refreshSpaces also tells the shell (sidebar) to re-read.
  // The listener below calls fetchSpaces, never refreshSpaces, so a page-side change
  // (dispatch → listener → fetch) can't re-dispatch and loop.
  const fetchSpaces = useCallback(() => {
    if (!session) return;
    docketopsGet('getSpaces', {}, session).then(s => setSpaces(s || [])).catch(() => {});
  }, [session]);
  function refreshSpaces() {
    fetchSpaces();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:spaces-changed'));
  }
  // Programs created elsewhere (top-bar / sidebar New program, drawer inline create)
  // feed the Program filter + cell options. Re-read only — this page never re-dispatches
  // from here, so the group-foot capture's own dispatch can't loop.
  const fetchPrograms = useCallback(() => {
    if (!session) return;
    docketopsGet('getPrograms', {}, session).then(p => setPrograms(p || [])).catch(() => {});
  }, [session]);
  useEffect(() => {
    window.addEventListener('docket:programs-changed', fetchPrograms);
    return () => window.removeEventListener('docket:programs-changed', fetchPrograms);
  }, [fetchPrograms]);
  // The shell's sidebar ⋯ (SpaceSettings in the layout) renames / archives / transfers
  // spaces too — keep this page's own `spaces` (bulk Move list, program capture, is_owner) in step.
  useEffect(() => {
    window.addEventListener('docket:spaces-changed', fetchSpaces);
    return () => window.removeEventListener('docket:spaces-changed', fetchSpaces);
  }, [fetchSpaces]);

  const tokens = useMemo(() => q.trim().toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const matchesQuery = useCallback((t) => {
    if (!tokens.length) return true;
    const hay = [t.task_no, t.title, t.owner_name, t.department_name, t.creator_name,
      ...(t.collaborators || []).map(c => c.full_name)].filter(Boolean).join(' ').toLowerCase();
    return tokens.every(tok => hay.includes(tok));
  }, [tokens]);

  /* ---------------- writes ---------------- */
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
  function copyTaskLink(task) {
    const url = `${window.location.origin}/tasks/detail/?id=${task.id}`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => showToast(`Link to ${task.task_no} copied`, 'success')).catch(() => showToast('Could not copy the link', 'error'));
    else showToast('Could not copy the link', 'error');
  }

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
  const [programSpace, setProgramSpace] = useState('');
  useEffect(() => { setProgramSpace(prev => prev || programDefaultSpace || ''); }, [programDefaultSpace]);
  useEffect(() => { setProgramSpace(''); }, [viewProgramId]);

  // Create a task from a group foot (replaces the P2 top capture bar; same create
  // bodies: space board → space_id, My tasks → assign_self, program → program_id +
  // the chosen space), with the group's value prefilled where the field maps.
  // F2: `extras` {owner_employee_id, deadline, priority} come from the capture's quick-add
  // tokens / chips and are merged OVER the group prefill — an explicit choice wins. On My
  // tasks a chosen owner replaces assign_self.
  async function createInGroup(title, field, value, extras) {
    const body = mineMode ? { title, assign_self: true }
      : inProgramMode ? { title, space_id: (programSpace || programDefaultSpace) || undefined, program_id: viewProgramId }
      : { title, space_id: spaceId || undefined };
    // A status group's value goes in the create itself (worker F1): one write, one history row.
    if (field && value && !(field === 'status' && value === 'abandoned')) body[field] = value;
    const x = extras || {};
    if (x.owner_employee_id) { body.owner_employee_id = x.owner_employee_id; delete body.assign_self; }
    if (x.deadline) body.deadline = x.deadline;
    if (x.priority) body.priority = x.priority;
    try {
      await docketopsPost('createTask', body, session);
      await load();
      if (inProgramMode && typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed')); // sidebar count
      // The toast reads the FINAL owner. Without an owner AND a deadline a new task lands in The
      // Grid (RULE-DOCKET-001) — say so only when one is still missing. assign_self with no
      // employee record (getMe.employee_id null) means no owner.
      const owner = body.owner_employee_id || (body.assign_self ? myEmployeeId : null) || null;
      const mine = !!owner && owner === myEmployeeId;
      const ownerName = owner && !mine ? (employees.find(e => e.id === owner)?.full_name || '').split(/\s+/)[0] : '';
      const where = mineMode ? (mine ? 'Added to your list' : ownerName ? `Added — owned by ${ownerName}` : 'Added')
        : inProgramMode ? 'Added to program' : 'Added';
      const missing = !owner && !body.deadline ? 'an owner and a deadline' : !owner ? 'an owner' : !body.deadline ? 'a deadline' : '';
      showToast(!missing ? where
        : (!mineMode && !inProgramMode) ? 'Captured to The Grid'
        : `${where} — in The Grid until it has ${missing}`, 'success');
      return true;
    } catch (e) { showToast(e.message || 'Create failed', 'error'); return false; }
  }

  /* ---------------- stable actions for memoised rows ---------------- */
  const live = useRef({});
  live.current = { saveField, abandonInline, reviseInline, addSubtask, addCollab, copyTaskLink, createInGroup, viewOpen: drawerId != null, closeTask };
  const toggleSelect = useCallback((id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const actions = useMemo(() => ({
    saveField: (...a) => live.current.saveField(...a),
    abandonInline: (...a) => live.current.abandonInline(...a),
    reviseInline: (...a) => live.current.reviseInline(...a),
    addSubtask: (...a) => live.current.addSubtask(...a),
    addCollab: (...a) => live.current.addCollab(...a),
    copyTaskLink: (...a) => live.current.copyTaskLink(...a),
    openDrawer: (id) => setDrawerId(id),
    // Rows ignore their own keys (x / s / j / k…) while TaskView is open — Enter still opens.
    isViewOpen: () => !!live.current.viewOpen,
    toggleExpand: (id) => setExpanded(s => ({ ...s, [id]: !s[id] })),
    setExpandedOn: (id) => setExpanded(s => (s[id] ? s : { ...s, [id]: true })),
    toggleSelect,
    enterSelect: () => setSelectMode(true),
    clearSubRequest: () => setSubRequest(null),
    focusedRowRef,
  }), [toggleSelect]);

  // ⌘K bar (P6): this page's loaded rows (any task here opens in place) + its view
  // switches. isViewOpen / closeTask let a nav / command pick close TaskView first.
  const cmdTasks = useMemo(() => ({
    rows: tasks, open: (id) => setDrawerId(id),
    isViewOpen: () => !!live.current.viewOpen, closeTask: () => live.current.closeTask?.(),
  }), [tasks]);
  useCommandSource('tasks', cmdTasks);
  const cmdView = useMemo(() => ({ viewMode: viewMode === 'board' && !mineMode ? 'board' : 'list', chooseView, density, chooseDensity, canBoard: !mineMode }), [viewMode, chooseView, density, chooseDensity, mineMode]);
  useCommandSource('tasksView', cmdView);

  /* ---------------- derived rows ---------------- */
  // Children grouped by parent (off the full set), so a parent can expand inline.
  // When "Archive done tasks" is on, done children are hidden from the active expand too.
  const childrenByParent = useMemo(() => {
    const m = {};
    for (const t of tasks) { if (t.parent_task_id && !(archiveDone && t.status === 'done')) (m[t.parent_task_id] = m[t.parent_task_id] || []).push(t); }
    return m;
  }, [tasks, archiveDone]);
  const parentById = useMemo(() => Object.fromEntries(tasks.filter(t => !t.parent_task_id).map(t => [t.id, t])), [tasks]);

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
  const onSort = useCallback((key) => {
    if (sortKey === key) { if (sortDir === 'asc') setSortDir('desc'); else { setSortKey(null); setSortDir('asc'); } }
    else { setSortKey(key); setSortDir('asc'); }
  }, [sortKey, sortDir]);

  const topLevel = useMemo(() => tasks.filter(t => !t.parent_task_id && matchesQuery(t)), [tasks, matchesQuery]);
  // "Archive done tasks" (per-person toggle): when ON, done top-level tasks leave the
  // active board into the collapsed Archived section; when OFF they stay on the board.
  const activeTop = useMemo(() => archiveDone ? topLevel.filter(t => t.status !== 'done') : topLevel, [topLevel, archiveDone]);
  const archivedRows = useMemo(() => archiveDone ? topLevel.filter(t => t.status === 'done').sort(sortFn) : [], [topLevel, archiveDone, sortFn]);
  const needsSetup = (t) => t.status !== 'abandoned' && (!t.deadline || !t.owner_employee_id);
  const gridRows = useMemo(() => activeTop.filter(needsSetup).sort(sortFn), [activeTop, sortFn]);
  // F3: snapshot the editable Grid tasks in display order; the rest are skipped with a note.
  // The list reloads only when triage closes (and only if it wrote), so rows don't jump.
  live.current.gridRows = gridRows;   // read by openTriage (stable callback)
  const tasksById = useMemo(() => Object.fromEntries(tasks.map(t => [t.id, t])), [tasks]);
  const openTriage = useCallback(() => {
    const rows = live.current.gridRows || [];
    const queue = rows.filter(t => t._can_edit && t.status !== 'abandoned').map(t => t.id);
    if (queue.length) setTriage({ queue, skipped: rows.length - queue.length });
  }, []);
  const boardRows = useMemo(() => activeTop.filter(t => !needsSetup(t)).sort(sortFn), [activeTop, sortFn]);
  // Subtasks "As separate tasks": sub-tasks become rows of their own (with a parent chip).
  const separate = subtaskMode === 'separate' && !mineMode;
  const childRows = useMemo(() => (separate
    ? tasks.filter(t => t.parent_task_id && matchesQuery(t) && !(archiveDone && t.status === 'done')).sort(sortFn) : []),
  [separate, tasks, matchesQuery, archiveDone, sortFn]);

  // My-tasks mode (P7 home): flat list (incl. sub-tasks) from list_my_tasks — ONE array,
  // each row tagged `_relation` owner | collaborator | creator by the worker (owner wins,
  // then collaborator). Regrouped here, each task in exactly one group, by precedence:
  // "Today & overdue" (owned, open, effective deadline ≤ end of today IST — overdue first)
  // → "Assigned to me" (the rest I own) → "Collaborating" → "Raised by me".
  const mineMatched = useMemo(() => (mineMode ? tasks.filter(matchesQuery) : []), [mineMode, tasks, matchesQuery]);
  // Keyed on the IST date string, re-read on focus / tab-visible: a tab left open past
  // midnight IST regroups (yesterday's "today" tasks move to overdue-or-later correctly).
  const [istDay, setIstDay] = useState(istDateStr);
  useEffect(() => {
    const sync = () => setIstDay(istDateStr());
    const onVis = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => { setIstDay(istDateStr()); }, [tasks]);   // a reload also re-reads the day
  const endOfTodayIST = useMemo(() => Date.parse(`${istDay}T23:59:59.999+05:30`), [istDay]);
  const isDueByToday = useCallback((t) => {
    if (t.status === 'done' || t.status === 'abandoned') return false;
    const eff = effectiveDeadline(t);
    return !!eff && Date.parse(eff) <= endOfTodayIST;
  }, [endOfTodayIST]);
  // Overdue first: by effective deadline unless the person picked a sort.
  const byDeadline = useCallback((a, b) => Date.parse(effectiveDeadline(a)) - Date.parse(effectiveDeadline(b)), []);
  const mineToday = useMemo(() => mineMatched.filter(t => t._relation === 'owner' && isDueByToday(t)).sort(sortKey ? sortFn : byDeadline), [mineMatched, isDueByToday, sortKey, sortFn, byDeadline]);
  const mineOwner = useMemo(() => mineMatched.filter(t => t._relation === 'owner' && !isDueByToday(t)).sort(sortFn), [mineMatched, isDueByToday, sortFn]);
  // Match 'collaborator' EXACTLY, not !== 'owner' — the worker also returns 'creator'.
  const mineCollab = useMemo(() => mineMatched.filter(t => t._relation === 'collaborator').sort(sortFn), [mineMatched, sortFn]);
  const mineCreated = useMemo(() => mineMatched.filter(t => t._relation === 'creator').sort(sortFn), [mineMatched, sortFn]);

  // Board (Kanban) view: top-level, non-abandoned tasks (incl. ones still "needs setup").
  // Columns follow the group-by axis, defaulting to Status. Independent of Archive done.
  const boardMode = viewMode === 'board' && !mineMode;
  const kanbanAxis = groupBy === 'none' ? 'status' : groupBy;
  const kanbanRows = useMemo(() => topLevel.filter(t => t.status !== 'abandoned').sort(sortFn), [topLevel, sortFn]);

  /* ---------------- groups ---------------- */
  const listRows = useMemo(() => (separate ? [...boardRows, ...childRows].sort(sortFn) : boardRows), [separate, boardRows, childRows, sortFn]);
  const groups = useMemo(() => {
    // Through `live` so a memoised group never holds a stale create (program space picker).
    const cap = (field, value) => (title, extras) => live.current.createInGroup(title, field, value, extras);
    const knownPrograms = new Set(programs.map(p => p.id));
    if (mineMode) {
      return [
        { key: 'mine:today', label: 'Today & overdue', rows: mineToday, color: 'var(--overdue)' },
        { key: 'mine:owner', label: 'Assigned to me', rows: mineOwner, capture: cap(), capturePlaceholder: "Add task — it's assigned to you" },
        { key: 'mine:collab', label: 'Collaborating', rows: mineCollab },
        // Raised by me, owned by someone else. Only OPEN ones (the RPC excludes done/abandoned).
        { key: 'mine:creator', label: 'Raised by me', rows: mineCreated },
      // Empty groups hidden — except one with a foot capture (Assigned to me), so "add a task
      // assigned to you" survives an empty group. All empty → the page's empty state.
      ].filter(g => g.capture || g.rows.length);
    }
    const capPlaceholder = inProgramMode ? "Add task — it's tagged to this program" : 'Add task';
    if (groupBy === 'none') return [{ key: 'none', label: null, rows: listRows, capture: cap(), capturePlaceholder: capPlaceholder }];
    const field = GROUP_FIELD[groupBy];
    const m = new Map();
    for (const t of listRows) {
      let value, label, color;
      if (groupBy === 'status') { value = t.status; label = STATUS_MAP[t.status]?.label || t.status; color = STATUS_MAP[t.status]?.color; }
      else if (groupBy === 'person') { value = t.owner_employee_id || ''; label = t.owner_name || 'Unassigned'; color = value ? personColor(label) : null; }
      else if (groupBy === 'department') { value = t.department_id || ''; label = t.department_name || 'No team'; color = value ? personColor(label) : null; }
      else {
        value = t.program?.id || t.program_id || '';
        label = value ? (t.program?.name || (knownPrograms.has(value) ? programs.find(p => p.id === value)?.name : null) || 'Unknown program') : 'No program';
        color = value ? (t.program?.color || personColor(value)) : null;
      }
      if (!m.has(value)) m.set(value, { key: `${groupBy}:${value || '∅'}`, value, label, color, rows: [], tone: groupBy === 'status' ? 'status' : null });
      m.get(value).rows.push(t);
    }
    const out = [...m.values()];
    if (groupBy === 'status') out.sort((a, b) => (statusRank[a.value] ?? 99) - (statusRank[b.value] ?? 99));
    else out.sort((a, b) => (a.value ? 0 : 1) - (b.value ? 0 : 1) || a.label.localeCompare(b.label));
    for (const g of out) {
      // Abandoning needs a reason — no one-line capture into the Abandoned group.
      // A program that no longer resolves (deleted / not visible) is never prefilled.
      const dead = groupBy === 'program' && g.value && !knownPrograms.has(g.value);
      if (!(groupBy === 'status' && g.value === 'abandoned')) { g.capture = dead ? cap() : cap(field, g.value); g.capturePlaceholder = capPlaceholder; }
    }
    // Grouped but nothing on the board yet: still offer one capture.
    if (!out.length) out.push({ key: 'none', label: null, rows: [], capture: cap(), capturePlaceholder: capPlaceholder });
    return out;
  }, [mineMode, mineToday, mineOwner, mineCollab, mineCreated, groupBy, listRows, statusRank, inProgramMode, programs]);

  const visibleCols = useMemo(() => visibleColumns(cols, { crossSpace }), [cols, crossSpace]);
  const columnKeys = useMemo(() => Object.keys(COLUMNS).filter(k => !COLUMNS[k].crossSpaceOnly || crossSpace)
    .sort((a, b) => cols.order.indexOf(a) - cols.order.indexOf(b)), [cols.order, crossSpace]);

  /* ---------------- selection + bulk ---------------- */
  // Works in Grid + list + my-tasks; only editable, non-abandoned tasks are selectable.
  const selectableIds = useMemo(() => {
    const pool = mineMode ? [...mineToday, ...mineOwner, ...mineCollab, ...mineCreated] : [...gridRows, ...listRows];
    return pool.filter(t => t._can_edit && t.status !== 'abandoned').map(t => t.id);
  }, [mineMode, mineToday, mineOwner, mineCollab, mineCreated, gridRows, listRows]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
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
  // The three S153 actions that are NOT plain field writes, so they each have their own
  // worker handler rather than riding bulkUpdateTasks. One shared reporter: every handler
  // returns {updated, skipped} and skips rather than failing the batch, so "skipped N" is
  // normal output (usually rows the caller can't edit), not an error.
  async function runBulk(action, payload, verb) {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const res = await docketopsPost(action, { ids, ...payload }, session);
      const updated = res?.updated ?? 0, skipped = res?.skipped ?? 0;
      showToast(`${verb} ${updated}${skipped ? ` · skipped ${skipped}` : ''}`, updated ? 'success' : 'info');
      clearSelection();
      await load();
    } catch (e) { showToast(e.message || `${verb} failed`, 'error'); }
  }
  const applyBulkCollaborator = (employee_id, mode) =>
    runBulk('bulkSetCollaborator', { employee_id, mode }, mode === 'remove' ? 'Removed from' : 'Added to');
  const applyBulkMove = (space_id) => runBulk('bulkMoveTasks', { space_id }, 'Moved');
  async function applyBulkAbandon(reason) {
    // Terminal and mass — confirm with the count, and the worker requires the reason too.
    if (!window.confirm(`Abandon ${selected.size} task${selected.size === 1 ? '' : 's'}? This is terminal.`)) return;
    await runBulk('bulkAbandonTasks', { reason }, 'Abandoned');
  }

  // Publish the visible count to the topbar; clear it when leaving the board.
  const headerCount = mineMode ? (mineToday.length + mineOwner.length + mineCollab.length + mineCreated.length) : activeTop.length;
  useEffect(() => { setCount?.(headerCount); return () => setCount?.(null); }, [headerCount, setCount]);

  /* ---------------- keyboard: f/g popovers + arrow-into-first-row ---------------- */
  useEffect(() => {
    function focusRow(dir) {
      const rows = [...document.querySelectorAll(ROW_SELECTOR)];
      if (!rows.length) return;
      (dir > 0 ? rows[0] : rows[rows.length - 1]).focus();
    }
    function onKey(e) {
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (drawerId || shellModalOpen || triage) return;
      // A ui Menu/Popover owns its own arrows + j/k (P1 top-bar + New, P2/P3 menus).
      if (e.defaultPrevented || ae?.closest?.('.ui-pop')) return;
      if (e.key === 'f') { e.preventDefault(); setFilterOpen(o => !o); }
      else if (e.key === 'g') { e.preventDefault(); setGroupMenu(m => !m); }
      else if ((e.key === 'ArrowDown' || e.key === 'j') && !ae?.classList?.contains('tl-row')) { e.preventDefault(); focusRow(1); }
      else if ((e.key === 'ArrowUp' || e.key === 'k') && !ae?.classList?.contains('tl-row')) { e.preventDefault(); focusRow(-1); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerId, shellModalOpen, triage]);

  // Kanban (unchanged) + The Grid cards + Archived rows still take a plain ctx.
  const gridCtx = {
    saveField: actions.saveField, openDrawer: actions.openDrawer, showSpace: crossSpace, ownerCellOpts,
    selectMode, selected, toggleSelect, enterSelect: actions.enterSelect,
  };
  // Board (P4): a column's "+ Add task" creates through the same createInGroup as a list
  // group foot — the column's axis value prefilled (status via the follow-up changeStatus),
  // never a program id that no longer resolves.
  const boardCtx = {
    ...gridCtx, showIds, cardSize, activeId: drawerId, drawerOpen: drawerId != null, shellModalOpen, sortKey,
    createIn: (title, value, extras) => {
      const dead = kanbanAxis === 'program' && value && !programs.some(p => p.id === value);
      return live.current.createInGroup(title, GROUP_FIELD[kanbanAxis], dead ? undefined : value, extras);
    },
  };

  // Toolbar: Subtasks menu (list view, when a visible row has sub-tasks).
  const parentIds = useMemo(() => boardRows.filter(t => (t.child_count || 0) > 0 || (childrenByParent[t.id] || []).length > 0).map(t => t.id), [boardRows, childrenByParent]);
  const expandAll = () => setExpanded(Object.fromEntries(parentIds.map(id => [id, true])));
  const collapseAll = () => setExpanded({});
  // + Task → New sub-task targets the last focused top-level row, if still visible + editable.
  // Only a row that is on screen right now (not board mode, not in a collapsed group).
  const getSubtaskTarget = () => {
    if (boardMode || mineMode || !focusedRowRef.current) return null;
    const t = boardRows.find(x => x.id === focusedRowRef.current);
    if (!t || !t._can_edit || t.status === 'abandoned') return null;
    if (!document.querySelector(`.tl-row[data-task-id="${t.id}"]`)) return null;
    return t;
  };
  function requestSubtask(id) {
    if (getSubtaskTarget()?.id !== id) return;
    setSubRequest(id);
    // The row consumes it on its next effect; never leave a stale request to fire later.
    setTimeout(() => setSubRequest(r => (r === id ? null : r)), 250);
  }
  // A focused row from another view is not a target.
  useEffect(() => { focusedRowRef.current = null; }, [viewMode, spaceId, viewProgramId, mineMode, subtaskMode]);
  // `g` in My tasks has no group control to show — don't leave the menu armed.
  useEffect(() => { setGroupMenu(false); }, [mineMode]);
  // + Task / + New → the un-prefilled top "New task" capture (focusing it reveals it).
  const focusCapture = () => {
    const el = document.querySelector('[data-create-primary]');
    try { el?.focus(); el?.select?.(); } catch { /* ignore */ }
  };
  // Closing TaskView also drops a `?task=` deep link, so a reload doesn't reopen it.
  function closeTask() {
    setDrawerId(null);
    if (taskParam) {
      const p = new URLSearchParams(search.toString()); p.delete('task');
      router.replace('/tasks' + (p.toString() ? '?' + p.toString() : ''));
    }
  }
  function copyLink() {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const done = () => showToast('Link copied', 'success');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(() => showToast('Could not copy the link', 'error'));
    else showToast('Could not copy the link', 'error');
  }

  // Program mode: the group-foot captures share one "which space" picker.
  const programSpacePicker = inProgramMode ? (
    <select className="tk-capture-space" value={programSpace || programDefaultSpace} onChange={e => setProgramSpace(e.target.value)}
      title="Space this task lives in" aria-label="Space for new tasks">
      {spaces.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  ) : null;
  if (programSpacePicker) for (const g of groups) if (g.capture) g.captureExtra = programSpacePicker;

  const isEmpty = mineMode ? (mineToday.length + mineOwner.length + mineCollab.length + mineCreated.length) === 0 : topLevel.length === 0;
  const anyQuery = !!(q || f.activeFilterCount);

  return (
    <CaptureProvider value={captureCtx}>
    <div data-density={density}>
      {/* Views bar + toolbar (P2/P3). The location (Space / Program) is the top-bar breadcrumb. */}
      <ViewsBar viewMode={viewMode} onView={chooseView} allowBoard={!mineMode} onCopyLink={copyLink}
        space={currentSpace} onSpaceDashboard={() => currentSpace && router.push('/dashboard?space=' + currentSpace.id)}
        onSpaceSettings={() => setSpaceSettingsOpen(true)} />
      <TasksToolbar
        showGroup={!mineMode} groupBy={groupBy} setGroupBy={setGroupBy} groupOpts={GROUP_OPTS} groupMenu={groupMenu} setGroupMenu={setGroupMenu}
        showSubtasks={!mineMode && !boardMode && parentIds.length > 0} subMenu={subMenu} setSubMenu={setSubMenu}
        onExpandAll={expandAll} onCollapseAll={collapseAll} subtaskMode={subtaskMode} chooseSubtaskMode={chooseSubtaskMode}
        filterOpen={filterOpen} setFilterOpen={setFilterOpen} filterCount={f.panelFilterCount}
        filter={{ status, setStatus: f.setStatus, departmentId, setDepartmentId: f.setDepartmentId, employeeId, setEmployeeId: f.setEmployeeId,
          priority, setPriority: f.setPriority, programId, setProgramId: f.setProgramId, overdue, setOverdue: f.setOverdue, revised, setRevised: f.setRevised,
          teamOpts, empOpts, programOpts, filterCount: f.panelFilterCount, clearFilters: f.clearPanelFilters, hideProgramFilter: inProgramMode, hideOwnerFilter: mineMode }}
        showMe={!mineMode} mine={mine} setMine={f.setMine}
        showArchive={!mineMode && !boardMode} archiveDone={archiveDone} toggleArchiveDone={toggleArchiveDone}
        showSelect={!boardMode} selectMode={selectMode} toggleSelectMode={() => setSelectMode(m => { if (m) clearSelection(); return !m; })}
        selectableCount={selectableIds.length} allSelected={allSelected} toggleSelectAll={toggleSelectAll} selectedCount={selected.size}
        q={q} setQ={f.setQ} searchRef={searchRef}
        showColumns={!boardMode} colsOpen={colsOpen} setColsOpen={setColsOpen} cols={cols} columnKeys={columnKeys}
        toggleColumn={toggleColumn} resetColumns={resetColumns}
        showCustomize boardMode={boardMode} cardSize={cardSize} chooseCardSize={chooseCardSize} density={density} chooseDensity={chooseDensity} custOpen={custOpen} setCustOpen={setCustOpen}
        showIds={showIds} toggleShowIds={toggleShowIds}
        onNewTask={focusCapture} newTaskMenuOpen={newTaskMenuOpen} setNewTaskMenuOpen={setNewTaskMenuOpen}
        getSubtaskTarget={getSubtaskTarget} onNewSubtask={requestSubtask}
        onNewSpace={() => router.push('/tasks?space=new')} />

      {/* The one un-prefilled capture ([data-create-primary]): hidden until + Task / + New / `c`
          reveal it, always open on an empty page. Same create body as the P2 quick capture. */}
      <NewTaskCapture create={(t, x) => live.current.createInGroup(t, undefined, undefined, x)} alwaysOpen={isEmpty && !boardMode && !(loading && tasks.length === 0)}
        placeholder={inProgramMode ? "New task — it's tagged to this program" : 'New task'}>{programSpacePicker}</NewTaskCapture>

      {loading && tasks.length === 0 ? <Spinner /> : boardMode ? (
        <div style={{ opacity: loading ? 0.5 : 1, pointerEvents: loading ? 'none' : 'auto', transition: 'opacity var(--base) var(--ease)' }}>
          <KanbanBoard rows={kanbanRows} axis={kanbanAxis} ctx={boardCtx} />
        </div>
      ) : isEmpty ? (
        <div className="tl-emptywrap">
          <EmptyState icon={ListChecks}
            title={anyQuery ? 'No tasks match' : (mineMode ? 'Nothing assigned to you' : 'All clear')}
            body={anyQuery ? 'Try a different search or widen the filters.' : (mineMode ? 'Tasks you own, collaborate on, or raised for someone else — across every space — show up here.' : 'Add a task above to get started.')}
            action={f.activeFilterCount > 0 ? <Button variant="neutral" size="sm" onClick={f.clearFilters}>Clear filters</Button> : null} />
        </div>
      ) : (
        <TaskListView
          gridRows={mineMode ? [] : gridRows} onTriage={mineMode ? undefined : openTriage} groups={groups} archivedRows={mineMode ? [] : archivedRows}
          childrenByParent={childrenByParent} expanded={expanded} sortFn={sortFn} selected={selected} selectMode={selectMode}
          showIds={showIds} separate={separate} flat={mineMode} parentById={parentById}
          visibleCols={visibleCols} cols={cols} moveColumn={moveColumn} resizeColumn={resizeColumn}
          sortKey={sortKey} sortDir={sortDir} onSort={onSort}
          collapsed={collapsed} toggleGroupCollapsed={toggleGroupCollapsed} setGroupsCollapsed={setGroupsCollapsed}
          actions={actions} opts={opts} subRequest={subRequest} gridCtx={gridCtx} loading={loading} />
      )}

      {!boardMode && selectMode && selected.size > 0 && (
        <BulkBar count={selected.size} onClear={clearSelection} onApply={applyBulk}
          ownerOpts={ownerCellOpts} prioOpts={prioOpts} programOpts={programCellOpts}
          empOpts={empOpts}
          spaceOpts={spaces.filter(s => !s.archived_at).map(s => ({ value: s.id, label: s.name }))}
          onCollaborator={applyBulkCollaborator} onMove={applyBulkMove} onAbandon={applyBulkAbandon} />
      )}

      {triage && (
        // Hidden (not unmounted) while "Open task" shows the full TaskView, then back to the card.
        <GridTriage queue={triage.queue} skippedCount={triage.skipped} tasksById={tasksById}
          ownerOpts={ownerCellOpts} empMap={empMap} session={session} showToast={showToast}
          suspended={drawerId != null} onOpenTask={setDrawerId}
          onClose={({ wrote }) => { setTriage(null); if (wrote) load(); }} />
      )}
      {drawerId && (
        // Opened from triage: pinned to the modal so the "full page" preference can't navigate
        // away and drop the triage session underneath.
        <TaskView id={drawerId} mode={triage ? 'modal' : undefined} session={session} departments={departments} employees={employees}
          onClose={closeTask} onOpen={setDrawerId} getOrder={domTaskOrder} onMutated={load}
          fromLink={drawerId === linkTaskId} refreshKey={tasks} />
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
    </CaptureProvider>
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
