'use client';
// /tasks view state (ClickUp redesign P3): view / group / filters / density /
// columns / collapsed groups / sub-task mode, plus the per-person localStorage
// behind the sticky ones. tasks/page.js orchestrates; this only holds state.
//
// localStorage keys: docket.viewMode · docket.density · docket.archiveDone (all
// pre-P3, unchanged) · docket.list.columns · docket.list.collapsed ·
// docket.list.showIds · docket.list.subtasks (P3).
import { useCallback, useEffect, useState } from 'react';

// Optional list columns, in default order. Title (first) and Status are always shown;
// Status is still reorderable. `space` only exists on cross-space views.
export const COLUMNS = {
  status:   { label: 'Status',        width: 124, min: 96,  fixed: true, sort: 'status' },
  team:     { label: 'Team',          width: 130, min: 72 },
  program:  { label: 'Program',       width: 130, min: 72 },
  space:    { label: 'Space',         width: 130, min: 72, crossSpaceOnly: true },
  owner:    { label: 'Owner',         width: 72,  min: 56,  sort: 'owner_name' },
  collabs:  { label: 'Collaborators', width: 104, min: 64 },
  priority: { label: 'Priority',      width: 84,  min: 64,  sort: 'priority' },
  deadline: { label: 'Deadline',      width: 128, min: 88,  sort: 'deadline' },
  meta:     { label: 'Activity',      width: 64,  min: 48 },
};
const DEFAULT_ORDER = ['status', 'team', 'program', 'space', 'owner', 'collabs', 'priority', 'deadline', 'meta'];
const DEFAULT_COLS = { order: DEFAULT_ORDER, hidden: {}, widths: {} };
const MAX_W = 400;

function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } }

// Old density values: 'compact' | 'roomy' (P2 added 'default'). All three still valid.
const DENSITIES = ['compact', 'default', 'roomy'];

export function useTaskViewState({ lensParam }) {
  // ---- structured filters (server-side) ----
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [priority, setPriority] = useState('');
  const [programId, setProgramId] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [revised, setRevised] = useState(false);
  const [mine, setMine] = useState(lensParam === 'mine');
  // `lens=mine` (sidebar "My tasks") drives the mine filter; absent → off.
  useEffect(() => { setMine(lensParam === 'mine'); }, [lensParam]);
  const [q, setQ] = useState('');

  const activeFilterCount = [status, departmentId, employeeId, priority, programId].filter(Boolean).length
    + [overdue, revised, mine].filter(Boolean).length;
  const clearFilters = useCallback(() => {
    setStatus(''); setDepartmentId(''); setEmployeeId(''); setPriority(''); setProgramId('');
    setOverdue(false); setRevised(false); setMine(false);
  }, []);
  // The Filter popover's own count + clear: Me mode is its own toolbar toggle (P2).
  const panelFilterCount = activeFilterCount - (mine ? 1 : 0);
  const clearPanelFilters = useCallback(() => {
    setStatus(''); setDepartmentId(''); setEmployeeId(''); setPriority(''); setProgramId('');
    setOverdue(false); setRevised(false);
  }, []);

  // ---- view prefs (sticky per person, per device) ----
  const [groupBy, setGroupBy] = useState('none');
  const [density, setDensity] = useState('default');
  const [archiveDone, setArchiveDone] = useState(false);
  const [viewMode, setViewMode] = useState('list');
  const [showIds, setShowIds] = useState(true);
  const [subtaskMode, setSubtaskMode] = useState('nested'); // 'nested' | 'separate'
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [collapsed, setCollapsed] = useState({});
  useEffect(() => {
    try {
      const d = localStorage.getItem('docket.density'); if (DENSITIES.includes(d)) setDensity(d);
      const a = localStorage.getItem('docket.archiveDone'); if (a != null) setArchiveDone(a === '1');
      const v = localStorage.getItem('docket.viewMode'); if (v === 'list' || v === 'board') setViewMode(v);
    } catch { /* ignore */ }
    const c = read('docket.list.columns', null);
    if (c && Array.isArray(c.order)) {
      // Keep known keys once each, then append any column added since the user saved.
      const order = [...new Set(c.order.filter(k => COLUMNS[k]))];
      for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);
      const widths = {};
      for (const [k, w] of Object.entries(c.widths || {})) {
        if (COLUMNS[k] && Number.isFinite(w)) widths[k] = Math.round(Math.max(COLUMNS[k].min || 48, Math.min(MAX_W, w)));
      }
      const hidden = {};
      for (const [k, v] of Object.entries(c.hidden || {})) if (COLUMNS[k] && !COLUMNS[k].fixed && v === true) hidden[k] = true;
      setCols({ order, hidden, widths });
    }
    setCollapsed(read('docket.list.collapsed', {}) || {});
    setShowIds(read('docket.list.showIds', true) !== false);
    setSubtaskMode(read('docket.list.subtasks', 'nested') === 'separate' ? 'separate' : 'nested');
  }, []);

  const chooseDensity = useCallback((d) => { setDensity(d); try { localStorage.setItem('docket.density', d); } catch { /* ignore */ } }, []);
  const toggleArchiveDone = useCallback(() => setArchiveDone(v => { const n = !v; try { localStorage.setItem('docket.archiveDone', n ? '1' : '0'); } catch { /* ignore */ } return n; }), []);
  const chooseView = useCallback((v) => { setViewMode(v); try { localStorage.setItem('docket.viewMode', v); } catch { /* ignore */ } }, []);
  const toggleShowIds = useCallback(() => setShowIds(v => { write('docket.list.showIds', !v); return !v; }), []);
  const chooseSubtaskMode = useCallback((m) => { setSubtaskMode(m); write('docket.list.subtasks', m); }, []);

  const updateCols = useCallback((fn) => setCols(prev => { const next = fn(prev); write('docket.list.columns', next); return next; }), []);
  const toggleColumn = useCallback((k) => {
    if (!COLUMNS[k] || COLUMNS[k].fixed) return;
    updateCols(c => ({ ...c, hidden: { ...c.hidden, [k]: !c.hidden[k] } }));
  }, [updateCols]);
  const moveColumn = useCallback((from, to) => {
    if (from === to) return;
    updateCols(c => {
      const order = c.order.filter(k => k !== from);
      const i = order.indexOf(to);
      order.splice(i < 0 ? order.length : i, 0, from);
      return { ...c, order };
    });
  }, [updateCols]);
  const resizeColumn = useCallback((k, w) => {
    const min = COLUMNS[k]?.min || 48;
    updateCols(c => ({ ...c, widths: { ...c.widths, [k]: Math.round(Math.max(min, Math.min(MAX_W, w))) } }));
  }, [updateCols]);
  const resetColumns = useCallback(() => updateCols(() => DEFAULT_COLS), [updateCols]);

  const toggleGroupCollapsed = useCallback((key, force) => setCollapsed(prev => {
    const next = { ...prev, [key]: force == null ? !prev[key] : force };
    if (!next[key]) delete next[key];
    write('docket.list.collapsed', next);
    return next;
  }), []);
  const setGroupsCollapsed = useCallback((keys, value) => setCollapsed(prev => {
    const next = { ...prev };
    for (const k of keys) { if (value) next[k] = true; else delete next[k]; }
    write('docket.list.collapsed', next);
    return next;
  }), []);

  return {
    filters: { status, setStatus, departmentId, setDepartmentId, employeeId, setEmployeeId, priority, setPriority,
      programId, setProgramId, overdue, setOverdue, revised, setRevised, mine, setMine, q, setQ,
      activeFilterCount, clearFilters, panelFilterCount, clearPanelFilters },
    groupBy, setGroupBy, density, chooseDensity, archiveDone, toggleArchiveDone, viewMode, chooseView,
    showIds, toggleShowIds, subtaskMode, chooseSubtaskMode,
    cols, toggleColumn, moveColumn, resizeColumn, resetColumns,
    collapsed, toggleGroupCollapsed, setGroupsCollapsed,
  };
}

// The visible column keys + the grid template for one list. Memoise on the inputs.
export function visibleColumns(cols, { crossSpace }) {
  return cols.order.filter(k => COLUMNS[k] && (COLUMNS[k].fixed || !cols.hidden[k]) && (!COLUMNS[k].crossSpaceOnly || crossSpace));
}
export function gridTemplate(keys, cols) {
  return ['minmax(240px, 1fr)', ...keys.map(k => `${cols.widths[k] || COLUMNS[k].width}px`)].join(' ');
}
// The list's minimum width: the title's 240px floor + every fixed column. The list is
// otherwise 100% wide, so the 1fr title column fills the leftover space and never grows
// to its longest title (a max-content list did that and pushed Owner/Deadline off-screen).
export function gridMinWidth(keys, cols) {
  return 240 + keys.reduce((n, k) => n + (cols.widths[k] || COLUMNS[k].width), 0);
}
