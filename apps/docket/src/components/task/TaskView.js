'use client';
// TaskView — the ONE way a task opens (ClickUp redesign P5, decision D3). Replaces the
// TaskDrawer slide-over and the separate /tasks/detail layout.
//
//   mode 'modal' (default) — centred dialog over the list, focus trapped, restored on close
//   mode 'side'            — right panel; the list behind stays scrollable + clickable
//   mode 'full'            — /tasks/detail/?id=… renders it inside the shell
// The overlay modes follow the per-person preference (taskViewMode.js); /tasks/detail
// passes mode="full". Choosing "Full page" from an overlay navigates there; leaving full
// page goes back to the list with the task reopened (?task=).
//
// Data + writes are the old drawer's, call for call: getTask; updateTask {id, field} per
// field (title, description, owner, team, priority, program, first deadline);
// changeStatus; reviseDeadline {id, new_deadline, reason} (reason required);
// abandonTask {id, reason} (reason required); add/removeCollaborator; createProgram +
// updateTask; moveTask; the shared Subtask / DocLinks / History panels. Editing is gated
// by _can_edit and not-abandoned; Reactivate by _can_edit alone (as before).
//
// Keys (focus not in a field, no picker open): Shift+S/A/D/P open status / owner /
// deadline / priority · s add sub-task · Ctrl+Shift+←/→ previous / next · Esc closes
// (a field blurs first; an open picker closes itself first — ui Popover takes Esc in
// the capture phase and stops it).
import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner, useToast } from '@throttle/ui';
import { X, ChevronLeft, ChevronRight, ChevronDown, Link2, MoreHorizontal, PanelRight, Maximize2, SquareStack, ArrowUp, Plus, Check, Ban, RotateCcw, Hash, OctagonMinus } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { useChrome } from '../../lib/chrome.js';
import { personColor } from '../primitives.js';
import { IconButton, Menu, MenuItem, MenuSeparator, MenuLabel, Tooltip } from '../ui/index.js';
import { SubtaskPanel } from '../SubtaskPanel.js';
import { DocLinksPanel } from '../DocLinksPanel.js';
import { PRIORITIES } from '../../lib/tasks.js';
import { recurrenceSummary } from '../../lib/recurrence.js';
import { TaskProps } from './TaskProps.js';
import { TaskActivity } from './TaskActivity.js';
import { DepsStrip, DepAddFlow } from './Dependencies.js';
import { linkCount, sendDone, doneConfirmText, DECLINED } from '../../lib/deps.js';
import { useCommandSource } from '../../lib/commandSources.js';
import { readMode, writeMode, goFull, leaveFull, readReturn, readOrder, claimFull } from './taskViewMode.js';
import { usePlanItems } from '../plan/PlanPicker.js';
import { planErrorText } from '../../lib/plan.js';
import { handoffErrorText } from '../../lib/handoff.js';

const MODE_META = {
  modal: { label: 'Modal', icon: SquareStack },
  side: { label: 'Side panel', icon: PanelRight },
  full: { label: 'Full page', icon: Maximize2 },
};
const SECTIONS_KEY = 'docket.taskView.sections';
const FIELD_KEYS = { S: 'status', A: 'owner', D: 'deadline', P: 'priority' };

function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 767px)');
    const on = () => setM(q.matches);
    on(); q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return m;
}

function grow(el) { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }

export function TaskView({ id, mode: fixedMode, session, departments = [], employees = [], onClose, onOpen, getOrder, onMutated, refreshKey, fromLink = false }) {
  const router = useRouter();
  const { showToast } = useToast();
  const { shellModalOpen } = useChrome();
  const isMobile = useIsMobile();
  const [pref, setPref] = useState(() => (typeof window === 'undefined' ? 'modal' : readMode()));
  // A deep link (?task=) always opens as an overlay — a remembered "full page" must not
  // bounce it to /tasks/detail again (Back would loop).
  const mode = fixedMode || (pref === 'full' && fromLink ? 'modal' : pref);
  const autoFull = !fixedMode && pref === 'full' && !fromLink;
  const overlay = mode !== 'full';

  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [programs, setPrograms] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [edit, setEdit] = useState(null);             // which property picker is open
  const [abandonMode, setAbandonMode] = useState(false);
  const [tab, setTab] = useState('comments');         // right pane
  const [mTab, setMTab] = useState('details');        // mobile: details | activity
  const [modeMenu, setModeMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [depAnchor, setDepAnchor] = useState(null);   // F7 add flow: the ref it opens against, or null
  const [sections, setSections] = useState({});       // collapsed sections
  const [nav, setNav] = useState({ prev: null, next: null });
  const refs = useMemo(() => ({ status: createRef(), owner: createRef(), collab: createRef(), deadline: createRef(), priority: createRef(), team: createRef(), program: createRef(), plan: createRef(), handoff: createRef(), handoffPerson: createRef(), space: createRef() }), []);
  const planItems = usePlanItems(session);   // F9 R2: the Plan picker's items (getPlan, shared)
  const rootRef = useRef(null);
  const titleRef = useRef(null);
  const descRef = useRef(null);
  const composerRef = useRef(null);
  const modeRef = useRef(null);
  const moreRef = useRef(null);
  const depAddRef = useRef(null);
  const depDescRef = useRef(null);

  // A stored "full page" preference: an overlay open goes straight to the full page.
  const order = useCallback(() => (fixedMode === 'full' ? readOrder() : (getOrder?.() || [])), [fixedMode, getOrder]);
  useEffect(() => { if (autoFull && id) goFull(router, id, order()); }, [autoFull, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Full page reached any other way than goFull (permalink, reload): no stale return / order.
  useEffect(() => { if (fixedMode === 'full') claimFull(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return;
    docketopsGet('getPrograms', {}, session).then(p => setPrograms(p || [])).catch(() => {});
    docketopsGet('getSpaces', {}, session).then(s => setSpaces(s || [])).catch(() => {});
  }, [session]);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}'); if (s && typeof s === 'object') setSections(s); } catch { /* ignore */ } }, []);

  // Loads are keyed on the task id + the signed-in user, NOT the session object (a token
  // refresh re-creates it); the session is read through a ref. A response for a task
  // that is no longer the open one (‹ ›, autorepeat, out-of-order) is dropped. Drafts
  // are only replaced when their field is neither focused nor dirty (edited since the
  // last server value), so a background reload never eats half-typed input.
  const idRef = useRef(id); idRef.current = id;
  const sessionRef = useRef(session); sessionRef.current = session;
  const userKey = session?.user?.id || (session ? 'session' : '');
  const server = useRef({ id: null, title: '', description: '' });
  const lastLoad = useRef(0);
  const load = useCallback(async (silent) => {
    const s = sessionRef.current;
    const reqId = id;
    if (!s || !reqId) return;
    lastLoad.current = Date.now();
    try {
      const t = await docketopsGet('getTask', { id: reqId }, s);
      if (reqId !== idRef.current) return;
      const same = server.current.id === t.id;
      const prev = server.current;
      setTask(t);
      setTitleDraft(d => (same && (document.activeElement === titleRef.current || d !== (prev.title || ''))) ? d : (t.title || ''));
      setDescDraft(d => (same && (document.activeElement === descRef.current || d !== (prev.description || ''))) ? d : (t.description || ''));
      server.current = { id: t.id, title: t.title || '', description: t.description || '' };
    } catch (e) {
      if (reqId !== idRef.current) return;
      showToast(e.message || 'Failed to load task', 'error'); if (!silent) setTask(null);
    } finally { if (!silent && reqId === idRef.current) setLoading(false); }
  }, [id, userKey, showToast]); // eslint-disable-line react-hooks/exhaustive-deps
  // A different task: drop the old one (nothing — Shift+S… — can edit it mid-load) and
  // its open picker. Only here, not on every reload.
  useEffect(() => { setTask(null); setLoading(true); setEdit(null); setAbandonMode(false); setDepAnchor(null); server.current = { id: null, title: '', description: '' }; }, [id]);
  useEffect(() => { load(); }, [load]);
  // Side mode: an edit made in the list behind (row edit, board drag) reloads the panel.
  // Skipped right after our own load (our writes refresh the page too).
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    if (mode === 'side' && Date.now() - lastLoad.current > 1500) load(true);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { grow(titleRef.current); grow(descRef.current); }, [task, titleDraft, descDraft, mTab]);

  // ‹ › neighbours in the list the task was opened from.
  useEffect(() => {
    const ids = order();
    const i = ids.indexOf(id);
    setNav(i < 0 ? { prev: null, next: null } : { prev: ids[i - 1] || null, next: ids[i + 1] || null });
  }, [id, task, order]);

  const canEdit = !!task?._can_edit && task?.status !== 'abandoned';
  const canAddSub = canEdit && task && !task.parent_task_id && !task.is_recurring;
  const mutated = useCallback(async () => { await load(true); onMutated?.(); }, [load, onMutated]);
  // F7: no dependencies UI on a recurring task; add / remove only while editable (not
  // abandoned, not archived — the worker refuses those too).
  const showDeps = !!task && !task.is_recurring;
  const canLink = showDeps && canEdit && !task.archived_at;

  /* ---------------- writes (the drawer's, call for call) ---------------- */
  async function saveField(field, value) {
    setBusy(true);
    try { await docketopsPost('updateTask', { id: task.id, [field]: value || null }, session); await mutated(); }
    catch (e) { showToast(handoffErrorText(e) || 'Save failed', 'error'); load(true); }   // a team change can hit handoff_same_team
    finally { setBusy(false); }
  }
  async function setStatus(status) {
    setBusy(true);
    try {
      // Done on a task still waiting on open blockers: the worker answers 409 waiting_on →
      // warn and offer "Mark done anyway" (F7 decision G3).
      const send = (force) => docketopsPost('changeStatus', { id: task.id, status, ...(force ? { force: true } : {}) }, session);
      if (status === 'done') {
        if (await sendDone(send, (m) => window.confirm(m), (d) => doneConfirmText(d, task.task_no)) === DECLINED) return;
      } else await send(false);
      if (status === 'done') showToast('Marked done', 'success'); await mutated();
    }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function commitDeadline(draft, reason) {
    if (!draft) return false;
    setBusy(true);
    try {
      if (!task.deadline) {
        await docketopsPost('updateTask', { id: task.id, deadline: draft }, session);
      } else {
        if (!reason.trim()) { showToast('A reason is required to revise', 'error'); return false; }
        await docketopsPost('reviseDeadline', { id: task.id, new_deadline: draft, reason: reason.trim() }, session);
      }
      await mutated(); return true;
    } catch (e) { showToast(e.message || 'Failed', 'error'); return false; }
    finally { setBusy(false); }
  }
  async function doAbandon(reason) {
    if (!reason.trim()) return false;
    setBusy(true);
    try { await docketopsPost('abandonTask', { id: task.id, reason: reason.trim() }, session); await mutated(); return true; }
    catch (e) { showToast(e.message || 'Failed', 'error'); return false; }
    finally { setBusy(false); }
  }
  async function addCollab(employeeId) {
    if (!employeeId) return;
    setBusy(true);
    try { await docketopsPost('addCollaborator', { id: task.id, employee_id: employeeId }, session); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  async function removeCollab(employeeId) {
    try { await docketopsPost('removeCollaborator', { id: task.id, employee_id: employeeId }, session); await mutated(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function createProgramInline(name) {
    setBusy(true);
    try {
      const prog = await docketopsPost('createProgram', { name }, session);
      setPrograms(ps => ps.some(p => p.id === prog.id) ? ps : [...ps, prog].sort((a, b) => a.name.localeCompare(b.name)));
      await docketopsPost('updateTask', { id: task.id, program_id: prog.id }, session); await mutated();
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('docket:programs-changed'));
    } catch (e) { showToast(e.message || 'Failed to add program', 'error'); }
    finally { setBusy(false); }
  }
  async function moveToSpace(v) {
    if (!v || v === task.space_id) return;
    setBusy(true);
    try { await docketopsPost('moveTask', { id: task.id, space_id: v }, session); await mutated(); showToast('Moved', 'success'); }
    catch (e) { showToast(planErrorText(e) || 'Failed', 'error'); }
    finally { setBusy(false); }
  }
  // F9 R8: the hand-off pair is one write (team + person together, so a person never outlives their team).
  async function saveHandoff(departmentId, employeeId) {
    setBusy(true);
    try {
      await docketopsPost('updateTask', { id: task.id, handoff_to_department_id: departmentId || null, handoff_to_employee_id: departmentId ? (employeeId || null) : null }, session);
      await mutated();
    } catch (e) { showToast(handoffErrorText(e), 'error'); load(true); }
    finally { setBusy(false); }
  }
  async function acceptHandoff() {
    setBusy(true);
    try { await docketopsPost('acceptHandoff', { id: task.id }, session); await mutated(); showToast('Hand-off accepted', 'success'); }
    catch (e) { showToast(handoffErrorText(e), 'error'); load(true); }
    finally { setBusy(false); }
  }
  const actions = { saveField, setStatus, commitDeadline, doAbandon, addCollab, removeCollab, createProgramInline, moveToSpace, saveHandoff, acceptHandoff };

  const opts = useMemo(() => ({
    teamOpts: [{ value: '', label: '— No team —' }, ...departments.map(d => ({ value: d.id, label: d.name, dot: personColor(d.id) }))],
    ownerOpts: [{ value: '', label: '— Unassigned —' }, ...employees.map(e => ({ value: e.id, label: e.full_name }))],
    prioOpts: PRIORITIES.map(p => ({ value: p.key, label: p.label })),
    programCellOpts: [{ value: '', label: '— No program —' }, ...programs.map(p => ({ value: p.id, label: p.name }))],
    spaceOpts: spaces.map(s => ({ value: s.id, label: s.name + (s.is_private ? '' : ' · open') })),
    collabOpts: task ? employees.filter(e => !(task.collaborators || []).some(c => c.employee_id === e.id) && e.id !== task.owner_employee_id).map(e => ({ value: e.id, label: e.full_name })) : [],
    planItems,
    departments, employees,   // F9 R8: the hand-off team / person pickers
  }), [departments, employees, programs, spaces, task, planItems]);
  const revisions = (task?.history || []).filter(h => h.event_type === 'deadline_revised').length;

  // ⌘K "Add dependency" for the open task (CommandBar reads source 'taskView'). Opens the add
  // flow against the ⋯ button — the one anchor every layout and mobile tab has.
  const startDep = useCallback((ref) => { setMoreMenu(false); setDepAnchor(ref || moreRef); }, []);
  const cmdTask = useMemo(() => (canLink ? { taskNo: task.task_no, addDependency: () => startDep(moreRef) } : null), [canLink, task?.task_no, startDep]); // eslint-disable-line react-hooks/exhaustive-deps
  useCommandSource('taskView', cmdTask);

  /* ---------------- navigation / layout ---------------- */
  // Leaving the task (close, ‹ ›, another task, a mode switch) can unmount a field before
  // its blur runs — blur it first so a dirty title / description saves.
  function leaveFields() {
    const ae = document.activeElement;
    if (ae && ae !== rootRef.current && rootRef.current?.contains(ae)) ae.blur?.();
  }
  const close = useCallback(() => {
    leaveFields();
    if (mode === 'full') router.push(readReturn());
    else onClose?.();
  }, [mode, router, onClose]);
  // `step`: ‹ › — on the full page they replace the history entry instead of piling up.
  const openOther = useCallback((otherId, step = false) => {
    if (!otherId) return;
    leaveFields();
    if (mode === 'full') { const url = `/tasks/detail/?id=${otherId}`; if (step) router.replace(url); else router.push(url); }
    else onOpen?.(otherId);
  }, [mode, router, onOpen]);
  // ‹ › read the order at the moment of the press (the list may have changed since).
  const stepBy = useCallback((dir) => {
    const ids = order();
    const i = ids.indexOf(idRef.current);
    if (i >= 0) openOther(ids[i + dir], true);
  }, [order, openOther]);
  function chooseMode(m) {
    setModeMenu(false);
    if (m === mode) return;
    leaveFields();
    writeMode(m);
    if (m === 'full') { goFull(router, id, order()); return; }
    if (mode === 'full') { leaveFull(router, id); return; }
    setPref(m);
  }
  function copyLink() {
    const url = `${window.location.origin}/tasks/detail/?id=${id}`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => showToast(`Link to ${task?.task_no || 'task'} copied`, 'success')).catch(() => showToast('Could not copy the link', 'error'));
    else showToast('Could not copy the link', 'error');
  }
  function copyId() {
    if (!task?.task_no) return;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(task.task_no).then(() => showToast(`${task.task_no} copied`, 'success')).catch(() => showToast('Could not copy', 'error'));
  }
  function toggleSection(k, force) {
    setSections(prev => {
      const next = { ...prev, [k]: force == null ? !prev[k] : force };
      if (!next[k]) delete next[k];
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }
  function openPicker(field) {
    if (isMobile) setMTab('details');
    setAbandonMode(false);
    setTimeout(() => { refs[field]?.current?.scrollIntoView({ block: 'nearest' }); setEdit(field); }, 0);
  }
  function startSubtask() {
    if (!canAddSub) return;
    if (isMobile) setMTab('details');
    toggleSection('subtasks', false);
    setTimeout(() => { const el = rootRef.current?.querySelector('[data-subtask-add]'); if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); } }, 0);
  }
  function startAbandon() { if (isMobile) setMTab('details'); setTimeout(() => { setAbandonMode(true); setEdit('status'); }, 0); }

  // Keyboard. Bubble phase on document: an open ui Popover has already taken its Esc
  // (capture + stopPropagation), so Esc here means "close the view".
  const live = useRef({});
  live.current = { close, stepBy, openPicker, startSubtask, canEdit, canAddSub, task, shellModalOpen };
  useEffect(() => {
    function onKey(e) {
      const L = live.current;
      if (L.shellModalOpen || e.defaultPrevented) return;
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);
      const popOpen = !!document.querySelector('.ui-pop, .pop');
      if (e.key === 'Escape') {
        if (popOpen) return;
        // A field in the view: the first Esc leaves (and saves) it. A field outside it
        // (side mode: the list's search) keeps its own Esc.
        if (typing) { if (rootRef.current?.contains(ae)) { e.preventDefault(); ae.blur(); } return; }
        e.preventDefault(); L.close(); return;
      }
      if (popOpen || typing) return;
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault(); L.stepBy(e.key === 'ArrowLeft' ? -1 : 1); return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || !L.task) return;
      if (e.shiftKey && FIELD_KEYS[e.key]) {
        const f = FIELD_KEYS[e.key];
        if (!L.canEdit || (f === 'deadline' && L.task.is_recurring)) return;
        e.preventDefault(); L.openPicker(f);
      } else if (e.key === 's' && !e.shiftKey && L.canAddSub) { e.preventDefault(); L.startSubtask(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Overlay: focus the dialog on open, restore the opener's focus on close. Modal (and
  // the mobile sheet) also trap Tab inside the dialog.
  useEffect(() => {
    if (!overlay) return undefined;
    const opener = document.activeElement;
    rootRef.current?.focus({ preventScroll: true });
    return () => { if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true }); };
  }, [overlay]);
  const trap = overlay && (mode === 'modal' || isMobile);
  // Keep focus inside while trapped: a picker that unmounts or a ‹ › switch can drop
  // focus to <body>, and Tab from there would reach the page behind. Portalled pickers
  // (.ui-pop / .pop / Combobox lists) are part of the view.
  useEffect(() => {
    if (!trap) return undefined;
    const back = () => rootRef.current?.focus({ preventScroll: true });
    function onIn(e) {
      const r = rootRef.current;
      // A shell modal over the view (⌘K bar, shortcuts sheet) owns focus while it's up.
      if (live.current.shellModalOpen) return;
      if (!r || r.contains(e.target) || e.target.closest?.('.ui-pop, .pop, .ui-tip, [role="listbox"], .cmdk')) return;
      back();
    }
    function onOut(e) {
      if (e.relatedTarget || live.current.shellModalOpen) return;
      setTimeout(() => { if (document.activeElement === document.body || document.activeElement == null) back(); }, 0);
    }
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, [trap]);
  function onTrapKey(e) {
    if (!trap || e.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root || !root.contains(e.target)) return;
    const f = [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // Modal: no page scroll behind it.
  useEffect(() => {
    if (!overlay || (mode !== 'modal' && !isMobile)) return undefined;
    const sc = document.querySelector('.dk-scroll');
    const prev = sc?.style.overflowY;
    if (sc) sc.style.overflowY = 'hidden';
    return () => { if (sc) sc.style.overflowY = prev || ''; };
  }, [overlay, mode, isMobile]);

  if (autoFull) return null; // navigating to the full page

  /* ---------------- render ---------------- */
  const ModeIcon = MODE_META[mode].icon;
  const header = (
    <div className="tv-head">
      <div className="tv-head-nav">
        <IconButton icon={ChevronLeft} label="Previous task" shortcut="Ctrl ⇧ ←" size="sm" disabled={!nav.prev} onClick={() => stepBy(-1)} />
        <IconButton icon={ChevronRight} label="Next task" shortcut="Ctrl ⇧ →" size="sm" disabled={!nav.next} onClick={() => stepBy(1)} />
      </div>
      <div className="tv-crumbs">
        {task && <>
          <span className="tv-crumb"><Hash size={12} aria-hidden />{task.space?.name || 'General'}</span>
          {task.program && <><span className="tv-crumb-sep">/</span><span className="tv-crumb">{task.program.name}</span></>}
          <span className="tv-crumb-sep">·</span>
          <Tooltip content="Copy task id"><button type="button" className="tv-id" onClick={copyId}>{task.task_no}</button></Tooltip>
        </>}
      </div>
      <div className="tv-head-acts">
        <IconButton icon={Link2} label="Copy link" size="sm" onClick={copyLink} disabled={!task} />
        <IconButton ref={moreRef} icon={MoreHorizontal} label="More actions" size="sm" aria-haspopup="menu" onClick={() => setMoreMenu(o => !o)} disabled={!task} />
        <Menu anchorRef={moreRef} open={moreMenu} onClose={() => setMoreMenu(false)} align="right" width={220} label="Task actions" className="tv-pop">
          <MenuItem icon={Link2} onClick={copyLink}>Copy link</MenuItem>
          <MenuItem icon={Hash} onClick={copyId}>Copy task id</MenuItem>
          {canAddSub && <MenuItem icon={Plus} shortcut="s" onClick={startSubtask}>Add sub-task</MenuItem>}
          {canLink && <MenuItem icon={OctagonMinus} onClick={() => startDep(moreRef)}>Add dependency…</MenuItem>}
          {canEdit && task?.status !== 'done' && <MenuItem icon={Check} onClick={() => setStatus('done')}>Mark done</MenuItem>}
          {canEdit && <><MenuSeparator /><MenuItem icon={Ban} danger onClick={startAbandon}>Abandon…</MenuItem></>}
          {task?.status === 'abandoned' && task._can_edit && <MenuItem icon={RotateCcw} onClick={() => setStatus('not_started')}>Reactivate</MenuItem>}
        </Menu>
        {task && canLink && <DepAddFlow open={!!depAnchor} anchorRef={depAnchor || moreRef} task={task} session={session}
          onClose={() => setDepAnchor(null)} onAdded={mutated} />}
        {/* A caller that pins an overlay mode (Grid triage) can't have it switched — "Full page"
            would navigate away from the session underneath. */}
        {(!fixedMode || fixedMode === 'full') && <>
        <IconButton ref={modeRef} icon={ModeIcon} label="Switch layout" size="sm" aria-haspopup="menu" onClick={() => setModeMenu(o => !o)} />
        <Menu anchorRef={modeRef} open={modeMenu} onClose={() => setModeMenu(false)} align="right" width={180} label="Layout" className="tv-pop">
          <MenuLabel>Open tasks as</MenuLabel>
          {Object.entries(MODE_META).map(([m, meta]) => (
            <MenuItem key={m} icon={meta.icon} selected={mode === m} onClick={() => chooseMode(m)}>{meta.label}</MenuItem>
          ))}
        </Menu>
        </>}
        <IconButton icon={X} label={mode === 'full' ? 'Back to the list' : 'Close'} shortcut="Esc" size="sm" onClick={close} />
      </div>
    </div>
  );

  const left = task && (
    <div className="tv-left">
      {task.parent && (
        <button type="button" className="tv-parent" onClick={() => openOther(task.parent.id)}>
          <ArrowUp size={12} /> {task.parent.task_no} · {task.parent.title}
        </button>
      )}
      {canEdit ? (
        <textarea ref={titleRef} className="tv-title" value={titleDraft} rows={1} aria-label="Title"
          onChange={e => { setTitleDraft(e.target.value); grow(e.target); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          onBlur={() => { const v = titleDraft.trim(); if (v && v !== task.title) saveField('title', v); else if (!v) setTitleDraft(task.title || ''); }} />
      ) : <h2 className="tv-title">{task.title}</h2>}

      {task.status === 'abandoned' && (
        <div className="tv-banner">
          Abandoned{task.abandon_reason ? `: “${task.abandon_reason}”` : ''}.
          {task._can_edit && <button type="button" className="tv-banner-btn" onClick={() => setStatus('not_started')} disabled={busy}>Reactivate</button>}
        </div>
      )}

      <TaskProps task={task} canEdit={canEdit} busy={busy} edit={edit} setEdit={setEdit} refs={refs}
        abandonMode={abandonMode} setAbandonMode={setAbandonMode} actions={actions} opts={opts} revisions={revisions} />

      {/* F7 Dependencies strip — above the description, only when something is linked. */}
      {showDeps && linkCount(task.links) > 0 && (
        <DepsStrip task={task} canEdit={canLink} session={session} onChange={mutated} onOpen={openOther}
          addRef={depAddRef} onAdd={() => startDep(depAddRef)} />
      )}

      <div className="tv-desc">
        <div className="tv-sh-row">
          <div className="tv-sh">Description</div>
          {canLink && linkCount(task.links) === 0 && (
            <button ref={depDescRef} type="button" className="tv-add dp-add" onClick={() => startDep(depDescRef)}><Plus size={12} /> Dependency</button>
          )}
        </div>
        {canEdit ? (
          <textarea ref={descRef} className="tv-desc-input" placeholder="Add a description…" value={descDraft} aria-label="Description"
            onChange={e => { setDescDraft(e.target.value); grow(e.target); }}
            onBlur={() => { if (descDraft !== (task.description || '')) saveField('description', descDraft); }} />
        ) : (task.description ? <div className="tv-desc-text">{task.description}</div> : <span className="tv-empty">No description</span>)}
      </div>

      {!task.is_recurring && (
        <Section k="subtasks" title="Sub-tasks" count={task.child_count ? `${task.child_done}/${task.child_count}` : null} sections={sections} toggle={toggleSection}>
          <SubtaskPanel task={task} session={session} canEdit={canEdit} onChange={mutated} onOpen={openOther} />
        </Section>
      )}
      <Section k="docs" title="Documents" count={(task.documents || []).length || null} sections={sections} toggle={toggleSection}>
        <DocLinksPanel task={task} session={session} canEdit={canEdit} onChange={mutated} />
      </Section>
      {task.is_recurring && (
        <Section k="checklist" title="Checklist" sections={sections} toggle={toggleSection}>
          <div className="tv-static">Repeats {recurrenceSummary(task.recurrence)} — ticked off on the <a className="tv-link" href="/checklist/">Checklist</a>.</div>
        </Section>
      )}
    </div>
  );

  const right = task && (
    <TaskActivity ref={composerRef} task={task} session={session} onChange={mutated} tab={tab} setTab={setTab}
      onSetOwner={canEdit && !task.owner_employee_id ? () => openPicker('owner') : null} />
  );

  const body = (loading && !task) ? <div className="tv-loading"><Spinner /></div>
    : !task ? <div className="tv-loading tv-empty">Task not found, or you can’t see it.</div>
    : isMobile ? (
      <div className="tv-body tv-body-m">
        <div className="tv-mtabs" role="tablist">
          <button type="button" role="tab" aria-selected={mTab === 'details'} className={'tv-tab' + (mTab === 'details' ? ' on' : '')} onClick={() => setMTab('details')}>Details</button>
          <button type="button" role="tab" aria-selected={mTab === 'activity'} className={'tv-tab' + (mTab === 'activity' ? ' on' : '')} onClick={() => setMTab('activity')}>
            Activity{(task.comments || []).length ? <span className="tv-tab-n">{task.comments.length}</span> : null}
          </button>
        </div>
        {mTab === 'details' ? <div className="tv-scroll">{left}</div> : right}
      </div>
    ) : (
      <div className="tv-body">
        <div className="tv-scroll">{left}</div>
        {right}
      </div>
    );

  const shell = (
    <div ref={rootRef} className={`tv tv-${mode}` + (isMobile ? ' tv-mobile' : '')} data-taskview={mode}
      role={overlay ? 'dialog' : 'region'} aria-modal={trap || undefined} aria-label={task ? `${task.task_no} ${task.title}` : 'Task'}
      tabIndex={-1} onKeyDown={onTrapKey}>
      {header}
      {body}
    </div>
  );

  // One wrapper element in every mode, so modal ↔ side only swaps a class (no remount: a
  // half-written comment or an open edit survives the switch).
  const dim = mode === 'modal' || (overlay && isMobile);
  return (
    <div className={dim ? 'tv-backdrop' : 'tv-host'}
      onMouseDown={dim ? (e) => { if (e.target === e.currentTarget && !document.querySelector('.ui-pop, .pop')) close(); } : undefined}>
      {shell}
    </div>
  );
}

function Section({ k, title, count, sections, toggle, children }) {
  const collapsed = !!sections[k];
  return (
    <section className={'tv-section' + (collapsed ? ' collapsed' : '')}>
      <button type="button" className="tv-section-h" aria-expanded={!collapsed} onClick={() => toggle(k)}>
        <ChevronDown size={14} className="tv-caret" aria-hidden />{title}
        {count != null && <span className="tv-section-n">{count}</span>}
      </button>
      {!collapsed && <div className="tv-section-b">{children}</div>}
    </section>
  );
}

export default TaskView;
