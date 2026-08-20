'use client';
import { useState } from 'react';
import { useAuth } from '@throttle/auth';
import { PhoneCall, Loader2 } from 'lucide-react';
import { csopsPost } from '../lib/csopsFetch.js';

/**
 * Click-to-call. Rings the AGENT first, then the customer, and bridges them on the
 * ExoPhone — so the customer never sees a personal number and the agent never dials
 * one by hand.
 *
 * ⚠️ The agent's own phone rings first. That surprises people the first time, so the
 * button says so rather than leaving them staring at a screen wondering what happened.
 *
 * Renders nothing without a phone number: a dead call button on a ticket with no
 * number is worse than no button.
 */
export default function CallButton({ phone, ticketId, size = 'md', label = 'Call', onPlaced }) {
  const { session, perms } = useAuth();
  const [state, setState] = useState('idle');   // idle | placing | ringing | error
  const [error, setError] = useState(null);

  if (!phone) return null;
  if (!perms?.cs_ticket_manage) return null;

  async function place() {
    setState('placing'); setError(null);
    try {
      const r = await csopsPost('placeCall', { to: phone, ticket_id: ticketId || null }, session);
      setState('ringing');
      onPlaced?.(r);
      // The button is not a call-control surface — the phone is. Reset so it can be
      // used again rather than sitting on a state it cannot keep truthful.
      setTimeout(() => setState('idle'), 8000);
    } catch (e) {
      setError(String(e.message || e));
      setState('error');
      setTimeout(() => setState('idle'), 6000);
    }
  }

  const small = size === 'sm';
  const busy = state === 'placing';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <button
        onClick={place}
        disabled={busy || state === 'ringing'}
        title={`Call ${phone} — your phone rings first`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: small ? '3px 9px' : '7px 13px',
          background: state === 'ringing' ? 'var(--surface-2)' : 'var(--accent)',
          color: state === 'ringing' ? 'var(--t2)' : 'var(--accent-fg)',
          border: state === 'ringing' ? '1px solid var(--border-1)' : 'none',
          borderRadius: 6, cursor: busy || state === 'ringing' ? 'default' : 'pointer',
          fontFamily: 'var(--f-display)', fontWeight: 700,
          fontSize: small ? 9.5 : 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
          opacity: busy ? 0.7 : 1,
        }}>
        {busy
          ? <Loader2 size={small ? 11 : 13} style={{ animation: 'spin 1s linear infinite' }} />
          : <PhoneCall size={small ? 11 : 13} />}
        {state === 'ringing' ? 'Your phone…' : busy ? 'Connecting' : label}
      </button>
      {state === 'error' && (
        <span style={{ fontSize: 11, color: '#dc2626', maxWidth: 260 }}>{error}</span>
      )}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </span>
  );
}
