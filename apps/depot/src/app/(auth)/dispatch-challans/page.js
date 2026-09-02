'use client';
/* ════════════════════════════════════════════════════════════
   DISPATCH · CHALLANS — Pit Wall v2. GST delivery documents
   (LOT-DC-YYYY-NNNN) with e-way bill state. Prototype:
   redesign-reference/app/challans.jsx. Data unchanged
   (getDeliveryChallans + the same filter params).
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, ToneBadge, fmt, btnPrimary, inputStyle,
} from '../../../components/kit/index.js';

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

const thStyle = { padding: '0 14px 9px', whiteSpace: 'nowrap' };
const tdBase = { padding: '11px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

function StatusForCell({ status }) {
  if (status === 'draft')     return <ToneBadge tone="mute">Draft</ToneBadge>;
  if (status === 'issued')    return <ToneBadge tone="ok">Issued</ToneBadge>;
  if (status === 'cancelled') return <ToneBadge tone="bad">Cancelled</ToneBadge>;
  return <ToneBadge tone="mute">{status}</ToneBadge>;
}

export default function DeliveryChallansPage() {
  const router = useRouter();
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusF, setStatusF] = useState('');
  const [q, setQ] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true); setRefreshing(true);
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
    setLoading(false); setRefreshing(false); setLastRefreshed(new Date());
  }, [session, statusF, q, fromDate, toDate, showToast, setRefreshing, setLastRefreshed]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { '': rows.length, draft: 0, issued: 0, cancelled: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const dateInput = { ...inputStyle, width: 'auto', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 12.5 };

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
          Transport documents for outbound material movements · <span className="num">{rows.length}</span> shown
        </span>
        <button onClick={() => router.push('/dispatch-challans/new')} style={btnPrimary}>
          <Icon name="plus" size={15} /> New Challan
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        {STATUS_TABS.map(t => (
          <FilterChip key={t.value} active={statusF === t.value} onClick={() => setStatusF(t.value)}
            count={t.value === '' ? counts[''] : counts[t.value]}>{t.label}</FilterChip>
        ))}
        <div style={{ flex: 1 }} />
        <input data-search-primary type="search" placeholder="Search by no. or recipient…  · /"
          value={q} onChange={(e) => setQ(e.target.value)}
          style={{ ...inputStyle, width: 240, padding: '7px 12px', fontSize: 13 }} />
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} title="From date" style={dateInput} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} title="To date" style={dateInput} />
      </div>

      {loading ? (
        <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : rows.length === 0 ? (
        <Panel pad={0}>
          <div style={{ padding: '48px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
              <Icon name="file" size={22} /></div>
            <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>
              {statusF || q || fromDate || toDate ? 'No challans match these filters' : 'No delivery challans yet'}</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>
              {statusF || q || fromDate || toDate ? 'Adjust or clear the filters.' : 'Click New Challan to create the first one.'}</div>
          </div>
        </Panel>
      ) : (
        <Panel pad={0}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Challan No.</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Date</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Dispatched To</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Purpose</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'right' }}>Total (₹)</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'center' }}>EWB</th>
                  <th className="eyebrow" style={{ ...thStyle, textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => router.push(`/dispatch-challans/detail?id=${r.id}`)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    style={{ cursor: 'pointer', transition: 'background 100ms' }}>
                    <td className="num" style={{ ...tdBase, fontWeight: 600, color: 'var(--yellow)' }}>{r.challan_no}</td>
                    <td className="num" style={{ ...tdBase, color: 'var(--t2)' }}>{fmtDate(r.challan_date)}</td>
                    {/* Vendor shown as a sub-line rather than its own column, deliberately:
                        the vendor QUALIFIES the recipient, and a dedicated column would be
                        empty on all 144 existing challans. It is searchable either way —
                        the worker's `q` filter covers vendor_code alongside challan_no/to_name. */}
                    <td style={{ ...tdBase, color: 'var(--t1)' }}>
                      {r.to_name || '—'}
                      {r.vendor_code && (
                        <div className="num" style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 2 }}>
                          {r.vendor_code}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdBase, color: 'var(--t2)', fontSize: 12.5 }}>{r.purpose || '—'}</td>
                    <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t1)' }}>{fmt(r.total_quantity)}</td>
                    <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t1)', fontWeight: 600 }}>{inr(r.total_amount)}</td>
                    <td style={{ ...tdBase, textAlign: 'center' }}>
                      {r.ewb_required
                        ? (r.ewb_number
                            ? <ToneBadge tone="info">{r.ewb_number}</ToneBadge>
                            : <ToneBadge tone="warn">Required</ToneBadge>)
                        : <span style={{ color: 'var(--t4)', fontSize: 11 }}>—</span>}
                    </td>
                    <td style={{ ...tdBase, textAlign: 'center' }}><StatusForCell status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
