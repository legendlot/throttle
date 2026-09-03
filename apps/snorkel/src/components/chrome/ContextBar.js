'use client';
// Slim top strip: area breadcrumb + segmented sub-tabs + LIVE dot.
// The page title lives in each page (PageHead), not here.
import { matchActive } from './navMatch.js';
import { AppLauncher } from '@throttle/ui';
import { Search } from 'lucide-react';

export function ContextBar({ groups, pathname, onNav, onSearch }) {
  const match = matchActive(groups, pathname);
  const group = match?.group;
  const activeRoute = match?.item?.route;
  const isDeeper = activeRoute && pathname !== activeRoute && pathname.startsWith(activeRoute + '/');
  const subTabs = group && !group.flat ? (group.items || []) : [];

  return (
    <div className="cb cb-slim">
      <div className="cb-left">
        <span className="cb-crumb">{group ? group.label : 'SNORKEL'}</span>
        {isDeeper && match?.item?.label && (
          <><span className="cb-slash">/</span><span className="cb-crumb cb-crumb-2">{match.item.label}</span></>
        )}
        {subTabs.length > 1 && (
          <div className="cb-tabs">
            {subTabs.map(it => {
              const on = it.route === activeRoute;
              return (
                <button key={it.id || it.route} className={`cb-tab ${on ? 'on' : ''}`} onClick={() => onNav(it.route)}>
                  {it.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
        <span className="tb-live"><span className="tb-dot" />LIVE</span>
        {/* Snorkel's search box lives INSIDE the sidebar, which is display:none at ≤767px — so on
            a phone there was nowhere to type. This bar survives on mobile; the button opens the
            search row below it. Desktop never renders it (.mob-search) — the sidebar box is there. */}
        {onSearch && (
          <button className="mob-search" onClick={onSearch} title="Search" aria-label="Search">
            <Search size={18} strokeWidth={1.75} />
          </button>
        )}
        <AppLauncher current="snorkel" />
      </div>
    </div>
  );
}
