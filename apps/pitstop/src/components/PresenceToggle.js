'use client';
/* ════════════════════════════════════════════════════════════
   PresenceToggle — topbar availability control (Phase 1).
   - Login → online (the mount heartbeat creates/promotes the row).
   - Activity-gated heartbeat: pings every BEAT_MS while there was real
     interaction within IDLE_LIMIT_MS, so a forgotten-open tab decays to
     offline (server freshness window). NOT gated on tab visibility —
     that gate was removed S318; see the note in the interval below.
   - Manual Online/Away/Offline → setPresence (auto=false). "Online"
     outside shift hours = the off-schedule override for today.
   The toggle reflects the server's authoritative status (heartbeat
   returns it), so a same-day manual Offline survives a reload.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Circle, ChevronDown, Check } from 'lucide-react';
import { csopsPost } from '../lib/csopsFetch.js';

const BEAT_MS = 60_000;              // ping cadence while engaged
const IDLE_LIMIT_MS = 15 * 60_000;   // stop pinging after 15 min of no interaction

const DOT = { online: '#27c93f', away: '#f5a623', offline: '#6b6b6b' };
const LABEL = { online: 'Available', away: 'Away', offline: 'Offline' };
const ORDER = ['online', 'away', 'offline'];

export default function PresenceToggle({ session }) {
  const [status, setStatus] = useState('offline');
  const [open, setOpen] = useState(false);
  const lastActivity = useRef(Date.now());

  // Track real user interaction (used to gate the heartbeat).
  useEffect(() => {
    const bump = () => { lastActivity.current = Date.now(); };
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'visibilitychange'];
    evs.forEach(e => window.addEventListener(e, bump, { passive: true }));
    return () => evs.forEach(e => window.removeEventListener(e, bump));
  }, []);

  // Heartbeat loop: beat on mount (login → online), then every BEAT_MS while
  // visible and not idle. The server returns the authoritative status.
  useEffect(() => {
    if (!session) return undefined;
    let alive = true;
    const beat = async () => {
      try {
        const r = await csopsPost('heartbeat', {}, session);
        if (alive && r?.status) setStatus(r.status);
      } catch { /* best-effort */ }
    };
    beat();
    const iv = setInterval(() => {
      // ⚠️ The visibility check that used to sit here was REMOVED 2026-08-27 (S318) and must
      // not come back. It stopped the heartbeat whenever the tab was backgrounded, so an agent
      // checking an order in Shopify — present, working, one tab away — went unroutable within
      // 3 minutes. Measured mid-shift: only 3 of 12 presence rows were effectively online.
      //
      // ⚠️ Idleness is what actually detects absence, and IDLE_LIMIT_MS below still enforces it:
      // a forgotten-open tab stops beating after 15 minutes of no interaction whether it is
      // visible or not. Visibility was a proxy for "is this person here", and a bad one —
      // support work lives in other tabs.
      //
      // ⚠️ Browsers throttle setInterval in hidden tabs (Chrome clamps to >=60s and degrades
      // further the longer a tab stays hidden), so a beat CAN still land late. That is why the
      // server freshness window was widened to 10 minutes in the same change — the two halves
      // compensate, and shipping either alone leaves the gap open.
      if (Date.now() - lastActivity.current > IDLE_LIMIT_MS) return;
      beat();
    }, BEAT_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [session]);

  // Close the menu on any outside click.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  const pick = useCallback(async (s) => {
    setOpen(false);
    setStatus(s);
    lastActivity.current = Date.now();
    try { await csopsPost('setPresence', { status: s }, session); } catch { /* best-effort */ }
  }, [session]);

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Your availability for thread routing"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', background: 'var(--surface-2)',
          border: '1px solid var(--border-1)', borderRadius: 6,
          color: 'var(--t1)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}
      >
        <Circle size={9} fill={DOT[status]} stroke="none" />
        {LABEL[status]}
        <ChevronDown size={12} style={{ color: 'var(--t3)' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 100,
          background: 'var(--surface-1)', border: '1px solid var(--border-1)',
          borderRadius: 6, minWidth: 180, padding: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
        }}>
          {ORDER.map(s => (
            <button key={s} onClick={() => pick(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%',
                background: status === s ? 'var(--surface-2)' : 'transparent', border: 'none', borderRadius: 4,
                color: 'var(--t1)', fontSize: 13, fontWeight: 500, cursor: 'pointer', textAlign: 'left',
              }}>
              <Circle size={9} fill={DOT[s]} stroke="none" />
              <span style={{ flex: 1 }}>{LABEL[s]}</span>
              {status === s && <Check size={12} style={{ color: 'var(--accent)' }} />}
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--border-1)', margin: '4px 4px 2px' }} />
          <div style={{ padding: '4px 10px 6px', fontSize: 10.5, color: 'var(--t4)', lineHeight: 1.4 }}>
            “Available” outside your shift hours is a manual override for today.
          </div>
        </div>
      )}
    </div>
  );
}
