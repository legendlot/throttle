'use client';
// Admin "All settings" pieces (ClickUp redesign P7). The P1 context sidebar's Admin
// sub-nav is THE settings nav (AdminTabs is gone); each page is a title + content cards.
import { cx } from './ui/util.js';

export function AdminHead({ title, lede, action }) {
  return (
    <div className="adm-head">
      <div className="adm-head-tx">
        <h1 className="adm-title">{title}</h1>
        {lede && <p className="adm-lede">{lede}</p>}
      </div>
      {action && <div className="adm-head-act">{action}</div>}
    </div>
  );
}

// On/off switch. Same click contract as the old On/Off button: `onClick` flips it.
export function Switch({ on, label, disabled, onClick }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled}
      className={cx('adm-switch', on && 'on')} onClick={onClick}>
      <span className="adm-switch-k" aria-hidden />
    </button>
  );
}
