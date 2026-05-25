'use client';
/**
 * /dispatch-challans/detail?id=<uuid> — single challan view.
 *
 * Read-only display of an issued/cancelled challan with Print + Cancel actions.
 * If status='draft', shows an "Edit" link to /dispatch-challans/new (reusing the
 * same form would be cleaner for v2 — for v1 we keep draft-edit + view in one
 * page is overkill; v1 lets you Save Draft → review here → Issue → Print).
 *
 * Actions surface by status:
 *   draft     → Issue button + Cancel button + (deep-link Edit returns to /new with prefill — v2)
 *   issued    → Print button + Cancel button
 *   cancelled → Print button only (read-only)
 */
import { Suspense, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Panel, StatusBadge } from '@throttle/ui';
import { Printer, X, Check, AlertTriangle } from 'lucide-react';

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

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 32 }}><Spinner /></div>}>
      <DetailInner />
    </Suspense>
  );
}

function DetailInner() {
  const params = useSearchParams();
  const id = params.get('id');
  const router = useRouter();
  const { session } = useAuth();
  const { showToast } = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id || !session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getDeliveryChallan', { id }, session);
      setData(r);
    } catch (e) {
      showToast('Failed to load: ' + (e.message || e), 'error');
    }
    setLoading(false);
  }, [id, session, showToast]);

  useEffect(() => { load(); }, [load]);

  async function issue() {
    if (!confirm(`Issue ${data.header.challan_no}? This locks it from further edits.`)) return;
    setBusy(true);
    try {
      const res = await workerFetch('issueDeliveryChallan', { id }, session);
      if (!res.ok) showToast('Issue failed: ' + (res.error || 'unknown'), 'error');
      else {
        showToast(`Challan ${data.header.challan_no} issued`, 'success');
        await load();
      }
    } finally { setBusy(false); }
  }

  async function cancel() {
    const reason = prompt('Reason for cancellation? (optional)') ?? null;
    if (reason === null) return; // user dismissed
    if (!confirm(`Cancel ${data.header.challan_no}?`)) return;
    setBusy(true);
    try {
      const res = await workerFetch('cancelDeliveryChallan', { id, reason }, session);
      if (!res.ok) showToast('Cancel failed: ' + (res.error || 'unknown'), 'error');
      else {
        showToast(`Challan ${data.header.challan_no} cancelled`, 'info');
        await load();
      }
    } finally { setBusy(false); }
  }

  if (!id) return <div style={{ padding: 32 }}>Missing id.</div>;
  if (loading) return <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!data) return <div style={{ padding: 32 }}>Not found.</div>;

  const h = data.header;
  const lines = data.lines || [];

  return (
    <div style={{ padding: '4px 4px 32px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border)',
      }}>
        <button onClick={() => router.push('/dispatch-challans')}
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 3,
            padding: '6px 10px', cursor: 'pointer', color: 'var(--t2)', fontSize: 12 }}>
          ← Back
        </button>
        <h1 style={{
          margin: 0,
          fontFamily: 'var(--cond)', fontSize: 'var(--text-xl)', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t1)',
        }}>
          {h.challan_no}
        </h1>
        <StatusForCell status={h.status} />
        {h.ewb_required && (
          <span title={h.ewb_number ? `EWB ${h.ewb_number}` : 'EWB required but not recorded'}>
            {h.ewb_number
              ? <StatusBadge variant="info" icon="✓">EWB {h.ewb_number}</StatusBadge>
              : <StatusBadge variant="warning" icon="⚠">EWB pending</StatusBadge>}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => window.open(`/dispatch-challans/print?id=${id}`, '_blank')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--yellow)', color: '#0a0a0a', border: 'none', borderRadius: 4,
              padding: '9px 16px', cursor: 'pointer',
              fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
            <Printer size={14} strokeWidth={2} /> Print
          </button>
          {h.status === 'draft' && (
            <button onClick={issue} disabled={busy}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'var(--state-success-bg)', color: 'var(--state-success-fg)',
                border: '1px solid rgba(34, 197, 94, 0.4)', borderRadius: 4,
                padding: '9px 16px', cursor: busy ? 'wait' : 'pointer',
                fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                opacity: busy ? 0.5 : 1,
              }}>
              <Check size={14} strokeWidth={2.25} /> Issue
            </button>
          )}
          {h.status !== 'cancelled' && (
            <button onClick={cancel} disabled={busy}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'transparent', color: 'var(--state-error-fg)',
                border: '1px solid rgba(222, 42, 42, 0.4)', borderRadius: 4,
                padding: '9px 16px', cursor: busy ? 'wait' : 'pointer',
                fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600,
                opacity: busy ? 0.5 : 1,
              }}>
              <X size={14} strokeWidth={2} /> Cancel
            </button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {h.status === 'cancelled' && (
        <div style={{
          background: 'var(--state-error-bg)',
          border: '1px solid rgba(222, 42, 42, 0.35)',
          borderRadius: 4, padding: '10px 14px', marginBottom: 12,
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--state-error-fg)',
        }}>
          <strong>Cancelled</strong> on {fmtDate(h.cancelled_at)}.
          {h.cancelled_reason ? ` Reason: ${h.cancelled_reason}` : ''}
        </div>
      )}

      {/* EWB reminder banner (live) */}
      {h.status === 'issued' && h.ewb_required && !h.ewb_number && (
        <div style={{
          background: 'var(--state-warning-bg)',
          border: '1px solid rgba(251, 191, 36, 0.35)',
          borderRadius: 4, padding: '10px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <AlertTriangle size={18} color="#fbbf24" strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--state-warning-fg)', lineHeight: 1.5 }}>
            E-Way Bill needed. Total ₹{inr(h.total_amount)} crosses ₹50,000.
            Generate the EWB at ewaybillgst.gov.in using this challan number{' '}
            ({h.challan_no}) and add the EWB number on the print before dispatch.
          </div>
        </div>
      )}

      {/* Meta + addresses */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Panel header="Dispatched From">
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--t1)', marginBottom: 4 }}>
            {h.from_name}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', whiteSpace: 'pre-line', marginBottom: 4 }}>
            {h.from_address}
          </div>
          {h.from_gstin && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
              GSTIN: {h.from_gstin}
            </div>
          )}
        </Panel>
        <Panel header="Dispatched To">
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--t1)', marginBottom: 4 }}>
            {h.to_name}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', whiteSpace: 'pre-line', marginBottom: 4 }}>
            {h.to_address}
          </div>
          {h.to_gstin && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
              GSTIN: {h.to_gstin}
            </div>
          )}
        </Panel>
      </div>

      {/* Lines */}
      <Panel header="Goods Supplied" padding={0} style={{ marginBottom: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>#</Th>
              <Th align="left">Description</Th>
              <Th align="left">HSN</Th>
              <Th align="right">Qty</Th>
              <Th align="left">Unit</Th>
              <Th align="right">Rate (₹)</Th>
              <Th align="right">Amount (₹)</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td align="center">{l.serial_no}</Td>
                <Td align="left">
                  <div style={{ color: 'var(--t1)' }}>{l.description}</div>
                  {(l.ean || l.product_code) && (
                    <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                      {l.ean ? `EAN: ${l.ean}` : ''}{l.ean && l.product_code ? ' · ' : ''}{l.product_code || ''}
                    </div>
                  )}
                </Td>
                <Td align="left">{l.hsn_code || '—'}</Td>
                <Td align="right">{Number(l.quantity)}</Td>
                <Td align="left">{l.unit || 'Pcs'}</Td>
                <Td align="right">₹{inr(l.rate)}</Td>
                <Td align="right" emphasis>₹{inr(l.amount)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Transport + meta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Panel header="Transport">
          <KV label="Mode" value={h.transport_mode || '—'} />
          <KV label="Vehicle" value={h.vehicle_number || '—'} />
          <KV label="Transporter" value={h.transporter_name || '—'} />
        </Panel>
        <Panel header="Meta">
          <KV label="Challan Date"  value={fmtDate(h.challan_date)} />
          <KV label="Purpose"       value={h.purpose || '—'} />
          <KV label="Created By"    value={h.created_by || '—'} />
          <KV label="Created"       value={fmtDate(h.created_at)} />
          {h.issued_at && <KV label="Issued" value={fmtDate(h.issued_at)} />}
          {h.notes && <KV label="Notes" value={h.notes} />}
        </Panel>
      </div>

      {/* Totals */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end',
        gap: 32, padding: 16, borderTop: '1px solid var(--border)',
      }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Taxable Value
          </div>
          <div style={{ fontSize: 18, color: 'var(--t1)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
            ₹{inr(h.subtotal)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            GST @ {Number(h.gst_rate)}%
          </div>
          <div style={{ fontSize: 18, color: 'var(--t1)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
            ₹{inr(h.gst_amount)}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--yellow)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Total
          </div>
          <div style={{ fontSize: 24, color: 'var(--yellow)', fontFamily: 'var(--mono)', fontWeight: 700 }}>
            ₹{inr(h.total_amount)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Th({ children, align = 'center' }) {
  return (
    <th style={{
      textAlign: align, padding: '10px 12px',
      fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
      color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em',
      borderBottom: '1px solid var(--border)', background: 'var(--surface)',
    }}>{children}</th>
  );
}
function Td({ children, align = 'center', emphasis }) {
  return (
    <td style={{
      textAlign: align, padding: '10px 12px',
      fontFamily: 'var(--mono)', fontSize: 14,
      color: emphasis ? 'var(--yellow)' : 'var(--t1)',
      fontWeight: emphasis ? 700 : 400,
      borderBottom: '1px solid var(--border)',
    }}>{children}</td>
  );
}
function KV({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '4px 0', borderBottom: '1px dashed rgba(64,64,64,0.5)' }}>
      <div style={{ flex: '0 0 110px', fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)' }}>{value}</div>
    </div>
  );
}
function StatusForCell({ status }) {
  if (status === 'draft')     return <StatusBadge variant="neutral">Draft</StatusBadge>;
  if (status === 'issued')    return <StatusBadge variant="success" icon="✓">Issued</StatusBadge>;
  if (status === 'cancelled') return <StatusBadge variant="error" icon="✗">Cancelled</StatusBadge>;
  return <StatusBadge variant="neutral">{status}</StatusBadge>;
}
