'use client';
import { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      {/* Toast container */}
      <div style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 9999,
        pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div
            key={t.id}
            onClick={() => removeToast(t.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#1e1e1e',
              border: `1px solid ${
                t.type === 'error'   ? '#DE2A2A' :
                t.type === 'warning' ? '#f59e0b' :
                '#3a3a3a'
              }`,
              borderLeft: `3px solid ${
                t.type === 'error'   ? '#DE2A2A' :
                t.type === 'warning' ? '#f59e0b' :
                '#F2CD1A'
              }`,
              borderRadius: 6,
              padding: '10px 14px',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
              pointerEvents: 'all',
              cursor: 'pointer',
              minWidth: 220,
              maxWidth: 360,
              animation: 'slideUp .2s ease',
            }}
          >
            <span style={{ flexShrink: 0 }}>
              {t.type === 'error' ? '✗' : t.type === 'warning' ? '⚠' : '✓'}
            </span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fail-soft: components rendered outside a ToastProvider (e.g. /login)
    // shouldn't crash — just return a no-op.
    return () => {};
  }
  return ctx;
}
