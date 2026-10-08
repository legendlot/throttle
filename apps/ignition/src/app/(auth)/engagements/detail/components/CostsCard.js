'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { LockedNote, KV } from './shared.js';

// Costs card. Goodies + shipping roll up from the product lines (edit those in the
// Products card); return cost + ad spend are engagement-level and editable here (⑦).
export function CostsCard({ e, canEdit, locked, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ret, setRet] = useState('');

  // S373: the "Ad spend" input is retired — ad money (payments to the creator for ad rights, and
  // Meta spend) lives on the Ads card and is NOT influencer budget. The column stays (the UGC Meta
  // pull still writes it) but it is no longer a term of the generated total_cost, so it is not
  // shown here: a row above TOTAL would read as part of it.
  function startEdit() {
    setRet(e.return_cost ?? '');
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
      await ignitionopsPost('updateEngagement', {
        engagement_id: e.id,
        return_cost: numOrNull(ret),
      }, session);
      toast('Costs updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  const cpm = e.cpm;
  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Costs</h2>
        {canEdit && !locked && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {locked && <LockedNote />}
      <KV label="Goodies" value={`₹${Number(e.goodies_cost || 0).toLocaleString()}`} />
      <KV label="Shipping" value={`₹${Number(e.shipping_cost || 0).toLocaleString()}`} />
      {editing && !locked ? (
        <>
          <CostEdit label="Return ₹" value={ret} onChange={setRet} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <KV label="Return" value={`₹${Number(e.return_cost || 0).toLocaleString()}`} />
          <KV label="CPM (organic)" value={cpm != null
            ? <span style={{ color: Number(cpm) > 100 ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: Number(cpm) > 100 ? 700 : 400 }}>
                ₹{Number(cpm).toFixed(2)}{Number(cpm) > 100 ? ' ⚠ high' : ''}
              </span>
            : '—'} />
          <KV label="TOTAL" value={<strong style={{ color: '#FF6B00' }}>₹{Number(e.total_cost || 0).toLocaleString()}</strong>} />
        </>
      )}
    </section>
  );
}

export function CostEdit({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', alignItems: 'center' }}>
      <span style={{ width: 130, color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <input type="number" min="0" value={value} onChange={e => onChange(e.target.value)} placeholder="0"
        style={{ flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 9px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
    </div>
  );
}
