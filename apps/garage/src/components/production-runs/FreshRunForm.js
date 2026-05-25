'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { ConfirmModal, useToast } from '@throttle/ui';
import { workerFetch, garageFetch } from '@throttle/db';
import { useProducts } from '../../hooks/useProducts.js';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
};
const inp = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%',
};
const sel = {
  background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)',
  borderRadius: 4, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, width: '100%',
};
const lbl = {
  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block',
};
const fieldErr = { fontSize: 11, color: 'var(--state-error-fg)', marginTop: 2 };
const btnPri = {
  background: 'var(--yellow)', color: '#000', border: 'none', borderRadius: 4,
  padding: '7px 16px', fontFamily: 'var(--mono)', fontSize: 12,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer', fontWeight: 700,
};
const btnSec = {
  background: 'var(--surface2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 4,
  padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, cursor: 'pointer',
};
const tinyBtn = {
  background: 'transparent', border: 'none', color: 'var(--t3)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1,
};

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function blankRow() {
  return {
    id: Math.random().toString(36).slice(2, 9),
    variant: '',
    colour: '',
    qtyEcomm: '',
    qtyRetail: '',
    issueMode: 'components',
  };
}

export function FreshRunForm({ onSuccess, session }) {
  const { showToast } = useToast();
  const { PRODUCTS, PRODUCT_VARIANTS, HAS_REMOTE, PRODUCT_COLORS, RECEIVE_FORMAT, loading } = useProducts();
  const [product, setProduct] = useState('');
  const [runDate, setRunDate] = useState(tomorrowISO());
  const [line, setLine] = useState('L1');
  const [shift, setShift] = useState('Morning');
  const [notes, setNotes] = useState('');
  const [variantRows, setVariantRows] = useState([blankRow()]);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  const [warningOpen, setWarningOpen] = useState(false);
  const [warningMessage, setWarningMessage] = useState('');
  const [pendingPayload, setPendingPayload] = useState(null);

  const [runType, setRunType] = useState('in-house');
  const [vendorId, setVendorId] = useState('');
  const [vendors, setVendors] = useState([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);

  // Vendor combobox state
  const [vendorQuery, setVendorQuery] = useState('');
  const [vendorDropOpen, setVendorDropOpen] = useState(false);
  const [vendorHighlight, setVendorHighlight] = useState(-1);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const highlightedVendorRef = useRef(null);

  // Product combobox state
  const [productQuery, setProductQuery] = useState('');
  const [productDropOpen, setProductDropOpen] = useState(false);
  const [productHighlight, setProductHighlight] = useState(-1);
  const highlightedProductRef = useRef(null);

  useEffect(() => {
    if (runType !== 'outsourced') return;
    if (vendors.length > 0) return;
    setVendorsLoading(true);
    garageFetch('getVendors', {}, session)
      .then(data => setVendors(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setVendorsLoading(false));
  }, [runType, session, vendors.length]);

  useEffect(() => {
    if (highlightedVendorRef.current) {
      highlightedVendorRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [vendorHighlight]);

  useEffect(() => {
    if (highlightedProductRef.current) {
      highlightedProductRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [productHighlight]);

  // isFbuFormat drives the Issue-As dropdown visibility AND the default issue_mode
  // on each variant row. Anchored on product_master.receive_format — not has_remote,
  // since drones like Wisp are FBU without a remote.
  const isFbuFormat = useMemo(() => RECEIVE_FORMAT[product] === 'FBU', [product, RECEIVE_FORMAT]);
  const productVariants = product ? PRODUCT_VARIANTS[product] || [] : [];

  // Sync each row's issueMode to the product's receive_format when the product changes.
  // Preserves any per-row override the user already made.
  useEffect(() => {
    if (!product) return;
    const targetMode = isFbuFormat ? 'fbu' : 'components';
    setVariantRows((prev) => prev.map((r) => (
      r.issueMode === targetMode ? r : { ...r, issueMode: targetMode }
    )));
  }, [product, isFbuFormat]);

  const filteredVendors = useMemo(
    () => vendors.filter(v =>
      (v.vendor_name || '').toLowerCase().includes(vendorQuery.toLowerCase()) ||
      (v.vendor_code || '').toLowerCase().includes(vendorQuery.toLowerCase())
    ),
    [vendors, vendorQuery],
  );

  const filteredProducts = useMemo(
    () => PRODUCTS.filter(p => p.toLowerCase().includes(productQuery.toLowerCase())),
    [PRODUCTS, productQuery],
  );

  function setProductAndReset(next) {
    setProduct(next);
    setVariantRows([blankRow()]);
    setErrors((e) => ({ ...e, product: undefined, rows: undefined }));
  }

  function selectVendorOption(v) {
    setSelectedVendor(v);
    setVendorId(v.id);
    setVendorQuery(v.vendor_name || '');
    setVendorDropOpen(false);
    setVendorHighlight(-1);
    setErrors((er) => ({ ...er, vendor: undefined }));
  }

  function selectProductOption(p) {
    setProductAndReset(p);
    setProductQuery(p);
    setProductDropOpen(false);
    setProductHighlight(-1);
  }

  function updateRow(id, patch) {
    setVariantRows((prev) =>
      prev.map((r) => (r.id !== id ? r : { ...r, ...patch })),
    );
  }

  function removeRow(id) {
    setVariantRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.id !== id)));
  }

  function addRow() {
    setVariantRows((prev) => [...prev, blankRow()]);
  }

  function buildVariantsPayload() {
    return variantRows
      .map((r) => {
        const e   = parseInt(r.qtyEcomm)  || 0;
        const ret = parseInt(r.qtyRetail) || 0;
        const total = e + ret;
        if (total <= 0) return null;
        return {
          variant:    r.variant || '',
          colour:     r.colour  || '',
          qty:        total,
          qty_ecomm:  e,
          qty_retail: ret,
          issue_mode: r.issueMode || 'components',
        };
      })
      .filter(Boolean);
  }

  function validate() {
    const next = {};
    if (!product) next.product = 'Select a product';
    if (!runDate) next.runDate = 'Run date is required';
    if (runType === 'outsourced' && !vendorId) next.vendor = 'Vendor is required for outsourced runs';
    const variants = buildVariantsPayload();
    if (!variants.length) next.rows = 'At least one variant must have a non-zero qty';
    // BUG-010: enforce colour selection when the product/variant has colour options.
    for (const r of variantRows) {
      const totalQ = (parseInt(r.qtyEcomm) || 0) + (parseInt(r.qtyRetail) || 0);
      if (totalQ <= 0) continue;
      const opts = (product && r.variant && PRODUCT_COLORS?.[product]?.[r.variant]) || [];
      if (opts.length > 0 && !r.colour) {
        showToast(`Select a colour for ${r.variant} (${product})`, 'error');
        next.rows = 'Pick a colour for each variant';
        break;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function postCreate(payload) {
    // Direct fetch so we can handle 409 with `warning: true` body without a thrown exception.
    const url = `${process.env.NEXT_PUBLIC_WORKER_URL}/?action=createProductionRun`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ action: 'createProductionRun', data: payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.warning === true) {
      return { warning: true, message: data.message };
    }
    if (!res.ok) {
      throw new Error(data.error || `Worker ${res.status}`);
    }
    return data; // { ok, data: { run_no, ... } }
  }

  async function submit(force = false, basePayload = null) {
    setSubmitting(true);
    try {
      const variants = buildVariantsPayload();
      const payload = basePayload || {
        product,
        run_date: runDate,
        line_no: runType === 'outsourced' && !line ? null : line,
        shift,
        notes: notes.trim() || null,
        variants,
        run_type: runType,
        vendor_id: runType === 'outsourced' ? (Number(vendorId) || null) : null,
      };
      const finalPayload = force ? { ...payload, force: true } : payload;

      const res = await postCreate(finalPayload);

      if (res.warning) {
        setWarningMessage(res.message || 'An open run already exists. Create another anyway?');
        setPendingPayload(payload);
        setWarningOpen(true);
        setSubmitting(false);
        return;
      }

      const runNo = res?.data?.run_no;
      if (!runNo) throw new Error('Worker returned no run_no');

      // Immediately submit to store
      await workerFetch('submitProductionRun', { data: { run_no: runNo } }, session);

      showToast(`Run ${runNo} created and submitted to store`, 'success');
      setProduct('');
      setProductQuery('');
      setProductDropOpen(false);
      setProductHighlight(-1);
      setRunDate(tomorrowISO());
      setLine('L1');
      setShift('Morning');
      setNotes('');
      setVariantRows([blankRow()]);
      setErrors({});
      setWarningOpen(false);
      setPendingPayload(null);
      setRunType('in-house');
      setVendorId('');
      setSelectedVendor(null);
      setVendorQuery('');
      setVendorDropOpen(false);
      setVendorHighlight(-1);
      onSuccess();
    } catch (e) {
      showToast(e.message || 'Failed to create run', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    if (!validate()) return;
    submit(false);
  }

  function handleConfirmForce() {
    if (pendingPayload) submit(true, pendingPayload);
  }

  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>New Run — Fresh</span>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <span style={lbl}>Run Type</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {['in-house', 'outsourced'].map((type) => {
              const active = runType === type;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setRunType(type);
                    if (type === 'in-house') {
                      setVendorId('');
                      setSelectedVendor(null);
                      setVendorQuery('');
                      setVendorDropOpen(false);
                      setVendorHighlight(-1);
                    }
                    setErrors((e) => ({ ...e, vendor: undefined }));
                  }}
                  disabled={submitting}
                  style={{
                    background: active ? 'var(--yellow)' : 'var(--surface2)',
                    color: active ? '#000' : 'var(--t3)',
                    border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
                    borderRadius: 4, padding: '5px 14px',
                    fontFamily: 'var(--mono)', fontSize: 11,
                    textTransform: 'uppercase', letterSpacing: 1,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {type === 'in-house' ? 'In-House' : 'Outsourced'}
                </button>
              );
            })}
          </div>
        </div>

        {runType === 'outsourced' && (
          <div style={{ marginBottom: 10 }}>
            <span style={lbl}>Vendor *</span>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                placeholder={vendorsLoading ? 'Loading vendors…' : 'Search vendors…'}
                value={vendorQuery}
                autoComplete="off"
                disabled={submitting || vendorsLoading}
                onChange={(e) => {
                  setVendorQuery(e.target.value);
                  setVendorDropOpen(true);
                  setVendorHighlight(-1);
                  if (selectedVendor) {
                    setSelectedVendor(null);
                    setVendorId('');
                  }
                  setErrors((er) => ({ ...er, vendor: undefined }));
                }}
                onFocus={() => setVendorDropOpen(true)}
                onBlur={() => setTimeout(() => { setVendorDropOpen(false); setVendorHighlight(-1); }, 150)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setVendorDropOpen(true);
                    setVendorHighlight((i) => Math.min((i < 0 ? -1 : i) + 1, filteredVendors.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setVendorHighlight((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    if (vendorDropOpen && vendorHighlight >= 0 && filteredVendors[vendorHighlight]) {
                      e.preventDefault();
                      selectVendorOption(filteredVendors[vendorHighlight]);
                    }
                  } else if (e.key === 'Escape') {
                    setVendorDropOpen(false);
                    setVendorHighlight(-1);
                  }
                }}
                style={{ ...inp, borderRadius: vendorDropOpen ? '4px 4px 0 0' : 4 }}
              />
              {vendorDropOpen && vendors.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                  background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none',
                  borderRadius: '0 0 4px 4px', maxHeight: 220, overflowY: 'auto',
                }}>
                  {filteredVendors.length === 0 ? (
                    <div style={{ padding: '8px 10px', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      No vendors found
                    </div>
                  ) : filteredVendors.map((v, idx) => {
                    const highlighted = idx === vendorHighlight;
                    return (
                      <div
                        key={v.id}
                        ref={highlighted ? highlightedVendorRef : null}
                        onMouseDown={() => selectVendorOption(v)}
                        onMouseEnter={() => setVendorHighlight(idx)}
                        style={{
                          padding: '8px 10px', cursor: 'pointer', fontSize: 12,
                          fontFamily: 'var(--mono)', color: 'var(--t1)',
                          background: highlighted ? 'var(--surface)' : 'transparent',
                          borderBottom: '1px solid var(--border)',
                          display: 'flex', alignItems: 'baseline', gap: 8,
                        }}
                      >
                        <span>{v.vendor_name}</span>
                        <span style={{ color: 'var(--t3)', fontSize: 11 }}>{v.vendor_code}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {errors.vendor && <div style={fieldErr}>{errors.vendor}</div>}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={lbl}>Product *</span>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                placeholder={loading ? 'Loading products…' : 'Search products…'}
                value={productQuery}
                autoComplete="off"
                disabled={submitting || loading}
                onChange={(e) => {
                  setProductQuery(e.target.value);
                  setProductDropOpen(true);
                  setProductHighlight(-1);
                  if (product) {
                    setProductAndReset('');
                  }
                }}
                onFocus={() => setProductDropOpen(true)}
                onBlur={() => setTimeout(() => { setProductDropOpen(false); setProductHighlight(-1); }, 150)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setProductDropOpen(true);
                    setProductHighlight((i) => Math.min((i < 0 ? -1 : i) + 1, filteredProducts.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setProductHighlight((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    if (productDropOpen && productHighlight >= 0 && filteredProducts[productHighlight]) {
                      e.preventDefault();
                      selectProductOption(filteredProducts[productHighlight]);
                    }
                  } else if (e.key === 'Escape') {
                    setProductDropOpen(false);
                    setProductHighlight(-1);
                  }
                }}
                style={{ ...inp, borderRadius: productDropOpen ? '4px 4px 0 0' : 4 }}
              />
              {productDropOpen && PRODUCTS.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                  background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none',
                  borderRadius: '0 0 4px 4px', maxHeight: 220, overflowY: 'auto',
                }}>
                  {filteredProducts.length === 0 ? (
                    <div style={{ padding: '8px 10px', color: 'var(--t3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      No products found
                    </div>
                  ) : filteredProducts.map((p, idx) => {
                    const highlighted = idx === productHighlight;
                    return (
                      <div
                        key={p}
                        ref={highlighted ? highlightedProductRef : null}
                        onMouseDown={() => selectProductOption(p)}
                        onMouseEnter={() => setProductHighlight(idx)}
                        style={{
                          padding: '8px 10px', cursor: 'pointer', fontSize: 12,
                          fontFamily: 'var(--mono)', color: 'var(--t1)',
                          background: highlighted ? 'var(--surface)' : 'transparent',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {p}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {errors.product && <div style={fieldErr}>{errors.product}</div>}
          </div>
          <div>
            <span style={lbl}>Run Date *</span>
            <input
              style={inp}
              type="date"
              value={runDate}
              onChange={(e) => setRunDate(e.target.value)}
              disabled={submitting}
            />
            {errors.runDate && <div style={fieldErr}>{errors.runDate}</div>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={lbl}>Line{runType === 'outsourced' ? '' : ' *'}</span>
            <select style={sel} value={line} onChange={(e) => setLine(e.target.value)} disabled={submitting}>
              {runType === 'outsourced' && <option value="">— None (no floor line) —</option>}
              <option value="L1">L1</option>
              <option value="L2">L2</option>
              <option value="L3">L3</option>
            </select>
          </div>
          <div>
            <span style={lbl}>Shift</span>
            <select style={sel} value={shift} onChange={(e) => setShift(e.target.value)} disabled={submitting}>
              <option value="Morning">Morning</option>
              <option value="Afternoon">Afternoon</option>
              <option value="Night">Night</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <span style={lbl}>Notes</span>
          <input style={inp} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} placeholder="Optional" />
        </div>

        <div style={{ marginTop: 14, marginBottom: 6 }}>
          <span style={lbl}>Variants & Quantities</span>
        </div>
        {variantRows.map((row) => {
          const total = (parseInt(row.qtyEcomm) || 0) + (parseInt(row.qtyRetail) || 0);
          // Colour sub-picker options for the picked variant (BUG-010 fix).
          const colorOptions = (product && row.variant && PRODUCT_COLORS?.[product]?.[row.variant]) || [];
          return (
            <div
              key={row.id}
              style={{
                display: 'grid',
                gridTemplateColumns: isFbuFormat
                  ? '1fr 1fr 0.8fr 0.8fr 60px 1fr 28px'
                  : '1fr 1fr 0.8fr 0.8fr 60px 28px',
                gap: 6, alignItems: 'end', marginBottom: 8,
              }}
            >
              <div>
                <span style={lbl}>Variant</span>
                <select
                  style={sel}
                  value={row.variant}
                  onChange={(e) => updateRow(row.id, { variant: e.target.value, colour: '' })}
                  disabled={submitting || productVariants.length === 0}
                >
                  {productVariants.length === 0 ? (
                    <option value="">Common</option>
                  ) : (
                    <>
                      <option value="">— Select —</option>
                      {productVariants.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </>
                  )}
                </select>
              </div>
              <div>
                <span style={lbl}>Colour</span>
                <select
                  style={sel}
                  value={row.colour}
                  onChange={(e) => updateRow(row.id, { colour: e.target.value })}
                  disabled={submitting || colorOptions.length === 0}
                >
                  <option value="">{colorOptions.length === 0 ? '—' : '— Select —'}</option>
                  {colorOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <span style={lbl}>E-Comm</span>
                <input
                  style={inp}
                  type="number"
                  min="0"
                  value={row.qtyEcomm}
                  onChange={(e) => updateRow(row.id, { qtyEcomm: e.target.value })}
                  disabled={submitting}
                />
              </div>
              <div>
                <span style={lbl}>Retail</span>
                <input
                  style={inp}
                  type="number"
                  min="0"
                  value={row.qtyRetail}
                  onChange={(e) => updateRow(row.id, { qtyRetail: e.target.value })}
                  disabled={submitting}
                />
              </div>
              <div>
                <span style={lbl}>Total</span>
                <div
                  style={{
                    fontFamily: 'var(--mono)', color: 'var(--yellow)', fontSize: 13,
                    padding: '6px 4px', textAlign: 'right',
                  }}
                >
                  {total}
                </div>
              </div>
              {isFbuFormat && (
                <div>
                  <span style={lbl}>Issue As</span>
                  <select
                    style={sel}
                    value={row.issueMode}
                    onChange={(e) => updateRow(row.id, { issueMode: e.target.value })}
                    disabled={submitting}
                  >
                    <option value="components">Components</option>
                    <option value="fbu">FBU Unit</option>
                  </select>
                </div>
              )}
              <button
                style={tinyBtn}
                onClick={() => removeRow(row.id)}
                disabled={submitting || variantRows.length === 1}
                title="Remove row"
              >
                ×
              </button>
            </div>
          );
        })}
        {errors.rows && <div style={fieldErr}>{errors.rows}</div>}

        <div style={{ marginTop: 6, marginBottom: 14 }}>
          <button style={btnSec} onClick={addRow} disabled={submitting}>+ Add Variant</button>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPri} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'CREATING…' : 'Create Run'}
          </button>
        </div>

        <div
          style={{
            marginTop: 16, padding: '8px 12px', fontSize: 11,
            background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.25)',
            color: '#7b93ff', borderRadius: 4,
          }}
        >
          ℹ {runType === 'in-house'
              ? 'Run is created and immediately submitted to store. Store will see it in their issue queue.'
              : 'Outsourced run is created and submitted. Store will issue materials and prepare them for vendor dispatch.'}
        </div>
      </div>

      <ConfirmModal
        open={warningOpen}
        onClose={() => !submitting && setWarningOpen(false)}
        title="Open Run Exists"
        message={warningMessage}
        confirmLabel={submitting ? 'CREATING…' : 'Create Anyway'}
        confirmColor="red"
        onConfirm={handleConfirmForce}
        loading={submitting}
      />
    </div>
  );
}
