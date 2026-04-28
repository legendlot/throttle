'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Spinner, useToast } from '@throttle/ui';
import { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_SUBVARIANTS } from '../../../hooks/useProducts.js';

// ── Helpers ────────────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(raw) {
  if (!raw) return '—';
  const str = String(raw);
  if (/^\d{2}-[A-Za-z]{3}-\d{4}/.test(str)) return str.slice(0, 11);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return String(d.getDate()).padStart(2,'0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
    }
  }
  return str.slice(0, 10);
}

// ── Style constants ────────────────────────────────────────────────────────────
const panel     = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr  = { padding: '10px 16px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const th        = { padding: '7px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const td        = { padding: '8px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const inp       = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%' };
const sel       = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12 };
const btnPri    = { background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700 };
const btnSec    = { background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer' };
const label     = { fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const BADGE     = { yellow: { background: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: '1px solid rgba(242,205,26,.2)' }, green: { background: 'rgba(34,197,94,.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,.2)' }, red: { background: 'rgba(222,42,42,.15)', color: '#ff7070', border: '1px solid rgba(222,42,42,.25)' }, gray: { background: 'rgba(80,80,80,.2)', color: '#888', border: '1px solid rgba(80,80,80,.3)' } };

function StatusBadge({ label: text, tone = 'gray' }) {
  const s = BADGE[tone] || BADGE.gray;
  return (
    <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: 2, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em', textTransform: 'uppercase', ...s }}>
      {text}
    </span>
  );
}

// ── Variant / Sub-variant selects — shared across all three panels ─────────────
function VariantSelects({ product, variant, setVariant, subvariant, setSubvariant }) {
  const variants    = product ? (PRODUCT_VARIANTS[product] || []) : [];
  const subvariants = (product && variant) ? ((PRODUCT_SUBVARIANTS[product] || {})[variant] || []) : [];

  useEffect(() => { setVariant(''); }, [product]);          // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSubvariant(''); }, [variant]);       // eslint-disable-line react-hooks/exhaustive-deps

  if (!product) return null;
  return (
    <>
      {variants.length > 0 && (
        <div>
          <span style={label}>Variant</span>
          <select style={{ ...sel, width: '100%' }} value={variant} onChange={e => setVariant(e.target.value)}>
            <option value="">— Any variant —</option>
            {variants.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      )}
      {subvariants.length > 0 && (
        <div>
          <span style={label}>Colour</span>
          <select style={{ ...sel, width: '100%' }} value={subvariant} onChange={e => setSubvariant(e.target.value)}>
            <option value="">— Any colour —</option>
            {subvariants.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
    </>
  );
}

// ── GRN Detail Modal ───────────────────────────────────────────────────────────
function GrnDetailModal({ grnNo, onClose, session }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!grnNo || !session) return;
    setLoading(true);
    setError(null);
    garageFetch('getGRNDetail', { grn_no: grnNo }, session)
      .then(d => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [grnNo, session]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}
    >
      <div
        style={{ ...panel, width: '100%', maxWidth: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: 6 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ ...panelHdr, borderRadius: '6px 6px 0 0' }}>
          <div>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--yellow)', marginRight: 8 }}>{grnNo}</span>
            {data?.summary && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                {formatDisplayDate(data.summary.grn_date)} · {data.summary.supplier || '—'} · {data.summary.lines || 0} lines
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ ...btnSec, padding: '2px 10px', fontSize: 11 }}>✕ Close</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: 16 }}>
          {loading && <div style={{ textAlign: 'center', padding: 32 }}><Spinner /></div>}
          {error && <EmptyState message={error} />}
          {!loading && !error && data && (
            <>
              {data.summary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginBottom: 16 }}>
                  {[
                    { label: 'Supplier',  value: data.summary.supplier || '—' },
                    { label: 'Date',      value: formatDisplayDate(data.summary.grn_date) },
                    { label: 'Product',   value: data.summary.product  || '—' },
                    { label: 'Lines',     value: (data.summary.lines || 0) + ' lines' },
                    { label: 'Total Qty', value: (data.summary.total_qty || 0).toLocaleString() + ' pcs' },
                    { label: 'PO Ref',    value: (data.lines && data.lines[0]?.po_reference) || '—' },
                  ].map(c => (
                    <div key={c.label} style={{ background: 'var(--surface2)', borderRadius: 4, padding: '8px 12px' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 2 }}>{c.label.toUpperCase()}</div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{c.value}</div>
                    </div>
                  ))}
                </div>
              )}
              {(!data.lines || !data.lines.length) ? (
                <EmptyState message="No lines found" />
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>Part Code</th>
                        <th style={th}>Part Name</th>
                        <th style={th}>Product</th>
                        <th style={{ ...th, textAlign: 'right' }}>Ordered</th>
                        <th style={{ ...th, textAlign: 'right' }}>Received</th>
                        <th style={{ ...th, textAlign: 'right' }}>Rejected</th>
                        <th style={th}>Inspection</th>
                        <th style={th}>PO Ref</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lines.map((l, i) => (
                        <tr key={i}>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{l.part_code || '—'}</td>
                          <td style={{ ...td, fontSize: 11 }}>{l.part_name || '—'}</td>
                          <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{l.product || '—'}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>{l.qty_ordered || 0}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>{l.qty_received || 0}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--red)' }}>{l.qty_rejected || 0}</td>
                          <td style={td}><span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: l.inspection === 'Fail' ? 'var(--red)' : 'var(--green)' }}>{l.inspection || '—'}</span></td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{l.po_reference || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Bulk GRN Panel — BOM-driven ────────────────────────────────────────────────
function BulkGrnPanel({ session, onSuccess }) {
  const { showToast }               = useToast();
  const [product, setProduct]       = useState('');
  const [variant, setVariant]       = useState('');
  const [subvariant, setSubvariant] = useState('');
  const [units, setUnits]           = useState('');
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [bomLines, setBomLines]     = useState([]);
  const [bomLoading, setBomLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadBom = useCallback(async () => {
    const qty = parseInt(units) || 0;
    if (!product || qty <= 0) { setBomLines([]); return; }
    setBomLoading(true);
    try {
      const data = await garageFetch('calcKit', { product, variant: variant || '', colour: subvariant || '', qty }, session);
      setBomLines((data.kit || []).map(r => ({ ...r, _received: r.total_qty || 0, _rejected: 0, _inspection: 'Pass' })));
    } catch (e) {
      showToast('Failed to load BOM: ' + e.message, 'error');
      setBomLines([]);
    } finally {
      setBomLoading(false);
    }
  }, [product, variant, subvariant, units, session]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(loadBom, 350);
    return () => clearTimeout(t);
  }, [loadBom]);

  function updateLine(idx, field, value) {
    setBomLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: field === '_inspection' ? value : parseInt(value) || 0 } : l));
  }

  function markAllReceived() {
    setBomLines(prev => prev.map(l => ({ ...l, _received: l.total_qty || 0 })));
  }

  function clearForm() {
    setProduct(''); setVariant(''); setSubvariant('');
    setUnits(''); setSupplier(''); setPoRef('');
    setGrnDate(todayISO()); setBomLines([]);
  }

  async function submit() {
    const qty = parseInt(units) || 0;
    if (!product || qty <= 0 || !bomLines.length) {
      showToast('Select product and enter units received', 'error'); return;
    }
    if (!grnDate) { showToast('Select a GRN date', 'error'); return; }
    const lines = bomLines
      .filter(l => l._received > 0)
      .map(l => ({
        part_code:    l.part_code,
        part_name:    l.part_name,
        product,
        qty_ordered:  l.total_qty || 0,
        qty_received: l._received,
        qty_rejected: l._rejected,
        inspection:   l._inspection,
        notes:        l._received !== (l.total_qty || 0) ? `Expected ${l.total_qty}, received ${l._received}` : '',
      }));
    if (!lines.length) { showToast('No lines with received qty > 0', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('postGRN', { data: { product, supplier, grn_date: grnDate, po_ref: poRef, lines } }, session);
      showToast(`GRN ${res.data.grn_no} created — ${res.data.lines} lines for ${qty} units`, 'success');
      clearForm();
      onSuccess();
    } catch (e) {
      showToast(e.message || 'GRN submission failed — check connection and retry', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const hasExceptions = bomLines.filter(l => l._received !== (l.total_qty || 0)).length;
  const hasRejected   = bomLines.filter(l => l._rejected > 0).length;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <span style={label}>Product *</span>
          <select style={{ ...sel, width: '100%' }} value={product} onChange={e => { setProduct(e.target.value); setVariant(''); setSubvariant(''); }}>
            <option value="">Select product…</option>
            {PRODUCTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <span style={label}>Units Received *</span>
          <input style={inp} type="number" min="1" value={units} onChange={e => setUnits(e.target.value)} placeholder="e.g. 500" />
        </div>
      </div>

      <VariantSelects product={product} variant={variant} setVariant={setVariant} subvariant={subvariant} setSubvariant={setSubvariant} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10, marginTop: 10 }}>
        <div>
          <span style={label}>Supplier</span>
          <input style={inp} value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Supplier name" />
        </div>
        <div>
          <span style={label}>GRN Date *</span>
          <input style={inp} type="date" value={grnDate} onChange={e => setGrnDate(e.target.value)} />
        </div>
        <div>
          <span style={label}>PO Reference</span>
          <input style={inp} value={poRef} onChange={e => setPoRef(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      {/* BOM Section */}
      {!product || !units || parseInt(units) <= 0 ? (
        <div style={{ padding: '16px 0', color: 'var(--t3)', fontSize: 12, textAlign: 'center' }}>
          Select a product and enter units received to load BOM
        </div>
      ) : bomLoading ? (
        <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
      ) : bomLines.length > 0 ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
              {bomLines.length} parts · {hasExceptions} exceptions · {hasRejected} rejected
            </div>
            <button style={{ ...btnSec, padding: '3px 10px', fontSize: 10 }} onClick={markAllReceived}>
              Mark All Received
            </button>
          </div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Part Name</th>
                  <th style={th}>Category</th>
                  <th style={{ ...th, textAlign: 'right' }}>BOM Qty</th>
                  <th style={{ ...th, textAlign: 'right' }}>Expected</th>
                  <th style={{ ...th, textAlign: 'right' }}>Received</th>
                  <th style={{ ...th, textAlign: 'right' }}>Rejected</th>
                  <th style={th}>Insp.</th>
                </tr>
              </thead>
              <tbody>
                {bomLines.map((l, i) => {
                  const isException = l._received !== (l.total_qty || 0);
                  const rowBg = isException ? 'rgba(242,205,26,.04)' : l.category === 'Packaging' ? 'rgba(34,197,94,.03)' : l.category === 'Accessories' ? 'rgba(255,140,0,.03)' : undefined;
                  return (
                    <tr key={i} style={rowBg ? { background: rowBg } : {}}>
                      <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{l.part_code}</td>
                      <td style={{ ...td, fontSize: 11 }}>{l.part_name}</td>
                      <td style={td}><StatusBadge label={l.category || '—'} tone="gray" /></td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>{l.bom_qty}</td>
                      <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', fontWeight: 700 }}>{l.total_qty || 0}</td>
                      <td style={td}>
                        <input
                          type="number" min="0" value={l._received}
                          onChange={e => updateLine(i, '_received', e.target.value)}
                          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '3px 6px', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12, width: 80, textAlign: 'right' }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          type="number" min="0" value={l._rejected}
                          onChange={e => updateLine(i, '_rejected', e.target.value)}
                          style={{ background: 'var(--surface2)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 2, padding: '3px 6px', color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12, width: 60, textAlign: 'right' }}
                        />
                      </td>
                      <td style={td}>
                        <select
                          value={l._inspection}
                          onChange={e => updateLine(i, '_inspection', e.target.value)}
                          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '3px 4px', color: 'var(--t1)', fontSize: 11 }}
                        >
                          <option value="Pass">Pass</option>
                          <option value="Fail">Fail</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div style={{ padding: '12px 0', color: 'var(--t3)', fontSize: 12 }}>No BOM data for this product/variant combination.</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={btnPri} onClick={submit} disabled={submitting || bomLines.length === 0}>
          {submitting ? 'Submitting…' : 'Submit Bulk GRN'}
        </button>
        <button style={btnSec} onClick={clearForm} disabled={submitting}>Clear</button>
      </div>
    </div>
  );
}

// ── FBU GRN Panel — units only ─────────────────────────────────────────────────
function FbuGrnPanel({ session, onSuccess }) {
  const { showToast }               = useToast();
  const [product, setProduct]       = useState('');
  const [variant, setVariant]       = useState('');
  const [subvariant, setSubvariant] = useState('');
  const [units, setUnits]           = useState('');
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [submitting, setSubmitting] = useState(false);

  function clearForm() {
    setProduct(''); setVariant(''); setSubvariant('');
    setUnits(''); setSupplier(''); setPoRef('');
    setGrnDate(todayISO());
  }

  async function submit() {
    if (!product) { showToast('Select a product', 'error'); return; }
    const qty = parseInt(units) || 0;
    if (qty <= 0) { showToast('Enter units received', 'error'); return; }
    if (!grnDate) { showToast('Select a GRN date', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('postFbuGRN', {
        data: { product, variant: variant || null, color: subvariant || null, qty_received: qty, grn_date: grnDate, supplier, po_ref: poRef }
      }, session);
      showToast(`FBU GRN ${res.data.grn_no} created — ${qty} units`, 'success');
      clearForm();
      onSuccess();
    } catch (e) {
      showToast(e.message || 'FBU GRN failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>
        Use for fully-built units received in retail-ready condition. Records unit count only — no part-level BOM tracking.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <span style={label}>Product *</span>
          <select style={{ ...sel, width: '100%' }} value={product} onChange={e => { setProduct(e.target.value); setVariant(''); setSubvariant(''); }}>
            <option value="">Select product…</option>
            {PRODUCTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <span style={label}>Units Received *</span>
          <input style={inp} type="number" min="1" value={units} onChange={e => setUnits(e.target.value)} placeholder="e.g. 200" />
        </div>
      </div>

      <VariantSelects product={product} variant={variant} setVariant={setVariant} subvariant={subvariant} setSubvariant={setSubvariant} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10, marginBottom: 14 }}>
        <div>
          <span style={label}>Supplier</span>
          <input style={inp} value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Supplier name" />
        </div>
        <div>
          <span style={label}>GRN Date *</span>
          <input style={inp} type="date" value={grnDate} onChange={e => setGrnDate(e.target.value)} />
        </div>
        <div>
          <span style={label}>PO Reference</span>
          <input style={inp} value={poRef} onChange={e => setPoRef(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPri} onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit FBU GRN'}
        </button>
        <button style={btnSec} onClick={clearForm} disabled={submitting}>Clear</button>
      </div>
    </div>
  );
}

// ── Parts GRN Panel — manual line entry ───────────────────────────────────────
function PartsGrnPanel({ session, onSuccess }) {
  const { showToast }               = useToast();
  const [product, setProduct]       = useState('');
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [lines, setLines]           = useState([{ partCode: '', partName: '', qty: '' }]);
  const [matCache, setMatCache]     = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!session) return;
    garageFetch('getMaterials', {}, session)
      .then(data => {
        const cache = {};
        (data || []).forEach(m => { if (m.part_code) cache[m.part_code] = m; });
        setMatCache(cache);
      })
      .catch(() => {});
  }, [session]);

  function addLine() {
    setLines(prev => [...prev, { partCode: '', partName: '', qty: '' }]);
  }

  function removeLine(idx) {
    setLines(prev => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [{ partCode: '', partName: '', qty: '' }];
    });
  }

  function updateLine(idx, field, value) {
    setLines(prev => {
      const next = prev.map((l, i) => i !== idx ? l : { ...l, [field]: value });
      // Auto-fill part name from material cache when code changes
      if (field === 'partCode') {
        const code  = value.trim().toUpperCase();
        const match = matCache[code];
        if (match) next[idx] = { ...next[idx], partName: match.part_name || '' };
      }
      return next;
    });
  }

  function clearForm() {
    setProduct(''); setSupplier(''); setPoRef('');
    setGrnDate(todayISO());
    setLines([{ partCode: '', partName: '', qty: '' }]);
  }

  async function submit() {
    if (!grnDate) { showToast('Select a GRN date', 'error'); return; }
    const validLines = lines
      .filter(l => l.partCode.trim() && parseInt(l.qty) > 0)
      .map(l => {
        const code = l.partCode.trim().toUpperCase();
        const name = l.partName.trim() || (matCache[code]?.part_name) || '';
        return { part_code: code, part_name: name, product, qty_received: parseInt(l.qty), inspection: 'Pass' };
      });
    if (!validLines.length) { showToast('Add at least one part line with code and qty', 'error'); return; }
    setSubmitting(true);
    try {
      const res = await workerFetch('postGRN', { data: { product, supplier, grn_date: grnDate, po_ref: poRef, lines: validLines } }, session);
      showToast(`GRN ${res.data.grn_no} created — ${res.data.lines} line(s)`, 'success');
      clearForm();
      onSuccess();
    } catch (e) {
      showToast(e.message || 'GRN submission failed — check connection and retry', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>
        Use for ad-hoc part receipts not tied to a full BOM. Enter part codes manually — names auto-fill from the material master.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <span style={label}>Product (optional)</span>
          <select style={{ ...sel, width: '100%' }} value={product} onChange={e => setProduct(e.target.value)}>
            <option value="">— None —</option>
            {PRODUCTS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <span style={label}>Supplier</span>
          <input style={inp} value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Supplier name" />
        </div>
        <div>
          <span style={label}>GRN Date *</span>
          <input style={inp} type="date" value={grnDate} onChange={e => setGrnDate(e.target.value)} />
        </div>
        <div>
          <span style={label}>PO Reference</span>
          <input style={inp} value={poRef} onChange={e => setPoRef(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      {/* Line entries */}
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 80px 28px', gap: 6, marginBottom: 4, padding: '0 2px' }}>
        <span style={label}>Part Code</span>
        <span style={label}>Part Name</span>
        <span style={{ ...label, textAlign: 'right' }}>Qty</span>
        <span />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 80px 28px', gap: 6, alignItems: 'center' }}>
            <input
              style={{ ...inp, textTransform: 'uppercase', fontSize: 11 }}
              value={l.partCode}
              onChange={e => updateLine(i, 'partCode', e.target.value.toUpperCase())}
              placeholder="Part code"
            />
            <input
              style={inp}
              value={l.partName}
              onChange={e => updateLine(i, 'partName', e.target.value)}
              placeholder="Auto-fills from master"
            />
            <input
              style={{ ...inp, textAlign: 'right' }}
              type="number" min="1"
              value={l.qty}
              onChange={e => updateLine(i, 'qty', e.target.value)}
              placeholder="Qty"
            />
            <button
              onClick={() => removeLine(i)}
              style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
            >×</button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPri} onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit GRN'}
        </button>
        <button style={btnSec} onClick={addLine}>+ Add Line</button>
        <button style={btnSec} onClick={clearForm} disabled={submitting}>Clear</button>
      </div>
    </div>
  );
}

// ── Recent GRNs Panel ─────────────────────────────────────────────────────────
function RecentGrnsPanel({ grns, loading, onOpenDetail }) {
  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>Recent GRNs</span>
        <span style={{ color: 'var(--t3)' }}>{grns.length}</span>
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' }}><Spinner size="sm" /></div>
      ) : grns.length === 0 ? (
        <EmptyState message="No GRNs yet" />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>GRN No</th>
              <th style={th}>Date</th>
              <th style={th}>Supplier</th>
              <th style={th}>Product</th>
              <th style={th}>Lines · Qty</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {grns.map((r, i) => (
              <tr key={i} style={{ cursor: 'pointer' }} onClick={() => onOpenDetail(r.grn_no)}>
                <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.grn_no || '—'}</td>
                <td style={{ ...td, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDisplayDate(r.grn_date)}</td>
                <td style={td}>{r.supplier || '—'}</td>
                <td style={td}>{r.product || '—'}</td>
                <td style={{ ...td, fontFamily: 'var(--mono)' }}>{(r.lines ?? '—')} · {(r.total_qty || 0).toLocaleString()} pcs</td>
                <td style={td}>
                  <StatusBadge label={r.has_fail ? 'Issues' : 'Done'} tone={r.has_fail ? 'red' : 'green'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── GRN Page ──────────────────────────────────────────────────────────────────
export default function GrnPage() {
  const { session, perms } = useAuth();
  const [mode, setMode]           = useState('bulk');
  const [grns, setGrns]           = useState([]);
  const [grnsLoading, setGrnsLoading] = useState(true);
  const [detailGrnNo, setDetailGrnNo] = useState(null);

  async function loadGrns() {
    if (!session) return;
    setGrnsLoading(true);
    try {
      const data = await garageFetch('getGRNSummary', {}, session);
      setGrns(data || []);
    } catch (e) {
      setGrns([]);
    } finally {
      setGrnsLoading(false);
    }
  }

  useEffect(() => { loadGrns(); }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!perms || !perms.grn || perms.grn === 'none') {
    return (
      <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
        <EmptyState message="You do not have permission to access GRN." />
      </div>
    );
  }

  const modes = [
    { id: 'bulk',  label: 'Bulk (BOM)' },
    { id: 'fbu',   label: 'FBU Units' },
    { id: 'parts', label: 'Parts' },
  ];

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      {/* Page header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          GRN Entry
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Goods Received Note — select a mode, enter receipt details, and submit.
        </p>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {modes.map(m => (
          <button
            key={m.id}
            style={mode === m.id ? btnPri : btnSec}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Two-column layout: form left, history right */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 16, alignItems: 'start' }}>
        {/* Active mode panel */}
        <div style={panel}>
          <div style={panelHdr}>
            <span>{mode === 'bulk' ? 'Bulk GRN — BOM Driven' : mode === 'fbu' ? 'FBU GRN — Units Only' : 'Parts GRN — Manual Entry'}</span>
          </div>
          <div style={{ padding: 16 }}>
            {mode === 'bulk'  && <BulkGrnPanel  session={session} onSuccess={loadGrns} />}
            {mode === 'fbu'   && <FbuGrnPanel   session={session} onSuccess={loadGrns} />}
            {mode === 'parts' && <PartsGrnPanel session={session} onSuccess={loadGrns} />}
          </div>
        </div>

        {/* GRN History */}
        <RecentGrnsPanel grns={grns} loading={grnsLoading} onOpenDetail={no => setDetailGrnNo(no)} />
      </div>

      {/* GRN Detail Modal */}
      {detailGrnNo && (
        <GrnDetailModal grnNo={detailGrnNo} onClose={() => setDetailGrnNo(null)} session={session} />
      )}
    </div>
  );
}
