'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Modal } from '@throttle/ui';
import { Lock } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../lib/podiumopsFetch.js';
import { fmtMoney } from '../../../lib/format.js';
import { GridHead, GridRow, gridTh, PrimaryButton, formLabel } from '../../../components/ui.js';

const COLS = '1.8fr 0.8fr 0.7fr 1.2fr 70px 110px';

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
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--t3)' }}>{rows.length} role{rows.length === 1 ? '' : 's'} defined{showBands ? ' · salary bands visible to HR' : ''}</span>
        <span style={{ flex: 1 }} />
        {canManage && <PrimaryButton onClick={() => setOpen(true)}>New Role</PrimaryButton>}
      </div>

      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
        <GridHead cols={COLS}>
          <div style={gridTh}>Title</div>
          <div style={gridTh}>Code</div>
          <div style={gridTh}>Level</div>
          <div style={gridTh}>Department</div>
          <div style={gridTh}>KPIs</div>
          <div style={gridTh}>Band · Mid</div>
        </GridHead>
        {rows.length === 0 && <div style={{ padding: '20px 16px', color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>No roles defined</div>}
        {rows.map(r => (
          <GridRow key={r.id} cols={COLS} onClick={() => router.push(`/roles/detail/?id=${r.id}`)}>
            <div style={{ padding: '11px 16px', fontSize: 13.5, fontWeight: 600, color: 'var(--t1)' }}>{r.title}{!r.active && <span style={{ color: 'var(--t4)', fontSize: 11 }}> (inactive)</span>}</div>
            <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 11.5, color: 'var(--t2)' }}>{r.role_code || '—'}</span></div>
            <div style={{ padding: '11px 16px' }}>{r.level ? <span style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--blue-soft)' }}>{r.level}</span> : <span style={{ color: 'var(--t4)' }}>—</span>}</div>
            <div style={{ padding: '11px 16px', fontSize: 13, color: 'var(--t3)' }}>{r.department?.name || '—'}</div>
            <div style={{ padding: '11px 16px' }}><span className="num" style={{ fontSize: 13, color: 'var(--t1)' }}>{r.kpi_count || 0}</span></div>
            <div style={{ padding: '11px 16px' }}>
              {r._bands_hidden
                ? <Lock size={14} color="var(--t4)" />
                : <span className="num" style={{ fontSize: 13, color: 'var(--yellow)' }}>{r.salary_band_mid != null ? fmtMoney(r.salary_band_mid) : '—'}</span>}
            </div>
          </GridRow>
        ))}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New Role" confirmLabel={busy ? 'Creating…' : 'Create'} onConfirm={create} loading={busy}>
        <Field label="Title *"><input className="pd-input" style={inp} value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} /></Field>
        <Field label="Role code"><input className="pd-input" style={inp} value={form.role_code} onChange={e => setForm(f => ({ ...f, role_code: e.target.value }))} /></Field>
        <Field label="Level"><input className="pd-input" style={inp} placeholder="e.g. L3 / Senior" value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))} /></Field>
      </Modal>
    </div>
  );
}

const inp = { width: '100%', background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '9px 11px', fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none' };
function Field({ label, children }) { return <label style={{ display: 'block', marginBottom: 12 }}><div style={formLabel}>{label}</div>{children}</label>; }
