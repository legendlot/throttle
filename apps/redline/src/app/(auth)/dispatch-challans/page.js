'use client';
/**
 * /dispatch-challans — list of delivery challans (LOT-DC-YYYY-NNNN)
 *
 * Filter chips: All / Draft / Issued / Cancelled.
 * Search by challan_no or to_name. Date range filter (challan_date).
 * "+ New Challan" button → /dispatch-challans/new.
 * Row click → /dispatch-challans/detail?id=<uuid>.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast, Panel, Chip, StatusBadge, EmptyState } from '@throttle/ui';
import { FileText, Plus } from 'lucide-react';

const STATUS_TABS = [
  { value: '',          label: 'All'       },
  { value: 'draft',     label: 'Draft'     },
  { value: 'issued',    label: 'Issued'    },
  { value: 'cancelled', label: 'Cancelled' },
];

function inr(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DeliveryChallansPage() {
  const router = useRouter();
  const { session } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusF, setStatusF] = useState('');
  const [q, setQ] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const params = {};
      if (statusF)  params.status    = statusF;
      if (q)        params.q         = q;
      if (fromDate) params.from_date = fromDate;
      if (toDate)   params.to_date   = toDate;
      const data = await garageFetch('getDeliveryChallans', params, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast('Failed to load challans: ' + (e.message || e), 'error');
      setRows([]);
    }
    setLoading(false);
  }, [session, statusF, q, fromDate, toDate, showToast]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { '': rows.length, draft: 0, issued: 0, cancelled: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  return (
    <div style={{ padding: '4px 4px 24px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <h1 style={{
            margin: 0,
            fontFamily: 'var(--cond)', fontSize: 'var(--text-xl)', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t1)',
          }}>
            Delivery Challans
          </h1>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
            Transport documents for outbound material movements. {rows.length} challan{rows.length === 1 ? '' : 's'} shown.
          </div>
        </div>
        <button
          onClick={() => router.push('/dispatch-challans/new')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '9px 16px', borderRadius: 4, border: 'none',
            background: 'var(--yellow)', color: '#0a0a0a',
            fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.06em',
            cursor: 'pointer',
            transition: 'background 150ms ease-out',
          }}
        >
          <Plus size={16} strokeWidth={2.25} />
          New Challan
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        {STATUS_TABS.map(t => (
          <Chip key={t.value} active={statusF === t.value} onClick={() => setStatusF(t.value)}
                count={t.value === '' ? counts[''] : counts[t.value]}>
            {t.label}
          </Chip>
        ))}
        <div style={{ flex: 1 }} />
        <input
          data-search-primary
          type="search"
          placeholder="Search by no. or recipient…  · /"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            background: 'var(--surface-2)', color: 'var(--t1)',
            border: '1px solid var(--border)', borderRadius: 3,
            padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13,
            width: 240, outline: 'none',
          }}
        />
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          title="From date"
          style={{
            background: 'var(--surface-2)', color: 'var(--t1)',
            border: '1px solid var(--border)', borderRadius: 3,
            padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13,
          }}
        />
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          title="To date"
          style={{
            background: 'var(--surface-2)', color: 'var(--t1)',
            border: '1px solid var(--border)', borderRadius: 3,
            padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13,
          }}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : rows.length === 0 ? (
        <EmptyState message={statusF || q || fromDate || toDate
          ? 'No challans match these filters.'
          : 'No delivery challans yet. Click + New Challan to create the first one.'} />
      ) : (
        <Panel padding={0}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th align="left">Challan No.</Th>
                <Th align="left">Date</Th>
                <Th align="left">Dispatched To</Th>
                <Th align="left">Purpose</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Total (₹)</Th>
                <Th align="center">EWB</Th>
                <Th align="center">Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}
                    onClick={() => router.push(`/dispatch-challans/detail?id=${r.id}`)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{ cursor: 'pointer', transition: 'background 100ms' }}>
                  <Td align="left">
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--yellow)' }}>
                      {r.challan_no}
                    </span>
                  </Td>
                  <Td align="left">{fmtDate(r.challan_date)}</Td>
                  <Td align="left">
                    <div style={{ color: 'var(--t1)' }}>{r.to_name || '—'}</div>
                  </Td>
                  <Td align="left">
                    <span style={{ color: 'var(--t2)', fontSize: 12 }}>{r.purpose || '—'}</span>
                  </Td>
                  <Td align="right">{Number(r.total_quantity) || 0}</Td>
                  <Td align="right">
                    <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{inr(r.total_amount)}</span>
                  </Td>
                  <Td align="center">
                    {r.ewb_required
                      ? (r.ewb_number
                          ? <StatusBadge variant="info" icon="✓">{r.ewb_number}</StatusBadge>
                          : <StatusBadge variant="warning" icon="⚠">REQUIRED</StatusBadge>)
                      : <span style={{ color: 'var(--t3)', fontSize: 11 }}>—</span>}
                  </Td>
                  <Td align="center">
                    <StatusForCell status={r.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

function Th({ children, align }) {
  return (
    <th style={{
      textAlign: align, padding: '10px 12px',
      fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
      color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em',
      borderBottom: '1px solid var(--border)',
      background: 'var(--surface)',
      position: 'sticky', top: 0,
    }}>{children}</th>
  );
}
function Td({ children, align }) {
  return (
    <td style={{
      textAlign: align, padding: '10px 12px',
      fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--t1)',
      borderBottom: '1px solid var(--border)',
    }}>{children}</td>
  );
}
function StatusForCell({ status }) {
  if (status === 'draft')     return <StatusBadge variant="neutral">Draft</StatusBadge>;
  if (status === 'issued')    return <StatusBadge variant="success" icon="✓">Issued</StatusBadge>;
  if (status === 'cancelled') return <StatusBadge variant="error" icon="✗">Cancelled</StatusBadge>;
  return <StatusBadge variant="neutral">{status}</StatusBadge>;
}
