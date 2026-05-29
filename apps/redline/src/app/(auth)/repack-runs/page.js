'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast } from '@throttle/ui';
import { canManageRepack } from './new/page';

export const RPK_STATUSES = [
  { id: 'Open',        label: 'Open',        variant: 'info'    },
  { id: 'In Progress', label: 'In Progress', variant: 'brand'   },
  { id: 'Completed',   label: 'Completed',   variant: 'success' },
  { id: 'Cancelled',   label: 'Cancelled',   variant: 'neutral' },
];

export function RpkStatusBadge({ status }) {
  const cfg = RPK_STATUSES.find(s => s.id === status) || { label: status, variant: 'neutral' };
  return <StatusBadge variant={cfg.variant}>{cfg.label}</StatusBadge>;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}

const th   = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td   = { padding: '10px 14px', borderBottom: '1px solid rgba(64,64,64,.5)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', verticalAlign: 'top' };
const btnP = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 14px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };

export default function RepackRunsListPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = canManageRepack(perms);

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusF, setStatusF] = useState('');

  async function load() {
    if (!session || !allowed) return;
    setLoading(true);
    try {
      const filter = {};
      if (statusF) filter.status = statusF;
      const r = await workerFetch('getRepackRuns', { data: filter }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); setRows([]); return; }
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast(e.message || 'Failed', 'err');
      setRows([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, statusF]);

  const counts = useMemo(() => {
    const c = { all: rows.length };
    RPK_STATUSES.forEach(s => c[s.id] = 0);
    rows.forEach(r => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [rows]);

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔒" message="Access denied — you need repack_run_manage (or dispatch) permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <Panel
        header="Repack Runs · Channel Swap"
        headerAction={<button onClick={() => router.push('/repack-runs/new')} style={btnP}>+ New Run</button>}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          <Chip active={statusF === ''} onClick={() => setStatusF('')} count={counts.all}>All</Chip>
          {RPK_STATUSES.map(s => (
            <Chip key={s.id} active={statusF === s.id} onClick={() => setStatusF(s.id)} count={counts[s.id] || 0}>
              {s.label}
            </Chip>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="🔁"
            message={statusF ? 'No repack runs with this status.' : 'No repack runs yet — click + New Run to start a channel swap.'}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Run</th>
                <th style={th}>Product</th>
                <th style={th}>Swap</th>
                <th style={th}>Progress</th>
                <th style={th}>Status</th>
                <th style={th}>Created</th>
              </tr></thead>
              <tbody>
                {rows.map(r => {
                  const variant = [r.variant_model, r.colour].filter(Boolean).join(' ');
                  const repacked = r.repacked || 0;
                  const pct = r.target_qty > 0 ? Math.round((repacked / r.target_qty) * 100) : 0;
                  return (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/repack-runs/detail?id=${r.id}`)}>
                      <td style={{ ...td, color: 'var(--yellow)', fontWeight: 700 }}>{r.run_no}</td>
                      <td style={{ ...td, fontFamily: 'var(--cond)', fontWeight: 600 }}>
                        {r.product}
                        {variant && <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{variant}</div>}
                      </td>
                      <td style={{ ...td, color: 'var(--t2)' }}>{r.from_channel} → {r.to_channel}</td>
                      <td style={td}>
                        <span style={{ color: repacked >= r.target_qty ? 'var(--green, #34d399)' : 'var(--t1)', fontWeight: 700 }}>{repacked}</span>
                        <span style={{ color: 'var(--t3)' }}> / {r.target_qty}</span>
                        <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>{pct}%</span>
                      </td>
                      <td style={td}><RpkStatusBadge status={r.status} /></td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{fmtDate(r.created_at)}</td>
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
