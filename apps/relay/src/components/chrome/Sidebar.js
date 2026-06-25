'use client';
// Snorkel-local Sidebar — auto-collapsing sections + in-sidebar search +
// icon-rail collapse. Wired to the real NAV_GROUPS (already perm-filtered) and
// router. Does NOT touch the shared @throttle/ui Sidebar.
import { useState, useEffect } from 'react';
import { Search, X, PanelLeftClose } from 'lucide-react';
import { matchActive } from './navMatch.js';

function Chev({ open }) {
  return (
    <svg className={`sb-chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function Sidebar({
  groups, pathname, onNav, appIcon,
  userLabel, userInitial, userRole, onLogout,
  collapsed, onToggle, search, onSearch,
}) {
  const match = matchActive(groups, pathname);
  const activeGroupId = match?.group?.id;
  const activeRoute = match?.item?.route;

  // auto mode: only the active section is open; follow navigation.
  const [open, setOpen] = useState({});
  useEffect(() => {
    setOpen(() => {
      const o = {};
      groups.forEach(g => { o[g.id] = g.id === activeGroupId; });
      return o;
    });
  }, [activeGroupId, groups]);

  function toggleSection(id) {
    setOpen(o => {
      const n = {};
      groups.forEach(g => { n[g.id] = g.id === id ? !o[id] : false; });
      return n;
    });
  }

  const renderItem = (it) => {
    const ItIcon = it.icon;
    const active = it.route === activeRoute;
    return (
      <button key={it.id || it.route}
        className={`sb-item ${active ? 'on' : ''}`}
        data-label={it.label}
        onClick={() => onNav(it.route)}>
        {ItIcon && <ItIcon size={18} strokeWidth={1.9} style={{ flexShrink: 0 }} />}
        {!collapsed && <span className="sb-item-l">{it.label}</span>}
      </button>
    );
  };

  return (
    <aside className={`sb ${collapsed ? 'sb-col' : ''}`}>
      <div className="sb-head">
        <div className="sb-brand" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
          <div className="sb-mark">{appIcon}</div>
          {!collapsed && <span className="sb-word">RELAY</span>}
        </div>
        {!collapsed && (
          <button className="sb-collapse" onClick={onToggle} aria-label="Collapse">
            <PanelLeftClose size={17} />
          </button>
        )}
      </div>

      {collapsed
        ? <button className="sb-search-ico" onClick={onToggle} aria-label="Search"><Search size={16} /></button>
        : (
          <div className="sb-search">
            <Search size={15} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
            <input data-search-primary value={search} onChange={e => onSearch(e.target.value)} placeholder="Search" />
            {search
              ? <button className="sb-search-x" onClick={() => onSearch('')} aria-label="Clear"><X size={13} /></button>
              : <kbd>/</kbd>}
          </div>
        )}

      <nav className="sb-nav">
        {groups.map(g => {
          if (g.flat) {
            // single flat item (e.g. System Manual) — no section header
            return (
              <div className="sb-group" key={g.id}>
                {collapsed && <div className="sb-divider" />}
                <div className="sb-items open"><div>{renderItem({ id: g.id, label: g.label, route: g.route, icon: g.icon })}</div></div>
              </div>
            );
          }
          const isOpen = collapsed ? true : !!open[g.id];
          const hasActive = g.id === activeGroupId;
          return (
            <div className="sb-group" key={g.id}>
              {collapsed
                ? <div className="sb-divider" />
                : (
                  <button className={`sb-section ${hasActive ? 'has-active' : ''}`} onClick={() => toggleSection(g.id)}>
                    <span>{g.label}</span>
                    <Chev open={isOpen} />
                  </button>
                )}
              <div className={`sb-items ${isOpen ? 'open' : ''}`}>
                <div>{(g.items || []).map(renderItem)}</div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="sb-foot">
        <div className="sb-avatar" onClick={onLogout} title="Sign out" style={{ cursor: onLogout ? 'pointer' : 'default' }}>{userInitial}</div>
        {!collapsed && (
          <div className="sb-id">
            <div className="sb-user">{userLabel}</div>
            <div className="sb-role">{userRole}</div>
          </div>
        )}
        {!collapsed && <span className="sb-live" title="Live data"><span className="tb-dot" /></span>}
      </div>
    </aside>
  );
}
