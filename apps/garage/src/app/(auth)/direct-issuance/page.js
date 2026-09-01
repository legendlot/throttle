'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast } from '@throttle/ui';

export const STATUSES = [
  { id: 'draft',     label: 'Draft',     tone: 'gray'   },
  { id: 'approved',  label: 'Approved',  tone: 'blue'   },
  { id: 'issued',    label: 'Issued',    tone: 'yellow' },
  { id: 'closed',    label: 'Closed',    tone: 'green'  },
  { id: 'cancelled', label: 'Cancelled', tone: 'gray'   },
];

// ⛔ MIRRORED SERVER-SIDE in 01_worker/worker.js `DI_PURPOSES`. Adding a purpose here WITHOUT
// adding it there makes the worker reject it on create with "Invalid purpose". Both or neither.
export const PURPOSES = [
  { id: 'sample',               label: 'Sample' },
  { id: 'office_request',       label: 'Office Request' },
  { id: 'external_test',        label: 'External Test' },
  { id: 'customer_replacement', label: 'Customer Replacement' },
  { id: 'marketing_event',      label: 'Marketing Event' },
  { id: 'jobwork',              label: 'Job Work (to vendor)' },
  { id: 'other',                label: 'Other' },
];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};

export function StatusBadge({ status }) {
  const cfg = STATUSES.find(s => s.id === status) || { label: status, tone: 'gray' };
  const s = TONE_STYLES[cfg.tone];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{cfg.label}</span>
  );
}

export function fmtTs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}

export function purposeLabel(id) {
  const p = PURPOSES.find(x => x.id === id);
  return p ? p.label : id;
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

export default function DirectIssuanceListPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const canRequest = hasPermission(perms, 'direct_issuance_request') || hasPermission(perms, 'users_manage');

  const [rows,      setRows]      = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [statusF,   setStatusF]   = useState('');     // '' = all (non-cancelled)
  const [purposeF,  setPurposeF]  = useState('');
  const [search,    setSearch]    = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  async function load() {
    if (!session || !canRequest) return;
    setLoading(true);
    try {
      const filter = {};
      if (statusF)   filter.status = statusF;
      else           filter.status = 'draft,issued,closed';   // default hide cancelled
      if (purposeF)  filter.purpose = purposeF;
      if (debounced) filter.search = debounced;
      const r = await workerFetch('getDirectIssuances', { data: filter }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'error'); setRows([]); return; }
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast(e.message || 'Failed', 'error');
      setRows([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [session, statusF, purposeF, debounced]);

  const counts = useMemo(() => {
    const c = { all: rows.length };
    STATUSES.forEach(s => c[s.id] = 0);
    rows.forEach(r => { if (c[r.status] != null) c[r.status]++; });
    return c;
  }, [rows]);

  if (!canRequest) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState title="Access denied" subtitle="You need direct_issuance_request permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={panel}>
        <div style={phdr}>
          <span>Direct Store Issuance</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => router.push('/direct-issuance/reports')} style={{ ...btnP, background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border)' }}>📊 Reports</button>
            <button onClick={() => router.push('/direct-issuance/new')} style={btnP}>+ NEW ISSUE</button>
          </span>
        </div>
        <div style={pbody}>
          {/* Status filter chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <button onClick={() => setStatusF('')} style={statusF === '' ? chipActive : chip}>
              Active · {counts.draft + counts.approved + counts.issued + counts.closed}
            </button>
            {STATUSES.map(s => (
              <button key={s.id} onClick={() => setStatusF(s.id)} style={statusF === s.id ? chipActive : chip}>
                {s.label} · {counts[s.id] || 0}
              </button>
            ))}
          </div>

          {/* Secondary filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={purposeF} onChange={e => setPurposeF(e.target.value)} style={{ ...input, minWidth: 180 }}>
              <option value="">All purposes</option>
              {PURPOSES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input
              data-search-primary
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search DI no / destination / contact  · /"
              style={{ ...input, flex: 1, minWidth: 240 }}
            />
          </div>

          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No issuances"
              subtitle={statusF || purposeF || debounced
                ? 'Try clearing filters.'
                : 'Click + New Issue to record a direct issuance.'}
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>DI No</th>
                  <th style={th}>Purpose</th>
                  <th style={th}>Destination</th>
                  <th style={th}>Items</th>
                  <th style={th}>Status</th>
                  <th style={th}>Requested by</th>
                  <th style={th}>Issued</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => router.push(`/direct-issuance/detail?id=${r.id}`)}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', color: '#f2cd1a', fontWeight: 700 }}>{r.issue_no}</td>
                      <td style={td}>{purposeLabel(r.purpose)}</td>
                      <td style={td}>
                        {r.destination || '—'}
                        {r.destination_contact && <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.destination_contact}</div>}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {r.item_summary?.lines || 0} lines
                        {(r.item_summary?.parts || 0) > 0 && (
                          <span style={{ color: 'var(--t3)' }}> · {r.item_summary.parts}p</span>
                        )}
                        {(r.item_summary?.units || 0) > 0 && (
                          <span style={{ color: 'var(--t3)' }}> · {r.item_summary.units}u</span>
                        )}
                      </td>
                      <td style={td}><StatusBadge status={r.status} /></td>
                      <td style={{ ...td, fontSize: 11 }}>
                        {r.requester_name || '—'}
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>{fmtTs(r.created_at)}</div>
                      </td>
                      <td style={{ ...td, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>
                        {r.issued_at ? fmtTs(r.issued_at) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
