'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Modal } from '@throttle/ui';
import { Plus } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { fmtMoney } from '../../../lib/format.js';

export default function RolesPage() {
  const { session, perms } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', role_code: '', level: '' });
  const [busy, setBusy] = useState(false);
  const canManage = !!perms?.podium_hr;

  function load() { podiumopsGet('getJobRoles', {}, session).then(r => setRows(r.job_roles || [])).catch(() => setRows([])); }
  useEffect(() => { if (session) load(); }, [session]);

  async function create() {
    if (!form.title.trim()) { showToast('Title required', 'error'); return; }
    setBusy(true);
    try {
      const r = await podiumopsPost('createJobRole', form, session);
      setOpen(false); setForm({ title: '', role_code: '', level: '' });
      router.push(`/roles/detail/?id=${r.id}`);
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  if (!rows) return <Spinner />;
  const showBands = rows.some(r => !r._bands_hidden);

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={h1}>Roles &amp; KPIs</h1>
        {canManage && <button onClick={() => setOpen(true)} style={newBtn}><Plus size={15} /> New Role</button>}
      </header>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
            <th style={th}>Title</th><th style={th}>Code</th><th style={th}>Level</th><th style={th}>Department</th><th style={th}>KPIs</th>{showBands && <th style={th}>Band (mid)</th>}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} style={{ ...td, color: 'var(--text-3)', textAlign: 'center' }}>No roles defined</td></tr>}
            {rows.map(r => (
              <tr key={r.id} onClick={() => router.push(`/roles/detail/?id=${r.id}`)} style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                <td style={td}>{r.title}{!r.active && <span style={{ color: 'var(--text-4)', fontSize: 11 }}> (inactive)</span>}</td>
                <td style={td}>{r.role_code || '—'}</td>
                <td style={td}>{r.level || '—'}</td>
                <td style={td}>{r.department?.name || '—'}</td>
                <td style={td}>{r.kpi_count || 0}</td>
                {showBands && <td style={td}>{r._bands_hidden ? '🔒' : fmtMoney(r.salary_band_mid)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New Role" confirmLabel={busy ? 'Creating…' : 'Create'} onConfirm={create} loading={busy}>
        <Field label="Title *"><input style={inp} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Role code"><input style={inp} value={form.role_code} onChange={e => setForm(f => ({ ...f, role_code: e.target.value }))} /></Field>
        <Field label="Level"><input style={inp} placeholder="e.g. L3 / Senior" value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))} /></Field>
      </Modal>
    </div>
  );
}

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const td = { padding: '10px 12px' };
const newBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--podium-green)', color: '#04130d', border: 'none', borderRadius: 'var(--radius-sm)', padding: '8px 14px', fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' };
const inp = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
function Field({ label, children }) { return <label style={{ display: 'block', marginBottom: 10 }}><div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{label}</div>{children}</label>; }
