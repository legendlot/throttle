'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast } from '@throttle/ui';

export const STAGES = [
  { id: 'request_received',     label: 'Request received',      tone: 'gray'   },
  { id: 'pickup_requested',     label: 'Pickup requested',      tone: 'blue'   },
  { id: 'pickup_done',          label: 'Pickup done',           tone: 'blue'   },
  { id: 'reached_stores',       label: 'Reached stores',        tone: 'yellow' },
  { id: 'handed_to_production', label: 'Handed to production',  tone: 'orange' },
  { id: 'repaired_ready',       label: 'Repaired · Ready',      tone: 'green'  },
  { id: 'dispatched',           label: 'Dispatched',            tone: 'gray'   },
];

const TONE = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};

export function StageBadge({ stage }) {
  const cfg = STAGES.find(s => s.id === stage) || { label: stage, tone: 'gray' };
  const s = TONE[cfg.tone];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{cfg.label}</span>
  );
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

const panel = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const phdr  = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const pbody = { padding: '12px 14px' };
const th    = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const td    = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };
const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const btnP  = { background: '#f2cd1a', border: 'none', borderRadius: 3, padding: '8px 14px', fontSize: 12, color: '#0a0a0a', cursor: 'pointer', fontFamily: 'var(--cond)', fontWeight: 700, letterSpacing: '0.05em' };
const chip  = { padding: '5px 11px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.05em', textTransform: 'uppercase', border: '1px solid var(--border)', background: 'transparent', color: 'var(--t2)', cursor: 'pointer' };
const chipActive = { ...chip, background: '#f2cd1a', color: '#0a0a0a', border: '1px solid #f2cd1a', fontWeight: 700 };

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
        <EmptyState title="Access denied" subtitle="You need customer_repair_manage permission to view this page." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Customer Repairs · Intake & Tracking</span>
          <button onClick={() => router.push('/customer-repairs/new')} style={btnP}>+ NEW REPAIR</button>
        </div>
        <div style={pbody}>
          {/* Stage filter chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            <button onClick={() => setStageF('')} style={stageF === '' ? chipActive : chip}>
              All · {counts.all}
            </button>
            {STAGES.map(s => (
              <button key={s.id} onClick={() => setStageF(s.id)} style={stageF === s.id ? chipActive : chip}>
                {s.label} · {counts[s.id] || 0}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ marginBottom: 12 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search customer / order / AWB / CR-NNN"
              style={{ ...input, width: '100%', maxWidth: 360 }}
            />
          </div>

          {/* Table */}
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No customer repairs"
              subtitle={stageF || debounced ? 'Try clearing filters.' : 'Click + New Repair to capture a request.'}
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
                    return (
                      <tr key={r.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => router.push(`/customer-repairs/detail?id=${r.id}`)}>
                        <td style={{ ...td, fontFamily: 'var(--mono)', color: '#f2cd1a', fontWeight: 700 }}>{r.repair_no}</td>
                        <td style={{ ...td, fontFamily: 'var(--cond)', fontWeight: 600 }}>
                          {r.customer_name}
                          {r.customer_phone && <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.customer_phone}</div>}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.order_id || '—'}</td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>{r.awb || '—'}</td>
                        <td style={td}>{r.channel || '—'}</td>
                        <td style={td}><StageBadge stage={r.stage} /></td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                          {fmtDate(r.captured_at)}
                          <div style={{ color: 'var(--t2)' }}>{r.captured_by_name || ''}</div>
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11, color: age >= 7 ? '#ff7070' : age >= 3 ? '#fbbf24' : 'var(--t3)', textAlign: 'right' }}>
                          {age != null ? `${age}d` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
