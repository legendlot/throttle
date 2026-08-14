'use client';
// COMMAND sidebar (handoff §4): standalone Overview + task-based groups, always
// visible (no accordions) — the group label is a mono eyebrow, the active item
// gets an accent-soft fill + a 3px accent bar bleeding off its left edge.
// Header click toggles the 256px rail ↔ 68px icon rail (persisted by the layout).
// A ⌘K launcher replaces the old filter field; the ON AIR rail above the user
// footer mirrors the currently-sending broadcast.
import { Search, PanelLeftClose, RadioTower } from 'lucide-react';
import { matchActive } from './navMatch.js';

export function Sidebar({
  groups, pathname, onNav, onair,
  userLabel, userInitial, userRole, onLogout,
  collapsed, onToggle, onOpenPalette,
}) {
  const match = matchActive(groups, pathname);
  const activeRoute = match?.item?.route;

  const renderItem = (it) => {
    const ItIcon = it.icon;
    const active = it.route === activeRoute;
    return (
      <button key={it.id || it.route}
        className={`sb-item ${active ? 'on' : ''}`}
        data-label={it.label}
        title={collapsed ? it.label : undefined}
        onClick={() => onNav(it.route)}>
        {ItIcon && <ItIcon size={19} strokeWidth={1.75} style={{ flexShrink: 0 }} />}
        {!collapsed && <span className="sb-item-l">{it.label}</span>}
      </button>
    );
  };

  const onairPct = onair && onair.total > 0 ? Math.min(100, Math.round((onair.sent / onair.total) * 100)) : 0;
  // "attempted", not "sent" — the numerator counts every settled message including FAILURES, and
  // on WhatsApp ~40% fail at Meta's engagement-quality block (wa_131049). Calling that "sent"
  // overstated real delivery by a third on the 2026-08-14 broadcast. Attempted is the right
  // numerator for a PROGRESS bar (it must reach 100% when the fan-out ends); it just needs the
  // honest word. True delivery lives on the campaign's own stats.
  const onairProg = onair ? `${Number(onair.sent || 0).toLocaleString('en-IN')} / ${Number(onair.total || 0).toLocaleString('en-IN')} attempted` : '';

  return (
    <aside className={`sb ${collapsed ? 'sb-col' : ''}`}>
      {/* whole header toggles collapse (§4) */}
      <div className="sb-head" onClick={onToggle} title="Collapse / expand sidebar">
        <div className="sb-brand">
          {/* The Relay brand mark (Orchestration Hub pack, public/brand/relay/) —
              yellow tile + ink hub-and-spokes, same asset family as the favicon +
              login page. The SVG tile fills its whole viewBox (no internal
              padding), so it renders at the slot size exactly. */}
          <div className="sb-mark"><img src="/favicon.svg" alt="Relay" style={{ width: 34, height: 34, display: 'block' }} /></div>
          {!collapsed && (
            <span className="sb-word-wrap">
              <span className="sb-word">RELAY</span>
              <span className="sb-sub">CONTROL TOWER</span>
            </span>
          )}
        </div>
        {!collapsed && <span className="sb-collapse"><PanelLeftClose size={17} /></span>}
      </div>

      {/* ⌘K launcher */}
      {collapsed
        ? (
          <button className="sb-search-ico" onClick={onOpenPalette} aria-label="Search — ⌘K" title="Search — ⌘K">
            <Search size={17} />
          </button>
        ) : (
          <button className="sb-search" onClick={onOpenPalette} aria-label="Search or jump to — ⌘K">
            <Search size={16} style={{ color: '#6f747b', flexShrink: 0 }} />
            <span className="sb-search-t">Search or jump to…</span>
            <kbd>⌘K</kbd>
          </button>
        )}

      <nav className="sb-nav">
        {groups.map((g, gi) => {
          if (g.flat) {
            return (
              <div className="sb-group" key={g.id}>
                {collapsed && gi > 0 && <div className="sb-divider" />}
                {renderItem({ id: g.id, label: g.label, route: g.route, icon: g.icon })}
              </div>
            );
          }
          return (
            <div className="sb-group" key={g.id}>
              {collapsed
                ? <div className="sb-divider" />
                : <div className="sb-section">{g.label}</div>}
              {(g.items || []).map(renderItem)}
            </div>
          );
        })}
      </nav>

      {/* ON AIR rail (§6) — the currently-sending broadcast, live progress */}
      {onair && (collapsed
        ? (
          <button className="sb-onair-ico" onClick={() => onNav('/campaigns')}
            title={`ON AIR — ${onair.name} · ${onairProg}`}>
            <RadioTower size={19} strokeWidth={1.75} />
            <span className="sb-onair-dot" />
          </button>
        ) : (
          <button className="sb-onair" onClick={() => onNav('/campaigns')} title="Open campaigns">
            <span className="sb-onair-head">
              <span className="sb-onair-dot" />
              <span className="sb-onair-l">ON AIR</span>
            </span>
            <span className="sb-onair-name" style={{ display: 'block' }}>{onair.name}</span>
            {onair.total > 0 && <span className="sb-onair-prog" style={{ display: 'block' }}>{onairProg}</span>}
            <span className="sb-onair-track" style={{ display: 'block' }}>
              <span className="sb-onair-fill" style={{ display: 'block', width: `${onairPct}%` }} />
            </span>
          </button>
        ))}

      <div className="sb-foot">
        <div className="sb-avatar" onClick={onLogout} title="Sign out" style={{ cursor: onLogout ? 'pointer' : 'default' }}>{userInitial}</div>
        {!collapsed && (
          <div className="sb-id">
            <div className="sb-user">{userLabel}</div>
            <div className="sb-role">{userRole}</div>
          </div>
        )}
        {!collapsed && <span className="sb-live" title="Live"><span className="tb-dot" /></span>}
      </div>
    </aside>
  );
}
