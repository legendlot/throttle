'use client';
import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { EmptyState, Modal, Spinner, useToast, buildBagLabelsHtml, printWindow, Combobox, useEscapeClose } from '@throttle/ui';
import { useProducts } from '../../../hooks/useProducts.js';

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

// ── Variant select — shared across panels ─────────────────────────────────────
function VariantSelects({ product, variant, setVariant }) {
  const { PRODUCT_VARIANTS } = useProducts();
  const variants = product ? (PRODUCT_VARIANTS[product] || []) : [];

  useEffect(() => { setVariant(''); }, [product]);          // eslint-disable-line react-hooks/exhaustive-deps

  if (!product) return null;
  if (variants.length === 0) return null;
  return (
    <div>
      <span style={label}>Variant</span>
      <select style={{ ...sel, width: '100%' }} value={variant} onChange={e => setVariant(e.target.value)}>
        <option value="">— Any variant —</option>
        {variants.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );
}

// ── GRN Detail Modal ───────────────────────────────────────────────────────────
function GrnDetailModal({ grnNo, onClose, session }) {
  const { showToast }         = useToast();
  useEscapeClose(true, onClose);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [bagPart, setBagPart]         = useState(null); // part_code expanded
  const [bagExisting, setBagExisting] = useState([]);
  const [bagsOf, setBagsOf]           = useState(50);
  const [bagBusy, setBagBusy]         = useState(false);
  const [bagSizeMap, setBagSizeMap]   = useState({}); // { part_code → default_bag_size }

  useEffect(() => {
    if (!grnNo || !session) return;
    setLoading(true);
    setError(null);
    Promise.all([
      garageFetch('getGRNDetail', { grn_no: grnNo }, session),
      workerFetch('getPartBagSizes', {}, session).catch(() => ({ ok: false })),
    ])
      .then(([d, bs]) => {
        setData(d);
        const map = {};
        if (bs?.ok) (bs.data || []).forEach(b => { map[b.part_code] = b.default_bag_size || 0; });
        setBagSizeMap(map);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [grnNo, session]);

  const isDirect = data?.summary?.is_direct === true
    || (data?.lines && data.lines.every(l => !(l.notes || '').startsWith('From ')));

  async function toggleBagPanel(line) {
    if (bagPart === line.part_code) {
      setBagPart(null); setBagExisting([]); return;
    }
    setBagPart(line.part_code);
    // Pre-fill Qty/Bag from the central catalogue. Operator can still
    // override per-print; fallback to existing 50-default when no central
    // value exists.
    const centralDefault = bagSizeMap[line.part_code];
    if (centralDefault && centralDefault > 0) setBagsOf(centralDefault);
    setBagBusy(true);
    try {
      const res = await workerFetch('getBagsByGrn',
        { data: { grn_no: grnNo, part_code: line.part_code } }, session);
      setBagExisting(Array.isArray(res?.data) ? res.data : []);
    } catch (e) {
      setBagExisting([]);
      showToast('Failed to load bag info: ' + (e.message || e), 'error');
    } finally {
      setBagBusy(false);
    }
  }

  function reprintExistingBags() {
    if (!bagExisting.length) return;
    printWindow(buildBagLabelsHtml(bagExisting, grnNo));
  }

  async function generateAndPrintBags(line) {
    if (!bagsOf || bagsOf < 1) { showToast('Pack size must be at least 1', 'error'); return; }
    const qty = parseInt(line.qty_received) || 0;
    if (qty <= 0) { showToast('Line has no qty_received', 'error'); return; }
    setBagBusy(true);
    try {
      const res = await workerFetch('generateBagsForGrn', {
        data: { grn_no: grnNo, part_code: line.part_code, part_name: line.part_name, qty, bags_of: bagsOf }
      }, session);
      const created = res?.data?.bags || [];
      if (!created.length) {
        showToast('No new bags to generate (already complete)', 'info');
      } else {
        showToast(`${created.length} bag label${created.length === 1 ? '' : 's'} generated for ${line.part_code}`, 'success');
        printWindow(buildBagLabelsHtml(created, grnNo));
      }
      // Refresh existing bags so the panel shows the new total
      const fresh = await workerFetch('getBagsByGrn',
        { data: { grn_no: grnNo, part_code: line.part_code } }, session);
      setBagExisting(Array.isArray(fresh?.data) ? fresh.data : []);
    } catch (e) {
      showToast(e.message || 'Bag generation failed', 'error');
    } finally {
      setBagBusy(false);
    }
  }

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
                        <th style={{ ...th, textAlign: 'right' }}>Damaged</th>
                        <th style={{ ...th, textAlign: 'right' }}>Rejected</th>
                        <th style={th}>Inspection</th>
                        <th style={th}>PO Ref</th>
                        {isDirect && <th style={th}>Labels</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.lines.map((l, i) => (
                        <Fragment key={i}>
                        <tr>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)' }}>{l.part_code || '—'}</td>
                          <td style={{ ...td, fontSize: 11 }}>{l.part_name || '—'}</td>
                          <td style={{ ...td, fontSize: 11, color: 'var(--t3)' }}>{l.product || '—'}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--t3)' }}>{l.qty_ordered || 0}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--state-success-fg)', fontWeight: 700 }}>{l.qty_received || 0}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--state-error-fg)' }}>{l.damaged_qty || 0}</td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', textAlign: 'right', color: 'var(--state-error-fg)' }}>{l.qty_rejected || 0}</td>
                          <td style={td}><span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: l.inspection === 'Fail' ? 'var(--red)' : 'var(--green)' }}>{l.inspection || '—'}</span></td>
                          <td style={{ ...td, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{l.po_reference || '—'}</td>
                          {isDirect && (
                            <td style={td}>
                              <button
                                style={{ ...btnSec, padding: '2px 8px', fontSize: 10 }}
                                onClick={() => toggleBagPanel(l)}
                                disabled={bagBusy && bagPart !== l.part_code}
                              >
                                {bagPart === l.part_code ? '✕ Close' : '🏷 Bag Labels'}
                              </button>
                            </td>
                          )}
                        </tr>
                        {isDirect && bagPart === l.part_code && (
                          <tr>
                            <td colSpan={10} style={{ ...td, padding: '12px 14px', background: 'var(--surface2)' }}>
                              {bagBusy && <Spinner />}
                              {!bagBusy && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                                    {bagExisting.length > 0
                                      ? <>Already generated: <span style={{ color: 'var(--yellow)' }}>{bagExisting.length}</span> bag{bagExisting.length === 1 ? '' : 's'} · <span style={{ color: 'var(--t3)' }}>{bagExisting.reduce((s, b) => s + (parseInt(b.qty) || 0), 0)} pcs</span></>
                                      : <>No bags generated yet for this part.</>}
                                  </div>
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                    <span style={{ ...label, marginBottom: 0 }}>Pack size</span>
                                    <input
                                      type="number" min="1"
                                      value={bagsOf}
                                      onChange={e => setBagsOf(Math.max(1, parseInt(e.target.value) || 1))}
                                      style={{ ...inp, width: 80, padding: '4px 8px', fontSize: 11 }}
                                    />
                                  </div>
                                  <button
                                    style={{ ...btnPri, padding: '4px 12px', fontSize: 11 }}
                                    onClick={() => generateAndPrintBags(l)}
                                    disabled={bagBusy}
                                  >
                                    Generate &amp; Print
                                  </button>
                                  {bagExisting.length > 0 && (
                                    <button
                                      style={{ ...btnSec, padding: '4px 12px', fontSize: 11 }}
                                      onClick={reprintExistingBags}
                                      disabled={bagBusy}
                                    >
                                      Reprint All
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                        </Fragment>
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
  const { PRODUCTS, loading: productsLoading } = useProducts();
  const [product, setProduct]       = useState('');
  const [variant, setVariant]       = useState('');
  const [units, setUnits]           = useState('');
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [bomLines, setBomLines]     = useState([]);
  const [bomLoading, setBomLoading] = useState(false);
  const [bagSizeMap, setBagSizeMap] = useState({}); // { part_code → default_bag_size }
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!session) return;
    workerFetch('getPartBagSizes', {}, session)
      .then(r => {
        if (!r?.ok) return;
        const map = {};
        (r.data || []).forEach(b => { map[b.part_code] = b.default_bag_size || 0; });
        setBagSizeMap(map);
      })
      .catch(() => {});
  }, [session]);

  const loadBom = useCallback(async () => {
    const qty = parseInt(units) || 0;
    if (!product || qty <= 0) { setBomLines([]); return; }
    setBomLoading(true);
    try {
      const data = await garageFetch('calcKit', { product, variant: variant || '', colour: '', qty }, session);
      setBomLines((data.kit || []).map(r => ({
        ...r,
        _received: r.total_qty || 0,
        _rejected: 0,
        _damaged:  0,
        _bagsOf:   bagSizeMap[r.part_code] || 0, // pre-fill from central catalogue
        _inspection: 'Pass',
      })));
    } catch (e) {
      showToast('Failed to load BOM: ' + e.message, 'error');
      setBomLines([]);
    } finally {
      setBomLoading(false);
    }
  }, [product, variant, units, session, bagSizeMap]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setProduct(''); setVariant('');
    setUnits(''); setSupplier(''); setPoRef('');
    setGrnDate(todayISO()); setBomLines([]);
  }

  async function submit() {
    const qty = parseInt(units) || 0;
    if (!product || qty <= 0 || !bomLines.length) {
      showToast('Select product and enter units received', 'error'); return;
    }
    if (!grnDate) { showToast('Select a GRN date', 'error'); return; }
    const rows = bomLines
      .filter(l => l._received > 0 || l._damaged > 0)
      .map(l => ({
        part_code:    l.part_code,
        part_name:    l.part_name,
        product,
        qty_ordered:  l.total_qty || 0,
        qty_received: l._received,
        qty_rejected: l._rejected,
        damaged_qty:  l._damaged || 0,
        inspection:   l._inspection,
        notes:        l._received !== (l.total_qty || 0) ? `Expected ${l.total_qty}, received ${l._received}` : '',
        bags_of:      parseInt(l._bagsOf) || 0,
      }));
    if (!rows.length) { showToast('No lines with received or damaged qty > 0', 'error'); return; }
    const lines = rows.map(({ bags_of, ...rest }) => rest);
    const bagRequests = rows.filter(r => r.bags_of > 0 && r.qty_received > 0);
    setSubmitting(true);
    try {
      const res = await workerFetch('postGRN', { data: { product, supplier, grn_date: grnDate, po_ref: poRef, lines } }, session);
      const grnNo = res.data.grn_no;
      showToast(`GRN ${grnNo} created — ${res.data.lines} lines for ${qty} units`, 'success');

      // Bag-label generation per-line. GRN already exists, so partial failure
      // here is recoverable from the GRN detail modal.
      if (bagRequests.length > 0) {
        const allBags = [];
        const failed = [];
        for (const r of bagRequests) {
          try {
            const bagRes = await workerFetch('generateBagsForGrn', {
              data: {
                grn_no:    grnNo,
                part_code: r.part_code,
                part_name: r.part_name,
                qty:       r.qty_received,
                bags_of:   r.bags_of,
              }
            }, session);
            allBags.push(...(bagRes?.data?.bags || []));
          } catch (e) {
            failed.push(`${r.part_code}: ${e.message || e}`);
          }
        }
        if (allBags.length > 0) {
          showToast(`${allBags.length} bag label${allBags.length === 1 ? '' : 's'} generated`, 'success');
          printWindow(buildBagLabelsHtml(allBags, grnNo));
        }
        if (failed.length > 0) {
          showToast(`Bag generation failed for ${failed.length} part(s) — reprint from GRN detail`, 'error');
        }
      }

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
  const bagLineCount  = bomLines.filter(l => (parseInt(l._bagsOf) || 0) > 0 && (parseInt(l._received) || 0) > 0).length;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <span style={label}>Product *</span>
          <Combobox
            value={product}
            options={PRODUCTS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => { setProduct(v); setVariant(''); }}
            placeholder="Search products…"
            loading={productsLoading}
          />
        </div>
        <div>
          <span style={label}>Units Received *</span>
          <input style={inp} type="number" min="1" value={units} onChange={e => setUnits(e.target.value)} placeholder="e.g. 500" />
        </div>
      </div>

      <VariantSelects product={product} variant={variant} setVariant={setVariant} />

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
                  <th style={{ ...th, textAlign: 'right' }}>Qty/Bag</th>
                  <th style={{ ...th, textAlign: 'right' }}>Damaged</th>
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
                          type="number" min="0" value={l._bagsOf}
                          onChange={e => updateLine(i, '_bagsOf', e.target.value)}
                          placeholder="Bag"
                          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 2, padding: '3px 6px', color: 'var(--t1)', fontFamily: 'var(--mono)', fontSize: 12, width: 60, textAlign: 'right' }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          type="number" min="0" value={l._damaged}
                          onChange={e => updateLine(i, '_damaged', e.target.value)}
                          placeholder="Dmg"
                          style={{ background: 'rgba(222,42,42,.06)', border: '1px solid rgba(222,42,42,.2)', borderRadius: 2, padding: '3px 6px', color: 'var(--state-error-fg)', fontFamily: 'var(--mono)', fontSize: 12, width: 60, textAlign: 'right' }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          type="number" min="0" value={l._rejected}
                          onChange={e => updateLine(i, '_rejected', e.target.value)}
                          style={{ background: 'var(--surface2)', border: '1px solid rgba(222,42,42,.3)', borderRadius: 2, padding: '3px 6px', color: 'var(--state-error-fg)', fontFamily: 'var(--mono)', fontSize: 12, width: 60, textAlign: 'right' }}
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

      <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
        <button style={btnPri} onClick={submit} disabled={submitting || bomLines.length === 0}>
          {submitting ? 'Submitting…' : (bagLineCount > 0 ? `🏷 Submit Bulk GRN & Print ${bagLineCount} Part${bagLineCount === 1 ? '' : 's'}` : 'Submit Bulk GRN')}
        </button>
        <button style={btnSec} onClick={clearForm} disabled={submitting}>Clear</button>
        {bagLineCount > 0 && (
          <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
            Bag labels will print after submit
          </span>
        )}
      </div>
    </div>
  );
}

// ── FBU GRN Panel — units only ─────────────────────────────────────────────────
function FbuGrnPanel({ session, onSuccess }) {
  const { showToast }               = useToast();
  const { PRODUCTS, PRODUCT_COLORS, loading: productsLoading } = useProducts();
  const [product, setProduct]       = useState('');
  const [variant, setVariant]       = useState('');
  const [color, setColor]           = useState('');
  const [units, setUnits]           = useState('');
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Colours available for the chosen product + variant (FBU units are unit-level,
  // so colour is captured here rather than via a BOM).
  const colorOptions = (product && variant) ? (PRODUCT_COLORS[product]?.[variant] || []) : [];
  // Reset colour whenever the product or variant changes.
  useEffect(() => { setColor(''); }, [product, variant]);

  function clearForm() {
    setProduct(''); setVariant(''); setColor('');
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
        data: { product, variant: variant || null, color: color || null, qty_received: qty, grn_date: grnDate, supplier, po_ref: poRef }
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
          <Combobox
            value={product}
            options={PRODUCTS.map((p) => ({ value: p, label: p }))}
            onChange={(v) => { setProduct(v); setVariant(''); }}
            placeholder="Search products…"
            loading={productsLoading}
          />
        </div>
        <div>
          <span style={label}>Units Received *</span>
          <input style={inp} type="number" min="1" value={units} onChange={e => setUnits(e.target.value)} placeholder="e.g. 200" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'end' }}>
        <VariantSelects product={product} variant={variant} setVariant={setVariant} />
        {colorOptions.length > 0 && (
          <div>
            <span style={label}>Colour</span>
            <select style={{ ...sel, width: '100%' }} value={color} onChange={e => setColor(e.target.value)}>
              <option value="">— Select colour —</option>
              {colorOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
      </div>

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

// ── Parts GRN Panel — searchable part picker ──────────────────────────────────
function PartsGrnPanel({ session, onSuccess }) {
  const { showToast }               = useToast();
  const [supplier, setSupplier]     = useState('');
  const [grnDate, setGrnDate]       = useState(todayISO());
  const [poRef, setPoRef]           = useState('');
  const [lines, setLines]           = useState([{ search: '', partCode: '', partName: '', product: '', qty: '', damaged: '', bagsOf: '' }]);
  const [matCache, setMatCache]     = useState({});
  const [bagSizeMap, setBagSizeMap] = useState({}); // { part_code → default_bag_size }
  const [submitting, setSubmitting] = useState(false);
  const [partHighlight, setPartHighlight] = useState({});
  const highlightedPartRef = useRef(null);

  useEffect(() => {
    if (highlightedPartRef.current) {
      highlightedPartRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [partHighlight]);

  useEffect(() => {
    if (!session) return;
    garageFetch('getMaterials', {}, session)
      .then(data => {
        const cache = {};
        (data || []).forEach(m => { if (m.part_code) cache[m.part_code] = m; });
        setMatCache(cache);
      })
      .catch(() => {});
    workerFetch('getPartBagSizes', {}, session)
      .then(r => {
        if (!r?.ok) return;
        const map = {};
        (r.data || []).forEach(b => { map[b.part_code] = b.default_bag_size || 0; });
        setBagSizeMap(map);
      })
      .catch(() => {});
  }, [session]);

  function addLine() {
    setLines(prev => [...prev, { search: '', partCode: '', partName: '', product: '', qty: '', damaged: '', bagsOf: '' }]);
  }

  function removeLine(idx) {
    setLines(prev => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [{ search: '', partCode: '', partName: '', product: '', qty: '', damaged: '', bagsOf: '' }];
    });
  }

  function updateSearch(idx, value) {
    // Clear selection whenever user edits the search text
    setLines(prev => prev.map((l, i) =>
      i !== idx ? l : { ...l, search: value, partCode: '', partName: '', product: '' }
    ));
  }

  function updateQty(idx, value) {
    setLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, qty: value }));
  }

  function updateDamaged(idx, value) {
    setLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, damaged: value }));
  }

  function updateBagsOf(idx, value) {
    setLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, bagsOf: value }));
  }

  function selectPart(idx, mat) {
    const centralBagSize = bagSizeMap[mat.part_code];
    setLines(prev => prev.map((l, i) =>
      i !== idx ? l : {
        ...l,
        search:   (mat.product ? mat.product + ' — ' : '') + (mat.part_name || ''),
        partCode: mat.part_code || '',
        partName: mat.part_name || '',
        product:  mat.product   || '',
        // Pre-fill Qty/Bag from the central catalogue when available;
        // operator can still override per-receipt.
        bagsOf:   l.bagsOf || (centralBagSize ? String(centralBagSize) : ''),
      }
    ));
  }

  function clearForm() {
    setSupplier(''); setPoRef('');
    setGrnDate(todayISO());
    setLines([{ search: '', partCode: '', partName: '', product: '', qty: '', damaged: '', bagsOf: '' }]);
  }

  async function submit() {
    if (!grnDate) { showToast('Select a GRN date', 'error'); return; }
    const validRows = lines
      .filter(l => l.partCode.trim() && ((parseInt(l.qty) || 0) > 0 || (parseInt(l.damaged) || 0) > 0))
      .map(l => ({
        part_code:    l.partCode.trim().toUpperCase(),
        part_name:    l.partName.trim() || (matCache[l.partCode.trim().toUpperCase()]?.part_name) || '',
        product:      l.product || '',
        qty_received: parseInt(l.qty) || 0,
        damaged_qty:  parseInt(l.damaged) || 0,
        bags_of:      parseInt(l.bagsOf) || 0,
        inspection:   'Pass',
      }));
    if (!validRows.length) { showToast('Select at least one part and enter a received or damaged qty', 'error'); return; }
    const validLines = validRows.map(({ bags_of, ...rest }) => rest);
    const bagRequests = validRows.filter(r => r.bags_of > 0 && r.qty_received > 0);
    // Derive top-level product from first line so batch number has a clean prefix
    const headerProduct = validLines[0]?.product || '';
    setSubmitting(true);
    try {
      const res = await workerFetch('postGRN', {
        data: { product: headerProduct, supplier, grn_date: grnDate, po_ref: poRef, lines: validLines }
      }, session);
      const grnNo = res.data.grn_no;
      showToast(`GRN ${grnNo} created — ${res.data.lines} line(s)`, 'success');

      // Bag-label generation: per-line, sequential (each is its own worker call).
      // GRN already exists, so partial failure here doesn't roll back the GRN —
      // unprinted lines can be re-attempted from the GRN detail modal later.
      if (bagRequests.length > 0) {
        const allBags = [];
        const failed = [];
        for (const r of bagRequests) {
          try {
            const bagRes = await workerFetch('generateBagsForGrn', {
              data: {
                grn_no:    grnNo,
                part_code: r.part_code,
                part_name: r.part_name,
                qty:       r.qty_received,
                bags_of:   r.bags_of,
              }
            }, session);
            const created = bagRes?.data?.bags || [];
            allBags.push(...created);
          } catch (e) {
            failed.push(`${r.part_code}: ${e.message || e}`);
          }
        }
        if (allBags.length > 0) {
          showToast(`${allBags.length} bag label${allBags.length === 1 ? '' : 's'} generated`, 'success');
          printWindow(buildBagLabelsHtml(allBags, grnNo));
        }
        if (failed.length > 0) {
          showToast(`Bag generation failed for ${failed.length} part(s) — reprint from GRN detail`, 'error');
        }
      }

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
        Use for ad-hoc part receipts not tied to a full BOM. Search by product and part name together (e.g. &quot;flare pcb&quot;) — select to fill automatically.
      </p>

      {/* Header fields — product removed, now auto-filled per line */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
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

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 70px 60px 28px', gap: 6, marginBottom: 4, padding: '0 2px' }}>
        <span style={label}>Part Search</span>
        <span style={label}>Code · Product</span>
        <span style={{ ...label, textAlign: 'right' }}>Qty</span>
        <span style={{ ...label, textAlign: 'right' }}>Qty/Bag</span>
        <span style={{ ...label, textAlign: 'right', color: 'var(--state-error-fg)' }}>Damaged</span>
        <span />
      </div>

      {/* Line rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {lines.map((l, i) => {
          const term   = l.search.trim().toLowerCase();
          const tokens = term.split(/\s+/).filter(Boolean);
          const showDropdown = tokens.length > 0 && !l.partCode;
          const results = showDropdown
            ? Object.values(matCache).filter(m => {
                const haystack = `${m.product || ''} ${m.part_name || ''} ${m.part_code || ''}`.toLowerCase();
                return tokens.every(t => haystack.includes(t));
              }).slice(0, 10)
            : [];

          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 70px 70px 60px 28px', gap: 6, alignItems: 'center' }}>
              {/* Search input with dropdown */}
              <div style={{ position: 'relative' }}>
                <input
                  style={inp}
                  value={l.search}
                  onChange={e => { updateSearch(i, e.target.value); setPartHighlight(s => ({ ...s, [i]: -1 })); }}
                  onKeyDown={(e) => {
                    if (!showDropdown || results.length === 0) {
                      if (e.key === 'Escape') setPartHighlight(s => ({ ...s, [i]: -1 }));
                      return;
                    }
                    const hi = partHighlight[i] ?? -1;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPartHighlight(s => ({ ...s, [i]: Math.min((hi < 0 ? -1 : hi) + 1, results.length - 1) }));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPartHighlight(s => ({ ...s, [i]: Math.max(hi - 1, 0) }));
                    } else if (e.key === 'Enter') {
                      if (hi >= 0 && results[hi]) {
                        e.preventDefault();
                        selectPart(i, results[hi]);
                        setPartHighlight(s => ({ ...s, [i]: -1 }));
                      }
                    } else if (e.key === 'Escape') {
                      e.currentTarget.blur();
                      setPartHighlight(s => ({ ...s, [i]: -1 }));
                    }
                  }}
                  placeholder="e.g. flare pcb, knox licence…"
                  autoComplete="off"
                />
                {showDropdown && results.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, zIndex: 200,
                    minWidth: 520,
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 4, boxShadow: '0 6px 20px rgba(0,0,0,.5)',
                    maxHeight: 300, overflowY: 'auto', marginTop: 2,
                  }}>
                    {results.map((m, ri) => {
                      const isHi = (partHighlight[i] ?? -1) === ri;
                      return (
                        <div
                          key={ri}
                          ref={isHi ? highlightedPartRef : null}
                          onMouseDown={e => { e.preventDefault(); selectPart(i, m); setPartHighlight(s => ({ ...s, [i]: -1 })); }}
                          onMouseEnter={() => setPartHighlight(s => ({ ...s, [i]: ri }))}
                          style={{
                            padding: '9px 12px', cursor: 'pointer',
                            borderBottom: ri < results.length - 1 ? '1px solid var(--border)' : 'none',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                            background: isHi ? 'var(--surface2)' : 'transparent',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {m.part_name || m.part_code}
                            </div>
                            {m.product && (
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginTop: 1 }}>
                                {m.product}
                              </div>
                            )}
                          </div>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--yellow)', flexShrink: 0 }}>
                            {m.part_code}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {showDropdown && tokens.length > 0 && results.length === 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, zIndex: 200,
                    minWidth: 520,
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 4, padding: '8px 10px', marginTop: 2,
                    fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)',
                  }}>
                    No parts found
                  </div>
                )}
              </div>

              {/* Code + product badge */}
              <div style={{
                padding: '5px 8px', background: 'var(--surface2)',
                borderRadius: 4, border: '1px solid var(--border)',
                minHeight: 34, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: l.partCode ? 'var(--yellow)' : 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.partCode || '—'}
                </div>
                {l.product && (
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.product}
                  </div>
                )}
              </div>

              {/* Qty */}
              <input
                style={{ ...inp, textAlign: 'right' }}
                type="number" min="0"
                value={l.qty}
                onChange={e => updateQty(i, e.target.value)}
                placeholder="Qty"
              />

              {/* Qty per bag — drives bag-label generation on submit */}
              <input
                style={{ ...inp, textAlign: 'right' }}
                type="number" min="0"
                value={l.bagsOf}
                onChange={e => updateBagsOf(i, e.target.value)}
                placeholder="Bag"
              />

              {/* Damaged */}
              <input
                style={{ ...inp, textAlign: 'right', background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.2)', color: 'var(--state-error-fg)' }}
                type="number" min="0"
                value={l.damaged}
                onChange={e => updateDamaged(i, e.target.value)}
                placeholder="Dmg"
              />

              {/* Remove */}
              <button
                onClick={() => removeLine(i)}
                style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
              >×</button>
            </div>
          );
        })}
      </div>

      {(() => {
        const bagLineCount = lines.filter(l => (parseInt(l.bagsOf) || 0) > 0 && (parseInt(l.qty) || 0) > 0).length;
        return (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={btnPri} onClick={submit} disabled={submitting}>
              {submitting ? 'Submitting…' : (bagLineCount > 0 ? `🏷 Submit GRN & Print ${bagLineCount} Part${bagLineCount === 1 ? '' : 's'}` : 'Submit GRN')}
            </button>
            <button style={btnSec} onClick={addLine}>+ Add Line</button>
            <button style={btnSec} onClick={clearForm} disabled={submitting}>Clear</button>
            {bagLineCount > 0 && (
              <span style={{ fontSize: 10, color: 'var(--t3)', fontFamily: 'var(--mono)', marginLeft: 'auto' }}>
                Bag labels will print after submit
              </span>
            )}
          </div>
        );
      })()}
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
                <td style={td}>
                  {r.product || '—'}
                  {r.is_fbu && (
                    <span style={{ marginLeft: 6, fontSize: 9, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '1px 4px', verticalAlign: 'middle' }}>FBU</span>
                  )}
                </td>
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
  const [showCreate, setShowCreate] = useState(false);
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

      <div style={{ marginBottom: 16 }}>
        <button
          style={{ background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4, padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700 }}
          onClick={() => setShowCreate(true)}
        >
          + New GRN
        </button>
      </div>

      {/* Full-width history table */}
      <RecentGrnsPanel grns={grns} loading={grnsLoading} onOpenDetail={no => setDetailGrnNo(no)} />

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        size="lg"
        title="New GRN"
      >
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {[{ id: 'bulk', label: 'Bulk (BOM)' }, { id: 'fbu', label: 'FBU Units' }, { id: 'parts', label: 'Parts' }].map(m => (
            <button
              key={m.id}
              style={mode === m.id ? btnPri : btnSec}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Active mode panel */}
        <div style={panel}>
          <div style={panelHdr}>
            <span>{mode === 'bulk' ? 'Bulk GRN — BOM Driven' : mode === 'fbu' ? 'FBU GRN — Units Only' : 'Parts GRN — Manual Entry'}</span>
          </div>
          <div style={{ padding: 16 }}>
            {mode === 'bulk'  && <BulkGrnPanel  session={session} onSuccess={() => { loadGrns(); setShowCreate(false); }} />}
            {mode === 'fbu'   && <FbuGrnPanel   session={session} onSuccess={() => { loadGrns(); setShowCreate(false); }} />}
            {mode === 'parts' && <PartsGrnPanel session={session} onSuccess={() => { loadGrns(); setShowCreate(false); }} />}
          </div>
        </div>
      </Modal>

      {/* GRN Detail Modal */}
      {detailGrnNo && (
        <GrnDetailModal grnNo={detailGrnNo} onClose={() => setDetailGrnNo(null)} session={session} />
      )}
    </div>
  );
}
