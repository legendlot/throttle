'use client';

export function Modal({
  open,
  onClose,
  title,
  titleColor,
  confirmLabel,
  confirmColor,
  onConfirm,
  loading,
  error,
  children,
}) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#111', border: '1px solid #333', borderRadius: 8,
          minWidth: 380, maxWidth: 560, padding: 20, color: '#eee',
          fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)',
        }}
      >
        {title && (
          <h3 style={{ margin: 0, marginBottom: 12, color: titleColor || '#eee', fontSize: 15 }}>
            {title}
          </h3>
        )}
        <div style={{ marginBottom: 16 }}>{children}</div>
        {error && (
          <div style={{ color: '#ef4444', marginBottom: 12, fontSize: 12 }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            disabled={loading}
            style={{ background: '#222', border: '1px solid #444', color: '#ccc', padding: '6px 14px', borderRadius: 4, cursor: 'pointer' }}
          >
            Cancel
          </button>
          {onConfirm && (
            <button
              onClick={onConfirm}
              disabled={loading}
              style={{
                background: confirmColor === 'red' ? '#ef4444' : (confirmColor || '#3b82f6'),
                border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 4,
                cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? '…' : (confirmLabel || 'Confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
