'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, Panel, Chip, StatusBadge, useToast } from '@throttle/ui';

// Stage tones map to StatusBadge variants — the local TONE map is gone.
// `brand` is yellow; `success` is green; `info` is blue; `warning` is amber/orange;
// `neutral` is gray.
export const STAGES = [
  { id: 'request_received',     label: 'Request received',      variant: 'neutral' },
  { id: 'pickup_requested',     label: 'Pickup requested',      variant: 'info'    },
  { id: 'pickup_done',          label: 'Pickup done',           variant: 'info'    },
  { id: 'reached_stores',       label: 'Reached stores',        variant: 'brand'   },
  { id: 'handed_to_production', label: 'Handed to production',  variant: 'warning' },
  { id: 'repaired_ready',       label: 'Repaired · Ready',      variant: 'success' },
  { id: 'dispatched',           label: 'Dispatched',            variant: 'neutral' },
];

export function StageBadge({ stage }) {
  const cfg = STAGES.find(s => s.id === stage) || { label: stage, variant: 'neutral' };
  return <StatusBadge variant={cfg.variant}>{cfg.label}</StatusBadge>;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}
export function ageDays(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  return Math.floor(ms / 86400000);
}

const th    = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '10px 14px', borderBottom: '1px solid rgba(64,64,64,.5)', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', outline: 'none' };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 14px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };

export default function CustomerRepairsListPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = hasPermission(perms, 'customer_repair_manage') || hasPermission(perms, 'users_manage');

  const [rows,     setRows]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [stageF,   setStageF]   = useState('');     // '' = all
  const [search,   setSearch]   = useState('');
  const [debounced,setDebounced]= useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  async function load() {
    if (!session || !allowed) return;
    setLoading(true);
    try {
      const filter = {};
      if (stageF)    filter.stage = stageF;
      if (debounced) filter.search = debounced;
      const r = await workerFetch('getCustomerRepairs', { data: filter }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); setRows([]); return; }
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast(e.message || 'Failed', 'err');
      setRows([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, stageF, debounced]);

  const counts = useMemo(() => {
    const c = { all: rows.length };
    STAGES.forEach(s => c[s.id] = 0);
    rows.forEach(r => { if (c[r.stage] != null) c[r.stage]++; });
    return c;
  }, [rows]);

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔒" message="Access denied — you need customer_repair_manage permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <Panel
        header="Customer Repairs · Intake & Tracking"
        headerAction={<button onClick={() => router.push('/customer-repairs/new')} style={btnP}>+ New Repair</button>}
      >
        {/* Stage filter chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          <Chip active={stageF === ''} onClick={() => setStageF('')} count={counts.all}>All</Chip>
          {STAGES.map(s => (
            <Chip
              key={s.id}
              active={stageF === s.id}
              onClick={() => setStageF(s.id)}
              count={counts[s.id] || 0}
            >
              {s.label}
            </Chip>
          ))}
        </div>

        {/* Search */}
        <div style={{ marginBottom: 14 }}>
          <input
            data-search-primary
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customer / order / AWB / CR-NNN  · /"
            style={{ ...input, width: '100%', maxWidth: 380 }}
          />
        </div>

        {/* Table */}
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="📥"
            message={stageF || debounced ? 'No customer repairs match these filters.' : 'No customer repairs yet — click + New Repair to capture a request.'}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>CR No</th>
                <th style={th}>Customer</th>
                <th style={th}>Order ID</th>
                <th style={th}>AWB</th>
                <th style={th}>Channel</th>
                <th style={th}>Stage</th>
                <th style={th}>Captured</th>
                <th style={{ ...th, textAlign: 'right' }}>Age</th>
              </tr></thead>
              <tbody>
                {rows.map(r => {
                  const age = ageDays(r.captured_at);
                  const ageColor = age >= 7 ? 'var(--red)' : age >= 3 ? 'var(--state-warning, #fbbf24)' : 'var(--t3)';
                  return (
                    <tr key={r.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => router.push(`/customer-repairs/detail?id=${r.id}`)}>
                      <td style={{ ...td, color: 'var(--yellow)', fontWeight: 700 }}>{r.repair_no}</td>
                      <td style={{ ...td, fontFamily: 'var(--cond)', fontWeight: 600, color: 'var(--t1)' }}>
                        {r.customer_name}
                        {r.customer_phone && (
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{r.customer_phone}</div>
                        )}
                      </td>
                      <td style={{ ...td, fontSize: 12 }}>{r.order_id || '—'}</td>
                      <td style={{ ...td, fontSize: 12 }}>{r.awb || '—'}</td>
                      <td style={{ ...td, color: 'var(--t2)' }}>{r.channel || '—'}</td>
                      <td style={td}><StageBadge stage={r.stage} /></td>
                      <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>
                        {fmtDate(r.captured_at)}
                        {r.captured_by_name && (
                          <div style={{ color: 'var(--t2)', marginTop: 2 }}>{r.captured_by_name}</div>
                        )}
                      </td>
                      <td style={{ ...td, color: ageColor, textAlign: 'right', fontWeight: 600 }}>
                        {age != null ? `${age}d` : '—'}
                      </td>
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
