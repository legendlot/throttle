'use client';
// Docket-local topbar. Replaces the shared @throttle/ui Topbar for Docket ONLY.
// Single source of the page name (screens no longer repeat it), a context label
// and a count pill on board views, plus the "?" shortcuts button and Live dot.
import { PanelLeft, Lock } from 'lucide-react';

export function DocketTopbar({ title, context, count, isSpace, onToggleSidebar, onHelp }) {
  return (
    <div className="topbar">
      <button className="collapse-btn" onClick={onToggleSidebar} title="Toggle sidebar  ( [ )"><PanelLeft size={16} /></button>
      <div className="tb-title">
        {isSpace && <Lock size={14} style={{ color: 'var(--accent)' }} />}
        <h1>{title}</h1>
        {context && <span className="ctx">{context}</span>}
      </div>
      {count != null && <span className="tb-count">{count}</span>}
      <div className="tb-spacer" />
      <button className="kbd-btn" title="Keyboard shortcuts  ( ? )" onClick={onHelp}>?</button>
      <span className="tb-live"><span className="pulse" />Live</span>
    </div>
  );
}

export default DocketTopbar;
