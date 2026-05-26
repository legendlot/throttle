'use client';
import { useEffect } from 'react';

export function Modal({
  open,
  onClose,
  title,
  titleColor,
  confirmLabel,
  confirmColor,
  confirmStyle,
  onConfirm,
  loading,
  error,
  size = 'md',
  footer,
  children,
}) {
  // Close on Escape — only listens while this modal is actually open.
  useEffect(() => {
    if (!open) return;
    function handleEsc(e) {
      if (e.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;
  const maxWidth = size === 'lg' ? 740 : 560;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9000, padding: '16px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111', border: '1px solid #333', borderRadius: 8,
          width: '100%', maxWidth, maxHeight: '90dvh', overflowY: 'auto',
          padding: 20, color: '#eee',
          fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 12, right: 12,
            background: 'none', border: 'none', color: 'var(--t3)',
            fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '2px 6px',
            borderRadius: 4,
          }}
          aria-label="Close"
        >×</button>

        {title && (
          <h3 style={{
            margin: 0, marginBottom: 16, marginRight: 28,
            color: titleColor || 'var(--t1)', fontSize: 15,
            fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            {title}
          </h3>
        )}

        <div style={{ marginBottom: (onConfirm || footer) ? 16 : 0 }}>{children}</div>

        {error && (
          <div style={{ color: '#ef4444', marginBottom: 12, fontSize: 12 }}>{error}</div>
        )}
        {footer ? (
          <div style={{ marginTop: 16 }}>{footer}</div>
        ) : onConfirm && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              onClick={onClose}
              disabled={loading}
              style={{
                background: '#222', border: '1px solid #444', color: '#ccc',
                padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 12,
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              style={{
                background: confirmColor === 'red' ? '#ef4444' : (confirmColor || '#3b82f6'),
                border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 4,
                cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1,
                fontFamily: 'var(--mono)', fontSize: 12,
                ...(confirmStyle || {}),
              }}
            >
              {loading ? '…' : (confirmLabel || 'Confirm')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
