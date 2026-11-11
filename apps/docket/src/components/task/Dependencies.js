'use client';
// F7 task dependencies, modelled on ClickUp (spec docs/superpowers/specs/2026-11-11-docket-dependencies.md
// §3.4, contract §7). Three pieces:
//   DepsStrip   — TaskView's "Dependencies" strip above the description, from task.links:
//                 Waiting on / Blocking / Related (empty groups hidden), ✕ unlinks
//                 (removeTaskLink), the date clash hint, "N tasks you can't see".
//   DepAddFlow  — "+ Add": pick Waiting on… / Blocks… / Related to…, then search every space
//                 the caller can open (searchTasks, as ⌘K does) → addTaskLink {id, other_id, kind}.
//   DepsBadge   — the list row / board card icon (waiting_open · blocking_open · cleared);
//                 click → a popover that reads getTaskLinks and can unlink / open.
// Every rule (cycles, access, the can't-see count) is the worker's; refusals arrive as codes and
// are worded in lib/deps.js. Abandoned and recurring tasks never reach the edit controls
// (callers pass canEdit=false / don't mount it).
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@throttle/ui';
import { Plus, X, OctagonMinus, OctagonAlert, CircleCheckBig, Loader2, ExternalLink, EyeOff } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { STATUS_MAP } from '../../lib/tasks.js';
import { dktQuery } from '../../lib/fuzzy.js';
import { LINK_KINDS, LINK_GROUPS, linkErrorMessage, hiddenText, dateClash, fmtDay, rowBadge } from '../../lib/deps.js';
import { Menu, MenuItem, MenuLabel, Popover, Tooltip } from '../ui/index.js';

const stop = (e) => e.stopPropagation();
const contain = { onClick: stop, onMouseDown: stop, onKeyDown: stop };

/* ---------------- the grouped list (strip + badge popover) ---------------- */
// `task` is the task the links hang off (for the date clash hint); `onUnlink(link)` is null
// when the caller can't edit.
export function DepLinkList({ links, task, onUnlink, onOpen, busyId, compact = false }) {
  if (!links) return null;
  const hidden = links.hidden || {};
  const hiddenLinks = Array.isArray(links.hidden_links) ? links.hidden_links : [];
  return (
    <div className={'dp-groups' + (compact ? ' compact' : '')}>
      {LINK_GROUPS.map(g => {
        const items = links[g.key] || [];
        const nHidden = Number(hidden[g.key]) || 0;
        if (!items.length && !nHidden) return null;
        return (
          <div key={g.key} className={'dp-group dp-g-' + g.key}>
            <div className="dp-gh">{g.key === 'waiting_on' && <OctagonMinus size={12} aria-hidden />}{g.key === 'blocking' && <OctagonAlert size={12} aria-hidden />}{g.label}</div>
            {items.map(it => {
              const st = STATUS_MAP[it.status];
              const clash = g.key === 'waiting_on' ? dateClash(task, it) : null;
              const abandonedBlocker = g.key === 'waiting_on' && it.status === 'abandoned';
              return (
                <div key={it.link_id} className={'dp-row' + (it.cleared ? ' cleared' : '')}>
                  <button type="button" className="dp-open" onClick={() => onOpen?.(it.id)} title={`Open ${it.task_no}`}>
                    <span className="dp-dot" style={{ background: st?.color || 'var(--text-4)' }} title={st?.label || it.status} aria-label={st?.label || it.status} />
                    <span className="dp-no">{it.task_no}</span>
                    <span className="dp-ttl">{it.title}</span>
                    {abandonedBlocker
                      ? <span className="dp-tag">Blocker abandoned</span>
                      : (!compact && <>
                          {it.owner_name && <span className="dp-own">{it.owner_name}</span>}
                          {it.due && <span className="dp-due">{fmtDay(it.due)}</span>}
                        </>)}
                  </button>
                  {onUnlink && (
                    <button type="button" className="dp-x" aria-label={`Remove link to ${it.task_no}`} title="Remove link"
                      disabled={busyId === it.link_id} onClick={() => onUnlink(it)}>
                      {busyId === it.link_id ? <Loader2 size={12} className="ui-spin" /> : <X size={12} />}
                    </button>
                  )}
                  {clash && <div className="dp-clash">{clash}</div>}
                </div>
              );
            })}
            {nHidden > 0 && (onUnlink && hiddenLinks.some(h => h.direction === g.key)
              ? hiddenLinks.filter(h => h.direction === g.key).map(h => (
                <div key={h.link_id} className="dp-row dp-hidden"><EyeOff size={12} aria-hidden />{hiddenText(1)}
                  <button type="button" className="dp-x" aria-label="Remove this link"
                    disabled={busyId === h.link_id} onClick={() => onUnlink(h)}>
                    {busyId === h.link_id ? <Loader2 size={12} className="ui-spin" /> : <X size={12} />}
                  </button>
                </div>))
              : <div className="dp-row dp-hidden"><EyeOff size={12} aria-hidden />{hiddenText(nHidden)}</div>)}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- TaskView strip ---------------- */
export function DepsStrip({ task, canEdit, session, onChange, onOpen, onAdd, addRef }) {
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState(null);
  async function unlink(it) {
    setBusyId(it.link_id);
    try { await docketopsPost('removeTaskLink', { link_id: it.link_id }, session); await onChange?.(); }
    catch (e) { showToast(linkErrorMessage(e), 'error'); }
    finally { setBusyId(null); }
  }
  return (
    <section className="dp-strip" aria-label="Dependencies">
      <div className="dp-head">
        <span className="tv-sh dp-sh">Dependencies</span>
        {canEdit && <button ref={addRef} type="button" className="tv-add dp-add" onClick={onAdd}><Plus size={12} /> Add</button>}
      </div>
      <DepLinkList links={task.links} task={task} onUnlink={canEdit ? unlink : null} onOpen={onOpen} busyId={busyId} />
    </section>
  );
}

/* ---------------- add flow: kind menu → search picker ---------------- */
// `kind` preset skips the menu. Results exclude this task and anything already linked.
export function DepAddFlow({ open, anchorRef, task, session, onClose, onAdded, className = 'tv-pop' }) {
  const { showToast } = useToast();
  const [kind, setKind] = useState(null);
  useEffect(() => { if (!open) setKind(null); }, [open]);
  const meta = LINK_KINDS.find(k => k.kind === kind);
  return (
    <>
      <Menu anchorRef={anchorRef} open={open && !kind} onClose={onClose} width={220} label="Add dependency" className={className}>
        <MenuLabel>Add a dependency</MenuLabel>
        {LINK_KINDS.map(k => (
          <MenuItem key={k.kind} keepOpen onClick={() => setKind(k.kind)}>{k.label}</MenuItem>
        ))}
      </Menu>
      <Popover anchorRef={anchorRef} open={open && !!kind} onClose={onClose} width={340} className={className + ' dp-pick'}>
        {open && kind && <DepSearch task={task} session={session} hint={meta?.hint}
          onPick={async (other) => {
            try {
              await docketopsPost('addTaskLink', { id: task.id, other_id: other.id, kind }, session);
              showToast(`Linked ${other.task_no}`, 'success');
              onClose?.();
              await onAdded?.();
            } catch (e) { showToast(linkErrorMessage(e), 'error'); }
          }} />}
      </Popover>
    </>
  );
}

const SEARCH_DEBOUNCE = 180;
function DepSearch({ task, session, hint, onPick }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ q: '', rows: [], status: 'idle' });
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const reqRef = useRef(0);
  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(t); }, []);

  // Same gate as ⌘K: ≥2 characters, or a DKT number.
  useEffect(() => {
    const query = q.trim();
    const id = ++reqRef.current;
    if (!dktQuery(query) && query.length < 2) { setRes({ q: '', rows: [], status: 'idle' }); return undefined; }
    setRes(r => ({ ...r, status: 'loading' }));
    const t = setTimeout(() => {
      docketopsGet('searchTasks', { q: query }, session)
        .then(rows => { if (reqRef.current === id) setRes({ q: query, rows: Array.isArray(rows) ? rows : [], status: 'done' }); })
        .catch(() => { if (reqRef.current === id) setRes({ q: query, rows: [], status: 'error' }); });
    }, SEARCH_DEBOUNCE);
    return () => clearTimeout(t);
  }, [q, session]);

  const linked = new Set(['waiting_on', 'blocking', 'related'].flatMap(k => (task.links?.[k] || []).map(i => i.id)));
  const rows = res.rows.filter(r => r.id !== task.id && !linked.has(r.id) && r.status !== 'abandoned');
  useEffect(() => { setActive(0); }, [res.rows]);
  const cur = Math.min(active, Math.max(0, rows.length - 1));

  async function pick(r) {
    if (!r || saving) return;
    setSaving(true);
    try { await onPick(r); } finally { setSaving(false); }
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[cur]); }
  }

  const empty = res.status === 'idle' ? 'Type a title or a DKT number'
    : res.status === 'loading' && !rows.length ? 'Searching…'
    : res.status === 'error' ? 'Search failed. Try again.'
    : !rows.length ? 'No matching tasks' : null;
  return (
    <div className="dp-search">
      {hint && <div className="ui-menu-label">{hint}</div>}
      <input ref={inputRef} className="menu-search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
        placeholder="Search tasks in every space…" aria-label="Search tasks" disabled={saving} />
      <div className="dp-results" role="listbox" aria-label="Tasks">
        {rows.map((r, i) => {
          const st = STATUS_MAP[r.status];
          return (
            <button key={r.id} type="button" role="option" aria-selected={i === cur} className={'dp-res' + (i === cur ? ' on' : '')}
              onMouseEnter={() => setActive(i)} onClick={() => pick(r)} disabled={saving}>
              <span className="dp-dot" style={{ background: st?.color || 'var(--text-4)' }} />
              <span className="dp-no">{r.task_no}</span>
              <span className="dp-ttl">{r.title}</span>
              {r.space_name && <span className="dp-own">{r.space_name}</span>}
            </button>
          );
        })}
        {empty && <div className="dp-empty">{empty}</div>}
      </div>
    </div>
  );
}

/* ---------------- list row / board card badge ---------------- */
// `editable` = the row's task can be edited and isn't abandoned. `onOpen(id)` opens a task in
// the page's TaskView; `onChanged()` re-reads the list (after an unlink, once the popover closes).
// `getSession()` is read at request time — memoised rows must not hold a refreshed-away token.
export function DepsBadge({ task, getSession, editable, onOpen, onChanged }) {
  const { showToast } = useToast();
  const b = rowBadge(task);
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const dirty = useRef(false);

  async function read() {
    try { setErr(''); setLinks(await docketopsGet('getTaskLinks', { id: task.id }, getSession?.())); }
    catch (e) { setErr(e.message || 'Could not load the links'); }
  }
  const openRef = useRef(false);
  openRef.current = open;
  useEffect(() => { if (open) { setLinks(null); read(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  function close() { setOpen(false); if (dirty.current) { dirty.current = false; onChanged?.(); } }
  async function unlink(it) {
    setBusyId(it.link_id);
    try {
      await docketopsPost('removeTaskLink', { link_id: it.link_id }, getSession?.());
      // The POST takes ~2s; if the popover was closed meanwhile, close() saw nothing dirty — refresh now.
      if (!openRef.current) { onChanged?.(); return; }
      dirty.current = true; await read();
    }
    catch (e) { showToast(linkErrorMessage(e), 'error'); }
    finally { setBusyId(null); }
  }
  if (!b) return null;
  const go = (id) => { setOpen(false); if (dirty.current) { dirty.current = false; onChanged?.(); } onOpen?.(id); };
  return (
    <span className="dp-badge-host" {...contain}>
      <Tooltip content={b.tip}>
        <button ref={ref} type="button" className="dp-badge" aria-label={`Dependencies: ${b.tip}`} aria-haspopup="dialog" draggable={false}
          onClick={() => (open ? close() : setOpen(true))}>
          {b.waiting > 0 && <span className="dp-b waiting"><OctagonMinus size={12} aria-hidden />{b.waiting}</span>}
          {b.cleared && <span className="dp-b cleared"><CircleCheckBig size={12} aria-hidden /></span>}
          {b.blocking > 0 && <span className="dp-b blocking"><OctagonAlert size={12} aria-hidden />{b.blocking}</span>}
        </button>
      </Tooltip>
      <Popover anchorRef={ref} open={open} onClose={close} width={320} className="dp-pop" {...contain}>
        <div className="dp-pop-h">{task.task_no} dependencies</div>
        {err ? <div className="dp-empty">{err}</div>
          : !links ? <div className="dp-empty"><Loader2 size={14} className="ui-spin" /></div>
          : <DepLinkList links={links} task={task} compact onUnlink={editable ? unlink : null} onOpen={go} busyId={busyId} />}
        <button type="button" className="dp-pop-open" onClick={() => go(task.id)}><ExternalLink size={12} /> Open {task.task_no}{editable ? ' to add links' : ''}</button>
      </Popover>
    </span>
  );
}
