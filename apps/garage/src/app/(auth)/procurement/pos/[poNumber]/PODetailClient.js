'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { computeTax } from '@/lib/poTax';

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
const PO_CURRENCIES   = ['INR', 'USD', 'RMB'];
const PO_INCOTERMS    = ['FOB', 'CIF', 'DDP', 'Ex-Works', 'Local delivery'];
const PO_PAYMENT_TERMS = ['Advance', 'Credit 30', 'Credit 60', 'LC', 'TT'];
const PO_SHIP_MODES   = ['Sea', 'Air', 'Land'];

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

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { background: '#ef4444', border: '1px solid #ef4444', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateInput(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d)) return '';
  return d.toISOString().slice(0, 10);
}

export default function PODetailPage() {
  // BUG-C: support both the new query-string route (/pos/detail?po_number=X)
  // and the legacy /pos/[poNumber]/ route (only renders the 'sample' placeholder
  // on static export). search-param wins when both are present.
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const poNumber = searchParams?.get('po_number') || params?.poNumber;

  const [poData, setPoData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendData, setAmendData] = useState({});
  const [amendSubmitting, setAmendSubmitting] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  const loadPO = useCallback(async () => {
    if (!session || !poNumber || poNumber === 'sample') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await garageFetch('getPO', { po_number: poNumber }, session);
      setPoData(data);
    } catch (e) {
      showToast(e.message || 'Failed to load PO', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, poNumber, showToast]);

  useEffect(() => { loadPO(); }, [loadPO]);

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  if (poNumber === 'sample') {
    return (
      <div style={{ padding: 24, color: 'var(--t3)' }}>
        Static-export placeholder. Open a real PO from <a href="/procurement/pos" style={{ color: 'var(--yellow)' }}>the PO list</a>.
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  }

  if (!poData) {
    return (
      <div style={{ padding: 24, color: 'var(--t3)' }}>
        PO not found.{' '}
        <button style={{ ...btnSecondary, marginLeft: 8 }} onClick={() => router.push('/procurement/pos')}>← Back to list</button>
      </div>
    );
  }

  const { po, vendor = null, lines = [], revisions = [] } = poData;
  const status = po.status || 'Draft';
  const tax = computeTax(lines, po.currency, vendor?.gstin || null);
  const isInr = po.currency === 'INR';

  function openAmend() {
    setAmendData({
      change_summary: '',
      vendor_name: po.vendor_name || '',
      currency: po.currency || 'INR',
      payment_terms: po.payment_terms || '',
      incoterms: po.incoterms || '',
      invoice_number: po.invoice_number || '',
      invoice_value: po.invoice_value != null ? String(po.invoice_value) : '',
      expected_ready_date: formatDateInput(po.expected_ready_date),
      shipping_date: formatDateInput(po.shipping_date),
      shipping_mode: po.shipping_mode || '',
      forwarder_code: po.forwarder_code || '',
      transit_days: po.transit_days != null ? String(po.transit_days) : '',
      actual_arrival_date: formatDateInput(po.actual_arrival_date),
      notes: po.notes || '',
      quality_hold: !!po.quality_hold,
    });
    setAmendOpen(true);
  }

  async function handleAction(action) {
    setActionLoading(true);
    try {
      if (action === 'approve') {
        await workerFetch('approvePO', { data: { po_number: po.po_number } }, session);
        showToast(`${po.po_number} approved`, 'success');
      } else if (action === 'send') {
        await workerFetch('updatePOStatus', { data: { po_number: po.po_number, status: 'Sent' } }, session);
        showToast(`${po.po_number} marked sent`, 'success');
      } else if (action === 'confirm') {
        await workerFetch('updatePOStatus', { data: { po_number: po.po_number, status: 'Confirmed & Payment Done' } }, session);
        showToast(`${po.po_number} confirmed & paid`, 'success');
      }
      loadPO();
    } catch (e) {
      showToast(e.message || 'Action failed', 'error');
    } finally {
      setActionLoading(false);
    }
  }

  async function submitAmend() {
    if (!amendData.change_summary?.trim()) { showToast('Change summary required', 'error'); return; }
    setAmendSubmitting(true);
    try {
      const payload = { po_number: po.po_number, change_summary: amendData.change_summary.trim() };
      const fields = ['vendor_name', 'currency', 'payment_terms', 'incoterms', 'invoice_number', 'expected_ready_date', 'shipping_date', 'shipping_mode', 'forwarder_code', 'actual_arrival_date', 'notes'];
      fields.forEach((k) => { if (amendData[k] !== undefined && amendData[k] !== '') payload[k] = amendData[k]; });
      if (amendData.invoice_value !== '') payload.invoice_value = parseFloat(amendData.invoice_value);
      if (amendData.transit_days !== '')  payload.transit_days  = parseInt(amendData.transit_days, 10);
      payload.quality_hold = !!amendData.quality_hold;
      await workerFetch('amendPO', { data: payload }, session);
      showToast(`${po.po_number} amended`, 'success');
      setAmendOpen(false);
      loadPO();
    } catch (e) {
      showToast(e.message || 'Amend failed', 'error');
    } finally {
      setAmendSubmitting(false);
    }
  }

  async function submitCancel() {
    if (!cancelReason.trim()) { showToast('Reason required', 'error'); return; }
    setCancelSubmitting(true);
    try {
      await workerFetch('cancelPO', { data: { po_number: po.po_number, reason: cancelReason.trim() } }, session);
      showToast(`${po.po_number} cancelled`, 'success');
      setCancelOpen(false);
      setCancelReason('');
      loadPO();
    } catch (e) {
      showToast(e.message || 'Cancel failed', 'error');
    } finally {
      setCancelSubmitting(false);
    }
  }

  const lineTotal = tax.taxable;
  const invoiceValue = parseFloat(po.invoice_value) || 0;
  // Invoice mismatch compares against grand total (incl. GST) for INR;
  // taxable subtotal otherwise (CN/RMB POs have no GST anyway).
  const comparisonTotal = isInr ? tax.grand : lineTotal;
  const mismatch = invoiceValue > 0 && Math.abs(invoiceValue - comparisonTotal) / Math.max(1, comparisonTotal) > 0.01;

  const canApprove = status === 'Draft' && perms?.procurement_approve;
  const canSend    = (status === 'Draft' && perms?.procurement_raise) || status === 'Approved';
  const canConfirm = status === 'Sent';
  const canAmend   = ['Draft', 'Approved', 'Sent', 'Confirmed & Payment Done'].includes(status) && perms?.procurement_raise;
  const canCancel  = !['Closed', 'Cancelled'].includes(status);

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button style={btnSecondary} onClick={() => router.push('/procurement/pos')}>← Back</button>
          <span style={{ fontFamily: 'var(--cond)', fontSize: 20, fontWeight: 700, color: 'var(--yellow)' }}>{po.po_number}</span>
          <StatusBadge label={`rev ${po.revision ?? 0}`} tone="gray" />
          <StatusBadge label={status} tone={PO_STATUS_TONES[status] || 'gray'} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            style={btnSecondary}
            onClick={() => window.open(`/procurement/pos/print?po_number=${encodeURIComponent(po.po_number)}`, '_blank')}
            disabled={actionLoading}
            title="Open printable PO in a new tab"
          >🖨 Print PO</button>
          {canApprove && <button style={btnPrimary} onClick={() => handleAction('approve')} disabled={actionLoading}>✅ Approve</button>}
          {canSend    && <button style={btnSecondary} onClick={() => handleAction('send')} disabled={actionLoading}>Mark Sent</button>}
          {canConfirm && <button style={btnPrimary} onClick={() => handleAction('confirm')} disabled={actionLoading}>Confirmed & Paid</button>}
          {canAmend   && <button style={btnSecondary} onClick={openAmend} disabled={actionLoading}>Amend</button>}
          {canCancel  && <button style={btnDanger} onClick={() => setCancelOpen(true)} disabled={actionLoading}>Cancel</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <section style={panelStyle}>
          <div style={panelHeaderStyle}><span>PO Details</span></div>
          <div style={panelBodyStyle}>
            <KvGrid cols={2} items={[
              ['Vendor', po.vendor_name || '—'],
              ['Order Type', po.order_type || '—'],
              ['Source', po.source || '—'],
              ['Raised By', po.raised_by || '—'],
              ['Approved By', po.approved_by || '—'],
              ['Quality Hold', po.quality_hold ? 'Yes' : 'No'],
            ]} />
            <div style={{ marginTop: 14 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Shipping Timeline</div>
              <KvGrid cols={3} items={[
                ['Ordered', formatDate(po.created_at)],
                ['Ready', formatDate(po.expected_ready_date)],
                ['Shipping', formatDate(po.shipping_date)],
                ['Mode', po.shipping_mode || '—'],
                ['Forwarder', po.forwarder_code || '—'],
                ['Transit', po.transit_days != null ? `${po.transit_days}d` : '—'],
                ['Expected Arrival', formatDate(po.expected_delivery)],
                ['Actual Arrival', formatDate(po.actual_arrival_date)],
                ['Lead Time', po.lead_time_days != null ? `${po.lead_time_days}d` : '—'],
              ]} />
            </div>
          </div>
        </section>

        <section style={panelStyle}>
          <div style={panelHeaderStyle}><span>Financial</span></div>
          <div style={panelBodyStyle}>
            <KvGrid cols={2} items={[
              ['Currency', po.currency || '—'],
              ['Payment Terms', po.payment_terms || '—'],
              ['Incoterms', po.incoterms || '—'],
              ['PO Value', `${po.currency || ''} ${(isInr ? tax.grand : (po.po_value ?? lineTotal)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
              ['Invoice No.', po.invoice_number || '—'],
              [
                'Invoice Value',
                <span key="iv">
                  {po.currency || ''} {(invoiceValue || 0).toLocaleString('en-IN')}
                  {mismatch && <span style={{ color: '#ff7070', marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 10 }}>⚠ MISMATCH</span>}
                </span>,
              ],
            ]} />
          </div>
        </section>
      </div>

      <section style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Line Items {lines.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({lines.length})</span>}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {lines.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)' }}>No lines</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>#</th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Item Type</th>
                <th style={tableThStyle}>Description</th>
                <th style={tableThStyle}>Part Code</th>
                <th style={tableThStyle}>Ordered</th>
                <th style={tableThStyle}>Received</th>
                <th style={tableThStyle}>Unit</th>
                <th style={tableThStyle}>Unit Price</th>
                {isInr && <th style={tableThStyle}>HSN</th>}
                {isInr && <th style={tableThStyle}>GST %</th>}
                <th style={tableThStyle}>Total</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const ord = parseFloat(l.qty_ordered) || 0;
                  const rec = parseFloat(l.qty_received) || 0;
                  const pct = ord > 0 ? Math.round((rec / ord) * 100) : 0;
                  const recColor = pct >= 100 ? '#4ade80' : pct > 0 ? '#f2cd1a' : 'var(--t3)';
                  const total = (parseFloat(l.unit_price) || 0) * ord;
                  return (
                    <tr key={l.id || i}>
                      <td style={{ ...tableTdStyle, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>{i + 1}</td>
                      <td style={tableTdStyle}>{l.product || '—'}</td>
                      <td style={tableTdStyle}>{l.item_type || '—'}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{l.description || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.part_code || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{ord.toLocaleString('en-IN')}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: recColor }}>
                        {rec.toLocaleString('en-IN')} {ord > 0 && <span style={{ fontSize: 9, marginLeft: 4 }}>({pct}%)</span>}
                      </td>
                      <td style={tableTdStyle}>{l.unit || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.unit_price != null ? l.unit_price.toLocaleString('en-IN') : '—'}</td>
                      {isInr && <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.hsn_code || '—'}</td>}
                      {isInr && <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{l.gst_percent != null ? `${parseFloat(l.gst_percent)}%` : '—'}</td>}
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{total.toLocaleString('en-IN')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {lines.length > 0 && (
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ minWidth: 280, fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                  <span style={{ color: 'var(--t3)' }}>Subtotal</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{po.currency || ''} {tax.taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                {tax.showGst && tax.isCgstSgst && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                      <span style={{ color: 'var(--t3)' }}>CGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span>
                      <span style={{ fontFamily: 'var(--mono)' }}>₹ {tax.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                      <span style={{ color: 'var(--t3)' }}>SGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span>
                      <span style={{ fontFamily: 'var(--mono)' }}>₹ {tax.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </>
                )}
                {tax.showGst && !tax.isCgstSgst && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span style={{ color: 'var(--t3)' }}>IGST {tax.fullRate > 0 ? `@ ${tax.fullRate}%` : ''}</span>
                    <span style={{ fontFamily: 'var(--mono)' }}>₹ {tax.igst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0 0', borderTop: '1px solid var(--border)', marginTop: 4, fontWeight: 700, color: 'var(--yellow)' }}>
                  <span>Grand Total</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{po.currency || ''} {tax.grand.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Revision History {revisions.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({revisions.length})</span>}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {revisions.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No revisions yet</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Rev</th>
                <th style={tableThStyle}>Changed By</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Summary</th>
              </tr></thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.id || r.revision}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.revision}</td>
                    <td style={tableTdStyle}>{r.changed_by || '—'}</td>
                    <td style={tableTdStyle}>{formatDate(r.created_at)}</td>
                    <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{r.change_summary || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {amendOpen && (
        <AmendModal
          po={po}
          data={amendData}
          setData={setAmendData}
          onClose={() => !amendSubmitting && setAmendOpen(false)}
          onSubmit={submitAmend}
          submitting={amendSubmitting}
        />
      )}
      {cancelOpen && (
        <CancelModal
          poNumber={po.po_number}
          reason={cancelReason}
          setReason={setCancelReason}
          onClose={() => !cancelSubmitting && setCancelOpen(false)}
          onSubmit={submitCancel}
          submitting={cancelSubmitting}
        />
      )}
    </div>
  );
}

function KvGrid({ cols, items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: '8px 16px' }}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ fontSize: 12 }}>
          <div style={labelStyle}>{k}</div>
          <div style={{ color: 'var(--t1)' }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function AmendModal({ po, data, setData, onClose, onSubmit, submitting }) {
  function set(field, value) { setData((d) => ({ ...d, [field]: value })); }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9000, padding: 24, overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 720, maxWidth: 960, width: '100%', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--yellow)', fontSize: 16 }}>
            Amend {po.po_number}
          </h3>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>✕</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>Change Summary *</span>
          <input type="text" value={data.change_summary || ''} onChange={(e) => set('change_summary', e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} placeholder="What is changing and why" />
        </div>

        <div style={{ ...labelStyle, marginBottom: 6, marginTop: 8 }}>PO Header</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Vendor" value={data.vendor_name || ''} onChange={(v) => set('vendor_name', v)} disabled={submitting} />
          <SelectField label="Currency" value={data.currency || ''} onChange={(v) => set('currency', v)} options={['', ...PO_CURRENCIES]} disabled={submitting} />
          <SelectField label="Payment Terms" value={data.payment_terms || ''} onChange={(v) => set('payment_terms', v)} options={['', ...PO_PAYMENT_TERMS]} disabled={submitting} />
          <SelectField label="Incoterms" value={data.incoterms || ''} onChange={(v) => set('incoterms', v)} options={['', ...PO_INCOTERMS]} disabled={submitting} />
          <Field label="Invoice Number" value={data.invoice_number || ''} onChange={(v) => set('invoice_number', v)} disabled={submitting} />
          <Field label="Invoice Value" type="number" value={data.invoice_value || ''} onChange={(v) => set('invoice_value', v)} disabled={submitting} />
        </div>

        <div style={{ ...labelStyle, marginBottom: 6 }}>Shipping Timeline</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Expected Ready Date" type="date" value={data.expected_ready_date || ''} onChange={(v) => set('expected_ready_date', v)} disabled={submitting} />
          <Field label="Shipping Date" type="date" value={data.shipping_date || ''} onChange={(v) => set('shipping_date', v)} disabled={submitting} />
          <SelectField label="Shipping Mode" value={data.shipping_mode || ''} onChange={(v) => set('shipping_mode', v)} options={['', ...PO_SHIP_MODES]} disabled={submitting} />
          <Field label="Forwarder Code" value={data.forwarder_code || ''} onChange={(v) => set('forwarder_code', v)} disabled={submitting} />
          <Field label="Transit Days" type="number" value={data.transit_days || ''} onChange={(v) => set('transit_days', v)} disabled={submitting} />
          <Field label="Actual Arrival Date" type="date" value={data.actual_arrival_date || ''} onChange={(v) => set('actual_arrival_date', v)} disabled={submitting} />
        </div>

        <div style={{ marginBottom: 12 }}>
          <span style={labelStyle}>Notes</span>
          <textarea value={data.notes || ''} onChange={(e) => set('notes', e.target.value)} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={submitting} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 12 }}>
          <input type="checkbox" checked={!!data.quality_hold} onChange={(e) => set('quality_hold', e.target.checked)} disabled={submitting} />
          Quality Hold
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Save Amendment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CancelModal({ poNumber, reason, setReason, onClose, onSubmit, submitting }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 380, maxWidth: 480 }}>
        <h3 style={{ margin: 0, marginBottom: 12, color: 'var(--yellow)', fontSize: 14, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Cancel {poNumber}
        </h3>
        <span style={labelStyle}>Reason *</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'var(--mono)' }}
          placeholder="Why is this PO being cancelled?"
          disabled={submitting}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
          <button style={btnSecondary} onClick={onClose} disabled={submitting}>Keep PO</button>
          <button style={{ ...btnDanger, opacity: submitting ? 0.6 : 1 }} onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Cancelling…' : 'Cancel PO'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: type === 'number' || type === 'date' ? 'var(--mono)' : 'inherit' }} disabled={disabled} />
    </div>
  );
}

function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={disabled}>
        {options.map((o) => <option key={o} value={o}>{o || '—'}</option>)}
      </select>
    </div>
  );
}
