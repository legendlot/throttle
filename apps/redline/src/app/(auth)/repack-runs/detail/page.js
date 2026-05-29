'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, useToast } from '@throttle/ui';
import { canManageRepack } from '../new/page';
import { RpkStatusBadge, fmtDate } from '../page';

const btnP = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 14px', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 14px', fontSize: 13, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--mono)' };
const btnD = { ...btnS, color: 'var(--red)', borderColor: 'var(--red)' };
const th   = { padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td   = { padding: '8px 12px', borderBottom: '1px solid rgba(64,64,64,.5)', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t1)', verticalAlign: 'top' };
const meta = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' };

export default function RepackRunDetailPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}>
      <RepackRunDetailInner />
    </Suspense>
  );
}

function RepackRunDetailInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const id = sp.get('id');
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = canManageRepack(perms);

  const [run, setRun]     = useState(null);
  const [loading, setLd]  = useState(true);
  const [busy, setBusy]   = useState(false);

  const load = useCallback(async () => {
    if (!session || !allowed || !id) return;
    setLd(true);
    try {
      const r = await workerFetch('getRepackRun', { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); setRun(null); return; }
      setRun(r.data);
    } catch (e) { toast(e.message || 'Failed', 'err'); setRun(null); }
    finally { setLd(false); }
  }, [session, allowed, id]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  async function act(action, label) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await workerFetch(action, { data: { id } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); return; }
      toast(`${label} — ${r.data.run_no || ''}`, 'ok');
      await load();
    } catch (e) { toast(e.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  if (!allowed) return <div style={{ padding: 16 }}><EmptyState icon="🔒" message="Access denied." /></div>;
  if (loading)  return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!run)     return <div style={{ padding: 16 }}><EmptyState icon="🔍" message="Repack run not found." /></div>;

  const repacked  = run.repacked || 0;
  const pct       = run.target_qty > 0 ? Math.round((repacked / run.target_qty) * 100) : 0;
  const active    = run.status === 'Open' || run.status === 'In Progress';
  const swaps     = Array.isArray(run.swaps) ? run.swaps : [];

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <button onClick={() => router.push('/repack-runs')} style={{ ...btnS, marginBottom: 12 }}>← All runs</button>

      <Panel
        header={`${run.run_no} · Channel Swap`}
        headerAction={active ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => act('completeRepackRun', 'Completed')} style={{ ...btnP, opacity: busy ? 0.6 : 1 }} disabled={busy}>Complete</button>
            <button onClick={() => { if (confirm(`Cancel ${run.run_no}? Units already repacked stay repacked.`)) act('cancelRepackRun', 'Cancelled'); }} style={{ ...btnD, opacity: busy ? 0.6 : 1 }} disabled={busy}>Cancel</button>
          </div>
        ) : <RpkStatusBadge status={run.status} />}
      >
        {/* Header facts */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginBottom: 18 }}>
          <div><div style={meta}>Target</div><div style={{ fontFamily: 'var(--cond)', fontSize: 16, fontWeight: 700, color: 'var(--yellow)' }}>{run.target_qty} units</div></div>
          <div><div style={meta}>Status</div><div style={{ marginTop: 2 }}><RpkStatusBadge status={run.status} /></div></div>
          <div><div style={meta}>Created</div><div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{fmtDate(run.created_at)}</div></div>
          {run.completed_at && <div><div style={meta}>Completed</div><div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{fmtDate(run.completed_at)}</div></div>}
        </div>

        {/* Progress */}
        <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={meta}>Repacked</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
            <strong style={{ color: repacked >= run.target_qty ? 'var(--green, #34d399)' : 'var(--yellow)' }}>{repacked}</strong>
            <span style={{ color: 'var(--t3)' }}> / {run.target_qty} · {pct}%</span>
            {run.in_flight > 0 && <span style={{ color: 'var(--state-warning, #fbbf24)', marginLeft: 8 }}>{run.in_flight} in-flight</span>}
          </span>
        </div>
        <div style={{ height: 8, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden', marginBottom: 18 }}>
          <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: repacked >= run.target_qty ? 'var(--green, #34d399)' : 'var(--yellow)' }} />
        </div>

        {run.notes && (
          <div style={{ marginBottom: 18, padding: '8px 12px', background: 'var(--surface2)', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{run.notes}</div>
        )}

        {/* Swap history */}
        <h3 style={{ margin: '4px 0 10px', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Units · {swaps.length}
        </h3>
        {swaps.length === 0 ? (
          <EmptyState icon="📦" message="No units repacked yet — scan the old box at Repack In to start." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Car UPC</th>
                <th style={th}>Remote</th>
                <th style={th}>Swap</th>
                <th style={th}>Old label</th>
                <th style={th}>New label</th>
                <th style={th}>In</th>
                <th style={th}>Out</th>
              </tr></thead>
              <tbody>
                {swaps.map(s => {
                  const swap = (s.from_channel || s.to_channel)
                    ? `${s.from_channel || '?'} → ${s.to_channel || '?'}`
                    : '—';
                  return (
                    <tr key={s.id}>
                      <td style={{ ...td, color: 'var(--t1)', fontWeight: 600 }}>{s.car_upc}</td>
                      <td style={{ ...td, color: 'var(--t3)' }}>{s.paired_remote_upc || '—'}</td>
                      <td style={{ ...td, color: 'var(--t2)' }}>{swap}</td>
                      <td style={{ ...td, color: 'var(--t3)' }}>{s.old_batch_label || '—'}</td>
                      <td style={{ ...td, color: s.new_batch_label ? 'var(--t1)' : 'var(--state-warning, #fbbf24)' }}>{s.new_batch_label || 'in-flight'}</td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{fmtDate(s.repacked_in_at)}</td>
                      <td style={{ ...td, fontSize: 11, color: s.repacked_out_at ? 'var(--t3)' : 'var(--state-warning, #fbbf24)' }}>{s.repacked_out_at ? fmtDate(s.repacked_out_at) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
