'use client';
import { useState, useEffect, useRef, useMemo, createElement } from 'react';
import { Search, ArrowRight, Plus } from 'lucide-react';
import { StatusBadge } from '@throttle/ui';
import { allNavItems } from '../../lib/nav.js';

// ════════════════════════════════════════════════════════════════════
// GarageCommandPalette — the ⌘K launcher. Fuzzy search across screens +
// quick actions, client-side over the (permission-filtered) nav. ↑↓ /
// Enter / Esc. §8: entity (run/part) fuzzy search would be the ONE
// optional new backend endpoint — kept client-side here over loaded nav;
// flag to add later if entity jumps are wanted.
// ════════════════════════════════════════════════════════════════════

const ACTIONS = [
  { id: 'act-grn',   label: 'New GRN',           hint: 'Receive goods',    route: '/grn' },
  { id: 'act-issue', label: 'New issue',         hint: 'Issue to a run',   route: '/issue-queue' },
  { id: 'act-count', label: 'Start cycle count', hint: 'Open count sheet', route: '/cycle-counts' },
  { id: 'act-gate',  label: 'New gate pass',     hint: 'Outward pass',     route: '/gate-pass' },
];

function fuzzy(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (const ch of text) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return text.includes(q);
}

const kbd = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--t3)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 4, padding: '2px 6px', lineHeight: 1.2 };

export function GarageCommandPalette({ open, onClose, nav, onNavigate }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 30); }
  }, [open]);

  const routesPresent = useMemo(() => {
    const set = new Set();
    allNavItems(nav).forEach((i) => set.add(i.route));
    return set;
  }, [nav]);

  const results = useMemo(() => {
    const screens = allNavItems(nav).map((s) => ({
      id: 's-' + s.route, kind: 'Screen', label: s.label, hint: s.desc || s.group, icon: s.icon, route: s.route,
    }));
    const actions = ACTIONS.filter((a) => routesPresent.has(a.route)).map((a) => ({ ...a, kind: 'Action', icon: Plus }));
    const all = [...actions, ...screens];
    return all.filter((r) => fuzzy(q, r.label + ' ' + (r.hint || ''))).slice(0, 9);
  }, [q, nav, routesPresent]);

  useEffect(() => { if (active >= results.length) setActive(0); }, [results.length]); // eslint-disable-line

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const r = results[active]; if (r) { onNavigate(r.route); onClose(); } }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, active]); // eslint-disable-line

  if (!open) return null;
  const KIND_TONE = { Action: 'brand', Screen: 'info' };
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(8,8,10,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '13vh' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 'min(620px, 92vw)', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 17px', borderBottom: '1px solid var(--border)' }}>
          <Search size={18} strokeWidth={1.75} style={{ color: 'var(--t3)' }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setActive(0); }}
            placeholder="Search screens, actions…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 15.5 }} />
          <kbd style={kbd}>ESC</kbd>
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: 7 }}>
          {results.length === 0 && (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--t3)', fontSize: 13.5 }}>No matches for “{q}”</div>
          )}
          {results.map((r, i) => (
            <button key={r.id} onMouseEnter={() => setActive(i)} onClick={() => { onNavigate(r.route); onClose(); }}
              style={{
                width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 12px', borderRadius: 'var(--r-sm)', cursor: 'pointer', border: 'none',
                background: active === i ? 'var(--surface-3)' : 'transparent',
              }}>
              <span style={{ width: 30, height: 30, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t2)', flexShrink: 0 }}>
                {r.icon ? createElement(r.icon, { size: 15, strokeWidth: 1.75 }) : <ArrowRight size={15} strokeWidth={1.75} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
                {r.hint && <div style={{ fontSize: 12, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.hint}</div>}
              </div>
              <StatusBadge variant={KIND_TONE[r.kind] || 'neutral'}>{r.kind}</StatusBadge>
              {active === i && <span style={{ color: 'var(--t4)', display: 'flex' }}><ArrowRight size={15} strokeWidth={1.75} /></span>}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '9px 15px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-ui)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><kbd style={kbd}>↑</kbd><kbd style={kbd}>↓</kbd> navigate</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><kbd style={kbd}>↵</kbd> open</span>
          <span style={{ flex: 1 }} />
          <span className="num">{results.length} results</span>
        </div>
      </div>
    </div>
  );
}
