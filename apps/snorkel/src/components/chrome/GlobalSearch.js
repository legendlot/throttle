'use client';
// Spotlight-style grouped search dropdown. Presentational — given grouped
// results, renders the panel and navigates on pick.
import { Icon } from '../Icon.js';
import { ArrowRight, SearchX } from 'lucide-react';

export function GlobalSearch({ query, groups, onNav, onPick, collapsed }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const left = (collapsed ? 66 : 234) + 18;
  return (
    <>
      <div className="gs-backdrop" style={{ left: collapsed ? 66 : 234 }} onClick={onPick} />
      <div className="gs-panel" style={{ left }}>
        <div className="gs-head">{total} result{total === 1 ? '' : 's'} for &ldquo;{query}&rdquo;</div>
        {total === 0
          ? <div className="gs-empty"><SearchX size={17} /> Nothing matches. Try a PO number, vendor, or partner.</div>
          : groups.map(g => (
            <div className="gs-group" key={g.label}>
              <div className="gs-glabel">{g.label}</div>
              {g.items.map((r, i) => (
                <button className="gs-row" key={i} onClick={() => { onNav(r.route); onPick(); }}>
                  <span className="gs-ico"><Icon name={r.icon} size={15} /></span>
                  <span className="gs-main">{r.primary}</span>
                  <span className="gs-sec">{r.secondary}</span>
                  <ArrowRight size={14} className="gs-go" />
                </button>
              ))}
            </div>
          ))}
      </div>
    </>
  );
}
