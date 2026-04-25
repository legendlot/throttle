'use client';
import { Spinner } from './Spinner.js';

const CSS = `
.tn-bar {
  display: flex;
  align-items: stretch;
  padding: 0 20px;
  height: 48px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: var(--surface, #161616);
  color: var(--t2, #999);
  position: sticky;
  top: 0;
  z-index: 100;
}
.tn-nav { display: flex; align-items: stretch; flex: 1; gap: 2px; }
.tn-group { position: relative; }

.tn-group-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  height: 100%;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--t2, #999);
  font-family: var(--cond, 'Tomorrow', sans-serif);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 3px;
  white-space: nowrap;
  transition: all 0.15s;
}
.tn-group-btn:hover {
  color: var(--t1, #e8e8e8);
  background: var(--surface2, #1e1e1e);
}
.tn-group.tn-active > .tn-group-btn {
  color: var(--yellow, #F2CD1A);
  background: rgba(242, 205, 26, 0.08);
}
.tn-caret { font-size: 9px; opacity: 0.5; margin-left: 1px; }

.tn-dropdown {
  display: none;
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 1000;
  min-width: 180px;
  background: var(--surface, #161616);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.tn-group:hover > .tn-dropdown,
.tn-group:focus-within > .tn-dropdown { display: block; }

.tn-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--t2, #999);
  font-family: var(--cond, 'Tomorrow', sans-serif);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.03em;
  white-space: nowrap;
  transition: all 0.1s;
}
.tn-item:hover {
  background: var(--surface2, #1e1e1e);
  color: var(--t1, #e8e8e8);
}
.tn-item.tn-item-active {
  color: var(--yellow, #F2CD1A);
  background: rgba(242, 205, 26, 0.06);
  font-weight: 600;
}

.tn-right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  padding-left: 16px;
}
.tn-last {
  font-size: 11px;
  color: var(--t3, #555);
  font-family: var(--mono, ui-monospace, monospace);
  letter-spacing: 0.05em;
}
.tn-logout {
  padding: 5px 12px;
  background: transparent;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 3px;
  color: var(--t3, #666);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.15s;
}
.tn-logout:hover {
  border-color: var(--red, #DE2A2A);
  color: var(--red, #DE2A2A);
}
`;

function isItemActive(item, activeTab) {
  return item && (item.id === activeTab || item.route === activeTab);
}
function isGroupActive(group, activeTab) {
  return (group.items || []).some(i => isItemActive(i, activeTab));
}

export function TopNav({ groups = [], activeTab, onTabSelect, rightSlot, onLogout, refreshing, lastRefreshed }) {
  return (
    <header className="tn-bar">
      <style>{CSS}</style>
      <nav className="tn-nav">
        {groups.map((g) => {
          const active = isGroupActive(g, activeTab);
          const items = g.items || [];
          return (
            <div
              key={g.id || g.label}
              className={`tn-group${active ? ' tn-active' : ''}`}
            >
              <button className="tn-group-btn" type="button">
                {g.label}
                <span className="tn-caret">▾</span>
              </button>
              <div className="tn-dropdown" role="menu">
                {items.map((item) => {
                  const itemActive = isItemActive(item, activeTab);
                  return (
                    <button
                      key={item.id || item.route}
                      type="button"
                      role="menuitem"
                      className={`tn-item${itemActive ? ' tn-item-active' : ''}`}
                      onClick={() => onTabSelect && onTabSelect(item)}
                    >
                      {item.label}
                      {item.badge || null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="tn-right">
        {refreshing && <Spinner size="sm" />}
        {lastRefreshed && <span className="tn-last">{lastRefreshed}</span>}
        {rightSlot}
        {onLogout && (
          <button type="button" className="tn-logout" onClick={onLogout}>
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
