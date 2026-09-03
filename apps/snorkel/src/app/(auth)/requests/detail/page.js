'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, labelStyle, inputStyle,
  btnPrimary, btnSecondary, btnDanger, pageH1, fmtDate, urgencyColor, StatusBadge, REQUEST_TONES,
} from '@/lib/snorkelui';

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ fontSize: 13, color: 'var(--t1)' }}>{children}</div>
    </div>
  );
}

function RequestDetail() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const requestNo = params.get('request_no');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session || !requestNo) return;
    setLoading(true);
    try {
      const res = await garageFetch('getRequest', { request_no: requestNo }, session);
      setData(res || null);
    } catch (e) {
      showToast(e.message || 'Failed to load request', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, requestNo, showToast]);

  useEffect(() => { load(); }, [load]);

  async function doReject() {
    if (!rejectNote.trim()) { showToast('Reason required', 'error'); return; }
    setBusy(true);
    try {
      await workerFetch('rejectRequest', { data: { request_no: requestNo, rejection_note: rejectNote.trim() } }, session);
      showToast('Request rejected', 'success');
      setRejecting(false); setRejectNote(''); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  async function doCancel() {
    setBusy(true);
    try {
      await workerFetch('cancelRequest', { data: { request_no: requestNo } }, session);
      showToast('Request cancelled', 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  if (loading) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  if (!data?.request) return <div style={{ padding: 24, color: 'var(--t3)' }}>Request not found.</div>;

  const r = data.request;
  const linked = data.linked_po;
  // Lines (S340). Legitimately empty for every request filed before line items
  // existed — those still read as prose in the field below.
  const reqLines = Array.isArray(data.lines) ? data.lines : [];
  const linesTaxable = reqLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const linesTax = reqLines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * ((Number(l.gst_percent) || 0) / 100), 0);
  const needsReview = reqLines.filter((l) => l.needs_hsn_review).length;
  const isPending = r.status === 'pending';
  const canCreatePO = !!perms?.po_create;
  const canAccept = !!perms?.po_request_accept;
  const isOwner = r.requested_by_user_id && session?.user?.id === r.requested_by_user_id;

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 820 }}>
      <button style={{ ...btnSecondary, marginBottom: 12 }} onClick={() => router.push('/requests')}>← Requests</button>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={pageH1}>{r.request_no}</h1>
          <div style={{ marginTop: 6 }}><StatusBadge label={r.status} tone={REQUEST_TONES[r.status] || 'gray'} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isPending && canCreatePO && (
            <button style={btnPrimary} onClick={() => router.push(`/procurement/pos/new/?request=${encodeURIComponent(r.request_no)}`)}>
              Make PO from request →
            </button>
          )}
          {isPending && canAccept && !rejecting && (
            <button style={btnDanger} onClick={() => setRejecting(true)}>Reject</button>
          )}
          {isPending && isOwner && (
            <button style={btnSecondary} onClick={doCancel} disabled={busy}>Cancel request</button>
          )}
        </div>
      </div>

      {rejecting && (
        <div style={{ ...panelStyle, borderColor: '#ff7070' }}>
          <div style={panelBodyStyle}>
            <span style={labelStyle}>Rejection reason *</span>
            <textarea value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} rows={3}
                      style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={busy} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
              <button style={btnSecondary} onClick={() => setRejecting(false)} disabled={busy}>Cancel</button>
              <button style={{ ...btnDanger, background: '#ef4444', color: '#fff', border: '1px solid #ef4444' }} onClick={doReject} disabled={busy}>
                {busy ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>{r.title}</span></div>
        <div style={panelBodyStyle}>
          <Field label={reqLines.length ? 'Why it\'s needed' : "What's needed"}>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{r.details}</div>
          </Field>

          {reqLines.length > 0 && (
            <Field label={`Items (${reqLines.length})`}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--t3)' }}>
                      <th style={{ padding: '4px 6px' }}>#</th>
                      <th style={{ padding: '4px 6px' }}>Item</th>
                      <th style={{ padding: '4px 6px' }}>Description</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: '4px 6px' }}>Unit</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right' }}>Est. price</th>
                      <th style={{ padding: '4px 6px' }}>HSN</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right' }}>GST</th>
                      <th style={{ padding: '4px 6px', textAlign: 'right' }}>Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reqLines.map((l) => (
                      <tr key={l.id || l.line_no} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ padding: '4px 6px', color: 'var(--t3)' }}>{l.line_no}</td>
                        <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)' }}>{l.part_code || <span style={{ color: 'var(--t3)' }}>new item</span>}</td>
                        <td style={{ padding: '4px 6px' }}>{l.description}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{Number(l.qty)}</td>
                        <td style={{ padding: '4px 6px' }}>{l.unit}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{l.unit_price != null ? Number(l.unit_price).toLocaleString('en-IN') : '—'}</td>
                        <td style={{ padding: '4px 6px', fontFamily: 'var(--mono)' }}>{l.hsn_code || '—'}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{l.gst_percent != null ? `${Number(l.gst_percent)}%` : '—'}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                          {l.unit_price != null ? ((Number(l.qty) || 0) * Number(l.unit_price)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: 12 }}>
                <span style={{ color: 'var(--t3)' }}>Subtotal <b style={{ fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{linesTaxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
                <span style={{ color: 'var(--t3)' }}>Est. tax <b style={{ fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{linesTax.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></span>
                <span><b>Est. total {r.currency || ''} <span style={{ fontFamily: 'var(--mono)' }}>{(linesTaxable + linesTax).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></b></span>
              </div>
              {needsReview > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--yellow)' }}>
                  ⚠ {needsReview} item{needsReview === 1 ? '' : 's'} {needsReview === 1 ? 'has' : 'have'} no tax rate resolved — procurement must confirm the HSN before this becomes a PO.
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--t3)' }}>
                Prices are the requester&apos;s estimate, not a quote.
              </div>
            </Field>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Field label="Category">{r.category || '—'}</Field>
            <Field label="Urgency"><span style={{ color: urgencyColor(r.urgency), fontWeight: 600 }}>{r.urgency || '—'}</span></Field>
            <Field label="Needed By">{fmtDate(r.needed_by)}</Field>
            <Field label="Est. Cost">{r.estimated_cost != null ? `${r.currency || ''} ${Number(r.estimated_cost).toLocaleString('en-IN')}` : '—'}</Field>
            <Field label="Suggested Vendor">{r.suggested_vendor || '—'}</Field>
            <Field label="Filed">{fmtDate(r.created_at)}</Field>
            <Field label="Requested By">{r.requested_by_name || '—'}{r.requested_by_email ? <div style={{ fontSize: 10, color: 'var(--t3)' }}>{r.requested_by_email}</div> : null}</Field>
          </div>
          {r.notes && <Field label="Notes">{r.notes}</Field>}
          {r.status === 'rejected' && r.rejection_note && (
            <Field label="Rejection reason"><span style={{ color: '#ff7070' }}>{r.rejection_note}</span> {r.rejected_by ? `· ${r.rejected_by}` : ''}</Field>
          )}
        </div>
      </div>

      {linked && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Linked Purchase Order</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{linked.po_number}</span>
                <span style={{ color: 'var(--t2)', marginLeft: 10 }}>{linked.vendor_name}</span>
                <span style={{ marginLeft: 10 }}><StatusBadge label={linked.status} tone="blue" /></span>
              </div>
              <button style={btnSecondary} onClick={() => router.push(`/procurement/pos/detail/?po_number=${encodeURIComponent(linked.po_number)}`)}>
                Open PO →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RequestDetailPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: 'var(--t3)' }}>Loading…</div>}>
      <RequestDetail />
    </Suspense>
  );
}
