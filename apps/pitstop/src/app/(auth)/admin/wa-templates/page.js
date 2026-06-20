'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner, useEscapeClose } from '@throttle/ui';
import { Plus, MessageSquare, AlertTriangle } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

export default function WaTemplatesPage() {
  const { perms, session } = useAuth();
  const [tpls, setTpls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const r = await csopsGet('getWaTemplates', {}, session);
      setTpls(r || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (session) load(); /* eslint-disable-line */ }, [session]);

  if (!perms?.cs_ticket_admin) return <EmptyState icon="🔒" message="Admin permission required." />;
  if (loading) return <Spinner />;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>WhatsApp Templates</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
            Pre-approved utility / marketing message templates. Used when opening a conversation or messaging outside the 24h customer-initiated window.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <Plus size={14} /> Add Template
        </button>
      </header>

      <div style={{
        padding: '8px 14px', background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 6, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#92400e',
      }}>
        <AlertTriangle size={14} />
        <span>
          Phase C: templates are recorded in Pitstop and used to compose outbound messages, but the actual Meta/BSP send happens in Phase C2.
          Template names must match what you submit for approval in Meta Business Manager.
        </span>
      </div>

      {error && <div style={errBox}>{error}</div>}

      <div style={{ background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:8, overflow:'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--surface-2)' }}>
            <tr>
              <Th>Name</Th><Th>Label</Th><Th>Category</Th><Th>Lang</Th><Th>{`Placeholders`}</Th><Th>Active</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {tpls.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center', color: 'var(--t3)' }}>
                <MessageSquare size={20} style={{ opacity: 0.4 }} /><br />No templates yet.
              </td></tr>
            ) : tpls.map(t => (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border-1)' }}>
                <Td><code style={mono}>{t.name}</code></Td>
                <Td>{t.display_label}</Td>
                <Td><CategoryPill cat={t.category} /></Td>
                <Td>{t.language}</Td>
                <Td>{t.placeholder_count}</Td>
                <Td><ActivePill active={t.is_active} onToggle={async () => {
                  await csopsPost('updateWaTemplate', { id: t.id, patch: { is_active: !t.is_active } }, session);
                  load();
                }} /></Td>
                <Td><button onClick={() => setEditing(t)} style={btnIcon}>Edit</button></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate && <TemplateModal session={session} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {editing && <TemplateModal initial={editing} session={session} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function CategoryPill({ cat }) {
  const palette = {
    utility:        { bg: 'rgba(59,130,246,0.15)', color: '#2563eb' },
    marketing:      { bg: 'rgba(245,158,11,0.15)', color: '#d97706' },
    authentication: { bg: 'rgba(168,85,247,0.15)', color: '#9333ea' },
  };
  const s = palette[cat] || palette.utility;
  return <span style={{ padding: '2px 8px', borderRadius: 999, background: s.bg, color: s.color, fontSize: 11, fontWeight: 600, textTransform: 'capitalize' }}>{cat}</span>;
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

function TemplateModal({ initial, session, onClose, onSaved }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [label, setLabel] = useState(initial?.display_label || '');
  const [category, setCategory] = useState(initial?.category || 'utility');
  const [language, setLanguage] = useState(initial?.language || 'en');
  const [body, setBody] = useState(initial?.body || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEscapeClose(true, onClose);

  const placeholders = [...new Set((body.match(/\{\{\d+\}\}/g) || []))].length;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await csopsPost('updateWaTemplate', {
          id: initial.id,
          patch: { display_label: label, category, language, body, notes: notes || null },
        }, session);
      } else {
        await csopsPost('createWaTemplate', {
          name: name.trim(), display_label: label, category, language, body,
          placeholder_count: placeholders, notes: notes || null,
        }, session);
      }
      onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <form onClick={e => e.stopPropagation()} onSubmit={submit} style={modalCard}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>{editing ? 'Edit Template' : 'New Template'}</h2>

        <Field label="Name (must match Meta-approved template name; e.g. evidence_request)">
          <input value={name} onChange={e => setName(e.target.value)} required disabled={editing} pattern="[a-z0-9_]+" style={input} autoFocus />
        </Field>
        <Field label="Display label (what agents see)">
          <input value={label} onChange={e => setLabel(e.target.value)} required style={input} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Category">
            <select value={category} onChange={e => setCategory(e.target.value)} style={input}>
              <option value="utility">Utility</option>
              <option value="marketing">Marketing</option>
              <option value="authentication">Authentication</option>
            </select>
          </Field>
          <Field label="Language">
            <input value={language} onChange={e => setLanguage(e.target.value)} style={input} />
          </Field>
        </div>
        <Field label="Body (use {{1}}, {{2}}, … for placeholders)">
          <textarea rows={4} value={body} onChange={e => setBody(e.target.value)} required style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>{placeholders} placeholder{placeholders === 1 ? '' : 's'} detected</div>
        </Field>
        <Field label="Notes (optional)">
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        {err && <div style={errBox}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
          <button type="submit" disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : (editing ? 'Save' : 'Create')}</button>
        </div>
      </form>
    </div>
  );
}

function Th({ children }) { return <th style={{ textAlign:'left', padding:'10px 12px', fontFamily:'var(--f-display)', fontSize:9.5, fontWeight:700, textTransform:'uppercase', color:'var(--t3)', letterSpacing:'0.1em' }}>{children}</th>; }
function Td({ children }) { return <td style={{ padding:'10px 12px', verticalAlign:'middle' }}>{children}</td>; }
function Field({ label, children }) {
  return <label style={{ display:'block', marginBottom: 10 }}><span style={{ display:'block', fontSize: 12, color:'var(--t3)', marginBottom: 4 }}>{label}</span>{children}</label>;
}

const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const btnPrimary = { display:'inline-flex', alignItems:'center', gap:6, padding:'8px 14px', background:'var(--accent)', color:'var(--accent-fg)', border:'none', borderRadius:'var(--radius-sm)', fontFamily:'var(--f-display)', fontWeight:700, fontSize:11, letterSpacing:'0.06em', textTransform:'uppercase', cursor:'pointer', boxShadow:'var(--accent-glow)' };
const btnSecondary = { padding:'7px 14px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:6, color:'var(--t2)', cursor:'pointer', fontSize:13 };
const btnIcon = { padding:'4px 10px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:5, color:'var(--t2)', cursor:'pointer', fontSize:12 };
const input = { width:'100%', padding:'7px 10px', background:'var(--surface-2)', border:'1px solid var(--border-1)', borderRadius:5, fontSize:13, color:'var(--t1)', boxSizing:'border-box' };
const errBox = { padding:10, background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', color:'#dc2626', borderRadius:6, fontSize:12, marginBottom:8 };
const modalBackdrop = { position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 };
const modalCard = { background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:10, padding:24, width:560, maxWidth:'94vw' };
