'use client';
/* ════════════════════════════════════════════════════════════
   DISPATCH · REPACK — Pit Wall v2. Channel-swap repack runs.
   Prototype: redesign-reference/app/repack.jsx. Data unchanged
   (getRepackRuns, canManageRepack gate). Exports RPK_STATUSES /
   RpkStatusBadge / fmtDate consumed by detail + reports routes.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { canManageRepack } from './new/page';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, FilterChip, ToneBadge, fmt, btnPrimary } from '../../../components/kit/index.js';

// status → kit ToneBadge tone (kept exported for sub-routes; variant retained for back-compat)
export const RPK_STATUSES = [
  { id: 'Open',        label: 'Open',        tone: 'info',  variant: 'info'    },
  { id: 'In Progress', label: 'In Progress', tone: 'brand', variant: 'brand'   },
  { id: 'Completed',   label: 'Completed',   tone: 'ok',    variant: 'success' },
  { id: 'Cancelled',   label: 'Cancelled',   tone: 'mute',  variant: 'neutral' },
];

export function RpkStatusBadge({ status }) {
  const cfg = RPK_STATUSES.find(s => s.id === status) || { label: status, tone: 'mute' };
  return <ToneBadge tone={cfg.tone}>{cfg.label}</ToneBadge>;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}

const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '11px 14px', borderTop: '1px solid var(--border)', verticalAlign: 'middle' };

export default function RepackRunsListPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const allowed = canManageRepack(perms);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusF, setStatusF] = useState('');

  async function load() {
    if (!session || !allowed) return;
    setLoading(true); setRefreshing(true);
    try {
      const filter = {};
      if (statusF) filter.status = statusF;
      const r = await workerFetch('getRepackRuns', { data: filter }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); setRows([]); return; }
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
      setRows([]);
    } finally { setLoading(false); setRefreshing(false); setLastRefreshed(new Date()); }
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
      <Panel pad={0}>
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
            background: 'var(--bad-bg)', color: 'var(--bad-fg)', border: '1px solid var(--bad-bd)', marginBottom: 12 }}>
            <Icon name="shield" size={22} /></div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>Access denied</div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>You need repack_run_manage (or dispatch) permission.</div>
        </div>
      </Panel>
    );
  }

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      <Panel title="Repack runs · channel swap" icon="swap" pad={16}
        action={<button onClick={() => router.push('/repack-runs/new')} style={{ ...btnPrimary, padding: '7px 13px' }}><Icon name="plus" size={14} /> New Run</button>}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          <FilterChip active={statusF === ''} onClick={() => setStatusF('')} count={counts.all}>All</FilterChip>
          {RPK_STATUSES.map(s => (
            <FilterChip key={s.id} active={statusF === s.id} onClick={() => setStatusF(s.id)} count={counts[s.id] || 0}>{s.label}</FilterChip>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
              <Icon name="swap" size={22} /></div>
            <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>{statusF ? 'No repack runs with this status' : 'No repack runs yet'}</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>Click New Run to start a channel swap.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th className="eyebrow" style={thStyle}>Run</th>
                <th className="eyebrow" style={thStyle}>Progress</th>
                <th className="eyebrow" style={thStyle}>Status</th>
                <th className="eyebrow" style={thStyle}>Notes</th>
                <th className="eyebrow" style={thStyle}>Created</th>
              </tr></thead>
              <tbody>
                {rows.map(r => {
                  const repacked = Number(r.repacked) || 0;
                  const target = Number(r.target_qty) || 0;
                  const pct = target > 0 ? Math.round((repacked / target) * 100) : 0;
                  return (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => router.push(`/repack-runs/detail?id=${r.id}`)}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <td className="num" style={{ ...tdBase, color: 'var(--yellow)', fontWeight: 700 }}>{r.run_no}</td>
                      <td style={tdBase}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="num" style={{ minWidth: 96 }}>
                            <span style={{ color: repacked >= target ? 'var(--ok-fg)' : 'var(--t1)', fontWeight: 700 }}>{fmt(repacked)}</span>
                            <span style={{ color: 'var(--t4)' }}> / {fmt(target)}</span>
                          </span>
                          <span style={{ flex: 1, maxWidth: 120, height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${Math.min(pct, 100)}%`, background: repacked >= target ? 'var(--green)' : 'var(--yellow)' }} />
                          </span>
                          <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{pct}%</span>
                        </span>
                      </td>
                      <td style={tdBase}><RpkStatusBadge status={r.status} /></td>
                      <td style={{ ...tdBase, color: 'var(--t2)', maxWidth: 320, fontSize: 12.5 }}>{r.notes || '—'}</td>
                      <td className="num" style={{ ...tdBase, fontSize: 11, color: 'var(--t3)' }}>{fmtDate(r.created_at)}</td>
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
