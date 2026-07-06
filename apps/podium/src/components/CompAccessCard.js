'use client';
import { useEffect, useState } from 'react';
import { KeyRound, X, Plus, ScrollText } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';

// Super-admin-only salary-access allow-list manager. Renders NOTHING for non-super-admins
// (the worker 403s getCompAccess → we hide the whole card). Lets Afshaan/Vinay see and edit
// who can view everyone's salary, and peek the access log.
export default function CompAccessCard({ session }) {
  const [members, setMembers] = useState(null); // null=loading, false=forbidden/hidden
  const [users, setUsers] = useState([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState(null);

  async function load() {
    try {
      const r = await podiumopsGet('getCompAccess', {}, session);
      setMembers(r.members || []);
      const u = await podiumopsGet('getPodiumUsers', {}, session).catch(() => []);
      setUsers(Array.isArray(u) ? u : []);
    } catch { setMembers(false); }
  }
  useEffect(() => { if (session) load(); }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (members === false || members === null) return null;

  const memberIds = new Set(members.map((m) => m.auth_user_id));
  const candidates = users.filter((u) => !memberIds.has(u.id) && u.active);

  async function add() {
    if (!pick) return;
    setBusy(true);
    try { await podiumopsPost('addCompAccess', { auth_user_id: pick }, session); setPick(''); await load(); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    setBusy(true);
    try { await podiumopsPost('removeCompAccess', { auth_user_id: id }, session); await load(); }
    finally { setBusy(false); }
  }
  async function toggleLog() {
    if (log) { setLog(null); return; }
    const r = await podiumopsGet('getCompAccessLog', { limit: 100 }, session).catch(() => ({ log: [] }));
    setLog(r.log || []);
  }

  return (
    <div style={card}>
      <div style={cardTitle}><KeyRound size={14} /> Salary Access (super-admins only)</div>
      <p style={p}>These people can see <strong>everyone&apos;s</strong> salary. Only super-admins can change this list.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {members.map((m) => (
          <div key={m.auth_user_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13.5, color: 'var(--t1)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span>{m.full_name || m.auth_user_id}</span>
            <button onClick={() => remove(m.auth_user_id)} disabled={busy} title="Remove" style={iconBtn}><X size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}
          className="pd-input" style={{ flex: 1, background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 13 }}>
          <option value="">Add a person…</option>
          {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.email ? ' · ' + u.email : ''}</option>)}
        </select>
        <button onClick={add} disabled={busy || !pick} style={addBtn}><Plus size={14} /> Add</button>
      </div>
      <button onClick={toggleLog} style={{ ...link, marginTop: 12, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <ScrollText size={13} /> {log ? 'Hide' : 'View'} access log
      </button>
      {log && (
        <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', fontSize: 12, color: 'var(--t2)' }}>
          {log.length === 0 ? <span style={{ color: 'var(--t3)' }}>No access logged yet.</span> : log.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', padding: '5px 0' }}>
              <span>{r.viewer_name || r.viewer_user_id} · {r.action}{r.subject_label ? ' → ' + r.subject_label : ''}</span>
              <span className="num" style={{ color: 'var(--t3)' }}>{(r.at || '').replace('T', ' ').slice(0, 16)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px' };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
const p = { fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 };
const link = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--yellow)', fontSize: 13 };
const iconBtn = { background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--t3)', cursor: 'pointer', padding: 4, display: 'inline-flex' };
const addBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
