'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useEscapeClose } from '@throttle/ui';
import { Plus, CopyCheck, Copy, PhoneCall, RefreshCw, Activity } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';
import { fmtIstStamp } from '../../../../lib/datetime.js';

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
  // Never swap an open form for the spinner — a background reload (a real token
  // refresh re-keys any effect on `session`) must not discard unsaved input.
  if (loading && !showCreate && !editId) return <Spinner />;

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

      <ExotelPanel session={session} />

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

/**
 * Exotel — health + the one-shot historic backfill.
 *
 * Lives here rather than in a console snippet because the backfill needs a real
 * Pitstop session: the worker gates it on cs_ticket_admin, and hand-extracting the
 * JWT out of localStorage produced a 401 (the stored shape is not a bare
 * { access_token }). csopsPost already holds the working session — use it.
 */
function ExotelPanel({ session }) {
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  // Default: the MyOperator → Exotel cutover, 2026-08-19 18:08 IST.
  const [since, setSince] = useState('2026-08-19T18:08');

  async function checkHealth() {
    setChecking(true); setErr(null);
    try { setHealth(await csopsGet('getExotelHealth', {}, session)); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setChecking(false); }
  }
  useEffect(() => { if (session) checkHealth(); /* eslint-disable-line */ }, [session]);

  async function runBackfill() {
    // Irreversible-ish and long-running: confirm, because a mistyped `since` walks
    // months of history rather than a day.
    if (!window.confirm(
      `Backfill Exotel calls from ${since} (IST) to now?\n\n`
      + 'Creates call records only — NO tickets. Safe to re-run: writes are idempotent.'
    )) return;
    setRunning(true); setErr(null); setResult(null);
    try {
      // datetime-local is IST wall-clock; send a real instant.
      const iso = new Date(since + ':00+05:30').toISOString();
      setResult(await csopsPost('runExotelBackfill', { since: iso }, session));
    } catch (e) { setErr(String(e.message || e)); }
    finally { setRunning(false); }
  }

  const dotColor = !health ? 'var(--t3)'
    : !health.configured ? 'var(--t3)'
    : health.reachable ? 'var(--ok-fg, #16a34a)' : '#dc2626';

  return (
    <div style={{ background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:8, padding:18, marginBottom:18 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:9 }}>
          <PhoneCall size={16} strokeWidth={1.75} style={{ color:'var(--accent)' }} />
          <div>
            <h2 style={{ margin:0, fontSize:15, fontWeight:700 }}>Exotel</h2>
            <p style={{ margin:'2px 0 0', color:'var(--t3)', fontSize:12 }}>
              Live call log. Polls every 2 minutes — no webhook or flow change needed.
            </p>
          </div>
        </div>
        <button onClick={checkHealth} disabled={checking} style={btnSecondary}>
          <RefreshCw size={12} style={{ marginRight:5, verticalAlign:-2 }} />
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:14, fontSize:12.5, color:'var(--t2)', flexWrap:'wrap' }}>
        <span style={{ width:8, height:8, borderRadius:999, background:dotColor, display:'inline-block' }} />
        {!health ? 'Checking…'
          : !health.configured ? <span>Not configured — <code style={mono}>{health.reason}</code></span>
          : health.reachable
            ? <span>
                Connected to <code style={mono}>{health.account_sid}</code> ({health.latency_ms}ms).
                {health.latest_logged?.started_at
                  ? ` Last call logged ${fmtIstStamp(health.latest_logged.started_at)}.`
                  : ' No Exotel calls logged yet.'}
              </span>
            : <span style={{ color:'#dc2626' }}>
                Unreachable — {health.error} (HTTP {health.http_status}). Check EXOTEL_API_KEY / EXOTEL_API_TOKEN.
              </span>}
      </div>

      <div style={{ marginTop:16, paddingTop:14, borderTop:'1px solid var(--border-1)' }}>
        <div style={{ display:'flex', alignItems:'flex-end', gap:10, flexWrap:'wrap' }}>
          <div>
            <label style={{ display:'block', fontSize:11, color:'var(--t3)', marginBottom:4, textTransform:'uppercase', letterSpacing:'0.05em' }}>
              Backfill from (IST)
            </label>
            <input type="datetime-local" value={since} onChange={e => setSince(e.target.value)}
                   style={{ ...input, width:220 }} />
          </div>
          <button onClick={runBackfill} disabled={running || !health?.reachable} style={btnPrimary}>
            <Activity size={13} /> {running ? 'Backfilling…' : 'Run backfill'}
          </button>
        </div>
        <p style={{ margin:'9px 0 0', color:'var(--t3)', fontSize:11.5, maxWidth:640 }}>
          Recovers calls Pitstop missed. Writes call records only — <strong>no tickets</strong>, so a
          day of history will not flood the queue or reset SLA clocks. Idempotent: re-running never
          duplicates.
        </p>
      </div>

      {err && <div style={{ ...errBox, marginTop:12, marginBottom:0 }}>{err}</div>}
      {result && (
        <pre style={{ ...mono, marginTop:12, marginBottom:0, padding:12, background:'var(--surface-2)',
                      border:'1px solid var(--border-1)', borderRadius:6, overflowX:'auto', fontSize:11.5 }}>
{JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
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
