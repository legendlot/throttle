'use client';
import { useEffect } from 'react';
import { X } from 'lucide-react';

// Ignition-local Modal — the EXACT props API and behaviour of @throttle/ui Modal (packages/ui/Modal.js),
// restyled in Pit Control. The shared one hard-codes #111/#222/#333 and an rgba(0,0,0,.75) scrim, so
// it cannot pick up the Ignition palette; @throttle/ui stays untouched for the other apps.
// Behaviour kept 1:1: Escape + scrim close only when dismissOnBackdrop; × always closes; Cancel is
// disabled while loading; Confirm is disabled while loading || confirmDisabled and reads '…' while
// loading; `footer` replaces the Cancel/Confirm row; size 'lg' widens the panel.
export function Modal({
  open,
  onClose,
  title,
  titleColor,
  confirmLabel,
  confirmColor,
  confirmStyle,
  onConfirm,
  confirmDisabled = false,
  dismissOnBackdrop = true,
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
      if (e.key === 'Escape' && dismissOnBackdrop) onClose?.();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose, dismissOnBackdrop]);

  if (!open) return null;
  const maxWidth = size === 'lg' ? 740 : 560;
  const danger = confirmColor === 'red';
  const confirmBg = danger ? 'var(--brand-red)' : (confirmColor || 'var(--accent)');
  const confirmFg = danger ? '#fff' : 'var(--accent-fg)';
  const busyOrBlocked = loading || confirmDisabled;
  return (
    <div
      className="ig-fade"
      onClick={dismissOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0, background: 'var(--scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9000, padding: '16px',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="ig-pop"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border-3)', borderRadius: 20,
          boxShadow: 'var(--shadow-modal)',
          width: '100%', maxWidth, maxHeight: '90dvh', overflowY: 'auto',
          padding: 22, color: 'var(--text-1)', fontFamily: 'var(--font-ui)', fontSize: 14,
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          className="ig-ghost-btn"
          style={{
            position: 'absolute', top: 16, right: 16, width: 32, height: 32,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: '1px solid transparent', color: 'var(--text-3)',
            cursor: 'pointer', borderRadius: 9, padding: 0,
          }}
          aria-label="Close"
        ><X size={17} strokeWidth={1.75} /></button>

        {title && (
          <h3 style={{
            margin: 0, marginBottom: 16, marginRight: 40, lineHeight: 1.2,
            color: titleColor || 'var(--text-1)', fontSize: 20, fontWeight: 700,
            fontFamily: 'var(--font-cond)',
          }}>
            {title}
          </h3>
        )}

        <div style={{ marginBottom: (onConfirm || footer) ? 16 : 0 }}>{children}</div>

        {error && (
          <div style={{ color: 'var(--state-error-fg)', marginBottom: 12, fontSize: 13 }}>{error}</div>
        )}
        {footer ? (
          <div style={{ marginTop: 16 }}>{footer}</div>
        ) : onConfirm && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              onClick={onClose}
              disabled={loading}
              className="ig-ghost-btn"
              style={{
                background: 'transparent', border: '1px solid var(--border-3)', color: 'var(--text-2)',
                height: 40, padding: '0 16px', borderRadius: 10, cursor: 'pointer',
                fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={busyOrBlocked}
              className={busyOrBlocked ? undefined : 'ig-cta'}
              style={{
                background: confirmBg, border: 'none', color: confirmFg,
                height: 40, padding: '0 18px', borderRadius: 10,
                cursor: loading ? 'wait' : (confirmDisabled ? 'not-allowed' : 'pointer'),
                opacity: busyOrBlocked ? 0.6 : 1,
                fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700,
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

export default Modal;
