'use client';
// ⌘K command bar (ClickUp redesign P6). Mounted once in the (auth) layout. Fuzzy search,
// client-side only, over what the app already holds:
//   Tasks              — the rows the tasks page has loaded (useCommandSource('tasks'));
//                        DKT id ("DKT-123" / "123") ranks first, then the title
//   Spaces & programs  — the shell's getMe spaces (General · My spaces · By others) + programs
//   Navigation         — the rail destinations (Dashboard perm-gated, Admin for docket_admin)
//   Commands           — New task / space / program, My tasks, List ↔ Board + density (on
//                        /tasks, via useCommandSource('tasksView')), sidebar, shortcuts;
//                        F7 "Add dependency to DKT-n" while an editable TaskView is open ('taskView')
// Empty query: Recent (last 5 picks, localStorage `docket.cmdk.recent`) + Navigation +
// Commands. ↑↓ (wrap) · Home/End · Enter runs · ⌘/Ctrl+Enter opens a task full-page ·
// Esc closes and gives focus back. ARIA combobox + listbox (aria-activedescendant).
// F5: typing ≥2 chars (or a DKT number) also asks the worker (searchTasks, debounced) for
// matches in EVERY space the caller can open; those merge into Tasks, deduped against the
// page's rows, ranked by scoreTask (lib/fuzzy.js) with the server's match rank as a floor.
// Until the user moves the highlight it follows the TOP row, so a late exact hit (DKT-247 from
// another space) takes it — the best match leads. Once they arrow or hover, it is held by key
// and a late reply never moves it (if their row drops out of the results, it returns to the top).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Target, ListTodo, UserCheck, ListChecks, NotebookPen, LayoutDashboard, BookOpen, Settings, Hash, Lock, Flag,
  SquarePen, FolderPlus, LayoutList, Columns3, Rows3, PanelLeft, Keyboard, Clock, CornerDownLeft, Info, Loader2, OctagonMinus } from 'lucide-react';
import { fuzzyMatch, dktQuery, rankGroups, scoreTask, serverFloor } from '../lib/fuzzy.js';
import { docketopsGet } from '../lib/docketopsFetch.js';
import { getCommandSource } from '../lib/commandSources.js';
import { ADMIN_ITEMS } from '../lib/nav.js';
import { STATUS_MAP } from '../lib/tasks.js';
import { Kbd } from './ui/index.js';
import { useModLabel } from '../lib/platform.js';

// Per user (a shared browser must not show the last person's spaces / tasks / Admin).
const RECENT_KEY = (userId) => `docket.cmdk.recent.${userId || 'anon'}`;
const CAP = 8;          // per group while searching; Navigation + Commands are uncapped when empty
const TASK_CAP = 12;    // Tasks while searching — the group that now spans every space
const SEARCH_DEBOUNCE = 180;
const GROUPS = [
  ['recent', 'Recent'],
  ['tasks', 'Tasks'],
  ['places', 'Spaces & programs'],
  ['nav', 'Navigation'],
  ['commands', 'Commands'],
];

function readRecent(userId) {
  try {
    localStorage.removeItem('docket.cmdk.recent');   // the pre-fix, unkeyed list
    const v = JSON.parse(localStorage.getItem(RECENT_KEY(userId)) || '[]');
    return Array.isArray(v) ? v.filter(r => r && typeof r.key === 'string' && typeof r.label === 'string').slice(0, 5) : [];
  } catch { return []; }
}
function pushRecent(userId, item) {
  const snap = { key: item.key, label: item.label, sub: item.sub || '', kind: item.kind, taskId: item.taskId || null };
  try { localStorage.setItem(RECENT_KEY(userId), JSON.stringify([snap, ...readRecent(userId).filter(r => r.key !== item.key)].slice(0, 5))); } catch { /* ignore */ }
}
const snapshot = (userId) => ({ tasks: getCommandSource('tasks') || null, view: getCommandSource('tasksView') || null, taskView: getCommandSource('taskView') || null, recent: readRecent(userId) });

function Highlight({ text, idx }) {
  if (!idx || !idx.length) return text;
  const set = new Set(idx);
  const out = [];
  let buf = '', on = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== on && buf) { out.push(on ? <mark key={i}>{buf}</mark> : buf); buf = ''; }
    on = m; buf += text[i];
  }
  if (buf) out.push(on ? <mark key="end">{buf}</mark> : buf);
  return out;
}

// Task row → bar item. meta = parent crumb + space (server hits and My-tasks rows carry space_name).
function taskMeta(t) {
  return [t.parent_task_no ? '↳ ' + t.parent_task_no : null, t.space_name || null].filter(Boolean).join(' · ');
}

export function CommandBar({ open = true, userId, session, onClose, router, spaces = [], programs = [], canViewDashboard, isAdmin, onNewTask, onNewSpace, onNewProgram, onToggleSidebar, onHelp }) {
  // The layout mounts the bar on each open, so this state starts fresh and the page
  // sources are read synchronously — no frame of the previous results.
  const [q, setQ] = useState('');
  // Highlight by key (group|key), not index: a server reply re-ranks the list, and the row
  // the user arrowed to must stay highlighted. null = follow the top row (see the header).
  const [activeK, setActiveK] = useState(null);
  // Cross-space server search (F5). rows are kept for the query they answered (q).
  const [remote, setRemote] = useState({ q: '', rows: [], status: 'idle' });
  const reqRef = useRef(0);
  const [snap] = useState(() => (typeof window === 'undefined' ? { tasks: null, view: null, taskView: null, recent: [] } : snapshot(userId)));
  const mod = useModLabel();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const openerRef = useRef(null);
  const pointer = useRef({ x: -1, y: -1 });

  // Opening: remember who had focus, then take it.
  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    const id = ++reqRef.current;   // any change retires the in-flight request
    if (!open || !session || (!dktQuery(query) && query.length < 2)) {
      setRemote(r => (r.status === 'idle' && !r.rows.length ? r : { q: '', rows: [], status: 'idle' }));
      return undefined;
    }
    setRemote(r => (r.status === 'loading' ? r : { ...r, status: 'loading' }));
    const t = setTimeout(() => {
      docketopsGet('searchTasks', { q: query }, session)
        .then(rows => { if (reqRef.current === id) setRemote({ q: query, rows: Array.isArray(rows) ? rows : [], status: 'done' }); })
        .catch(() => { if (reqRef.current === id) setRemote({ q: query, rows: [], status: 'error' }); });
    }, SEARCH_DEBOUNCE);
    return () => clearTimeout(t);
  }, [q, open, session]);

  const go = (route) => router.push(route);
  const openTask = (id, full) => {
    if (full) { router.push(`/tasks/detail/?id=${id}`); return; }
    const src = getCommandSource('tasks');
    if (src?.open) src.open(id); else router.push(`/tasks?task=${id}`);
  };

  const taskItem = (t) => ({ key: 'task:' + t.id, group: 'tasks', kind: 'task', taskId: t.id, label: t.title || '(untitled)',
    sub: t.task_no || '', meta: taskMeta(t),
    num: String(t.task_no || '').replace(/\D/g, '').replace(/^0+(?=\d)/, ''), status: t.status,
    run: (full) => openTask(t.id, full) });

  // The searchable index — built once per open (lowercase strings precomputed).
  const index = useMemo(() => {
    if (!open) return [];
    const items = [];
    const add = (it) => items.push({ ...it, lc: it.label.toLowerCase(), lcSub: (it.sub || '').toLowerCase() });
    const navItems = [
      { key: 'nav:plan', label: 'Plan', icon: Target, route: '/plan' },
      { key: 'nav:tasks', label: 'Tasks', icon: ListTodo, route: '/tasks' },
      { key: 'nav:mine', label: 'My tasks', icon: UserCheck, route: '/tasks?lens=mine' },
      { key: 'nav:checklist', label: 'Checklist', icon: ListChecks, route: '/checklist' },
      { key: 'nav:scratchpad', label: 'Scratchpad', icon: NotebookPen, route: '/scratchpad' },
      ...(canViewDashboard ? [{ key: 'nav:dashboard', label: 'Dashboard', icon: LayoutDashboard, route: '/dashboard' }] : []),
      { key: 'nav:manual', label: 'Manual', icon: BookOpen, route: '/manual' },
      ...(isAdmin ? ADMIN_ITEMS.map(a => ({ key: 'nav:' + a.key, label: 'Admin · ' + a.label, icon: Settings, route: a.key })) : []),
    ];
    for (const n of navItems) add({ ...n, group: 'nav', kind: 'nav', run: () => go(n.route) });

    const general = spaces.find(s => !s.is_private);
    if (general) add({ key: 'space:' + general.id, group: 'places', kind: 'nav', label: general.name || 'General', sub: 'Space', icon: Hash, route: '/tasks', run: () => go('/tasks') });
    for (const s of spaces.filter(x => x.is_private)) {
      const route = '/tasks?space=' + s.id;
      add({ key: 'space:' + s.id, group: 'places', kind: 'nav', label: s.name || 'Space', sub: s.is_owner ? 'My space' : 'Space · by others', icon: Lock, route, run: () => go(route) });
    }
    for (const p of programs) {
      const route = '/tasks?program=' + p.id;
      add({ key: 'program:' + p.id, group: 'places', kind: 'nav', label: p.name || 'Program', sub: 'Program', icon: Flag, route, run: () => go(route) });
    }

    const v = snap.view;
    const tv = snap.taskView;   // the open TaskView (F7), when its task is editable
    const cmds = [
      // keepView: acts ON the open task, so the view must stay up (see run()).
      ...(tv ? [{ key: 'cmd:add-dep', label: `Add dependency to ${tv.taskNo}`, icon: OctagonMinus, keepView: true, run: tv.addDependency }] : []),
      { key: 'cmd:new-task', label: 'New task', icon: SquarePen, kbd: 'c', run: onNewTask },
      { key: 'cmd:new-space', label: 'New space', icon: FolderPlus, run: onNewSpace },
      { key: 'cmd:new-program', label: 'New program', icon: Flag, run: onNewProgram },
      { key: 'cmd:mine', label: 'Go to My tasks', icon: UserCheck, run: () => go('/tasks?lens=mine') },
      ...(v && v.canBoard ? [{ key: 'cmd:view', label: v.viewMode === 'board' ? 'Switch to List view' : 'Switch to Board view', icon: v.viewMode === 'board' ? LayoutList : Columns3, run: () => v.chooseView(v.viewMode === 'board' ? 'list' : 'board') }] : []),
      ...(v && v.viewMode !== 'board' ? [['compact', 'Compact'], ['default', 'Default'], ['roomy', 'Roomy']].filter(([d]) => d !== v.density)
        .map(([d, l]) => ({ key: 'cmd:density-' + d, label: `Density: ${l}`, icon: Rows3, run: () => v.chooseDensity(d) })) : []),
      { key: 'cmd:sidebar', label: 'Toggle sidebar', icon: PanelLeft, kbd: '[', run: onToggleSidebar },
      { key: 'cmd:help', label: 'Keyboard shortcuts', icon: Keyboard, kbd: '?', run: onHelp },
    ];
    for (const c of cmds) add({ ...c, group: 'commands', kind: 'cmd' });

    for (const t of (snap.tasks?.rows || [])) add(taskItem(t));
    return items;
  }, [open, spaces, programs, canViewDashboard, isAdmin, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rows to show: grouped, ranked, capped. Flattened for keyboard order.
  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const groups = {};
    if (!query) {
      const byKey = new Map(index.map(i => [i.key, i]));
      groups.recent = snap.recent.map(r => {
        const live = byKey.get(r.key);
        if (live) return { ...live, group: 'recent' };
        // Off the tasks page a picked task still opens by its link (the server checks
        // access). Places / nav / commands only while they're in the live index — a
        // revoked perm or a space you can no longer see drops out.
        if (r.kind === 'task' && r.taskId) return { key: r.key, group: 'recent', kind: 'task', label: r.label, sub: r.sub, taskId: r.taskId, run: (full) => openTask(r.taskId, full) };
        return null;
      }).filter(Boolean);
      groups.nav = index.filter(i => i.group === 'nav');
      groups.commands = index.filter(i => i.group === 'commands');
    } else {
      const num = dktQuery(query);
      // Server hits count with their rank floor only while they answer THIS query; an older
      // reply (still typing) keeps just the rows that fuzzy-match what's typed now.
      const fresh = remote.q.toLowerCase() === query;
      const floorById = new Map();
      if (fresh) remote.rows.forEach((t, pos) => floorById.set(t.id, serverFloor(t.match_rank, pos)));
      const localTaskIds = new Set();
      const push = (it, r) => { (groups[it.group] = groups[it.group] || []).push({ ...it, _score: r.score, _idx: r.idx }); };
      for (const it of index) {
        if (it.kind === 'task') {
          localTaskIds.add(it.taskId);
          const r = scoreTask(it, query, num, floorById.get(it.taskId) ?? null);
          if (r) push(it, r);
          continue;
        }
        const m = fuzzyMatch(query, it.lc);
        let score = m ? m.score : -1;
        if (!m && it.lcSub) { const ms = fuzzyMatch(query, it.lcSub); if (ms) score = ms.score - 200; }
        if (score >= 0) push(it, { score, idx: m?.idx || [] });
      }
      for (const t of remote.rows) {
        if (localTaskIds.has(t.id)) continue;   // the page's own row wins (same task)
        const it = taskItem(t);
        it.lc = it.label.toLowerCase(); it.lcSub = it.sub.toLowerCase();
        const r = scoreTask(it, query, num, floorById.get(t.id) ?? null);
        if (r) push(it, r);
      }
      for (const g of Object.keys(groups)) groups[g].sort((a, b) => b._score - a._score);
    }
    const out = [];
    for (const [g, label] of GROUPS) {
      const list = (!query && (g === 'nav' || g === 'commands')) ? (groups[g] || []) : (groups[g] || []).slice(0, g === 'tasks' ? TASK_CAP : CAP);
      if (list.length) out.push({ group: g, label, items: list });
    }
    // Searching: the group holding the best match comes first (an exact DKT id scores
    // 3000, so it still leads), which makes row 0 — the default Enter — the overall best.
    // Empty query keeps the fixed order.
    return query ? rankGroups(out) : out;
  }, [q, index, snap, remote]); // eslint-disable-line react-hooks/exhaustive-deps

  const flat = useMemo(() => rows.flatMap(r => r.items.map(it => ({ ...it, _k: r.group + '|' + it.key }))), [rows]);
  const searching = remote.status === 'loading';
  const searchFailed = remote.status === 'error' && !!q.trim();
  useEffect(() => { setActiveK(null); }, [q]);
  const found = activeK ? flat.findIndex(x => x._k === activeK) : -1;
  const cur = flat.length ? (found >= 0 ? found : 0) : -1;
  const setActive = (i) => setActiveK(flat[i]?._k ?? null);
  const optId = (i) => `cmdk-opt-${i}`;
  useEffect(() => { if (cur >= 0) document.getElementById(optId(cur))?.scrollIntoView({ block: 'nearest' }); }, [cur]);

  function close(restore = true) {
    onClose();
    if (restore) { const o = openerRef.current; setTimeout(() => { if (o && document.contains(o)) o.focus?.({ preventScroll: true }); }, 0); }
  }
  function run(item, full = false) {
    if (!item) return;
    pushRecent(userId, item);
    close(item.kind === 'cmd' && (item.key === 'cmd:sidebar' || item.key.startsWith('cmd:density') || item.key === 'cmd:view'));
    // Anything but a task pick acts on the page — close an open TaskView first so it
    // doesn't run behind the view (and its focus trap). A task pick just switches it.
    const src = getCommandSource('tasks');
    const viewOpen = item.kind !== 'task' && !item.keepView && src?.isViewOpen?.();
    if (viewOpen) src.closeTask();
    // After the bar (and the view) have unmounted, so the action's own focus wins.
    setTimeout(() => item.run(full && item.kind === 'task'), viewOpen ? 60 : 0);
  }
  function onKeyDown(e) {
    const n = flat.length;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { e.preventDefault(); inputRef.current?.focus(); return; }   // the input is the only stop
    if (!n) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((cur + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((cur - 1 + n) % n); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur], e.metaKey || e.ctrlKey); }
  }

  if (!open) return null;
  let i = -1;
  return (
    <div className="cmdk-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {/* Keys at the dialog level and no focus theft: a click anywhere in the bar that
          isn't the input (a group header, the hint, the scrollbar) keeps the input focused. */}
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command bar" onKeyDown={onKeyDown}
        onMouseDown={e => { if (e.target !== inputRef.current) e.preventDefault(); }}>
        <div className="cmdk-input">
          <Search size={16} strokeWidth={2} aria-hidden />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search tasks, spaces, programs, commands…"
            role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list"
            aria-activedescendant={cur >= 0 ? optId(cur) : undefined} autoComplete="off" spellCheck={false} />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id="cmdk-list" className="cmdk-list" role="listbox" aria-label="Results"
          onMouseMove={(e) => { pointer.current = { x: e.clientX, y: e.clientY }; }}>
          {rows.map(r => (
            <div key={r.group} role="group" aria-labelledby={`cmdk-g-${r.group}`}>
              <div id={`cmdk-g-${r.group}`} className="cmdk-group" role="presentation">{r.label}</div>
              {r.items.map(it => {
                i += 1; const me = i;
                const Ic = it.kind === 'task' ? null : (r.group === 'recent' && !it.icon ? Clock : it.icon);
                const st = it.kind === 'task' ? STATUS_MAP[it.status] : null;
                return (
                  <div key={r.group + it.key} id={optId(me)} role="option" aria-selected={me === cur}
                    className={'cmdk-opt' + (me === cur ? ' on' : '')}
                    onMouseMove={(e) => {
                      // Only a real pointer move takes the highlight — not the list
                      // re-rendering under a still mouse while typing.
                      if (e.clientX === pointer.current.x && e.clientY === pointer.current.y && me !== cur) return;
                      if (me !== cur) setActive(me);
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => run(it, e.metaKey || e.ctrlKey)}>
                    <span className="cmdk-ic">
                      {it.kind === 'task'
                        ? <span className="cmdk-st" style={{ background: st?.color || 'var(--text-4)' }} title={st?.label} />
                        : Ic ? <Ic size={15} strokeWidth={1.75} aria-hidden /> : null}
                    </span>
                    <span className="cmdk-label"><Highlight text={it.label} idx={it._idx} /></span>
                    {it.meta && <span className="cmdk-meta">{it.meta}</span>}
                    {it.sub && <span className={'cmdk-sub' + (it.kind === 'task' ? ' mono' : '')}>{it.sub}</span>}
                    {it.kbd && <Kbd>{it.kbd}</Kbd>}
                    {me === cur && <CornerDownLeft className="cmdk-enter" size={13} aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
          {q.trim() && flat.length === 0 && !searching && !searchFailed && <div className="cmdk-empty">No matches</div>}
        </div>
        {/* Outside the listbox (only options/groups belong in it); a live region for SR users. */}
        <div role="status" aria-live="polite">
          {searching && <div className="cmdk-hint"><Loader2 className="cmdk-spin" size={13} aria-hidden />Searching all spaces…</div>}
          {searchFailed && <div className="cmdk-hint"><Info size={13} aria-hidden />Couldn’t search other spaces — showing what’s loaded here</div>}
        </div>
        <div className="cmdk-foot" aria-hidden>
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>{mod} ↵</Kbd> task full page</span>
          <span><Kbd>Esc</Kbd> close</span>
        </div>
      </div>
    </div>
  );
}

export default CommandBar;
