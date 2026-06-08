'use client';
import { PRIORITY_MAP } from '../lib/tasks.js';

// Priority tag — a colored severity dot + the code (P0–P3). The dot reads clearly
// at a glance (the old 3-bar glyph rendered like a "⋮" menu and was illegible).
// Pass `onClick` to make it the clickable trigger for a priority menu.
export function PriorityBadge({ priority, onClick }) {
  const p = PRIORITY_MAP[priority] || { short: priority, color: 'var(--text-3)' };
  return (
    <span className="pri" onClick={onClick} title={p.label} style={{ color: p.color }}>
      <span className="pdot" style={{ background: p.color }} />
      {p.short || priority}
    </span>
  );
}

export default PriorityBadge;
