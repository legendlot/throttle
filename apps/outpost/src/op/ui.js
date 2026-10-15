'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, say } from './api.js';

export { UPC_RE, CTN_RE, BATCH_RE, clean } from './scan.mjs';

export const fmtTime = t => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit' }) : '—');
export const ago = t => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
export const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

// GET a /v/ route; `reload` re-fetches; `every` (ms) polls while mounted.
export function useLoad(path, { every } = {}) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const alive = useRef(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;                   // a slower, older reply (another view, an earlier poll) is dropped
    const r = await get(path);
    if (!alive.current || mine !== seq.current) return;
    setState({ loading: false, data: r.ok ? r.data : null, error: r.ok ? null : say(r) });
  }, [path]);
  useEffect(() => {
    alive.current = true;
    reload();
    const t = every ? setInterval(reload, every) : null;
    return () => { alive.current = false; if (t) clearInterval(t); };
  }, [reload, every]);
  return { ...state, reload };
}

// A keyboard-wedge scanner types into whatever has focus and ends with Enter. While `on`, any keystroke outside a text
// field (a focused button would be CLICKED by that Enter, a focused picker would jump) is pulled into `ref` first.
// Not while a dialog above this screen is open (`.back` deeper than `ownLayer`).
export function useScanCapture(ref, on = true, ownLayer = 0) {
  useEffect(() => {
    if (!on) return undefined;
    const k = () => {
      if (document.querySelectorAll('.back').length > ownLayer) return;
      const a = document.activeElement;
      if (!a || !/^(INPUT|TEXTAREA)$/.test(a.tagName)) ref.current?.focus();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [ref, on, ownLayer]);
}

// Two short tones the floor can hear over a line: high = done, low buzz = refused.
let audio;
export function beep(good) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain();
    o.type = good ? 'sine' : 'square'; o.frequency.value = good ? 1320 : 220;
    g.gain.value = 0.08; o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (good ? 0.12 : 0.35));
  } catch { /* no audio */ }
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="back" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={wide ? { width: 'min(760px, 100%)' } : undefined} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }) {
  return <label className="f"><span>{label}</span>{children}</label>;
}

export const STATUS_TONE = { open: 'blue', closed: 'green', in_transit: 'amber', draft: 'blue', dispatched: 'green', cancelled: '',
  pending: 'blue', leased: 'blue', printed: 'green', outcome_unknown: 'amber', failed: 'red', receiving: 'amber', accepted: 'green', hold: 'red' };
export const Badge = ({ s, children }) => <span className={`badge ${STATUS_TONE[s] || ''}`}>{children || String(s || '').replace(/_/g, ' ')}</span>;

// Supervisor approval on THIS bench for one purpose: op code + PIN → a single-use token (120 s). The action that
// spends it runs in `then(token)`; a refused action never burns it (the worker consumes it inside the transaction).
export function StepUp({ purpose, title, onClose, then, children, ready = true }) {
  const [op, setOp] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async e => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr(null);
    const s = await post('stepup', { purpose, op_code: op, pin });
    if (!s.ok) { setBusy(false); setPin(''); setErr(say(s)); return; }
    const msg = await then(s.data.stepup);
    setBusy(false);
    if (msg) { setErr(msg); setPin(''); }
  };
  return (
    <Modal title={title} onClose={busy ? undefined : onClose}>
      <form onSubmit={go} className="stack">
        {children}
        <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Supervisor code">
            <input className="in mono" inputMode="numeric" maxLength={3} value={op} onChange={e => setOp(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
          </Field>
          <Field label="Supervisor PIN">
            <input className="in mono" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
          </Field>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready || op.length !== 3 || pin.length !== 6}>{busy ? 'Working…' : 'Approve'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Confirm({ title, body, yes = 'Confirm', danger, onClose, onYes }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  return (
    <Modal title={title} onClose={busy ? undefined : onClose}>
      <div className="muted">{body}</div>
      {err && <div className="err">{err}</div>}
      <div className="row end" style={{ marginTop: 18 }}>
        <button className="btn" onClick={onClose} disabled={busy}>Back</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}
          onClick={async () => { setBusy(true); const m = await onYes(); setBusy(false); if (m) setErr(m); }}>{busy ? 'Working…' : yes}</button>
      </div>
    </Modal>
  );
}
