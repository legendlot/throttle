'use client';
// Outpost — the vendor floor app. Gate order: this browser enrolled as a bench? → an operator logged in? → the floor.
import { useCallback, useEffect, useState } from 'react';
import { enrolDevice, forgetDevice, get, initDevice, onAuthEvent, post, say, setSession, watchSession } from './api.js';
import { Field } from './ui.js';
import Floor from './Floor.js';

export default function OutpostApp() {
  const [phase, setPhase] = useState('boot');     // boot | enrol | revoked | agent | login | floor | down
  const [me, setMe] = useState(null);
  const [note, setNote] = useState(null);

  const refresh = useCallback(async () => {
    const dev = await initDevice().catch(() => null);
    if (!dev) { setPhase('enrol'); return; }
    const r = await get('/v/me');
    if (!r.ok) {
      if (r.error === 'device_not_enrolled') { setPhase('revoked'); return; }
      setNote(say(r)); setPhase('down'); return;
    }
    setMe(r.data);
    if (r.data.device.kind !== 'bench') { setPhase('agent'); return; }
    setPhase(r.data.operator ? 'floor' : 'login');
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => watchSession(), []);
  useEffect(() => onAuthEvent(e => {
    if (e === 'logged_out') { setNote('Your session ended. Please log in again.'); setPhase(p => (p === 'floor' ? 'login' : p)); }
    if (e === 'device_revoked') setPhase('revoked');
  }), []);

  if (phase === 'boot') return <div className="center muted">Starting Outpost…</div>;
  if (phase === 'enrol') return <Enrol onDone={refresh} />;
  if (phase === 'revoked') return <Revoked onReset={async () => { await forgetDevice(); setSession(null); setPhase('enrol'); }} />;
  if (phase === 'down') return (
    <div className="center"><div className="card" style={{ width: 'min(440px, 100%)' }}>
      <h2>Can’t reach Outpost</h2><p className="muted">{note}</p>
      <button className="btn primary wide" style={{ marginTop: 16 }} onClick={() => { setPhase('boot'); refresh(); }}>Try again</button>
    </div></div>
  );
  if (phase === 'agent') return (
    <div className="center"><div className="card" style={{ width: 'min(440px, 100%)' }}>
      <h2>This device is a print agent</h2>
      <p className="muted">It is enrolled for printing, not for the floor app. Enrol bench laptops with a <b>bench</b> code from LOT.</p>
    </div></div>
  );
  if (phase === 'login') return <Login me={me} note={note} onDone={() => { setNote(null); refresh(); }} />;
  // A logout the worker could not record (502 revoke_failed) leaves the session live: say so, stay logged in.
  return <Floor me={me} onLogout={async () => {
    const r = await post('logout', {});
    if (!r.ok && r.error !== 'login_required') return say(r);
    setSession(null); setNote(null); refresh();
    return null;
  }} />;
}

function Enrol({ onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async e => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await enrolDevice(code).catch(() => ({ ok: false, error: 'offline' }));
    setBusy(false);
    if (!r.ok) { setErr(say(r)); return; }
    onDone();
  };
  return (
    <div className="center">
      <form className="card" style={{ width: 'min(460px, 100%)' }} onSubmit={go}>
        <div className="brand" style={{ marginBottom: 8 }}>OUTPOST</div>
        <h2>Set up this bench</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          Enter the 8-digit enrolment code LOT gave you for this bench. It works once and expires in 24 hours.
          Do this once per laptop, in the browser the bench will use.
        </p>
        <Field label="Enrolment code">
          <input className="in code" inputMode="numeric" maxLength={8} autoFocus value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
        </Field>
        {err && <div className="err">{err}</div>}
        <button className="btn primary wide" style={{ marginTop: 16 }} disabled={busy || code.length !== 8}>{busy ? 'Enrolling…' : 'Enrol bench'}</button>
      </form>
    </div>
  );
}

function Revoked({ onReset }) {
  return (
    <div className="center"><div className="card" style={{ width: 'min(460px, 100%)' }}>
      <h2>This bench is not enrolled</h2>
      <p className="muted">LOT has revoked this device, or its key was lost. Ask LOT for a new enrolment code, then set the bench up again.</p>
      <button className="btn primary wide" style={{ marginTop: 16 }} onClick={onReset}>Enter a new code</button>
    </div></div>
  );
}

function Login({ me, note, onDone }) {
  const [op, setOp] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(note);
  const go = async e => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await post('login', { op_code: op, pin });
    setBusy(false);
    if (!r.ok) { setPin(''); setErr(say(r)); return; }
    setSession(r.data.session);
    onDone();
  };
  return (
    <div className="center">
      <form className="card" style={{ width: 'min(420px, 100%)' }} onSubmit={go}>
        <div className="brand">OUTPOST</div>
        <div className="muted" style={{ margin: '4px 0 16px' }}>{me?.vendor_name} · Bench {me?.device?.bench_no ?? '—'}</div>
        <div className="stack">
          <Field label="Operator code">
            <input className="in code" inputMode="numeric" maxLength={3} autoFocus value={op} onChange={e => setOp(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
          </Field>
          <Field label="PIN">
            <input className="in code" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
          </Field>
        </div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary wide" style={{ marginTop: 16 }} disabled={busy || op.length !== 3 || pin.length !== 6}>{busy ? 'Checking…' : 'Log in'}</button>
      </form>
    </div>
  );
}
