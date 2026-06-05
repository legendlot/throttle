'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';

const SHIPMENT_STATUS_COLORS = {
  open:                'var(--yellow)',
  partially_processed: '#7b93ff',
  fully_processed:     '#4ade80',
  handed_over:         '#4ade80',
  closed:              'var(--t3)',
};

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusLabel(s) {
  return (s || '').replace(/_/g, ' ').toUpperCase();
}

export default function ShipmentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [date, setDate] = useState(todayStr());
  const [channelId, setChannelId] = useState('');
  const [courier, setCourier] = useState('');
  const [ref, setRef] = useState('');
  const [expected, setExpected] = useState('');
  const [received, setReceived] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [channels, setChannels] = useState([]);
  const [channelsAvailable, setChannelsAvailable] = useState(true);
  const [shipments, setShipments] = useState([]);
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState(todayStr());
  const [loading, setLoading] = useState(true);

  const channelMap = useMemo(() => {
    const m = {};
    channels.forEach((c) => { m[c.channel_id] = c; });
    return m;
  }, [channels]);

  const loadChannels = useCallback(async () => {
    if (!session) return;
    try {
      const data = await garageFetch('getChannels', {}, session);
      setChannels(Array.isArray(data) ? data : []);
      setChannelsAvailable(true);
    } catch {
      setChannels([]);
      setChannelsAvailable(false);
    }
  }, [session]);

  const loadShipments = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReturnShipments', { from: fromDate, to: toDate }, session);
      setShipments(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load shipments', 'error');
      setShipments([]);
    } finally {
      setLoading(false);
    }
  }, [session, fromDate, toDate, showToast]);

  useEffect(() => { loadChannels(); }, [loadChannels]);
  useEffect(() => { loadShipments(); }, [loadShipments]);

  function resetForm() {
    setDate(todayStr());
    setChannelId('');
    setCourier('');
    setRef('');
    setExpected('');
    setReceived('');
    setNotes('');
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await workerFetch('openReturnShipment', {
        data: {
          received_date:        date,
          channel:              channelId || null,
          courier:              courier || null,
          platform_reference:   ref || null,
          total_units_expected: expected ? parseInt(expected, 10) : null,
          notes:                notes || null,
        },
      }, session);
      const result = res.data || res;
      showToast(`Shipment ${result.shipment_id} created`, 'success');
      resetForm();
      loadShipments();
      router.push(`/returns/process?id=${encodeURIComponent(result.shipment_id)}`);
    } catch (e) {
      showToast(e.message || 'Failed to create shipment', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (perms && !perms.returns) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: 16, alignItems: 'start' }}>
        {/* Create form */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Receive New Shipment</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <span style={labelStyle}>Date Received *</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Courier</span>
                <input type="text" value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="e.g. Delhivery, Bluedart" style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Channel (optional)</span>
                <select value={channelId} onChange={(e) => setChannelId(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                  <option value="">{channelsAvailable ? 'Select…' : '(channels unavailable)'}</option>
                  {channels.map((c) => (
                    <option key={c.channel_id} value={c.channel_id}>
                      {c.channel_name} {c.platform ? `(${c.platform})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={labelStyle}>Platform Reference (AWB / shipment ID)</span>
                <input type="text" value={ref} onChange={(e) => setRef(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Units Expected</span>
                <input type="number" min="0" value={expected} onChange={(e) => setExpected(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Units Received</span>
                <input type="number" min="0" value={received} onChange={(e) => setReceived(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={labelStyle}>Notes</span>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
              <button style={btnSecondary} onClick={resetForm} disabled={submitting}>Clear</button>
              <button
                style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Creating…' : 'Receive Shipment'}
              </button>
            </div>
          </div>
        </div>

        {/* Recent shipments */}
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>Recent Shipments {shipments.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({shipments.length})</span>}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)' }} />
              <span style={{ color: 'var(--t3)', fontSize: 10 }}>→</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inputStyle, fontFamily: 'var(--mono)' }} />
              <button style={btnSecondary} onClick={loadShipments} disabled={loading}>↻</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : shipments.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No shipments in this date range</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>ID</th>
                  <th style={tableThStyle}>Date</th>
                  <th style={tableThStyle}>Channel</th>
                  <th style={tableThStyle}>Ref</th>
                  <th style={tableThStyle}>Units</th>
                  <th style={tableThStyle}>Status</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {shipments.map((s) => {
                    const channelName = channelMap[s.channel]?.channel_name || s.channel || '—';
                    const statusColor = SHIPMENT_STATUS_COLORS[s.status] || 'var(--t3)';
                    return (
                      <tr
                        key={s.shipment_id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => router.push(`/returns/process?id=${encodeURIComponent(s.shipment_id)}`)}
                      >
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{s.shipment_id}</td>
                        <td style={tableTdStyle}>{formatDate(s.received_date)}</td>
                        <td style={tableTdStyle}>{channelName}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{s.platform_reference || '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                          {(s.total_units_received ?? 0)} / {(s.total_units_expected ?? 0)}
                        </td>
                        <td style={{ ...tableTdStyle, color: statusColor, fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700 }}>
                          {statusLabel(s.status)}
                        </td>
                        <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                          <button
                            style={btnPrimary}
                            onClick={(e) => { e.stopPropagation(); router.push(`/returns/process?id=${encodeURIComponent(s.shipment_id)}`); }}
                          >
                            Process →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
