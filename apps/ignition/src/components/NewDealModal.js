'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, useToast } from '@throttle/ui';
import { ignitionopsGet, ignitionopsPost } from '../lib/ignitionopsFetch.js';

// Quick-add deal (engagement). Essentials only — influencer, type, deal terms,
// product, expected post date (feeds the Schedule). Lands on the new deal to
// fill metrics/links later. `presetInfluencer` prefills when launched from a
// specific influencer.
export function NewDealModal({ open, onClose, session, presetInfluencer, onCreated }) {
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(presetInfluencer || null);
  const [form, setForm] = useState({
    engagement_type: 'video_tracking', deal_type: 'paid',
    product_code: '', product_variant: '', expected_post_date: '',
  });
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => { setSelected(presetInfluencer || null); }, [presetInfluencer, open]);

  useEffect(() => {
    if (!session || search.length < 2) { setResults([]); return; }
    ignitionopsGet('getInfluencers', { search, limit: 8 }, session)
      .then(r => setResults(r.influencers || []))
      .catch(() => setResults([]));
  }, [search, session]);

  async function submit() {
    if (!selected) { setErr('Pick an influencer first'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { influencer_id: selected.id, ...form };
      if (!payload.expected_post_date) delete payload.expected_post_date;
      const res = await ignitionopsPost('createEngagement', payload, session);
      toast(`Created ${res.engagement_no}`, 'success');
      onClose?.();
      onCreated ? onCreated(res) : router.push(`/engagements/detail/?id=${res.id}`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Deal"
      confirmLabel={busy ? 'Creating…' : 'Create Deal'} confirmColor="#FF6B00"
      onConfirm={submit} loading={busy} error={err}>
      <div style={{ marginBottom: 14 }}>
        <div style={lbl}>Influencer *</div>
        {selected ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            <div>
              <span style={{ color: '#FF6B00', fontWeight: 700 }}>{selected.influencer_code}</span>
              <span style={{ marginLeft: 10 }}>{selected.channel_name || selected.person_name}</span>
            </div>
            {!presetInfluencer && <button type="button" onClick={() => setSelected(null)} style={ghost}>Change</button>}
          </div>
        ) : (
          <>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code, handle, name…" style={inp} />
            {results.length > 0 && (
              <div style={{ marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 180, overflowY: 'auto' }}>
                {results.map(r => (
                  <div key={r.id} onClick={() => { setSelected(r); setSearch(''); setResults([]); }}
                    style={{ padding: 9, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span>
                    <span style={{ marginLeft: 8 }}>{r.channel_name || r.person_name || '—'}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-3)' }}>{r.influencer_type}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Engagement type">
          <select value={form.engagement_type} onChange={e => setField('engagement_type', e.target.value)} style={inp}>
            <option value="video_tracking">Video</option>
            <option value="ugc">UGC</option>
          </select>
        </Field>
        <Field label="Deal type">
          <select value={form.deal_type} onChange={e => setField('deal_type', e.target.value)} style={inp}>
            <option value="paid">Paid</option>
            <option value="barter">Barter</option>
            <option value="affiliate">Affiliate</option>
            <option value="paid_plus_affiliate">Paid + Affiliate</option>
          </select>
        </Field>
        <Field label="Product code">
          <input value={form.product_code} onChange={e => setField('product_code', e.target.value)} placeholder="e.g. Shadow" style={inp} />
        </Field>
        <Field label="Variant / colour">
          <input value={form.product_variant} onChange={e => setField('product_variant', e.target.value)} placeholder="e.g. Tarmac Black" style={inp} />
        </Field>
        <Field label="Expected post date">
          <input type="date" value={form.expected_post_date} onChange={e => setField('expected_post_date', e.target.value)} style={inp} />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={lbl}>{label}</div>
      {children}
    </div>
  );
}
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const ghost = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
