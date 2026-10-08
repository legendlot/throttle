'use client';
import { useCallback, useEffect, useState } from 'react';
import { PanelLeftOpen, PanelLeftClose } from 'lucide-react';

// Pit Control icon rail — replaces the shared @throttle/ui <Sidebar> for Ignition only.
// Collapsible, DEFAULT COLLAPSED, persisted in localStorage['ig.rail.expanded'] ('1' / '0').
// Static export: storage is read in an effect, never at render. `[` toggles it (not while typing,
// not with a modifier). Hidden ≤767px via `.ig-rail` in globals.css (tab bar + More sheet take over).

const STORAGE_KEY = 'ig.rail.expanded';
const EASE = 'cubic-bezier(.22,1,.36,1)';

const onRoute = (route, pathname) => !!route && (pathname === route || pathname.startsWith(route + '/'));

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

// Rail sections from the perm-filtered nav: WORK · LISTS · ANALYZE as-is, then the flat
// "System Manual" group joins Admin under one HELP & ADMIN heading. Items marked `rail: false`
// (New Deal → top-bar CTA) are skipped here only; the mobile sheet still lists them.
function railSections(navGroups) {
  const main = [];
  const help = [];
  for (const g of navGroups) {
    if (g.flat) { help.push({ id: g.id, label: g.label, route: g.route, icon: g.icon }); continue; }
    const items = (g.items || []).filter((it) => it.rail !== false);
    if (g.id === 'admin') { help.push(...items); continue; }
    if (items.length) main.push({ id: g.id, label: g.label, items });
  }
  if (help.length) main.push({ id: 'help', label: 'HELP & ADMIN', items: help });
  return main;
}

export default function IgRail({ navGroups, pathname, onNavigate, userLabel, userInitial, userRole, onLogout }) {
  const [expanded, setExpanded] = useState(false);
  // No width tween until the stored state is applied — otherwise an expanded rail animates open on
  // every full page load (S412 review).
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    try { if (window.localStorage.getItem(STORAGE_KEY) === '1') setExpanded(true); } catch { /* storage blocked */ }
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const toggle = useCallback(() => {
    setExpanded((p) => {
      const next = !p;
      try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* storage blocked */ }
      return next;
    });
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const ex = expanded;
  const itemW = ex ? 208 : 44;
  const labelOp = ex ? 1 : 0;
  const widthT = settled ? `width 240ms ${EASE}` : 'none';
  const sections = railSections(navGroups);

  const go = (route) => (e) => {
    // plain click → client-side nav; ⌘/Ctrl/middle click keep the native new-tab behaviour
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(route);
  };

  return (
    <aside className="ig-rail" style={{
      width: ex ? 232 : 68, height: '100%', flexShrink: 0, background: 'var(--rail)',
      borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      padding: '16px 12px 14px', gap: 4, overflow: 'hidden', transition: widthT,
      fontFamily: 'var(--font-ui)',
    }}>
      {/* header: mark + wordmark + toggle (toggle at the TOP so it never scrolls away) */}
      <div style={{
        display: 'flex', flexDirection: ex ? 'row' : 'column', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, width: itemW, flexShrink: 0, marginBottom: 12, transition: widthT,
      }}>
        <a href="/dashboard/" onClick={go('/dashboard')} title="Ignition" style={{
          display: 'flex', alignItems: 'center', gap: 12, height: 32, width: ex ? 'auto' : 44,
          paddingLeft: ex ? 8 : 10, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0,
        }}>
          <img src="/favicon.svg" alt="Ignition" style={{ height: 28, width: 'auto', flexShrink: 0, display: 'block' }} />
          <span style={{ fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700, letterSpacing: '.1em',
            opacity: labelOp, transition: 'opacity 180ms' }}>IGNITION</span>
        </a>
        <button type="button" onClick={toggle} className="ig-ghost-btn"
          title={ex ? 'Collapse sidebar  [' : 'Expand sidebar  ['}
          aria-label={ex ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={ex}
          style={{
            width: 32, height: 32, flexShrink: 0, borderRadius: 9, border: '1px solid var(--border-2)',
            background: 'transparent', color: 'var(--text-3)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', padding: 0,
          }}>
          {ex ? <PanelLeftClose size={16} strokeWidth={1.75} /> : <PanelLeftOpen size={16} strokeWidth={1.75} />}
        </button>
      </div>

      {/* Only the nav scrolls, so the user row stays pinned on short screens (at 768px tall the
          collapsed rail is ~880px of content; it used to push the footer below the fold). */}
      <nav className="ig-rail-nav" style={{
        display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 auto', minHeight: 0,
        overflowY: 'auto', overflowX: 'hidden',
      }} aria-label="Ignition">
        {sections.map((sec, si) => (
          <div key={sec.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{
              position: 'relative', width: itemW, flexShrink: 0,
              height: si === 0 ? (ex ? 28 : 0) : (ex ? 34 : 13),
              transition: `width 240ms ${EASE}, height 240ms ${EASE}`,
            }}>
              {si > 0 && (
                <span style={{ position: 'absolute', left: 8, top: '50%', width: 28, height: 1, background: 'var(--border)',
                  opacity: ex ? 0 : 1, transition: 'opacity 180ms' }} />
              )}
              <span style={{
                position: 'absolute', left: 13, bottom: 6, fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '.14em', color: 'var(--text-4)', whiteSpace: 'nowrap',
                opacity: labelOp, transition: 'opacity 180ms', pointerEvents: 'none',
              }}>{sec.label}</span>
            </span>
            {sec.items.map((it) => {
              const on = onRoute(it.route, pathname);
              const Icon = it.icon;
              return (
                <a key={it.route} href={it.route + '/'} onClick={go(it.route)}
                  title={ex ? undefined : it.label} aria-current={on ? 'page' : undefined}
                  className={`ig-rail-item${on ? ' on' : ''}`}
                  style={{
                    position: 'relative', width: itemW, height: 40, flexShrink: 0, borderRadius: 12,
                    background: on ? 'var(--accent)' : 'transparent', color: on ? '#0a0a0a' : 'var(--text-3)',
                    display: 'flex', alignItems: 'center', gap: 12, padding: '0 13px', overflow: 'hidden', whiteSpace: 'nowrap',
                  }}>
                  {Icon && <Icon size={18} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, fontSize: 14, fontWeight: on ? 700 : 500, opacity: labelOp, transition: 'opacity 180ms' }}>
                    {it.label}
                  </span>
                </a>
              );
            })}
          </div>
        ))}
      </nav>

      {/* footer: user + sign out */}
      <div style={{ marginTop: 'auto', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8, width: itemW, flexShrink: 0, transition: widthT }}>
        {/* The whole user block signs out (prototype). Collapsed it is just the avatar, so one stray
            click would end the session — confirm first (S412 lane review). */}
        <button type="button" onClick={() => { if (window.confirm('Sign out of Ignition?')) onLogout?.(); }} className="ig-rail-user"
          title={`${userLabel}${userRole ? ` · ${userRole}` : ''} — sign out`}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '2px 4px', borderRadius: 12, border: 'none',
            background: 'transparent', color: 'var(--text-1)', overflow: 'hidden', whiteSpace: 'nowrap',
            cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-ui)', width: '100%',
          }}>
          <span style={{
            flexShrink: 0, width: 36, height: 36, borderRadius: '50%', background: 'var(--brand-blue)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-cond)', fontWeight: 700, fontSize: 15,
          }}>{userInitial}</span>
          <span style={{ flex: 1, minWidth: 0, opacity: labelOp, transition: 'opacity 180ms' }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{userLabel}</span>
            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{userRole}</span>
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-4)', opacity: labelOp, transition: 'opacity 180ms' }}>Sign out</span>
        </button>
      </div>
    </aside>
  );
}
