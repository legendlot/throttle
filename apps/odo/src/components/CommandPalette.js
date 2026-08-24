'use client';
// ⌘K palette — the intended primary navigation now that the rail is grouped and
// Channels/P&L no longer spill their children into it. Fuzzy-searches screens PLUS
// the seven channel families and the P&L scopes, each deep-linking to the right
// in-page tab (the routes are unchanged, so the tab and the URL stay 1:1).
//
// Entries are static — no search endpoint is needed or used.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { FAMILY_ORDER, FAMILIES } from '../lib/families.js';
import { Swatch } from './prism.js';

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setOpen(o => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}

// Build the entry list from the nav the user can actually see, so the palette never
// offers a screen their permissions would bounce them from.
export function paletteEntries(navGroups) {
  const out = [];
  (navGroups || []).forEach(g => (g.items || []).forEach(it => {
    out.push({ id: it.route, label: it.label, group: g.label || 'Go to', route: it.route });
  }));
  const canSee = (route) => out.some(e => e.route === route || route.startsWith(e.route + '/'));
  if (canSee('/channels')) FAMILY_ORDER.forEach(k => out.push({
    id: `chan-${k}`, label: `Channels · ${FAMILIES[k].label}`, group: 'Channels', route: `/channels/${k}`, color: FAMILIES[k].color,
  }));
  // Products' two scopes left the rail with the IA change; the palette carries them like the
  // Channels families and the P&L scopes, so nothing is reachable by URL alone.
  if (canSee('/products')) {
    out.push({ id: 'prod-drr', label: 'Products · Cross-channel', group: 'Products', route: '/products/drr' });
    // Gated on /pnl, NOT /products: per-product P&L is P&L data (margin through GM), so it follows
    // the super-admin gate even though it lives under the Products route. Products itself stays
    // open to analysts.
    if (canSee('/pnl')) out.push({ id: 'prod-pnl', label: 'Products · P&L by product', group: 'Products', route: '/products/pnl' });
  }
  if (canSee('/pnl')) {
    out.push({ id: 'pnl-overall', label: 'Company P&L', group: 'P&L', route: '/pnl/overall' });
    FAMILY_ORDER.forEach(k => out.push({
      id: `pnl-${k}`, label: `${FAMILIES[k].label} P&L`, group: 'P&L', route: `/pnl/${k}`, color: FAMILIES[k].color,
    }));
  }
  return out;
}

export function CommandPalette({ open, onClose, entries, onGo }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { if (open) { setQ(''); setHi(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return entries.slice(0, 12);
    const toks = s.split(/\s+/).filter(Boolean);
    return entries.filter(e => {
      const hay = `${e.label} ${e.group} ${e.route}`.toLowerCase();
      return toks.every(t => hay.includes(t));
    }).slice(0, 12);
  }, [q, entries]);

  useEffect(() => { setHi(0); }, [q]);

  if (!open || typeof document === 'undefined') return null;

  const go = (e) => { if (!e) return; onClose(); onGo(e.route); };

  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); setHi(i => Math.min(i + 1, hits.length - 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setHi(i => Math.max(i - 1, 0)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); go(hits[hi]); }
  };

  return createPortal(
    <div onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(4,5,7,.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div onMouseDown={e => e.stopPropagation()} onKeyDown={onKey}
        style={{ width: 600, maxWidth: 'calc(100vw - 32px)', background: '#14151b', border: '1px solid #2a2d35',
          borderRadius: 16, boxShadow: '0 40px 90px -30px rgba(0,0,0,.9)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid #23252b' }}>
          <Search size={17} strokeWidth={1.75} style={{ color: 'var(--t3)', flex: 'none' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search or jump to…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)',
              fontFamily: 'var(--ui)', fontSize: 14 }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', border: '1px solid #2c2f36',
            borderRadius: 5, padding: '2px 6px' }}>ESC</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {hits.length === 0 && (
            <div style={{ padding: '18px 12px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t4)' }}>
              No matches
            </div>
          )}
          {hits.map((e, i) => (
            <button key={e.id} onMouseEnter={() => setHi(i)} onMouseDown={() => go(e)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
                border: 'none', borderRadius: 9, padding: '9px 11px', cursor: 'pointer',
                background: i === hi ? 'rgba(255,255,255,.06)' : 'transparent',
                color: i === hi ? 'var(--t1)' : 'var(--t2)', fontFamily: 'var(--ui)', fontSize: 13 }}>
              {e.color ? <Swatch color={e.color} /> : <span className="so-swatch" style={{ background: 'var(--border-strong)' }} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t5)' }}>{e.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
