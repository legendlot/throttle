'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import {
  Phone, PhoneCall, PhoneIncoming, PhoneOff, Mic, MicOff, Pause, Play, X,
} from 'lucide-react';
import { csopsGet } from '../lib/csopsFetch.js';
import { notify } from '../lib/notify.js';

/**
 * CallBar — the Phase 6 browser softphone (S305).
 *
 * Exotel's WebRTC SDK, delivered as a persistent bar in the (auth) LAYOUT so a call
 * survives route changes (same reasoning as CallPop, which stays: CallPop is the
 * customer's context card, CallBar is the audio device — they compose).
 *
 * ⚠️ The SDK is ~1.4 MB, so it is imported dynamically ONLY after getSoftphoneToken
 * succeeds — tel-preference agents and non-CS users never download it (the 404 from
 * the worker is the gate). Never move this import to the top of the file.
 *
 * ⚠️ Keyed on userId, NEVER on `session` (CORE.md): a token refresh lands ~hourly and
 * would tear the registered SIP device down mid-call.
 */
export default function CallBar() {
  const { userId, session } = useAuth();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const webPhone = useRef(null);
  const [phase, setPhase] = useState('boot');   // boot | off | online | offline
  const [call, setCall] = useState(null);       // { state: incoming|active, number, startedAt }
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [dialOpen, setDialOpen] = useState(false);
  const [dialNum, setDialNum] = useState('');
  const [tick, setTick] = useState(0);          // re-render driver for the call timer

  const [attempt, setAttempt] = useState(0);   // Retry drives re-init
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    (async () => {
      let boot;
      try {
        boot = await csopsGet('getSoftphoneToken', {}, sessionRef.current);
      } catch {
        // 404 = not a SIP agent; 409 = setup not run. Either way: no softphone here.
        if (alive) setPhase('off');
        return;
      }
      if (!alive) return;
      // Ask for the microphone BEFORE the SDK registers — a softphone without audio
      // fails registration in ways the SDK reports poorly. Denied mic = offline, with
      // Retry re-prompting after the agent fixes the browser permission.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());   // permission was the point, not the stream
      } catch (e) {
        console.warn('[callbar] microphone not granted', e?.name || e);
        if (alive) setPhase('offline');
        return;
      }
      if (!alive) return;
      setPhase('registering');
      const { default: ExotelCRMWebSDK } = await import('@exotel-npm-dev/exotel-ip-calling-crm-websdk');
      if (!alive) return;

      const handleCallEvents = (eventType, ...args) => {
        const c = args?.[0] || {};
        if (eventType === 'incoming') {
          setCall({ state: 'incoming', number: c.remoteId || c.callFromNumber || '', startedAt: null });
          // The phone ringing is the primary alert; this covers the agent on another tab.
          notify('📞 Incoming call', { body: c.remoteId || undefined, tag: `softphone:${c.callSid || 'incoming'}` });
        } else if (eventType === 'connected') {
          setCall((prev) => ({ state: 'active', number: prev?.number || c.remoteId || '', startedAt: Date.now() }));
          setMuted(false); setHeld(false);
        } else if (eventType === 'callEnded') {
          setCall(null); setMuted(false); setHeld(false);
        } else if (eventType === 'mutetoggle') {
          setMuted((m) => !m);
        } else if (eventType === 'holdtoggle') {
          setHeld((h) => !h);
        }
      };
      const handleRegisterEvents = (event) => {
        if (event === 'registered') setPhase('online');
        if (event === 'unregistered') setPhase('offline');
      };

      try {
        const sdk = new ExotelCRMWebSDK(boot.token, boot.user_id, true);
        const phone = await sdk.Initialize(handleCallEvents, handleRegisterEvents);
        if (!phone) { setPhase('offline'); return; }   // e.g. usermapping missing on Exotel's side
        webPhone.current = phone;
      } catch (e) {
        console.error('[callbar] init failed', e);
        setPhase('offline');
      }
    })();
    return () => {
      alive = false;
      try { webPhone.current?.UnRegisterDevice?.(); } catch { /* best-effort */ }
      webPhone.current = null;
    };
  }, [userId, attempt]);

  // 1s heartbeat while a call is active — drives the timer only.
  useEffect(() => {
    if (call?.state !== 'active') return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [call?.state]);

  if (phase === 'boot' || phase === 'off') return null;

  const accept = () => { webPhone.current?.AcceptCall(); };
  const hangup = () => { webPhone.current?.HangupCall(); setCall(null); };
  // ⚠️ The SDK's ToggleMute/ToggleHold synchronously fire the mutetoggle/holdtoggle event
  // back through the call listener, which is what updates `muted`/`held`. The buttons must
  // NOT also flip state — that double-flip is exactly the "mute and hold are not working"
  // bug Pruthvi reported on launch day (state flipped twice, icon never moved). Debounce
  // mirrors Exotel's own sample app, which carries the same guard for the same reason.
  const lastToggle = useRef(0);
  const debounced = (fn) => { const n = Date.now(); if (n - lastToggle.current < 350) return; lastToggle.current = n; fn(); };
  const toggleMute = () => debounced(() => webPhone.current?.ToggleMute());
  const toggleHold = () => debounced(() => webPhone.current?.ToggleHold());
  const dial = () => {
    const n = dialNum.replace(/[^\d+]/g, '');
    if (!/^\+?\d{10,14}$/.test(n)) return;
    setCall({ state: 'active', number: n, startedAt: Date.now() });
    setDialOpen(false);
    webPhone.current?.MakeCall(n, (status) => {
      if (status !== 'success') setCall(null);
    });
  };

  const secs = call?.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : 0;
  const timer = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  void tick; // consumed above via re-render

  return (
    <div className="pt-callbar" style={wrap} role="region" aria-label="Softphone">
      {call?.state === 'incoming' && (
        <div style={row}>
          <PhoneIncoming size={15} style={{ color: 'var(--ok-fg)' }} />
          <span style={num}>{call.number || 'Incoming call'}</span>
          <button onClick={accept} style={{ ...btn, background: 'var(--ok-fg)', color: '#fff' }} aria-label="Accept">
            <Phone size={14} /> Accept
          </button>
          <button onClick={hangup} style={{ ...btn, background: 'var(--danger-fg)', color: '#fff' }} aria-label="Reject">
            <PhoneOff size={14} />
          </button>
        </div>
      )}
      {call?.state === 'active' && (
        <div style={row}>
          <PhoneCall size={15} style={{ color: 'var(--ok-fg)' }} />
          <span style={num}>{call.number}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, opacity: 0.8 }}>{timer}</span>
          <button onClick={toggleMute} style={iconBtn} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
          <button onClick={toggleHold} style={iconBtn} aria-label={held ? 'Resume' : 'Hold'} title={held ? 'Resume' : 'Hold'}>
            {held ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button onClick={hangup} style={{ ...btn, background: 'var(--danger-fg)', color: '#fff' }} aria-label="Hang up">
            <PhoneOff size={14} />
          </button>
        </div>
      )}
      {!call && (
        <div style={row}>
          <span style={{ width: 8, height: 8, borderRadius: 999, flex: '0 0 auto',
            background: phase === 'online' ? 'var(--ok-fg)' : phase === 'registering' ? 'var(--warn-fg)' : 'var(--danger-fg)' }} />
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            {phase === 'online' ? 'Softphone ready' : phase === 'registering' ? 'Softphone connecting…' : 'Softphone offline'}
          </span>
          {phase === 'online' && (
            <button onClick={() => setDialOpen((o) => !o)} aria-label="Dialpad" title="Dial a number"
              style={{ ...iconBtn, width: 'auto', padding: '0 10px', gap: 5, fontSize: 12, fontWeight: 600 }}>
              {dialOpen ? <X size={14} /> : <Phone size={14} />} {dialOpen ? 'Close' : 'Dial'}
            </button>
          )}
          {phase === 'offline' && (
            <button onClick={() => { setPhase('boot'); setAttempt((n) => n + 1); }} style={{ ...iconBtn, width: 'auto', padding: '0 8px', fontSize: 12 }}>
              Retry
            </button>
          )}
        </div>
      )}
      {dialOpen && !call && (
        <div style={{ ...row, marginTop: 6 }}>
          <input
            value={dialNum}
            onChange={(e) => setDialNum(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') dial(); }}
            placeholder="+91 phone number"
            inputMode="tel"
            style={{ flex: 1, minWidth: 0, height: 30, padding: '0 8px', fontSize: 13,
              background: 'var(--surface)', color: 'var(--t1)',
              border: '1px solid var(--line)', borderRadius: 6 }}
          />
          <button onClick={dial} style={{ ...btn, background: 'var(--ok-fg)', color: '#fff' }} aria-label="Call">
            <Phone size={14} /> Call
          </button>
        </div>
      )}
    </div>
  );
}

const wrap = {
  position: 'fixed', left: 16, bottom: 16, zIndex: 60, minWidth: 220, maxWidth: 340,
  background: 'var(--surface-2, var(--surface))', color: 'var(--t1)',
  border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px',
  boxShadow: '0 8px 28px rgba(0,0,0,.25)',
};
const row = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 };
const num = { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 };
const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px',
  fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer', flex: '0 0 auto',
};
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--line)',
  borderRadius: 6, cursor: 'pointer', flex: '0 0 auto',
};
