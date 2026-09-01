'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, garageFetch } from '@throttle/db';
import { EmptyState, useToast, Combobox } from '@throttle/ui';
import { PURPOSES } from '../page.js';

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '14px 16px' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnP  = { background: '#f2cd1a', border: 'none', borderRadius: 3, padding: '10px 18px', fontSize: 12, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '9px 16px', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.05em' };

export default function DirectIssuanceNewPage() {
  const router = useRouter();
  const { session, perms, userId } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = hasPermission(perms, 'direct_issuance_request') || hasPermission(perms, 'users_manage');

  const [f, setF] = useState({
    purpose: 'sample',
    vendor_code: '',
    destination: '',
    destination_contact: '',
    requester_notes: '',
    expected_return_at: '',
    notes: '',
  });
  const [vendors, setVendors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // Keyed on userId, NEVER on `session` — onAuthStateChange re-fires on tab switch and a real
  // token refresh lands ~hourly, and re-running this effect would blow away a half-typed form.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await garageFetch('getVendors', {}, session);
        if (alive && Array.isArray(r)) setVendors(r);
      } catch { /* picker stays empty; the field still blocks submit */ }
    })();
    return () => { alive = false; };
  }, [userId]);   // eslint-disable-line react-hooks/exhaustive-deps

  function setField(k, v) { setF(prev => ({ ...prev, [k]: v })); }

  async function submit() {
    if (!f.purpose) { toast('Purpose required', 'error'); return; }
    if (!f.vendor_code) { toast('Pick a vendor — use LOT Office for an internal request', 'error'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('saveDirectIssuance', { data: f }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data.issue_no} created`, 'success');
      router.push(`/direct-issuance/detail?id=${r.data.id}`);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
    } finally { setSubmitting(false); }
  }

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState title="Access denied" subtitle="You need direct_issuance_request permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <div style={panel}>
        <div style={phdr}><span>New Direct Issuance</span></div>
        <div style={pbody}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 14 }}>
            Create a draft — you&apos;ll add part/unit lines on the next screen, then approve &amp; issue.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={lbl}>Purpose <span style={{ color: '#ff7070' }}>*</span></label>
              <select value={f.purpose} onChange={e => setField('purpose', e.target.value)} style={input}>
                {PURPOSES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Expected return date (optional)</label>
              <input type="date" value={f.expected_return_at} onChange={e => setField('expected_return_at', e.target.value)} style={input} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Vendor <span style={{ color: '#ff7070' }}>*</span></label>
              {/* `portal` is required — this form sits inside a bordered panel, and without it
                  the dropdown is clipped by the panel's bounds. */}
              <Combobox
                portal
                value={f.vendor_code}
                onChange={v => setField('vendor_code', v)}
                options={vendors.map(v => ({
                  value:  v.vendor_code,
                  label:  v.vendor_name,
                  hint:   v.vendor_code,
                  search: v.category || '',
                }))}
                placeholder="Search vendor… (use LOT Office for internal)"
              />
              <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
                Internal / office requests go to <strong>LOT Office</strong>.
              </div>
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Deliver to (person or place)</label>
              <input value={f.destination} onChange={e => setField('destination', e.target.value)} placeholder="e.g. Kirti / LOT HQ / Brand Team" style={input} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Contact phone</label>
              <input value={f.destination_contact} onChange={e => setField('destination_contact', e.target.value)} placeholder="e.g. +91 98204 90522" style={input} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Reason / context (visible to store)</label>
              <textarea rows={2} value={f.requester_notes} onChange={e => setField('requester_notes', e.target.value)} placeholder="Why are these items needed?" style={{ ...input, resize: 'vertical' }} />
            </div>
            <div style={{ gridColumn: '1 / 3' }}>
              <label style={lbl}>Internal notes (optional)</label>
              <textarea rows={2} value={f.notes} onChange={e => setField('notes', e.target.value)} style={{ ...input, resize: 'vertical' }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => router.push('/direct-issuance')} style={btnS} disabled={submitting}>CANCEL</button>
            <button onClick={submit} style={btnP} disabled={submitting}>
              {submitting ? 'CREATING…' : 'CREATE DRAFT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
