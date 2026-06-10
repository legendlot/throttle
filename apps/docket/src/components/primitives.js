'use client';
// Shared presentation primitives for the redesigned Docket surfaces
// (board + drawer): avatars, an anchored popover, a searchable option list,
// and small date/name helpers. Pure presentation — no data wiring lives here.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';

/* ---- name helpers ---- */
export function firstName(name) { return name ? name.trim().split(/\s+/)[0] : ''; }
export function initials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}

// Deterministic avatar colour from a stable key (employee id or name), so each
// person reads as a distinct chip without needing a colour stored server-side.
const AV_COLORS = [
  '#5b78ff', '#43d17f', '#f9923a', '#e15ad8', '#22b8cf',
  '#f25c5c', '#9b7bff', '#d4b200', '#3fb950', '#ff8fab',
];
export function personColor(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

/* ---- date helpers ---- */
export function dayDelta(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso) - new Date()) / 86400000);
}
export function fmtShortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
export function relDeadline(iso) {
  const dd = dayDelta(iso);
  if (dd === null) return '';
  if (dd === 0) return 'today';
  if (dd === 1) return 'tomorrow';
  if (dd === -1) return 'yesterday';
  if (dd < 0) return `${-dd}d overdue`;
  return `in ${dd}d`;
}
// '', 'over', or 'soon' for a task's effective deadline (ignores done/abandoned).
export function deadlineState(task) {
  const eff = task?.revised_deadline || task?.deadline;
  if (!eff || task.status === 'done' || task.status === 'abandoned') return '';
  const dd = dayDelta(eff);
  if (dd < 0) return 'over';
  if (dd <= 2) return 'soon';
  return '';
}

/* ---- Avatar ---- */
export function Avatar({ name, size = 22, ring = false, title }) {
  const color = personColor(name);
  return (
    <span className="avatar" title={title || name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color,
        boxShadow: ring ? '0 0 0 2px var(--bg), inset 0 0 0 1px rgba(255,255,255,.08)' : undefined }}>
      {initials(name)}
    </span>
  );
}
// Overlapping stack of collaborator avatars (max 3 + "+n").
export function AvatarRow({ names = [], size = 20, onClick, title }) {
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return (
    <span className="av-row" onClick={onClick} title={title} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      {shown.map((n, i) => (
        <span key={i} style={{ marginLeft: i ? -7 : 0, zIndex: 5 - i, position: 'relative' }}>
          <Avatar name={n} size={size} ring />
        </span>
      ))}
      {extra > 0 && <span className="avatar av-extra" style={{ width: size, height: size, fontSize: Math.round(size * 0.4), marginLeft: -7, zIndex: 1 }}>+{extra}</span>}
    </span>
  );
}

/* ---- Popover: anchored dropdown that closes on outside-click / Esc ---- */
export function Popover({ open, onClose, children, align = 'left', width }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function key(e) { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="pop" style={{ top: 'calc(100% + 5px)', [align]: 0, width, minWidth: width }} onMouseDown={e => e.stopPropagation()}>
      {children}
    </div>
  );
}

/* ---- Anchored popover: portals to <body> and positions `fixed` against a
   trigger, so it escapes scroll/overflow-clipping ancestors (e.g. the board's
   horizontal scroll on small screens) and clamps into the viewport. Used for the
   deadline calendar, which is wide enough to get cut otherwise. ---- */
export function AnchoredPopover({ anchorRef, open, onClose, width = 272, align = 'left', children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    function place() {
      const a = anchorRef?.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const m = 8;                                    // viewport margin
      const w = Math.min(width, window.innerWidth - m * 2);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(m, Math.min(left, window.innerWidth - w - m));
      const estH = 360;                               // calendar + reason + actions
      let top = r.bottom + 5;
      if (top + estH > window.innerHeight - m && r.top - estH - 5 > m) top = r.top - estH - 5;
      top = Math.max(m, top);
      setPos({ top, left, w });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchorRef, width, align]);
  useEffect(() => {
    if (!open) return undefined;
    function down(e) {
      if (ref.current && ref.current.contains(e.target)) return;
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return;
      onClose();
    }
    function key(e) { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open, anchorRef, onClose]);
  if (!open || !pos || typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="pop" style={{ position: 'fixed', top: pos.top, left: pos.left, width: 'auto', maxWidth: pos.w, padding: 12 }} onMouseDown={e => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/* ---- searchable option list (arrow-key + Enter navigable) ---- */
export function OptionList({ options, value, onPick, searchable, label }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const listRef = useRef(null);
  useEffect(() => { if (searchable) ref.current?.focus(); }, [searchable]);
  const filtered = q ? options.filter(o => (o.label || '').toLowerCase().includes(q.toLowerCase())) : options;
  // Reset the highlight to the top whenever the filter changes; keep it in range.
  useEffect(() => { setActive(0); }, [q]);
  const cur = Math.min(active, Math.max(0, filtered.length - 1));
  // Keep the highlighted row scrolled into view as it moves.
  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cur, filtered.length]);

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[cur]; if (o) onPick(o.value, o); }
  }

  return (
    <>
      {label && <div className="menu-label">{label}</div>}
      {searchable && <input ref={ref} className="menu-search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search…" />}
      <div ref={listRef} style={{ maxHeight: 240, overflowY: 'auto' }} tabIndex={searchable ? undefined : 0} onKeyDown={searchable ? undefined : onKey}>
        {filtered.map((o, i) => (
          <button key={o.value ?? '∅'} data-active={i === cur} onMouseEnter={() => setActive(i)}
            className={'menu-item' + (o.value === value ? ' active' : '')}
            style={i === cur ? { background: 'var(--surface-3)', color: 'var(--text-1)' } : undefined}
            onClick={() => onPick(o.value, o)}>
            {o.dot && <span className="si" style={{ background: o.dot }} />}
            {o.node || o.label}
            {o.value === value && <span className="ck"><Check size={14} /></span>}
          </button>
        ))}
        {filtered.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-4)' }}>No matches</div>}
      </div>
    </>
  );
}
