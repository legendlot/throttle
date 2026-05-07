'use client';
import { useState, useMemo } from 'react';
import { ConfirmModal, useToast } from '@throttle/ui';
import { workerFetch } from '@throttle/db';
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
const fieldErr = { fontSize: 11, color: 'var(--red)', marginTop: 2 };
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
    qtyEcomm: '',
    qtyRetail: '',
    issueMode: 'components',
  };
}

export function FreshRunForm({ onSuccess, session }) {
  const { showToast } = useToast();
  const { PRODUCTS, PRODUCT_VARIANTS, HAS_REMOTE, loading } = useProducts();
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

  const isFbuFormat = useMemo(() => HAS_REMOTE.has(product), [product]);
  const productVariants = product ? PRODUCT_VARIANTS[product] || [] : [];

  function setProductAndReset(next) {
    setProduct(next);
    setVariantRows([blankRow()]);
    setErrors((e) => ({ ...e, product: undefined, rows: undefined }));
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
          colour:     '',
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
    const variants = buildVariantsPayload();
    if (!variants.length) next.rows = 'At least one variant must have a non-zero qty';
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
        line_no: line,
        shift,
        notes: notes.trim() || null,
        variants,
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
      setRunDate(tomorrowISO());
      setLine('L1');
      setShift('Morning');
      setNotes('');
      setVariantRows([blankRow()]);
      setErrors({});
      setWarningOpen(false);
      setPendingPayload(null);
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={lbl}>Product *</span>
            <select
              style={sel}
              value={product}
              onChange={(e) => setProductAndReset(e.target.value)}
              disabled={submitting || loading}
            >
              <option value="">{loading ? 'Loading products…' : 'Select product…'}</option>
              {PRODUCTS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
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
            <span style={lbl}>Line</span>
            <select style={sel} value={line} onChange={(e) => setLine(e.target.value)} disabled={submitting}>
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
          return (
            <div
              key={row.id}
              style={{
                display: 'grid',
                gridTemplateColumns: isFbuFormat
                  ? '1fr 0.8fr 0.8fr 60px 1fr 28px'
                  : '1fr 0.8fr 0.8fr 60px 28px',
                gap: 6, alignItems: 'end', marginBottom: 8,
              }}
            >
              <div>
                <span style={lbl}>Variant</span>
                <select
                  style={sel}
                  value={row.variant}
                  onChange={(e) => updateRow(row.id, { variant: e.target.value })}
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
          ℹ Run is created and immediately submitted to store. Store will see it in their issue queue.
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
