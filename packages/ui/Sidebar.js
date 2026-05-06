'use client';
import { useState } from 'react';

const STYLE = `
.sb-wrap {
  display: flex; flex-direction: column; height: 100%;
  background: var(--surface); border-right: 1px solid var(--border);
  transition: width .18s ease; overflow: hidden; flex-shrink: 0;
}
.sb-wrap.sb-expanded { width: 220px; }
.sb-wrap.sb-collapsed { width: 52px; }

.sb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 14px; height: 48px; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.sb-collapsed .sb-header { justify-content: center; padding: 0; cursor: pointer; }
.sb-logo { font-size: 11px; font-weight: 700; letter-spacing: .1em; color: var(--yellow); white-space: nowrap; }
.sb-logo span { color: var(--t3); font-weight: 400; }
.sb-logo-short { font-size: 13px; font-weight: 700; color: var(--yellow); letter-spacing: .06em; }
.sb-toggle {
  width: 22px; height: 22px; background: none;
  border: 1px solid var(--border2); border-radius: 4px;
  color: var(--t3); font-size: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.sb-toggle:hover { border-color: var(--t3); color: var(--t2); }

.sb-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px 0 16px; }
.sb-scroll::-webkit-scrollbar { width: 3px; }
.sb-scroll::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

.sb-section {
  font-size: 9px; letter-spacing: .18em; color: var(--t3);
  text-transform: uppercase; font-weight: 700;
  padding: 10px 16px 4px; white-space: nowrap; overflow: hidden;
}
.sb-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 16px; font-size: 11px; color: var(--t2);
  cursor: pointer; border-left: 2px solid transparent;
  white-space: nowrap; overflow: hidden;
}
.sb-item:hover { color: var(--t1); background: rgba(255,255,255,.025); }
.sb-item.sb-active { color: var(--yellow); background: rgba(242,205,26,.07); border-left-color: var(--yellow); }
.sb-item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }

.sb-group-btn {
  width: 36px; height: 36px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; letter-spacing: .06em;
  cursor: pointer; border-left: 2px solid transparent;
  color: var(--t3); position: relative; margin: 2px auto;
}
.sb-group-btn:hover { background: rgba(255,255,255,.035); color: var(--t2); }
.sb-group-btn.sb-active { background: rgba(242,205,26,.09); color: var(--yellow); border-left-color: var(--yellow); }
.sb-badge-dot {
  position: absolute; top: 4px; right: 4px;
  width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--surface);
}

.sb-collapsed-scroll {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 0; gap: 2px;
}
.sb-collapsed-scroll::-webkit-scrollbar { display: none; }
.sb-divider { width: 28px; height: 1px; background: var(--border); margin: 5px auto; }

.sb-footer {
  border-top: 1px solid var(--border); padding: 10px 14px;
  display: flex; align-items: center; gap: 9px; flex-shrink: 0;
}
.sb-collapsed .sb-footer { justify-content: center; padding: 10px 0; }
.sb-avatar {
  width: 26px; height: 26px; background: var(--surface2);
  border: 1px solid var(--border2); border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--t3); flex-shrink: 0;
}
.sb-user-name { font-size: 11px; color: var(--t2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-user-role { font-size: 9px; color: var(--t3); }
.sb-signout {
  margin-left: auto; background: none; border: none; color: var(--t3);
  font-size: 10px; cursor: pointer; font-family: var(--mono);
  padding: 3px 6px; border-radius: 3px; flex-shrink: 0;
}
.sb-signout:hover { color: var(--red); background: rgba(222,42,42,.08); }
`;

function abbr(label) {
  const words = label.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

function isGroupActive(group, pathname) {
  return (group.items || []).some(i =>
    pathname === i.route || pathname.startsWith(i.route + '/')
  );
}

function groupHasBadge(group) {
  return (group.items || []).some(i => i.badge);
}

function groupBadgeColor(group) {
  const item = (group.items || []).find(i => i.badge && i.badgeColor);
  return item?.badgeColor || 'red';
}

export function Sidebar({
  groups = [],
  activeTab,
  onTabSelect,
  userLabel = '',
  userInitial = '?',
  userRole = '',
  onLogout,
  collapsed,
  onToggle,
  appLabel = 'LOT',
  appShortLabel = 'L',
  appIcon = null,
}) {
  const isCollapsed = !!collapsed;

  function renderExpanded() {
    return (
      <div className="sb-scroll">
        {groups.map((group) => {
          if (group.flat) {
            const isActive = activeTab === group.route || (activeTab || '').startsWith((group.route || '') + '/');
            return (
              <div key={group.id}>
                <div className="sb-section">{group.label}</div>
                <div
                  className={`sb-item${isActive ? ' sb-active' : ''}`}
                  onClick={() => onTabSelect && onTabSelect(group)}
                >
                  <span className="sb-item-label">{group.label}</span>
                  {group.badge || null}
                </div>
              </div>
            );
          }
          return (
            <div key={group.id}>
              <div className="sb-section">{group.label}</div>
              {(group.items || []).map((item, idx) => {
                if (item.separator) return <div key={`sep-${idx}`} style={{ height: 4 }} />;
                const isActive = activeTab === item.route || (activeTab || '').startsWith(item.route + '/');
                return (
                  <div
                    key={item.id}
                    className={`sb-item${isActive ? ' sb-active' : ''}`}
                    onClick={() => onTabSelect && onTabSelect(item)}
                  >
                    <span className="sb-item-label">{item.label}</span>
                    {item.badge || null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  function renderCollapsed() {
    return (
      <div className="sb-collapsed-scroll">
        {groups.map((group, idx) => {
          const active = isGroupActive(group, activeTab || '');
          const hasBadge = groupHasBadge(group);
          const badgeColor = groupBadgeColor(group);
          const badgeBg = badgeColor === 'orange' ? '#f97316' : '#de2a2a';
          const showDivider = idx === 3 || idx === 5;

          const handleClick = () => {
            if (group.flat) {
              onTabSelect && onTabSelect(group);
            } else {
              const firstItem = (group.items || []).find(i => !i.separator);
              if (firstItem) onTabSelect && onTabSelect(firstItem);
            }
          };

          return (
            <div key={group.id} style={{ display: 'contents' }}>
              {showDivider && <div className="sb-divider" />}
              <div
                className={`sb-group-btn${active ? ' sb-active' : ''}`}
                onClick={handleClick}
                title={group.label}
              >
                {abbr(group.label)}
                {hasBadge && (
                  <div className="sb-badge-dot" style={{ background: badgeBg }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const initial = userInitial || (userLabel ? userLabel[0].toUpperCase() : '?');
  const [labelPart, subPart] = appLabel.includes('/') ? appLabel.split('/').map(s => s.trim()) : [appLabel, null];

  return (
    <>
      <style>{STYLE}</style>
      <div className={`sb-wrap ${isCollapsed ? 'sb-collapsed' : 'sb-expanded'}`}>

        <div className="sb-header" onClick={isCollapsed ? onToggle : undefined}>
          {isCollapsed ? (
            appIcon
              ? <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{appIcon}</span>
              : <span className="sb-logo-short">{appShortLabel}</span>
          ) : (
            <>
              <span className="sb-logo" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {appIcon}
                <span>{labelPart}{subPart && <span> / {subPart}</span>}</span>
              </span>
              <button
                className="sb-toggle"
                onClick={(e) => { e.stopPropagation(); onToggle && onToggle(); }}
              >
                ‹
              </button>
            </>
          )}
        </div>

        {isCollapsed ? renderCollapsed() : renderExpanded()}

        <div className="sb-footer">
          <div className="sb-avatar">{initial}</div>
          {!isCollapsed && (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="sb-user-name">{userLabel}</div>
                <div className="sb-user-role">{userRole}</div>
              </div>
              {onLogout && (
                <button className="sb-signout" onClick={onLogout}>out</button>
              )}
            </>
          )}
        </div>

      </div>
    </>
  );
}
