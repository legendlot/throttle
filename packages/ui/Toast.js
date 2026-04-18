'use client';
import { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(null);

const TYPE_COLOR = {
  success: '#22c55e',
  error:   '#ef4444',
  info:    '#3b82f6',
  warning: '#f59e0b',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = 'info', ms = 3500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: '#111',
              border: `1px solid ${TYPE_COLOR[t.type] || '#3b82f6'}`,
              color: '#fff',
              padding: '8px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              minWidth: 220,
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
