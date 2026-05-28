'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useEscapeClose } from '@throttle/ui';
import { Plus } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

export default function DepartmentsPage() {
  const { perms, session } = useAuth();
  const [depts, setDepts] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        csopsGet('getDepartments', {}, session),
        csopsGet('getDeptAgents', {}, session),
      ]);
      setDepts(d || []);
      setAgents(a || []);
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (session) load(); /* eslint-disable-line */ }, [session]);

  if (!perms?.cs_ticket_admin) return <EmptyState icon="🔒" message="Admin permission required." />;
  if (loading) return <Spinner />;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Departments</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
            Define CS teams (Inbound, Outbound, Confirmation, Messaging) and assign agents. Non-admin users only see tickets + calls in their own department.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <Plus size={14} /> Add Department
        </button>
      </header>

      {error && <div style={errBox}>{error}</div>}

      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionH2}>Departments</h2>
        <div style={cardWrap}>
          <table style={tableStyle}>
            <thead style={theadStyle}>
              <tr><Th>Slug</Th><Th>Name</Th><Th>Sort</Th><Th>Agents</Th><Th>Active</Th></tr>
            </thead>
            <tbody>
              {depts.map(d => {
                const count = agents.filter(a => a.cs_department_id === d.id).length;
                return (
                  <tr key={d.id} style={{ borderTop: '1px solid var(--border-1)' }}>
                    <Td><code style={mono}>{d.slug}</code></Td>
                    <Td>{d.name}</Td>
                    <Td>{d.sort_order}</Td>
                    <Td>{count}</Td>
                    <Td><ActivePill active={d.is_active} onToggle={async () => {
                      await csopsPost('updateDepartment', { id: d.id, patch: { is_active: !d.is_active } }, session);
                      load();
                    }} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={sectionH2}>Agents</h2>
        <div style={cardWrap}>
          <table style={tableStyle}>
            <thead style={theadStyle}>
              <tr><Th>Name</Th><Th>Role</Th><Th>CS Perms</Th><Th>Department</Th></tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <AgentRow key={a.id} agent={a} depts={depts} session={session} onChanged={load} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showCreate && (
        <CreateDeptModal
          session={session}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function AgentRow({ agent, depts, session, onChanged }) {
  const [busy, setBusy] = useState(false);
  async function changeDept(e) {
    const id = e.target.value || null;
    setBusy(true);
    try { await csopsPost('assignUserDepartment', { user_id: agent.id, department_id: id }, session); onChanged(); }
    catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }
  const csTags = [];
  if (agent.has_cs_admin) csTags.push('admin');
  else if (agent.has_cs_manage) csTags.push('manage');
  return (
    <tr style={{ borderTop: '1px solid var(--border-1)' }}>
      <Td>{agent.full_name}</Td>
      <Td><code style={{ ...mono, color: 'var(--t3)' }}>{agent.role}</code></Td>
      <Td>
        {csTags.length === 0 ? <span style={{ color:'var(--t3)' }}>—</span> :
          csTags.map(t => (
            <span key={t} style={{
              padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              background: 'rgba(99,102,241,0.15)', color: '#4f46e5',
            }}>{t}</span>
          ))}
      </Td>
      <Td>
        <select value={agent.cs_department_id || ''} onChange={changeDept} disabled={busy} style={select}>
          <option value="">— None —</option>
          {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Td>
    </tr>
  );
}

function ActivePill({ active, onToggle }) {
  return (
    <button onClick={onToggle} style={{
      padding: '2px 10px', borderRadius: 999, border: 'none',
      fontSize: 11, fontWeight: 600, cursor: 'pointer',
      background: active ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
      color: active ? '#16a34a' : '#64748b',
    }}>{active ? 'Active' : 'Inactive'}</button>
  );
}

function CreateDeptModal({ session, onClose, onCreated }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [sort, setSort] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEscapeClose(true, onClose);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await csopsPost('createDepartment', { slug: slug.trim().toLowerCase(), name: name.trim(), sort_order: Number(sort) }, session);
      onCreated();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={modalCard}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>New Department</h2>
        <Field label="Slug">
          <input value={slug} onChange={e => setSlug(e.target.value)} required pattern="[a-z][a-z0-9_-]{1,30}" style={input} autoFocus />
        </Field>
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} required style={input} />
        </Field>
        <Field label="Sort order (lower = first)">
          <input type="number" value={sort} onChange={e => setSort(e.target.value)} style={input} />
        </Field>
        {err && <div style={errBox}>{err}</div>}
        <div style={{ display:'flex', gap: 8, justifyContent:'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={busy} style={btnPrimary}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function Th({ children }) { return <th style={{ textAlign:'left', padding:'8px 12px', fontSize:11, fontWeight:700, textTransform:'uppercase', color:'var(--t3)', letterSpacing:'0.05em' }}>{children}</th>; }
function Td({ children }) { return <td style={{ padding:'10px 12px', verticalAlign:'middle' }}>{children}</td>; }
function Field({ label, children }) {
  return <label style={{ display:'block', marginBottom: 10 }}><span style={{ display:'block', fontSize: 12, color:'var(--t3)', marginBottom: 4 }}>{label}</span>{children}</label>;
}

const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const sectionH2 = { margin: '0 0 10px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t3)' };
const cardWrap = { background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:8, overflow:'hidden' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const theadStyle = { background: 'var(--surface-2)' };
const btnPrimary = { display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:6, fontWeight:600, cursor:'pointer', fontSize:13 };
const btnSecondary = { padding:'7px 14px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:6, color:'var(--t2)', cursor:'pointer', fontSize:13 };
const input = { width:'100%', padding:'7px 10px', background:'var(--surface-2)', border:'1px solid var(--border-1)', borderRadius:5, fontSize:13, color:'var(--t1)', boxSizing:'border-box' };
const select = { padding:'4px 8px', background:'var(--surface-2)', border:'1px solid var(--border-1)', borderRadius:5, fontSize:13, color:'var(--t1)' };
const errBox = { padding:10, background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', color:'#dc2626', borderRadius:6, fontSize:12, marginBottom:8 };
const modalBackdrop = { position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 };
const modalCard = { background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:10, padding:24, width:420, maxWidth:'92vw' };
