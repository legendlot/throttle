'use client';
/* Global toast feedback — fire from anywhere with toast(msg, tone, icon)
   or window.dispatchEvent(new CustomEvent('throttle:toast', {detail})). */
import React, { useState, useEffect } from 'react';
import { Icon } from './Icon';
import { TONE } from './ui';

export function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const onToast = e => {
      const id = Math.random().toString(36).slice(2);
      const t = { id, msg: e.detail.msg, tone: e.detail.tone || 'ok', icon: e.detail.icon || 'check' };
      setToasts(list => [...list, t]);
      setTimeout(() => setToasts(list => list.filter(x => x.id !== id)), 3200);
    };
    window.addEventListener('throttle:toast', onToast);
    return () => window.removeEventListener('throttle:toast', onToast);
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 500,
      display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'center', pointerEvents: 'none' }}>
      {toasts.map(t => {
        const tn = TONE[t.tone] || TONE.ok;
        return (
          <div key={t.id} className="t-toast" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px 11px 13px',
            background: 'var(--surface)', border: '1px solid var(--border-2)', borderLeft: `3px solid ${tn.fg}`, borderRadius: 'var(--r-sm)',
            boxShadow: 'var(--shadow-pop)', minWidth: 260, maxWidth: 420 }}>
            <span style={{ color: tn.fg, display: 'flex', flexShrink: 0 }}><Icon name={t.icon} size={17} /></span>
            <span style={{ fontSize: 13.5, color: 'var(--t1)', fontFamily: 'var(--font-ui)', lineHeight: 1.35 }}>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

export function toast(msg, tone, icon) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('throttle:toast', { detail: { msg, tone, icon } }));
}
