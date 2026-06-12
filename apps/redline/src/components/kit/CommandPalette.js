'use client';
/* ════════════════════════════════════════════════════════════
   CommandPalette — ⌘K. Fuzzy search across every screen +
   common actions. Client-side only (screens + actions); entity
   search (runs/operators) is flagged in the handoff §9 as a
   possible future endpoint and is NOT wired yet.
   Keyboard: ↑↓ move · Enter run · Esc close.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { NAV_PRIMARY, NAV_SETUP, NAV_MANUAL, NAV_HIDDEN } from '../../lib/nav.js';
import { Icon } from './Kit.js';

function buildCommands() {
  const cmds = [];
  for (const g of NAV_PRIMARY) {
    if (g.route) cmds.push({ k: g.label, grp: 'Screens', icon: g.icon, route: g.route, s: 'Go to' });
    for (const c of g.children || []) {
      cmds.push({ k: `${g.label} · ${c.label}`, grp: 'Screens', icon: c.icon, route: c.route, s: 'Go to' });
    }
  }
  for (const s of NAV_SETUP) cmds.push({ k: `Setup · ${s.label}`, grp: 'Setup', icon: s.icon, route: s.route, s: 'Go to' });
  cmds.push({ k: NAV_MANUAL.label, grp: 'Help', icon: NAV_MANUAL.icon, route: NAV_MANUAL.route, s: 'Go to' });
  for (const h of NAV_HIDDEN) cmds.push({ k: h.label, grp: 'Screens', icon: h.icon, route: h.route, s: 'Go to' });
  // actions — jump straight into the doing surface
  cmds.unshift(
    { k: 'New run / request', grp: 'Action', icon: 'plus', route: '/new-run', s: 'Create' },
    { k: 'Log hourly count', grp: 'Action', icon: 'clock', route: '/hourly', s: 'Open' },
    { k: 'Generate UPC batch', grp: 'Action', icon: 'qr', route: '/upc', s: 'Open' },
    { k: 'New delivery challan', grp: 'Action', icon: 'file', route: '/dispatch-challans/new', s: 'Create' },
    { k: 'Print a label', grp: 'Action', icon: 'printer', route: '/print', s: 'Open' },
  );
  return cmds;
}

export function CommandPalette({ open, onClose }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const commands = useMemo(buildCommands, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return commands;
    return commands.filter(c => c.k.toLowerCase().includes(t));
  }, [q, commands]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[sel]; if (c) { onClose(); router.push(c.route); } }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, filtered, sel, onClose, router]);

  if (!open) return null;

  let i = -1;
  const groups = {};
  filtered.forEach(c => { (groups[c.grp] = groups[c.grp] || []).push(c); });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.55)',
      display: 'flex', justifyContent: 'center', paddingTop: 96 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxHeight: 460, alignSelf: 'flex-start',
        background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-pop)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        animation: 'rl-pop-in 160ms var(--ease)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
          <Search size={18} strokeWidth={1.75} style={{ color: 'var(--t3)', flexShrink: 0 }} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search screens, actions…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--t1)',
              fontFamily: 'var(--font-ui)', fontSize: 15 }} />
          <span className="num" style={{ fontSize: 11, color: 'var(--t3)', border: '1px solid var(--border-2)',
            borderRadius: 4, padding: '2px 6px' }}>ESC</span>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {Object.entries(groups).map(([g, items]) => (
            <div key={g} style={{ marginBottom: 6 }}>
              <div className="eyebrow" style={{ padding: '8px 10px 4px' }}>{g}</div>
              {items.map(c => {
                i++;
                const idx = i;
                const active = idx === sel;
                return (
                  <div key={c.k} onClick={() => { onClose(); router.push(c.route); }}
                    onMouseEnter={() => setSel(idx)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px',
                      borderRadius: 'var(--r-sm)', cursor: 'pointer',
                      background: active ? 'var(--surface-3)' : 'transparent' }}>
                    <span style={{ color: active ? 'var(--yellow)' : 'var(--t3)', display: 'flex' }}>
                      <Icon name={c.icon} size={16} /></span>
                    <span style={{ flex: 1, fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--t1)' }}>{c.k}</span>
                    <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{c.s}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {!filtered.length && (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              No matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
