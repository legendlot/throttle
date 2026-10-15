'use client';
// Small pieces shared by the Depot › Outpost pages.
import { useEffect, useState } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { Modal, useToast } from '@throttle/ui';
import { Panel, btnGhost, btnPrimary, inputStyle } from '../kit/index.js';
import { opGet, rememberVendor, rememberedVendor } from '../../lib/outpost.js';

export const label = { fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: 6 };
export const text = { fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 };
export const mono = { fontFamily: 'var(--font-mono, ui-monospace, Menlo, monospace)', fontSize: 12.5 };
export const smallBtn = { ...btnGhost, padding: '4px 10px', fontSize: 11.5 };
export const dangerBtn = { ...smallBtn, color: 'var(--bad-fg)', borderColor: 'var(--bad-fg)' };

export function Field({ name, hint, children, style }) {
  return (
    <label style={{ display: 'block', ...style }}>
      <div style={label}>{name}</div>
      {children}
      {hint && <div style={{ ...text, fontSize: 11.5, color: 'var(--t3)', marginTop: 5 }}>{hint}</div>}
    </label>
  );
}

export const Input = props => <input {...props} style={{ ...inputStyle, ...props.style }} />;
export function Select({ children, ...props }) {
  return <select {...props} style={{ ...inputStyle, ...props.style }}>{children}</select>;
}

export function Toggle({ on, onChange, disabled, title }) {
  return (
    <button type="button" onClick={() => onChange(!on)} disabled={disabled} title={title}
      style={{ width: 38, height: 22, borderRadius: 'var(--r-full)', border: 'none', position: 'relative', flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', background: on ? 'var(--ok-fg)' : 'var(--surface-3)', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left var(--fast)' }} />
    </button>
  );
}

// Show a one-time secret (enrolment code, PIN, login code). Never stored: closing it is the last time anyone sees it.
export function SecretModal({ secret, onClose }) {
  const { showToast } = useToast();
  if (!secret) return null;
  return (
    <Modal open onClose={onClose} title={secret.title} dismissOnBackdrop={false}>
      <div style={{ ...text, marginBottom: 14 }}>{secret.lead}</div>
      {secret.items.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <div style={{ ...label, marginBottom: 0, width: 120 }}>{k}</div>
          <div style={{ ...mono, fontSize: 26, letterSpacing: '0.18em', color: 'var(--t1)', fontWeight: 700 }}>{v}</div>
          <button style={smallBtn} onClick={() => navigator.clipboard?.writeText(String(v)).then(() => showToast('Copied', 'success'))}>Copy</button>
        </div>
      ))}
      <div style={{ ...text, color: 'var(--warn-fg, var(--yellow))', marginTop: 12 }}>
        Shown once only. Send it by hand (WhatsApp or email) — Outpost keeps only a hash and cannot show it again.
        {secret.expires && <> Expires {secret.expires}.</>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button style={btnPrimary} onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// A yes/no with consequences spelled out; resolves onYes while it shows "Working…".
export function Confirm({ ask, onClose }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!ask) return null;
  return (
    <Modal open onClose={busy ? undefined : onClose} title={ask.title} confirmLabel={busy ? 'Working…' : ask.yes || 'Confirm'}
      confirmColor={ask.danger ? 'var(--bad-fg)' : undefined} loading={busy} error={err}
      onConfirm={async () => {
        setBusy(true); setErr(null);
        try { await ask.onYes(); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>
      <div style={text}>{ask.body}</div>
    </Modal>
  );
}

// Page gate: the worker refuses anyone without outpost_owner; say so up front instead of a page of errors.
export function OwnerGate({ children }) {
  const { perms } = useAuth();
  if (perms && !hasPermission(perms, 'outpost_owner')) {
    return (
      <Panel pad={20} style={{ maxWidth: 640 }}>
        <div style={text}><strong>Outpost is owner-only.</strong> Your role does not have the <code>outpost_owner</code> permission.
          Ask an admin if you need to manage vendors, benches or work orders.</div>
      </Panel>
    );
  }
  return children;
}

// The Outpost vendors (vendor_config rows) + which one is selected, remembered per browser.
export function useOutpostVendors(session, userId) {
  const [state, setState] = useState({ loading: true, error: null, vendors: [], killAll: null });
  const [vendorId, setVendorIdRaw] = useState(null);
  const load = async () => {
    try {
      const d = await opGet('getVendors', {}, session);
      setState({ loading: false, error: null, vendors: d.vendors || [], killAll: d.kill_all });
      setVendorIdRaw(cur => {
        const ids = (d.vendors || []).map(v => v.vendor_id);
        const want = cur || rememberedVendor();
        return ids.includes(want) ? want : ids[0] || null;
      });
    } catch (e) { setState(s => ({ ...s, loading: false, error: e.message })); }
  };
  // Keyed on userId (not the session object): a token refresh would otherwise reload under an open form.
  useEffect(() => { if (userId) load(); /* eslint-disable-next-line */ }, [userId]);
  const setVendorId = id => { setVendorIdRaw(id); rememberVendor(id); };
  return { ...state, vendorId, setVendorId, reload: load };
}

export function ErrorPanel({ error, onRetry }) {
  return (
    <Panel pad={18} style={{ borderColor: 'var(--bad-fg)' }}>
      <div style={{ ...text, color: 'var(--bad-fg)' }}>{error}</div>
      {onRetry && <button style={{ ...smallBtn, marginTop: 10 }} onClick={onRetry}>Try again</button>}
    </Panel>
  );
}
