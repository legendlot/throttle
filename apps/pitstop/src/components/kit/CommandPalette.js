'use client';
/* ════════════════════════════════════════════════════════════
   CommandPalette — ⌘K (handoff §3). Real navigation: fuzzy
   search across SCREENS + ACTIONS (client-side) AND ENTITIES
   (tickets + calls, via the EXISTING getTickets?search= /
   getCalls?search= endpoints — no new backend). ↑↓ move · Enter
   run · Esc close. App-local.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NAV_PRIMARY, NAV_SETUP, NAV_MANUAL, filterNav } from '../../lib/nav.js';
import { Icon } from './Icon.js';
import { csopsGet } from '../../lib/csopsFetch.js';

function buildCommands(perms) {
  const cmds = [];
  // actions first — jump straight into the doing surface
  cmds.push(
    { k: 'New ticket',                kind: 'Action', icon: 'plus',   color: 'var(--ok-fg)',   route: '/new' },
    { k: 'Approve pending refunds',   kind: 'Action', icon: 'refund', color: 'var(--warn-fg)', route: '/queue?disposition=refund&stage=inspected' },
    { k: 'Missed calls awaiting callback', kind: 'Action', icon: 'missed', color: 'var(--bad-fg)', route: '/calls?tab=missed' },
  );
  for (const g of filterNav(NAV_PRIMARY, perms)) cmds.push({ k: `Go to ${g.label}`, kind: 'Navigation', icon: g.icon, color: 'var(--accent)', route: g.route });
  for (const s of filterNav(NAV_SETUP, perms)) cmds.push({ k: `Setup · ${s.label}`, kind: 'Navigation', icon: s.icon, color: 'var(--accent)', route: s.route });
  cmds.push({ k: NAV_MANUAL.label, kind: 'Help', icon: NAV_MANUAL.icon, color: 'var(--accent)', route: NAV_MANUAL.route });
  return cmds;
}

export function CommandPalette({ open, onClose, perms = {}, session }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [entities, setEntities] = useState([]);
  const commands = useMemo(() => buildCommands(perms), [perms]);
  const debounce = useRef(null);

  useEffect(() => { if (open) { setQ(''); setSel(0); setEntities([]); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);

  // live entity search (tickets + calls) via existing endpoints
  useEffect(() => {
    if (!open) return undefined;
    const t = q.trim();
    if (t.length < 2 || !session) { setEntities([]); return undefined; }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      try {
        const [tk, cl] = await Promise.all([
          csopsGet('getTickets', { search: t, limit: 6, tab: 'open' }, session).catch(() => null),
          csopsGet('getCalls', { search: t, limit: 4 }, session).catch(() => null),
        ]);
        const items = [];
        (tk?.tickets || []).forEach(x => items.push({
          k: `${x.customer_name || 'Customer'} · ${x.ticket_no}`,
          kind: `Ticket · ${x.disposition || 'pending'}`, icon: 'box', color: 'var(--info-fg)',
          route: `/queue/detail?ticket_no=${encodeURIComponent(x.ticket_no)}`,
        }));
        (cl?.calls || []).forEach(x => items.push({
          k: `${x.customer_name || x.customer_phone || 'Call'} · call`,
          kind: `Call · ${x.status || ''}`, icon: x.direction === 'outgoing' ? 'out' : 'in', color: 'var(--ok-fg)',
          route: `/calls/detail?id=${encodeURIComponent(x.id)}`,
        }));
        setEntities(items);
      } catch { setEntities([]); }
    }, 220);
    return () => clearTimeout(debounce.current);
  }, [q, open, session]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const cmds = t ? commands.filter(c => c.k.toLowerCase().includes(t) || c.kind.toLowerCase().includes(t)) : commands;
    return [...cmds, ...entities];
  }, [q, commands, entities]);

  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const c = results[sel]; if (c) { onClose(); router.push(c.route); } }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, results, sel, onClose, router]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh', animation: 'pit-fade .15s ease' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', background: 'var(--surface)',
        border: '1px solid var(--border-2)', borderRadius: 'var(--radius)', boxShadow: '0 30px 80px -20px rgba(0,0,0,.7)',
        overflow: 'hidden', animation: 'pit-pop .18s var(--ease)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={17} style={{ color: 'var(--t3)' }} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search tickets, calls, actions…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)',
              fontFamily: 'var(--f-ui)', fontSize: 15 }} />
          <kbd className="num" style={{ fontSize: 10, background: 'var(--surface-3)', border: '1px solid var(--border-2)',
            borderRadius: 4, padding: '2px 6px', color: 'var(--t3)' }}>ESC</kbd>
        </div>
        <div style={{ maxHeight: '54vh', overflowY: 'auto', padding: 8 }}>
          {results.map((r, idx) => {
            const active = idx === sel;
            return (
              <div key={`${r.k}-${idx}`} onClick={() => { onClose(); router.push(r.route); }} onMouseEnter={() => setSel(idx)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer', background: active ? 'var(--surface-2)' : 'transparent' }}>
                <div style={{ width: 30, height: 30, borderRadius: 'var(--radius-sm)', display: 'grid', placeItems: 'center',
                  background: 'var(--surface-2)', color: r.color, flexShrink: 0 }}>
                  <Icon name={r.icon} size={15} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.k}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--t4)' }}>{r.kind}</div>
                </div>
                <Icon name="chevR" size={14} style={{ color: 'var(--t4)' }} />
              </div>
            );
          })}
          {!results.length && (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--f-ui)', fontSize: 13 }}>No matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
