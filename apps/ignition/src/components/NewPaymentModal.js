'use client';
import { useEffect, useState } from 'react';
import { Modal, useToast } from '@throttle/ui';
import { supabase } from '@throttle/db';
import { ignitionopsGet, ignitionopsPost } from '../lib/ignitionopsFetch.js';

const PROOF_BUCKET = 'ignition-payment-proofs';

// Record a payment against a deal. Flow: search influencer → pick one of their
// deals → kind (advance/final/other) + amount + date. Kept deliberately small.
export function NewPaymentModal({ open, onClose, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [influencer, setInfluencer] = useState(null);
  const [engagements, setEngagements] = useState([]);
  const [form, setForm] = useState({ engagement_id: '', kind: 'advance', amount: '', paid_on: '', note: '' });
  const [proofFile, setProofFile] = useState(null);
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function reset() {
    setSearch(''); setResults([]); setInfluencer(null); setEngagements([]);
    setForm({ engagement_id: '', kind: 'advance', amount: '', paid_on: '', note: '' }); setProofFile(null); setErr(null);
  }
  useEffect(() => { if (open) reset(); }, [open]);

  useEffect(() => {
    if (!session || search.length < 2) { setResults([]); return; }
    ignitionopsGet('getInfluencers', { search, limit: 8 }, session)
      .then(r => setResults(r.influencers || [])).catch(() => setResults([]));
  }, [search, session]);

  function pickInfluencer(inf) {
    setInfluencer(inf); setSearch(''); setResults([]);
    ignitionopsGet('getInfluencer', { id: inf.id }, session)
      .then(r => {
        const engs = r.engagements || [];
        setEngagements(engs);
        if (engs.length === 1) setField('engagement_id', engs[0].id);
      })
      .catch(() => setEngagements([]));
  }

  async function submit() {
    if (!form.engagement_id) { setErr('Pick the deal this payment is for'); return; }
    if (!(Number(form.amount) >= 0) || form.amount === '') { setErr('Enter an amount'); return; }
    if (!proofFile) { setErr('A payment screenshot is required'); return; }   // #12
    setBusy(true); setErr(null);
    try {
      let proof = {};
      if (proofFile) {
        const { storage_path, token } = await ignitionopsPost(
          'createPaymentProofUploadUrl',
          { engagement_id: form.engagement_id, file_name: proofFile.name },
          session,
        );
        if (!token) throw new Error('Could not get an upload link for the screenshot');
        const { error } = await supabase.storage.from(PROOF_BUCKET).uploadToSignedUrl(storage_path, token, proofFile);
        if (error) throw error;
        proof = { proof_path: storage_path, proof_name: proofFile.name, proof_mime: proofFile.type || null };
      }
      await ignitionopsPost('addPayment', {
        engagement_id: form.engagement_id,
        kind: form.kind,
        amount: Number(form.amount),
        paid_on: form.paid_on || undefined,
        note: form.note || undefined,
        ...proof,
      }, session);
      toast('Payment recorded', 'success');
      onClose?.(); onSaved?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record Payment"
      confirmLabel={busy ? 'Saving…' : 'Save Payment'} confirmColor="#FF6B00"
      onConfirm={submit} loading={busy} error={err}>
      <div style={{ marginBottom: 14 }}>
        <div style={lbl}>Influencer *</div>
        {influencer ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            <span><span style={{ color: '#FF6B00', fontWeight: 700 }}>{influencer.influencer_code}</span> {influencer.channel_name || influencer.person_name}</span>
            <button type="button" onClick={() => { setInfluencer(null); setEngagements([]); setField('engagement_id', ''); }} style={ghost}>Change</button>
          </div>
        ) : (
          <>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code, handle, name…" style={inp} />
            {results.length > 0 && (
              <div style={{ marginTop: 6, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 180, overflowY: 'auto' }}>
                {results.map(r => (
                  <div key={r.id} onClick={() => pickInfluencer(r)} style={{ padding: 9, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: '#FF6B00', fontWeight: 600 }}>{r.influencer_code}</span>
                    <span style={{ marginLeft: 8 }}>{r.channel_name || r.person_name || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {influencer && (
        <div style={{ marginBottom: 14 }}>
          <div style={lbl}>Deal *</div>
          {engagements.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>This influencer has no deals yet — create one first.</div>
          ) : (
            <select value={form.engagement_id} onChange={e => setField('engagement_id', e.target.value)} style={inp}>
              <option value="">Select a deal…</option>
              {engagements.map(e => (
                <option key={e.id} value={e.id}>{e.engagement_no} · {e.product_code || 'no product'} · {e.stage}</option>
              ))}
            </select>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Payment kind">
          <select value={form.kind} onChange={e => setField('kind', e.target.value)} style={inp}>
            <option value="advance">Advance</option>
            <option value="final">Final</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Amount (₹)">
          <input type="number" value={form.amount} onChange={e => setField('amount', e.target.value)} placeholder="0" style={inp} />
        </Field>
        <Field label="Paid on">
          <input type="date" value={form.paid_on} onChange={e => setField('paid_on', e.target.value)} style={inp} />
        </Field>
        <Field label="Note">
          <input value={form.note} onChange={e => setField('note', e.target.value)} placeholder="UTR / ref (optional)" style={inp} />
        </Field>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={lbl}>Payment screenshot *</div>
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={e => setProofFile(e.target.files?.[0] || null)}
          style={{ fontSize: 12, color: 'var(--text-2)' }}
        />
        {proofFile && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-3)' }}>{proofFile.name}</span>}
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return <div><div style={lbl}>{label}</div>{children}</div>;
}
const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const ghost = { padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
