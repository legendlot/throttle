'use client';
// COMMAND top context bar (handoff §4): breadcrumb GROUP / SCREEN (mono,
// uppercase) on the left; a green LIVE · UPDATED h:mm IST pulse + the
// cross-system launcher on the right. Sub-tabs keep their slot for groups
// with more than one screen. Page titles live in each page (PageHead).
import { useEffect, useState } from 'react';
import { matchActive } from './navMatch.js';
import { crumbFor } from '../../lib/nav.js';
import { AppLauncher } from '@throttle/ui';
import { Search } from 'lucide-react';

function istNow() {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
    }).format(new Date());
  } catch { return ''; }
}

export function ContextBar({ groups, pathname, onNav, onSearch }) {
  const match = matchActive(groups, pathname);
  const group = match?.group;
  const activeRoute = match?.item?.route;
  const crumb = crumbFor(groups, pathname);
  const subTabs = group && !group.flat ? (group.items || []) : [];

  // "UPDATED h:mm IST" — re-render once a minute so the stamp stays honest.
  const [now, setNow] = useState(istNow);
  useEffect(() => {
    const t = setInterval(() => setNow(istNow()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="cb cb-slim">
      <div className="cb-left">
        <span className="cb-crumb">{crumb.group}</span>
        {crumb.page && (
          <><span className="cb-slash">/</span><span className="cb-crumb cb-crumb-2">{crumb.page}</span></>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <span className="tb-live"><span className="tb-dot" />LIVE · UPDATED {now} IST</span>
        {/* The ⌘K palette is keyboard-only and the sidebar that reached it is hidden at ≤767px,
            so on a phone it had no trigger. This bar survives on mobile; the button does not
            render on desktop (.mob-search), where the shortcut is unchanged. */}
        {onSearch && (
          <button className="mob-search" onClick={onSearch} title="Search (⌘K)" aria-label="Search">
            <Search size={18} strokeWidth={1.75} />
          </button>
        )}
        <AppLauncher current="relay" />
      </div>
    </div>
  );
}
