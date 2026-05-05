'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_SUBVARIANTS } from '../../../../hooks/useProducts.js';

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

const RR_STATUS_TONES = { Pending: 'yellow', Converted: 'green', Rejected: 'red' };

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

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)', gap: 8, flexWrap: 'wrap' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };
const btnDanger        = { background: 'transparent', border: '1px solid #ff7070', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: '#ff7070', cursor: 'pointer', fontFamily: 'var(--cond)' };

const tabBtn = (active) => ({
  background: active ? 'var(--yellow)' : 'var(--surface2)',
  color: active ? '#000' : 'var(--t3)',
  border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
  borderRadius: 4, padding: '5px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: active ? 700 : 500,
});

function formatDate(raw) {
  if (!raw) return '—';
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReordersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);

  // form state
  const [rrType, setRrType] = useState('part');
  const [partCode, setPartCode] = useState('');
  const [partName, setPartName] = useState('');
  const [currentStock, setCurrentStock] = useState(null);
  const [partSuggestions, setPartSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [product, setProduct] = useState('');
  const [variant, setVariant] = useState('');
  const [color, setColor] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [urgency, setUrgency] = useState('Normal');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getReorderRequests', {}, session);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load reorder requests', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setRrType('part');
    setPartCode('');
    setPartName('');
    setCurrentStock(null);
    setPartSuggestions([]);
    setProduct('');
    setVariant('');
    setColor('');
    setQty('');
    setUnit('pcs');
    setUrgency('Normal');
    setNotes('');
  }

  function handlePartSearch(value) {
    setPartCode(value);
    setPartName('');
    setCurrentStock(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.length < 2) {
      setPartSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await garageFetch('getMaterials', { search: value }, session);
        setPartSuggestions(Array.isArray(data) ? data.slice(0, 8) : []);
        setShowSuggestions(true);
      } catch {
        setPartSuggestions([]);
      }
    }, 200);
  }

  async function selectPart(p) {
    setPartCode(p.part_code);
    setPartName(p.part_name || '');
    setShowSuggestions(false);
    if (p.unit) setUnit(p.unit);
    try {
      const stock = await garageFetch('getStock', { part_code: p.part_code }, session);
      const row = Array.isArray(stock) ? stock[0] : null;
      setCurrentStock(row?.closing_stock ?? 0);
    } catch {
      setCurrentStock(null);
    }
  }

  async function handleSubmit() {
    const qtyNum = parseFloat(qty) || 0;
    if (qtyNum <= 0) { showToast('Enter a quantity > 0', 'error'); return; }
    if (rrType === 'part' && !partCode) { showToast('Select a part', 'error'); return; }
    if (rrType === 'product' && !product) { showToast('Select a product', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('postReorderRequest', {
        data: {
          request_type: rrType,
          part_code:    rrType === 'part'    ? partCode : null,
          part_name:    rrType === 'part'    ? partName : null,
          product:      rrType === 'product' ? product  : null,
          variant:      rrType === 'product' ? variant  : null,
          color:        rrType === 'product' ? color    : null,
          requested_qty: qtyNum,
          unit,
          urgency,
          notes: notes || null,
        },
      }, session);
      const result = res.data || res;
      showToast(`${result.request_id} raised`, 'success');
      resetForm();
      setFormOpen(false);
      load();
    } catch (e) {
      showToast(e.message || 'Failed to raise request', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmReject() {
    if (!rejectNote.trim()) { showToast('Reason required', 'error'); return; }
    setRejectSubmitting(true);
    try {
      await workerFetch('updateReorderRequest', {
        data: { request_id: rejectingId, action: 'reject', rejection_note: rejectNote.trim() },
      }, session);
      showToast(`${rejectingId} rejected`, 'success');
      setRejectingId(null);
      setRejectNote('');
      load();
    } catch (e) {
      showToast(e.message || 'Failed to reject', 'error');
    } finally {
      setRejectSubmitting(false);
    }
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  const canRaise = perms?.procurement_raise || perms?.reorder_raise;
  const variants = product ? (PRODUCT_VARIANTS[product] || []) : [];
  const colors   = product && variant ? ((PRODUCT_SUBVARIANTS[product] || {})[variant] || []) : [];

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
            Reorder Requests
          </h1>
          <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
            Raise requests for short-stock items — convert to PO when ready.
          </p>
        </div>
        {canRaise && (
          <button
            style={formOpen ? btnSecondary : btnPrimary}
            onClick={() => { setFormOpen((v) => !v); if (formOpen) resetForm(); }}
          >
            {formOpen ? '✕ Cancel' : '+ New Request'}
          </button>
        )}
      </div>

      {formOpen && canRaise && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Raise a Reorder Request</span></div>
          <div style={panelBodyStyle}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button style={tabBtn(rrType === 'part')} onClick={() => setRrType('part')}>By Part Code</button>
              <button style={tabBtn(rrType === 'product')} onClick={() => setRrType('product')}>By Product</button>
            </div>

            {rrType === 'part' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10, position: 'relative' }}>
                <div style={{ position: 'relative' }}>
                  <span style={labelStyle}>Part Code</span>
                  <input
                    type="text"
                    value={partCode}
                    onChange={(e) => handlePartSearch(e.target.value)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                    onFocus={() => partSuggestions.length > 0 && setShowSuggestions(true)}
                    placeholder="Type to search…"
                    style={{ ...inputStyle, fontFamily: 'var(--mono)', width: '100%' }}
                    disabled={submitting}
                  />
                  {showSuggestions && partSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, zIndex: 50, maxHeight: 220, overflowY: 'auto' }}>
                      {partSuggestions.map((p) => (
                        <div
                          key={p.part_code}
                          style={{ padding: '6px 10px', borderBottom: '1px solid rgba(42,42,42,.4)', cursor: 'pointer', fontSize: 11 }}
                          onMouseDown={(e) => { e.preventDefault(); selectPart(p); }}
                        >
                          <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{p.part_code}</span>
                          <span style={{ color: 'var(--t2)', marginLeft: 8 }}>{p.part_name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <span style={labelStyle}>Part Name</span>
                  <input type="text" value={partName} readOnly style={{ ...inputStyle, width: '100%', color: 'var(--t2)' }} placeholder="—" />
                </div>
                <div>
                  <span style={labelStyle}>Current Stock</span>
                  <input
                    type="text"
                    value={currentStock == null ? '—' : currentStock.toLocaleString()}
                    readOnly
                    style={{ ...inputStyle, width: '100%', color: 'var(--t2)', fontFamily: 'var(--mono)' }}
                  />
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <span style={labelStyle}>Product</span>
                  <select value={product} onChange={(e) => { setProduct(e.target.value); setVariant(''); setColor(''); }} style={{ ...selectStyle, width: '100%' }}>
                    <option value="">Select product…</option>
                    {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Variant</span>
                  <select value={variant} onChange={(e) => { setVariant(e.target.value); setColor(''); }} style={{ ...selectStyle, width: '100%' }} disabled={!product}>
                    <option value="">{variants.length ? 'Select…' : '—'}</option>
                    {variants.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <span style={labelStyle}>Colour</span>
                  <select value={color} onChange={(e) => setColor(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={!variant || !colors.length}>
                    <option value="">{colors.length ? 'Select…' : '—'}</option>
                    {colors.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: 10, marginBottom: 12 }}>
              <div>
                <span style={labelStyle}>Qty Needed</span>
                <input type="number" min="0" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Unit</span>
                <input type="text" value={unit} onChange={(e) => setUnit(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
              </div>
              <div>
                <span style={labelStyle}>Urgency</span>
                <select value={urgency} onChange={(e) => setUrgency(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={submitting}>
                  <option>Normal</option>
                  <option>Urgent</option>
                  <option>Critical</option>
                </select>
              </div>
              <div>
                <span style={labelStyle}>Notes (optional)</span>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={submitting} />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
              <button onClick={() => { resetForm(); setFormOpen(false); }} style={btnSecondary} disabled={submitting}>Cancel</button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
              >
                {submitting ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>All Requests {rows.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({rows.length})</span>}</span>
          <button style={btnSecondary} onClick={load} disabled={loading}>↻ Refresh</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No reorder requests yet</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>ID</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Part / Product</th>
                <th style={tableThStyle}>Qty</th>
                <th style={tableThStyle}>Urgency</th>
                <th style={tableThStyle}>Requested By</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Status</th>
                <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const label = r.request_type === 'part'
                    ? `${r.part_code || ''} ${r.part_name ? '· ' + r.part_name : ''}`.trim() || '—'
                    : [r.product, r.variant, r.color].filter(Boolean).join(' · ') || '—';
                  return (
                    <tr key={r.request_id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.request_id}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.request_type || '—'} tone="gray" /></td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{label}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.requested_qty} {r.unit || ''}</td>
                      <td style={{ ...tableTdStyle, color: urgencyColor(r.urgency), fontWeight: 600 }}>{r.urgency || '—'}</td>
                      <td style={tableTdStyle}>{r.requested_by || '—'}</td>
                      <td style={tableTdStyle}>{formatDate(r.created_at)}</td>
                      <td style={tableTdStyle}>
                        <StatusBadge label={r.status || '—'} tone={RR_STATUS_TONES[r.status] || 'gray'} />
                        {r.status === 'Converted' && r.po_number && (
                          <div style={{ fontSize: 9, color: 'var(--t3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{r.po_number}</div>
                        )}
                        {r.status === 'Rejected' && r.rejection_note && (
                          <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2, fontStyle: 'italic' }}>{r.rejection_note}</div>
                        )}
                      </td>
                      <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                        {r.status === 'Pending' && perms?.procurement_raise && (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              style={btnPrimary}
                              onClick={() => router.push(`/procurement/pos/new?rr=${encodeURIComponent(r.request_id)}`)}
                            >
                              Convert →
                            </button>
                            <button
                              style={btnDanger}
                              onClick={() => { setRejectingId(r.request_id); setRejectNote(''); }}
                            >
                              Reject
                            </button>
                          </div>
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

      {rejectingId !== null && (
        <div
          onClick={() => !rejectSubmitting && setRejectingId(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#111', border: '1px solid #333', borderRadius: 6, padding: 20, color: '#eee', minWidth: 380, maxWidth: 480 }}>
            <h3 style={{ margin: 0, marginBottom: 12, color: 'var(--yellow)', fontSize: 14, fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Reject {rejectingId}
            </h3>
            <span style={labelStyle}>Reason *</span>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'var(--mono)' }}
              disabled={rejectSubmitting}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
              <button style={btnSecondary} onClick={() => setRejectingId(null)} disabled={rejectSubmitting}>Cancel</button>
              <button
                style={{ ...btnDanger, color: '#fff', background: '#ef4444', border: '1px solid #ef4444', opacity: rejectSubmitting ? 0.6 : 1 }}
                onClick={confirmReject}
                disabled={rejectSubmitting}
              >
                {rejectSubmitting ? 'Rejecting…' : 'Reject Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
