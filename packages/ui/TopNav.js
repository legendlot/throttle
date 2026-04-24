'use client';
import { Spinner } from './Spinner.js';

const CSS = `
.tn-bar {
  display: flex; align-items: stretch;
  padding: 0 16px;
  border-bottom: 1px solid var(--surface2, #1f1f1f);
  background: var(--surface, #0a0a0a);
  color: var(--t2, #bbb);
  font-family: var(--mono, ui-monospace, Menlo, monospace);
  font-size: 13px;
  min-height: 44px;
}
.tn-nav { display: flex; align-items: stretch; flex: 1; }
.tn-group { position: relative; }
.tn-group-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 14px;
  height: 100%;
  background: transparent; border: none; cursor: pointer;
  color: var(--t2, #aaa);
  font: inherit; font-size: 12px;
  text-transform: uppercase; letter-spacing: 1px;
  border-bottom: 2px solid transparent;
}
.tn-group-btn:hover { color: var(--t1, #fff); background: var(--surface2, #171717); }
.tn-group.tn-active > .tn-group-btn {
  color: var(--yellow, #f2cd1a);
  background: rgba(242, 205, 26, 0.08);
  border-bottom-color: var(--yellow, #f2cd1a);
}
.tn-caret { font-size: 9px; opacity: 0.6; }
.tn-dropdown {
  display: none;
  position: absolute; top: 100%; left: 0; z-index: 100;
  min-width: 200px;
  background: var(--surface, #0f0f0f);
  border: 1px solid var(--surface2, #222);
  border-top: none;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
  padding: 4px 0;
}
.tn-group:hover > .tn-dropdown,
.tn-group:focus-within > .tn-dropdown { display: block; }
.tn-item {
  display: block; width: 100%; text-align: left;
  padding: 8px 14px;
  background: transparent; border: none; cursor: pointer;
  color: var(--t2, #bbb);
  font: inherit; font-size: 12px;
}
.tn-item:hover { background: var(--surface2, #1a1a1a); color: var(--t1, #fff); }
.tn-item.tn-item-active {
  color: var(--yellow, #f2cd1a);
  background: rgba(242, 205, 26, 0.08);
  font-weight: 600;
}
.tn-right {
  display: flex; align-items: center; gap: 12px;
  padding-left: 16px;
}
.tn-last { font-size: 11px; color: var(--t3, #666); font-family: var(--mono, ui-monospace, Menlo, monospace); }
.tn-logout {
  background: var(--surface2, #1a1a1a);
  border: 1px solid var(--surface2, #333);
  color: var(--t2, #ccc);
  padding: 5px 12px; border-radius: 4px; cursor: pointer;
  font: inherit; font-size: 11px;
  text-transform: uppercase; letter-spacing: 1px;
}
.tn-logout:hover { background: #222; color: var(--t1, #fff); }
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
