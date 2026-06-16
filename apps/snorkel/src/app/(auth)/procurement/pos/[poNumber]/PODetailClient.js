'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox, useEscapeClose } from '@throttle/ui';
import { computeTax } from '@/lib/poTax';
import { Panel, Badge, Btn } from '@/components/ui.js';
import { sourceTone } from '@/components/format.js';
import { ArrowLeft, Printer, Pencil, Check, Send, ClipboardList } from 'lucide-react';

const PO_STATUS_TONES = {
  Soft:                           'orange',
  Draft:                          'gray',
  Accepted:                       'yellow',
  Approved:                       'green',
  Sent:                           'yellow',
  'Confirmed & Payment Done':     'green',
  'Partially Received':           'yellow',
  Closed:                         'green',
  Cancelled:                      'red',
  'Pending Approval':             'yellow',
};

function RestrictedField() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11,
      fontStyle: 'italic',
    }}>🔒 Restricted</span>
  );
}
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
      vendor_code: po.vendor_code || '',
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

  async function handleAction(action, extra) {
    setActionLoading(true);
    try {
      if (action === 'accept') {
        await workerFetch('acceptPO', { data: { po_number: po.po_number } }, session);
        showToast(`${po.po_number} accepted`, 'success');
      } else if (action === 'finalApprove') {
        await workerFetch('finalApprovePO', { data: { po_number: po.po_number } }, session);
        showToast(`${po.po_number} approved`, 'success');
      } else if (action === 'send') {
        await workerFetch('updatePOStatus', { data: { po_number: po.po_number, status: 'Sent' } }, session);
        showToast(`${po.po_number} marked sent`, 'success');
      } else if (action === 'route') {
        await workerFetch('routePayment', { data: { po_number: po.po_number, route_to: extra } }, session);
        showToast(`Payment requested from ${extra}`, 'success');
      } else if (action === 'markPaid') {
        await workerFetch('markPaid', { data: { po_number: po.po_number } }, session);
        showToast(`${po.po_number} marked paid`, 'success');
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
      const fields = ['vendor_name', 'vendor_code', 'currency', 'payment_terms', 'incoterms', 'invoice_number', 'expected_ready_date', 'shipping_date', 'shipping_mode', 'forwarder_code', 'actual_arrival_date', 'notes'];
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

  // Snorkel approval chain: Draft → Accepted → Approved → payment routing.
  // Financial fields on China POs gated by po_china (Snorkel perm).
  const isChina = po.source === 'China';
  const isFinanceVisible = !isChina || !!perms?.po_china;
  const isSoft = status === 'Soft';
  const canAccept       = status === 'Draft'    && !!perms?.po_request_accept;
  const canFinalApprove = status === 'Accepted' && !!perms?.po_approve;
  const canSend         = status === 'Approved' && !!perms?.po_create;
  const canAmend        = !isSoft && ['Draft', 'Accepted', 'Approved', 'Sent'].includes(status) && !!perms?.po_create;
  const canCancel       = !['Closed', 'Cancelled'].includes(status) && !!perms?.po_create;
  const canPromote      = isSoft && !!perms?.po_china;
  const canPay          = status === 'Approved' && !!perms?.payment_route;
  const payStatus       = po.payment_status || 'none';

  const grandStr = (n) => `${po.currency || ''} ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const shipNodes = [
    ['Ordered', po.created_at], ['Ready', po.expected_ready_date], ['Shipped', po.shipping_date],
    ['Expected', po.expected_delivery], ['Arrived', po.actual_arrival_date],
  ];

  return (
    <div className="pg">
      <div className="po-head">
        <div className="po-head-l">
          <Btn onClick={() => router.push('/procurement/pos')}><ArrowLeft size={14} /> Back</Btn>
          <span className="po-head-no">{po.po_number}</span>
          <Badge label={`rev ${po.revision ?? 0}`} tone="gray" />
          <Badge label={status} tone={PO_STATUS_TONES[status] || 'gray'} dot />
        </div>
        <div className="po-head-r">
          <Btn onClick={() => window.open(`/procurement/pos/print?po_number=${encodeURIComponent(po.po_number)}`, '_blank')} disabled={actionLoading}><Printer size={14} /> Print</Btn>
          {canAccept       && <Btn kind="primary" onClick={() => handleAction('accept')} disabled={actionLoading}><Check size={14} /> Accept</Btn>}
          {canFinalApprove && <Btn kind="primary" onClick={() => handleAction('finalApprove')} disabled={actionLoading}><Check size={14} /> Final Approve</Btn>}
          {canPay && payStatus === 'none' && <Btn onClick={() => handleAction('route', 'finance')} disabled={actionLoading}>Request Finance</Btn>}
          {canPay && payStatus === 'none' && <Btn onClick={() => handleAction('route', 'requester')} disabled={actionLoading}>Request Requester</Btn>}
          {canPay && payStatus === 'requested' && <Btn kind="primary" onClick={() => handleAction('markPaid')} disabled={actionLoading}><Check size={14} /> Mark Paid</Btn>}
          {canSend         && <Btn onClick={() => handleAction('send')} disabled={actionLoading}><Send size={14} /> Mark Sent</Btn>}
          {canAmend        && <Btn onClick={openAmend} disabled={actionLoading}><Pencil size={14} /> Amend</Btn>}
          {canCancel       && <Btn onClick={() => setCancelOpen(true)} disabled={actionLoading} style={{ borderColor: 'var(--red)', color: 'var(--red-fg)' }}>Cancel</Btn>}
        </div>
      </div>

      {(po.source_request_no || payStatus !== 'none') && (
        <div className="po-banner">
          {po.source_request_no && (
            <span className="po-banner-chip" onClick={() => router.push(`/requests/detail?request_no=${encodeURIComponent(po.source_request_no)}`)}>
              <ClipboardList size={14} /> From request {po.source_request_no}
            </span>
          )}
          {payStatus !== 'none' && (
            <span className={`po-banner-pay ${payStatus === 'paid' ? 'po-banner-paid' : ''}`}>
              {payStatus === 'paid' ? <Check size={14} /> : <span className="tb-dot" style={{ background: 'var(--yellow)' }} />}
              Payment {payStatus === 'paid' ? 'settled' : 'requested'}{po.payment_routed_to ? ` · ${po.payment_routed_to}` : ''}{payStatus === 'paid' && po.paid_by ? ` · ${po.paid_by}` : ''}
            </span>
          )}
        </div>
      )}

      <div className="po-grid">
        <Panel title="PO Details" pad>
          <div className="kv-grid">
            <KV k="Vendor" v={po.vendor_name || '—'} />
            <KV k="Order type" v={po.order_type || '—'} />
            <KV k="Source" v={<Badge label={po.source || '—'} tone={sourceTone(po.source)} soft={false} />} />
            <KV k="Raised by" v={po.raised_by || '—'} />
            <KV k="Approved by" v={po.approved_by || '—'} />
            <KV k="Quality hold" v={po.quality_hold ? 'Yes' : 'No'} />
          </div>
          <div className="kv-divider">Shipping timeline</div>
          <div className="ship-timeline">
            {shipNodes.map(([lbl, d]) => (
              <div className={`ship-node ${d ? 'done' : ''}`} key={lbl}>
                <span className="ship-dot" /><div className="ship-lbl">{lbl}</div><div className="ship-date mono">{d ? formatDate(d).replace(/, \d{4}$/, '') : '—'}</div>
              </div>
            ))}
          </div>
          <div className="kv-grid kv-3" style={{ marginTop: 14 }}>
            <KV k="Mode" v={po.shipping_mode || '—'} />
            <KV k="Forwarder" v={po.forwarder_code || '—'} />
            <KV k="Transit" v={po.transit_days != null ? `${po.transit_days}d` : '—'} />
          </div>
        </Panel>

        <Panel title="Financial" pad action={!isFinanceVisible && <span className="panel-hint">🔒 China PO — restricted</span>}>
          <div className="kv-grid">
            <KV k="Currency" v={isFinanceVisible ? (po.currency || '—') : <RestrictedField />} />
            <KV k="Payment terms" v={isFinanceVisible ? (po.payment_terms || '—') : <RestrictedField />} />
            <KV k="Incoterms" v={po.incoterms || '—'} />
            <KV k="PO value" accent v={isFinanceVisible ? grandStr(isInr ? tax.grand : (po.po_value ?? lineTotal)) : <RestrictedField />} />
            <KV k="Invoice no." v={isFinanceVisible ? (po.invoice_number || '—') : <RestrictedField />} />
            <KV k="Invoice value" v={isFinanceVisible
              ? <span>{po.currency || ''} {(invoiceValue || 0).toLocaleString('en-IN')}{mismatch && <span style={{ color: 'var(--red-fg)', marginLeft: 6, fontSize: 10 }}>⚠ MISMATCH</span>}</span>
              : <RestrictedField />} />
          </div>
        </Panel>
      </div>

      <Panel title="Line Items" count={lines.length}>
        {lines.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center' }} className="dim">No lines</div>
        ) : (
          <>
            <table className="dt">
              <thead><tr>
                <th>#</th><th>Product</th><th>Item Type</th><th>Description</th><th>Part code</th>
                <th className="num">Ordered</th><th className="num">Received</th><th>Unit</th><th className="num">Unit price</th>
                {isInr && <th>HSN</th>}{isInr && <th className="num">GST %</th>}<th className="num">Total</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const ord = parseFloat(l.qty_ordered) || 0;
                  const rec = parseFloat(l.qty_received) || 0;
                  const pct = ord > 0 ? Math.round((rec / ord) * 100) : 0;
                  const recColor = pct >= 100 ? 'var(--green-fg)' : pct > 0 ? 'var(--yellow)' : 'var(--text-3)';
                  const total = (parseFloat(l.unit_price) || 0) * ord;
                  return (
                    <tr key={l.id || i}>
                      <td className="mono dim">{i + 1}</td>
                      <td><span className="prod-name">{l.product || '—'}</span></td>
                      <td className="dim">{l.item_type || '—'}</td>
                      <td className="dim" style={{ whiteSpace: 'normal' }}>{l.description || '—'}</td>
                      <td className="mono">{l.part_code || '—'}</td>
                      <td className="num mono">{ord.toLocaleString('en-IN')}</td>
                      <td className="num mono" style={{ color: recColor }}>{rec.toLocaleString('en-IN')}{ord > 0 && <span className="pct">({pct}%)</span>}</td>
                      <td>{l.unit || '—'}</td>
                      <td className="num mono">{isFinanceVisible ? (l.unit_price != null ? l.unit_price.toLocaleString('en-IN') : '—') : <RestrictedField />}</td>
                      {isInr && <td className="mono">{l.hsn_code || '—'}</td>}
                      {isInr && <td className="num mono">{l.gst_percent != null ? `${parseFloat(l.gst_percent)}%` : '—'}</td>}
                      <td className="num mono">{isFinanceVisible ? total.toLocaleString('en-IN') : <RestrictedField />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ minWidth: 280, fontSize: 13 }}>
                <div className="dr-tr"><span>Subtotal</span><span className="mono">{grandStr(tax.taxable)}</span></div>
                {tax.showGst && tax.isCgstSgst && (<>
                  <div className="dr-tr"><span>CGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span><span className="mono">₹ {tax.cgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                  <div className="dr-tr"><span>SGST {tax.halfRate > 0 ? `@ ${tax.halfRate}%` : ''}</span><span className="mono">₹ {tax.sgst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                </>)}
                {tax.showGst && !tax.isCgstSgst && (
                  <div className="dr-tr"><span>IGST {tax.fullRate > 0 ? `@ ${tax.fullRate}%` : ''}</span><span className="mono">₹ {tax.igst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                )}
                <div className="dr-tr dr-tr-grand" style={{ color: 'var(--accent)' }}><span>Grand total</span><span className="mono">{grandStr(tax.grand)}</span></div>
              </div>
            </div>
          </>
        )}
      </Panel>

      <Panel title="Revision History" count={revisions.length}>
        {revisions.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center' }} className="dim">No revisions yet</div>
        ) : (
          <table className="dt">
            <thead><tr><th>Rev</th><th>Changed by</th><th>Date</th><th>Summary</th></tr></thead>
            <tbody>
              {revisions.map((r) => (
                <tr key={r.id || r.revision}>
                  <td className="mono accent">r{r.revision}</td>
                  <td>{r.changed_by || '—'}</td>
                  <td className="mono dim">{formatDate(r.created_at)}</td>
                  <td style={{ whiteSpace: 'normal' }}>{r.change_summary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {amendOpen && (
        <AmendModal
          po={po}
          session={session}
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

function KV({ k, v, accent }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className="kv-v" style={accent ? { color: 'var(--accent)' } : null}>{v}</div>
    </div>
  );
}

function AmendModal({ po, session, data, setData, onClose, onSubmit, submitting }) {
  function set(field, value) { setData((d) => ({ ...d, [field]: value })); }
  const [vendorCache, setVendorCache] = useState([]);
  useEscapeClose(true, () => { if (!submitting) onClose(); });
  useEffect(() => {
    if (!session) return;
    garageFetch('getVendors', {}, session)
      .then((d) => setVendorCache(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [session]);
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
          <div>
            <span style={labelStyle}>Vendor *</span>
            <Combobox
              value={data.vendor_code || ''}
              options={(() => {
                const opts = vendorCache.map((v) => ({ value: v.vendor_code, label: v.vendor_name, hint: v.vendor_code }));
                // Surface the current PO's vendor even if it's no longer active.
                if (data.vendor_name && !vendorCache.find((v) => v.vendor_code === data.vendor_code)) {
                  opts.unshift({ value: data.vendor_code || '__stale__', label: `${data.vendor_name} (inactive)`, hint: 'legacy' });
                }
                return opts;
              })()}
              onChange={(_, opt) => {
                const v = opt ? vendorCache.find((x) => x.vendor_code === opt.value) : null;
                set('vendor_code', v ? v.vendor_code : (opt?.value || ''));
                set('vendor_name', v ? v.vendor_name : (opt?.label?.replace(/ \(inactive\)$/, '') || ''));
              }}
              placeholder="Search vendors…"
              disabled={submitting}
              required
            />
          </div>
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
  useEscapeClose(true, () => { if (!submitting) onClose(); });
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
