'use client';
import { PRIORITY_MAP } from '../lib/tasks.js';

// Priority tag — a 3-bar glyph colored by severity + the code (P0–P3).
// Pass `onClick` to make it the clickable trigger for a priority menu.
export function PriorityBadge({ priority, onClick }) {
  const p = PRIORITY_MAP[priority] || { short: priority, color: 'var(--text-3)', bars: 0 };
  return (
    <span className="pri" onClick={onClick} title={p.label} style={{ color: p.color }}>
      <span className="bars">
        {[1, 2, 3].map(i => <i key={i} style={{ background: i <= (p.bars || 0) ? p.color : 'var(--border-strong)' }} />)}
      </span>
      {p.short || priority}
    </span>
  );
}

export default PriorityBadge;
