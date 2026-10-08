'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import { Card, LockedNote, KV } from './shared.js';

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
  const highCpm = cpm != null && Number(cpm) > 100;
  return (
    <Card title="Costs" action={canEdit && !locked && !editing ? 'Edit' : null} onAction={startEdit}>
      {locked && <LockedNote />}
      <KV label="Goodies" value={<span style={mono}>₹{Number(e.goodies_cost || 0).toLocaleString()}</span>} />
      <KV label="Shipping" value={<span style={mono}>₹{Number(e.shipping_cost || 0).toLocaleString()}</span>} />
      {editing && !locked ? (
        <>
          <CostEdit label="Return ₹" value={ret} onChange={setRet} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={() => setEditing(false)} className="ig-ghost-btn" style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy} style={{ ...primaryBtn, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <>
          <KV label="Return" value={<span style={mono}>₹{Number(e.return_cost || 0).toLocaleString()}</span>} />
          <KV label="CPM (organic)" value={cpm != null
            ? <span style={{ ...mono, color: highCpm ? 'var(--state-error-fg)' : 'var(--text-1)', fontWeight: highCpm ? 700 : 400 }}>
                ₹{Number(cpm).toFixed(2)}{highCpm ? ' ⚠ high' : ''}
              </span>
            : '—'} />
          <KV label="Total cost" value={<span style={{ ...mono, fontWeight: 700, color: 'var(--accent-hi)' }}>₹{Number(e.total_cost || 0).toLocaleString()}</span>} />
        </>
      )}
    </Card>
  );
}

// Also the edit row of the Deal terms card (DealTermsCard imports it) — keep the signature.
export function CostEdit({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: '1px solid var(--row-divider)', fontSize: 14 }}>
      <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{label}</span>
      <input type="number" min="0" value={value} onChange={e => onChange(e.target.value)} placeholder="0"
        style={{ width: '100%', maxWidth: 160, boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'right' }} />
    </div>
  );
}

const mono = { fontFamily: 'var(--font-mono)' };
const primaryBtn = { height: 36, padding: '0 16px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700 };
const ghostBtn = { height: 36, padding: '0 14px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
