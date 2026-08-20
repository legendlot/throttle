'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { PhoneCall, Save, Check } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

/**
 * Who can be called from, and on which device.
 *
 * This is what actually gates click-to-call working for a person: without a row here
 * `placeCall` has no `From` leg and refuses. It was seeded by SQL, which is not
 * something the team can run — so it lives on a screen.
 *
 * Scope: people who could plausibly place a call (cs_agent / cs_lead / admin /
 * super_admin) plus anyone already configured. The first version listed every active
 * user so that "who cannot call" was visible — in practice that is 77 rows, 71 of them
 * `viewer` accounts that will never touch a phone, which buried the one row that
 * mattered. Unconfigured people sort FIRST for the same reason.
 */
export default function TelephonyAdminPage() {
  const { session, perms } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // user_id being edited

  async function load() {
    setLoading(true);
    try {
      setData(await csopsGet('getTelephonyAgents', {}, session));
      setError(null);
    } catch (e) { setError(String(e.message || e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (session) load(); /* eslint-disable-line */ }, [session]);

  if (!perms?.cs_ticket_admin) {
    return <EmptyState icon="🔒" message="Admin permission required to manage telephony." />;
  }
  // Never swap an open editor for the spinner — a background reload must not discard
  // half-typed input (CORE.md).
  if (loading && !editing) return <Spinner />;

  const users = data?.users || [];
  const configured = users.filter(u => u.telephony?.is_active).length;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 9 }}>
          <PhoneCall size={18} style={{ color: 'var(--accent)' }} /> Telephony
        </h1>
        <p style={{ margin: '5px 0 0', color: 'var(--t3)', fontSize: 13 }}>
          {configured} of {users.length} can place calls.
          {data?.needs_setup > 0 && (
            <strong style={{ color: 'var(--warn-fg)' }}> {data.needs_setup} still cannot.</strong>
          )}
          {' '}Calls go out on <code style={mono}>{data?.exophone}</code> — the customer never sees a personal number.
        </p>
      </header>

      {error && <div style={errBox}>{error}</div>}

      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <Th>Person</Th><Th>Role</Th><Th>SIP device</Th><Th>Mobile</Th><Th>Rings</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {[...users].sort((a, b) =>
              (a.telephony?.is_active ? 1 : 0) - (b.telephony?.is_active ? 1 : 0)
              || (a.full_name || '').localeCompare(b.full_name || '')
            ).map(u => (
              <AgentRow key={u.user_id} user={u} session={session}
                editing={editing === u.user_id}
                setEditing={(v) => setEditing(v ? u.user_id : null)}
                onSaved={load} />
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--t3)', maxWidth: 640 }}>
        <strong>Rings</strong> decides which leg Exotel calls first — the browser softphone
        (<code style={mono}>sip</code>) or the person&apos;s mobile (<code style={mono}>tel</code>).
        Someone with no SIP device falls back to mobile automatically, so a call still connects.
        SIP ids come from Exotel → Co-workers and Groups.
      </p>
    </div>
  );
}

function AgentRow({ user, session, editing, setEditing, onSaved }) {
  const t = user.telephony;
  const [sip, setSip] = useState(t?.sip_id || '');
  const [tel, setTel] = useState(t?.agent_phone || '');
  const [pref, setPref] = useState(t?.device_preference || 'tel');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await csopsPost('setTelephonyAgent', {
        user_id: user.user_id,
        sip_id: sip.trim() || null,
        agent_phone: tel.trim() || null,
        device_preference: pref,
        is_active: true,
      }, session);
      setEditing(false);
      onSaved();
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <tr style={{ borderTop: '1px solid var(--border-1)' }}>
        <Td><strong>{user.full_name || '—'}</strong></Td>
        <Td><span style={{ color: 'var(--t3)', fontSize: 12 }}>{user.role}</span></Td>
        <Td>{t?.sip_id ? <code style={mono}>{t.sip_id}</code> : <Missing />}</Td>
        <Td>{t?.agent_phone ? <code style={mono}>{t.agent_phone}</code> : <Missing />}</Td>
        <Td>
          {t
            ? <span style={pill(t.device_preference === 'sip')}>{t.device_preference === 'sip' ? 'Softphone' : 'Mobile'}</span>
            : <span style={{ color: 'var(--warn-fg)', fontSize: 11.5 }}>cannot call</span>}
        </Td>
        <Td style={{ textAlign: 'right' }}>
          <button onClick={() => setEditing(true)} style={btnSecondary}>{t ? 'Edit' : 'Set up'}</button>
        </Td>
      </tr>
    );
  }

  return (
    <tr style={{ borderTop: '1px solid var(--border-1)', background: 'var(--surface-2)' }}>
      <Td><strong>{user.full_name}</strong></Td>
      <Td><span style={{ color: 'var(--t3)', fontSize: 12 }}>{user.role}</span></Td>
      <Td><input value={sip} onChange={e => setSip(e.target.value)} placeholder="sip:name…" style={input} /></Td>
      <Td><input value={tel} onChange={e => setTel(e.target.value)} placeholder="+91…" style={input} /></Td>
      <Td>
        <select value={pref} onChange={e => setPref(e.target.value)} style={{ ...input, width: 110 }}>
          <option value="tel">Mobile</option>
          <option value="sip">Softphone</option>
        </select>
      </Td>
      <Td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {err && <div style={{ color: '#dc2626', fontSize: 11, marginBottom: 4 }}>{err}</div>}
        <button onClick={save} disabled={busy} style={btnPrimary}>
          {busy ? <Check size={12} /> : <Save size={12} />} Save
        </button>
        <button onClick={() => setEditing(false)} style={{ ...btnSecondary, marginLeft: 6 }}>Cancel</button>
      </Td>
    </tr>
  );
}

function Missing() { return <span style={{ color: 'var(--t4)', fontSize: 12 }}>—</span>; }
function Th({ children }) { return <th style={{ textAlign: 'left', padding: '10px 12px', fontFamily: 'var(--f-display)', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: '0.1em' }}>{children}</th>; }
function Td({ children, ...rest }) { return <td {...rest} style={{ padding: '9px 12px', verticalAlign: 'middle', ...rest.style }}>{children}</td>; }

const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };
const input = { width: '100%', padding: '6px 9px', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 5, fontSize: 12.5, color: 'var(--t1)', boxSizing: 'border-box' };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 5, fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const btnSecondary = { padding: '5px 11px', background: 'transparent', border: '1px solid var(--border-1)', borderRadius: 5, color: 'var(--t2)', cursor: 'pointer', fontSize: 12 };
const errBox = { padding: 10, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#dc2626', borderRadius: 6, fontSize: 12, marginBottom: 12 };
function pill(isSip) {
  return { padding: '2px 9px', borderRadius: 999, fontSize: 10.5, fontWeight: 600,
    background: isSip ? 'rgba(59,130,246,0.13)' : 'var(--surface-2)',
    color: isSip ? 'var(--info-fg)' : 'var(--t2)',
    border: isSip ? 'none' : '1px solid var(--border-1)' };
}
