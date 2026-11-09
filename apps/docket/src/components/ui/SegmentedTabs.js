'use client';
// Views-bar tabs: 32px, 12px/600, 2px yellow underline on the active tab.
// ←/→ move between tabs.
import { useRef } from 'react';
import { cx, renderIcon } from './util.js';

export function SegmentedTabs({ tabs = [], value, onChange, label, className, ...rest }) {
  const ref = useRef(null);
  function onKey(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const live = tabs.filter(t => !t.disabled);
    const i = live.findIndex(t => t.value === value);
    const next = live[(i + (e.key === 'ArrowRight' ? 1 : -1) + live.length) % live.length];
    if (next) { e.preventDefault(); onChange?.(next.value); ref.current?.querySelector(`[data-tab="${next.value}"]`)?.focus(); }
  }
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx('ui-tabs', className)} onKeyDown={onKey} {...rest}>
      {tabs.map(t => {
        const on = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" data-tab={t.value} aria-selected={on} tabIndex={on ? 0 : -1}
            disabled={t.disabled} className={cx('ui-tab', on && 'is-active')} onClick={() => onChange?.(t.value)}>
            {renderIcon(t.icon, 14)}
            <span>{t.label}</span>
            {t.count != null && <span className="ui-tab-count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
