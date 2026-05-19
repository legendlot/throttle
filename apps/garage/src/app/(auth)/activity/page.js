'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import {
  Inbox, PackageOpen, ClipboardList, PackageMinus,
  Undo2, Truck, Workflow, CheckSquare,
  FileText, CheckCircle2, RefreshCw, XCircle,
  AlertTriangle, Dot,
} from 'lucide-react';

// Matches the dashboard ACT_ICONS map — same icon choices for the same actions.
const ACT_ICONS = {
  GRN_CREATED:       Inbox,         GRN_FROM_RECEIVING:    PackageOpen,
  WO_CREATED:        ClipboardList, STOCK_ISSUED:          PackageMinus,
  RETURN_LOGGED:     Undo2,         SHIPMENT_CREATED:      Truck,
  FLUSH_CREATED:     Workflow,      FLUSH_VERIFIED:        CheckSquare,
  PO_CREATED:        FileText,      PO_APPROVED:           CheckCircle2,
  PO_STATUS_UPDATED: RefreshCw,     PO_CANCELLED:          XCircle,
  RECEIPT_CONFIRMED: CheckCircle2,  RECEIPT_SHORT_PENDING: AlertTriangle,
};

const ACT_COLORS = {
  GRN: '#4ade80', WO: '#7b93ff',
  Issue: '#f2cd1a', Return: '#ff7070',
  Shipment: '#7b93ff', Flush: '#f2cd1a',
  PO: '#aaa', Receipt: '#aaa',
};

const ENTITY_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'GRN', label: 'GRN' },
  { value: 'WO', label: 'Work Orders' },
  { value: 'Issue', label: 'Stock Issues' },
  { value: 'Return', label: 'Returns' },
  { value: 'Shipment', label: 'Shipments' },
  { value: 'Flush', label: 'Flushes' },
  { value: 'PO', label: 'POs' },
];

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function formatActivityTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export default function ActivityPage() {
  const { session, perms } = useAuth();

  const [allRows, setAllRows] = useState([]);
  const [entityFilter, setEntityFilter] = useState('');
  const [search, setSearch] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [limit, setLimit] = useState('50');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getActivityLog', {
        entity_type: entityFilter,
        limit: parseInt(limit, 10) || 50,
      }, session);
      setAllRows(Array.isArray(data) ? data : []);
    } catch {
      setAllRows([]);
    } finally {
      setLoading(false);
    }
  }, [session, entityFilter, limit]);

  useEffect(() => { load(); }, [load]);

  const displayRows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const a = actorFilter.trim().toLowerCase();
    return allRows.filter((r) => {
      if (s && !((r.summary || '').toLowerCase().includes(s) || (r.action || '').toLowerCase().includes(s) || (r.entity_id || '').toLowerCase().includes(s))) return false;
      if (a && !((r.actor || '').toLowerCase().includes(a))) return false;
      return true;
    });
  }, [allRows, search, actorFilter]);

  if (perms && !perms.reports && !perms.users_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  function loadMore() {
    setLimit((l) => String(parseInt(l, 10) + 100));
  }

  const limitNum = parseInt(limit, 10) || 50;

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Activity Log
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Cross-cutting log of all actions across the system.
        </p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Filters</span>
          <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
        </div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <span style={labelStyle}>Search summary…</span>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ flex: '0 0 160px' }}>
              <span style={labelStyle}>Type</span>
              <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                {ENTITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ flex: '0 0 160px' }}>
              <span style={labelStyle}>Actor</span>
              <input type="text" value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} placeholder="Filter by person…" style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ flex: '0 0 130px' }}>
              <span style={labelStyle}>Limit</span>
              <select value={limit} onChange={(e) => setLimit(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="50">Last 50</option>
                <option value="100">Last 100</option>
                <option value="250">Last 250</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Activity {displayRows.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({displayRows.length}{search || actorFilter ? ` of ${allRows.length}` : ''})</span>}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : displayRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No matching activity</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Time</th>
                <th style={tableThStyle}>Who</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Reference</th>
                <th style={tableThStyle}>Summary</th>
              </tr></thead>
              <tbody>
                {displayRows.map((r) => {
                  const tone = ACT_COLORS[r.entity_type] || 'var(--t2)';
                  const Icon = ACT_ICONS[r.action] || Dot;
                  return (
                    <tr key={r.id || `${r.logged_at}-${r.action}-${r.entity_id}`}>
                      <td style={{ ...tableTdStyle, color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{formatActivityTime(r.logged_at)}</td>
                      <td style={{ ...tableTdStyle, fontWeight: 600, fontSize: 11 }}>{r.actor || '—'}</td>
                      <td style={tableTdStyle}>
                        <span style={{
                          display: 'inline-block', padding: '2px 6px', borderRadius: 2,
                          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
                          textTransform: 'uppercase',
                          background: `${tone}22`, color: tone, border: `1px solid ${tone}55`,
                        }}>
                          {r.entity_type || '—'}
                        </span>
                      </td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{r.entity_id || '—'}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 600 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Icon size={14} strokeWidth={1.75} style={{ flexShrink: 0, color: 'var(--t3)' }} />
                          <span>{r.summary || '—'}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--t3)' }}>
          <span>{allRows.length} action{allRows.length === 1 ? '' : 's'}</span>
          {allRows.length === limitNum && (
            <button style={btnSecondary} onClick={loadMore} disabled={loading}>Load more</button>
          )}
        </div>
      </div>
    </div>
  );
}
