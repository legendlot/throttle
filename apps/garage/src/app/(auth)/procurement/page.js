'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const PO_STATUS_TONES = {
  Draft:                          'gray',
  Approved:                       'blue',
  Sent:                           'yellow',
  'Confirmed & Payment Done':     'green',
  'Partially Received':           'yellow',
  Closed:                         'green',
  Cancelled:                      'red',
  'Pending Approval':             'yellow',
};

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  orange: { bg: 'rgba(255,140,0,.15)',  fg: '#ffaa33', border: 'rgba(255,140,0,.25)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

function urgencyColor(u) {
  const v = (u || '').toLowerCase();
  if (v === 'critical') return '#ff7070';
  if (v === 'urgent') return '#f2cd1a';
  return 'var(--t3)';
}

function sourceTone(s) {
  if (s === 'China') return 'blue';
  if (s === 'India') return 'green';
  return 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '6px 14px', fontSize: 11, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };

const kpiCardStyle = (tone) => ({
  background: 'var(--surface)',
  border: `1px solid ${tone === 'yellow' ? 'rgba(242,205,26,.3)' : tone === 'green' ? 'rgba(34,197,94,.3)' : 'var(--border)'}`,
  borderTop: `2px solid ${tone === 'yellow' ? 'var(--yellow)' : tone === 'green' ? 'var(--green, #4ade80)' : 'var(--border)'}`,
  borderRadius: 4,
  padding: '14px 16px',
});

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ProcurementOverviewPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [rrRows, setRrRows] = useState([]);
  const [poRows, setPoRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [rrs, pos] = await Promise.all([
        garageFetch('getReorderRequests', { status: 'Pending' }, session),
        garageFetch('getPOs', {}, session),
      ]);
      setRrRows(Array.isArray(rrs) ? rrs : []);
      setPoRows(Array.isArray(pos) ? pos : []);
    } catch (e) {
      showToast(e.message || 'Failed to load procurement overview', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  const kpis = useMemo(() => {
    const pendingRR = rrRows.length;
    const openPO   = poRows.filter((p) => ['Draft', 'Approved', 'Sent'].includes(p.status)).length;
    const pendingApproval = poRows.filter((p) => p.status === 'Pending Approval').length;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 14);
    const arriving = poRows.filter((p) => {
      if (!['Approved', 'Sent', 'Confirmed & Payment Done'].includes(p.status)) return false;
      if (!p.expected_delivery) return false;
      const d = new Date(p.expected_delivery);
      return !isNaN(d) && d <= cutoff && d >= new Date();
    }).length;
    return { pendingRR, openPO, pendingApproval, arriving };
  }, [rrRows, poRows]);

  const topRR  = useMemo(() => rrRows.slice(0, 8), [rrRows]);
  const openPOList = useMemo(
    () => poRows.filter((p) => ['Draft', 'Approved', 'Sent'].includes(p.status)).slice(0, 8),
    [poRows]
  );

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Procurement
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Overview · pending requests · open purchase orders
        </p>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Pending Requests" value={kpis.pendingRR} loading={loading} />
        <KpiCard label="Open POs" value={kpis.openPO} loading={loading} />
        <KpiCard label="Pending Approval" value={kpis.pendingApproval} tone="yellow" loading={loading} />
        <KpiCard label="Arriving Soon" value={kpis.arriving} tone="green" loading={loading} sub="Next 14 days" />
      </div>

      {/* Pending RR */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Pending Reorder Requests {topRR.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({rrRows.length})</span>}</span>
          <button style={btnSecondary} onClick={() => router.push('/procurement/reorders')}>View All →</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : topRR.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No pending requests</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>ID</th>
                <th style={tableThStyle}>Part / Product</th>
                <th style={tableThStyle}>Qty</th>
                <th style={tableThStyle}>Urgency</th>
                <th style={tableThStyle}>Requested By</th>
                <th style={tableThStyle}>Date</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {topRR.map((r) => {
                  const label = r.request_type === 'part'
                    ? `${r.part_code || ''} ${r.part_name || ''}`.trim() || '—'
                    : [r.product, r.variant, r.color].filter(Boolean).join(' · ') || '—';
                  return (
                    <tr key={r.request_id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.request_id}</td>
                      <td style={tableTdStyle}>{label}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.requested_qty} {r.unit || ''}</td>
                      <td style={{ ...tableTdStyle, color: urgencyColor(r.urgency), fontWeight: 600 }}>{r.urgency || '—'}</td>
                      <td style={tableTdStyle}>{r.requested_by || '—'}</td>
                      <td style={tableTdStyle}>{formatDate(r.created_at)}</td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        {perms?.procurement_raise && (
                          <button
                            style={btnPrimary}
                            onClick={() => router.push(`/procurement/pos/new?rr=${encodeURIComponent(r.request_id)}`)}
                          >
                            Convert →
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Open POs */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Open Purchase Orders {openPOList.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({openPOList.length})</span>}</span>
          <button style={btnSecondary} onClick={() => router.push('/procurement/pos')}>View All →</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : openPOList.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No open purchase orders</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>PO Number</th>
                <th style={tableThStyle}>Vendor</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Source</th>
                <th style={tableThStyle}>Value</th>
                <th style={tableThStyle}>Expected</th>
                <th style={tableThStyle}>Status</th>
              </tr></thead>
              <tbody>
                {openPOList.map((p) => (
                  <tr
                    key={p.po_number}
                    style={{ cursor: 'pointer' }}
                    onClick={() => router.push(`/procurement/pos/${encodeURIComponent(p.po_number)}`)}
                  >
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.po_number}</td>
                    <td style={tableTdStyle}>{p.vendor_name || '—'}</td>
                    <td style={tableTdStyle}>{p.order_type || '—'}</td>
                    <td style={tableTdStyle}><StatusBadge label={p.source || '—'} tone={sourceTone(p.source)} /></td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                      {p.currency || ''} {(p.po_value ?? 0).toLocaleString('en-IN')}
                    </td>
                    <td style={tableTdStyle}>{formatDate(p.expected_delivery)}</td>
                    <td style={tableTdStyle}><StatusBadge label={p.status || '—'} tone={PO_STATUS_TONES[p.status] || 'gray'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, tone, loading }) {
  return (
    <div style={kpiCardStyle(tone)}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 28, fontWeight: 700, marginTop: 4,
        color: tone === 'yellow' ? 'var(--yellow)' : tone === 'green' ? '#4ade80' : 'var(--t1)',
      }}>
        {loading ? '—' : (value ?? 0)}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2, fontFamily: 'var(--mono)' }}>{sub}</div>
      )}
    </div>
  );
}
