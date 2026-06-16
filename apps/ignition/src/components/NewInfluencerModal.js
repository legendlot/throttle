'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, useToast } from '@throttle/ui';
import { ignitionopsPost } from '../lib/ignitionopsFetch.js';

const PLATFORMS = ['instagram', 'youtube', 'facebook', 'twitter', 'other'];
const TYPES = ['nano', 'micro', 'macro', 'brand', 'store'];

// Quick-add influencer. Code auto-mints worker-side (IN<n>); only essentials
// here — the rest are filled on the influencer detail page after creation.
export function NewInfluencerModal({ open, onClose, session, onCreated }) {
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({
    channel_name: '', channel_platform: 'instagram', influencer_type: 'micro',
    reach: '', contact_number: '', email: '', channel_link: '', location: '',
  });
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.channel_name.trim()) { setErr('Channel / handle name is required'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { ...form, channel_name: form.channel_name.trim(), list_status: 'master' };
      payload.reach = form.reach === '' ? null : Number(form.reach);
      const row = await ignitionopsPost('createInfluencer', payload, session);
      toast(`Added ${row.influencer_code}`, 'success');
      onClose?.();
      onCreated ? onCreated(row) : router.push(`/influencers/detail/?id=${row.id}`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Influencer"
      confirmLabel={busy ? 'Adding…' : 'Add Influencer'} confirmColor="#FF6B00"
      onConfirm={submit} loading={busy} error={err}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Channel / handle *" full>
          <input autoFocus value={form.channel_name} onChange={e => setField('channel_name', e.target.value)} placeholder="e.g. aki_d_hotpistonz" style={inp} />
        </Field>
        <Field label="Platform">
          <select value={form.channel_platform} onChange={e => setField('channel_platform', e.target.value)} style={inp}>
            {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={form.influencer_type} onChange={e => setField('influencer_type', e.target.value)} style={inp}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Reach">
          <input type="number" value={form.reach} onChange={e => setField('reach', e.target.value)} placeholder="e.g. 50000" style={inp} />
        </Field>
        <Field label="Location">
          <input value={form.location} onChange={e => setField('location', e.target.value)} placeholder="e.g. Karnataka" style={inp} />
        </Field>
        <Field label="Phone">
          <input value={form.contact_number} onChange={e => setField('contact_number', e.target.value)} placeholder="+91…" style={inp} />
        </Field>
        <Field label="Email">
          <input value={form.email} onChange={e => setField('email', e.target.value)} style={inp} />
        </Field>
        <Field label="Channel link" full>
          <input value={form.channel_link} onChange={e => setField('channel_link', e.target.value)} placeholder="https://…" style={inp} />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children, full }) {
  return (
    <div style={full ? { gridColumn: '1 / -1' } : undefined}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
