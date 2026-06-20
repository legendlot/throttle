'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useEscapeClose } from '@throttle/ui';
import { Plus, CopyCheck, Copy } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

const CSOPS_URL = process.env.NEXT_PUBLIC_CSOPS_URL || 'https://csops.afshaan.workers.dev';

function webhookUrlFor(slug) {
  return `${CSOPS_URL}/webhooks/myoperator?account=${encodeURIComponent(slug)}`;
}

function envVarFor(slug) {
  return `MYOP_WEBHOOK_SECRET_${slug.toUpperCase().replace(/-/g, '_')}`;
}

export default function MyopAccountsPage() {
  const { user, session, perms } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editId, setEditId] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const data = await csopsGet('getMyopAccounts', {}, session);
      setAccounts(data || []);
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (session) load(); /* eslint-disable-line */ }, [session]);

  if (!perms?.cs_ticket_admin) {
    return <EmptyState icon="🔒" message="Admin permission required to manage MyOp accounts." />;
  }
  if (loading) return <Spinner />;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>MyOperator Accounts</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
            Each account has its own webhook URL + secret. Configure new accounts here, then point MyOperator at the URL below.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <Plus size={14} /> Add Account
        </button>
      </header>

      {error && <div style={errBox}>{error}</div>}

      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <Th>Slug</Th><Th>Name</Th><Th>DID</Th><Th>Owner</Th><Th>Webhook URL</Th><Th>Env var</Th><Th>Active</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: 'var(--t3)' }}>No accounts yet.</td></tr>
            ) : accounts.map(a => (
              <AccountRow key={a.id} account={a} onUpdated={load} session={session} editing={editId === a.id} setEditing={(v) => setEditId(v ? a.id : null)} />
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} session={session} />}
    </div>
  );
}

function AccountRow({ account, onUpdated, session, editing, setEditing }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await csopsPost('updateMyopAccount', { id: account.id, patch: { is_active: !account.is_active } }, session);
      onUpdated();
    } catch (e) { alert(e.message || String(e)); }
    finally { setBusy(false); }
  }

  const url = webhookUrlFor(account.slug);
  const envVar = envVarFor(account.slug);

  return (
    <tr style={{ borderTop: '1px solid var(--border-1)' }}>
      <Td><code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>{account.slug}</code></Td>
      <Td>{account.name}</Td>
      <Td><code style={mono}>{account.did || '—'}</code></Td>
      <Td>{account.owner_email || '—'}</Td>
      <Td>
        <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
          <code style={{ ...mono, fontSize: 11, color: 'var(--t2)' }}>{url}</code>
          <button onClick={() => copy(url)} style={btnIcon} title="Copy webhook URL">
            {copied ? <CopyCheck size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </Td>
      <Td>
        <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
          <code style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>{envVar}</code>
          <button onClick={() => copy(envVar)} style={btnIcon} title="Copy env var name">
            <Copy size={14} />
          </button>
        </div>
      </Td>
      <Td>
        <button onClick={toggleActive} disabled={busy} style={{ ...pill, background: account.is_active ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)', color: account.is_active ? '#16a34a' : '#64748b' }}>
          {account.is_active ? 'Active' : 'Inactive'}
        </button>
      </Td>
      <Td>—</Td>
    </tr>
  );
}

function CreateModal({ onClose, onCreated, session }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [did, setDid] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEscapeClose(true, onClose);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await csopsPost('createMyopAccount', { slug: slug.trim().toLowerCase(), name: name.trim(), did: did.trim() || null, owner_email: owner.trim() || null }, session);
      onCreated();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={modalCard}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>New MyOp Account</h2>
        <Field label="Slug (URL-safe, 2-31 chars, e.g. 'abc', 'confirm')">
          <input value={slug} onChange={e => setSlug(e.target.value)} placeholder="abc" pattern="[a-z][a-z0-9_-]{1,30}" required style={input} autoFocus />
        </Field>
        <Field label="Name (display label)">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="ABC Outbound" required style={input} />
        </Field>
        <Field label="DID / Caller ID (optional)">
          <input value={did} onChange={e => setDid(e.target.value)} placeholder="+91 XXXXX XXXXX" style={input} />
        </Field>
        <Field label="Owner email (optional)">
          <input type="email" value={owner} onChange={e => setOwner(e.target.value)} placeholder="lead@legendoftoys.com" style={input} />
        </Field>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ marginTop: 12, padding: 10, background: 'var(--surface-2)', borderRadius: 6, fontSize: 12, color: 'var(--t2)', lineHeight: 1.5 }}>
          <strong>After create:</strong> set the per-account webhook secret in Cloudflare:<br/>
          <code style={{ ...mono, fontSize: 11 }}>cd 05_Throttle/csops-worker && npx wrangler secret put {slug ? envVarFor(slug) : 'MYOP_WEBHOOK_SECRET_&lt;SLUG&gt;'}</code>
        </div>
        <div style={{ display:'flex', gap: 8, justifyContent:'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={busy} style={btnPrimary}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function Th({ children }) {
  return <th style={{ textAlign:'left', padding: '10px 12px', fontFamily:'var(--f-display)', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: '0.1em' }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>{children}</td>;
}
function Field({ label, children }) {
  return (
    <label style={{ display:'block', marginBottom: 10 }}>
      <span style={{ display:'block', fontSize: 12, color:'var(--t3)', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

const mono = { fontFamily:'var(--font-mono)', fontSize: 12 };
const btnPrimary  = { display:'inline-flex', alignItems:'center', gap:6, padding:'8px 14px', background:'var(--accent)', color:'var(--accent-fg)', border:'none', borderRadius:'var(--radius-sm)', fontFamily:'var(--f-display)', fontWeight:700, fontSize:11, letterSpacing:'0.06em', textTransform:'uppercase', cursor:'pointer', boxShadow:'var(--accent-glow)' };
const btnSecondary= { padding:'7px 14px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:6, color:'var(--t2)', cursor:'pointer', fontSize:13 };
const btnIcon     = { padding:4, background:'transparent', border:'none', color:'var(--t3)', cursor:'pointer', display:'inline-flex', alignItems:'center' };
const pill        = { padding:'2px 10px', borderRadius:999, border:'none', fontSize:11, fontWeight:600, cursor:'pointer' };
const input       = { width:'100%', padding:'7px 10px', background:'var(--surface-2)', border:'1px solid var(--border-1)', borderRadius:5, fontSize:13, color:'var(--t1)', boxSizing:'border-box' };
const errBox      = { padding:10, background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', color:'#dc2626', borderRadius:6, fontSize:12, marginBottom:8 };
const modalBackdrop = { position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 };
const modalCard   = { background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:10, padding:24, width:480, maxWidth:'92vw' };
