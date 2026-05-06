'use client';
import { useState, useEffect, useRef } from 'react';
import { createElement, isValidElement } from 'react';

const STYLE = `
.qc-fab {
  position: fixed; bottom: 24px; right: 24px; z-index: 8000;
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--yellow); color: #000;
  border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 300; line-height: 1;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  transition: transform .15s ease, box-shadow .15s ease;
  font-family: var(--mono);
}
.qc-fab:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.6); }
.qc-fab.qc-open { transform: rotate(45deg); }
.qc-menu {
  position: fixed; bottom: 82px; right: 24px; z-index: 8000;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  min-width: 210px;
  animation: qcIn .12s ease;
}
@keyframes qcIn {
  from { opacity: 0; transform: translateY(8px) scale(.97); }
  to   { opacity: 1; transform: translateY(0)   scale(1);   }
}
.qc-group-label {
  font-size: 9px; color: var(--t3); text-transform: uppercase;
  letter-spacing: .12em; padding: 8px 14px 4px;
  font-family: var(--mono); font-weight: 700;
}
.qc-item {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 14px; cursor: pointer;
  font-family: var(--mono); font-size: 11px; color: var(--t2);
  border-top: 1px solid var(--border);
  transition: background .1s, color .1s;
}
.qc-item:first-of-type { border-top: none; }
.qc-item:hover { background: rgba(242,205,26,.07); color: var(--yellow); }
.qc-item-icon { display: flex; align-items: center; color: var(--t3); flex-shrink: 0; }
.qc-item:hover .qc-item-icon { color: var(--yellow); }
`;

function renderIcon(icon) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  return createElement(icon, { size: 13, strokeWidth: 1.75 });
}

export function QuickCreate({ groups = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  if (!groups || groups.length === 0) return null;

  return (
    <>
      <style>{STYLE}</style>
      <div ref={ref}>
        <button
          className={`qc-fab${open ? ' qc-open' : ''}`}
          onClick={() => setOpen(o => !o)}
          aria-label="Quick Create"
        >
          +
        </button>
        {open && (
          <div className="qc-menu">
            {groups.map((group, gi) => (
              <div key={gi}>
                {group.label && <div className="qc-group-label">{group.label}</div>}
                {(group.actions || []).map((action, ai) => (
                  <div
                    key={ai}
                    className="qc-item"
                    onClick={() => { action.onClick(); setOpen(false); }}
                  >
                    {action.icon && (
                      <span className="qc-item-icon">{renderIcon(action.icon)}</span>
                    )}
                    {action.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
