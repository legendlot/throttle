'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { EmptyState, Panel, useToast } from '@throttle/ui';

const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', outline: 'none', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'block' };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 18px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' };

export function canManageRepack(perms) {
  return hasPermission(perms, 'repack_run_manage')
      || hasPermission(perms, 'dispatch_restock')
      || hasPermission(perms, 'users_manage');
}

export default function RepackRunNewPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const allowed = canManageRepack(perms);

  const [f, setF] = useState({ target_qty: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);

  function setField(k, v) { setF(prev => ({ ...prev, [k]: v })); }

  async function submit() {
    const qty = parseInt(f.target_qty, 10);
    if (!qty || qty < 1) { toast('Target quantity must be a positive number', 'error'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('createRepackRun', { data: {
        target_qty: qty,
        notes:      f.notes.trim() || null,
      } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); return; }
      toast(`${r.data.run_no} created`, 'success');
      router.push(`/repack-runs/detail?id=${r.data.id}`);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
    } finally { setSubmitting(false); }
  }

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState message="Access denied — you need repack_run_manage (or dispatch) permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 560 }}>
      <Panel header="New Repack Run · Channel Swap">
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 16, letterSpacing: '0.04em', lineHeight: 1.5 }}>
          A repack run is a counter for how many boxes the floor plans to redo today.
          The operator scans the old box at <strong style={{ color: 'var(--t2)' }}>Repack In</strong> on a production line — the worker rolls every unit in that box back to <strong style={{ color: 'var(--t2)' }}>QC Pass</strong>. They then re-pair car + remote at <strong style={{ color: 'var(--t2)' }}>Repack Out</strong>, pick the new channel (E/R), and the new sticker prints. The unit then flows through dispatch normally (PKG Out → DTK → Allocate → Pack → Dispatch Out).
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Target quantity <span style={{ color: 'var(--bad-fg)' }}>*</span></label>
          <input
            type="number" min="1" autoFocus
            value={f.target_qty}
            onChange={e => setField('target_qty', e.target.value)}
            placeholder="how many units the floor will repack"
            style={input}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Notes <span style={{ color: 'var(--t3)' }}>· optional</span></label>
          <textarea
            rows={3}
            value={f.notes}
            onChange={e => setField('notes', e.target.value)}
            placeholder='e.g. "Flare retail → ecom" — for daily ops visibility'
            style={{ ...input, resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => router.push('/repack-runs')} style={btnS} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={{ ...btnP, opacity: submitting ? 0.6 : 1 }} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Run'}
          </button>
        </div>
      </Panel>
    </div>
  );
}
