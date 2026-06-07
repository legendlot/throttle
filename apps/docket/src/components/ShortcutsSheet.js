'use client';
// Centered keyboard-shortcuts sheet. Opened from the topbar "?" button or the
// global "?" key; closes on backdrop click or Esc (handled by the layout).
import { ListChecks, X } from 'lucide-react';

const BINDINGS = [
  ['/', 'Search'],
  ['c', 'Capture a task'],
  ['f', 'Filter'],
  ['g', 'Group by'],
  ['[', 'Toggle sidebar'],
  ['↑↓ jk', 'Move between tasks'],
  ['Enter', 'Open task'],
  ['x', 'Toggle done'],
  ['→← lh', 'Expand / collapse sub-tasks'],
  ['s', 'Add sub-task'],
  ['Esc', 'Close panel'],
  ['?', 'This sheet'],
];

export function ShortcutsSheet({ onClose }) {
  return (
    <div className="backdrop" style={{ justifyContent: 'center', alignItems: 'center' }} onMouseDown={onClose}>
      <div className="help-card" onMouseDown={e => e.stopPropagation()}>
        <div className="help-head">
          <ListChecks size={16} style={{ color: 'var(--accent)' }} /> Keyboard shortcuts
          <button className="dr-icon" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="help-grid">
          {BINDINGS.map(([k, d]) => (
            <div key={d} className="help-row">
              <span className="help-keys">{k.split(' ').map((kk, i) => <span key={i} className="kbd">{kk}</span>)}</span>
              <span className="help-desc">{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ShortcutsSheet;
