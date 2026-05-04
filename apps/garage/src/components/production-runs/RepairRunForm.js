'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { workerFetch } from '@throttle/db';
import {
  PRODUCTS,
  PRODUCT_VARIANTS,
  PRODUCT_SUBVARIANTS,
} from '../../hooks/useProducts.js';

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

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildRowsForProduct(product) {
  const variants = PRODUCT_VARIANTS[product] || [];
  if (variants.length === 0) {
    return [{ model: null, color: null, label: product, carQty: 0, remoteQty: 0 }];
  }
  const subMap = PRODUCT_SUBVARIANTS[product] || {};
  const rows = [];
  for (const v of variants) {
    const subs = subMap[v] || [];
    if (subs.length === 0) {
      rows.push({ model: v, color: null, label: v, carQty: 0, remoteQty: 0 });
    } else {
      for (const c of subs) {
        rows.push({ model: v, color: c, label: `${v} · ${c}`, carQty: 0, remoteQty: 0 });
      }
    }
  }
  return rows;
}

export function RepairRunForm({ onSuccess, session }) {
  const { showToast } = useToast();
  const [runDate, setRunDate] = useState(tomorrowISO());
  const [line, setLine] = useState('L1');
  const [shift, setShift] = useState('Morning');
  const [notes, setNotes] = useState('');
  const [productBlocks, setProductBlocks] = useState([]);
  const [productToAdd, setProductToAdd] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function addProductBlock() {
    if (!productToAdd) return;
    if (productBlocks.some((b) => b.product === productToAdd)) {
      showToast(`${productToAdd} already added`, 'error');
      return;
    }
    setProductBlocks((prev) => [
      ...prev,
      { product: productToAdd, rows: buildRowsForProduct(productToAdd) },
    ]);
    setProductToAdd('');
  }

  function removeBlock(product) {
    setProductBlocks((prev) => prev.filter((b) => b.product !== product));
  }

  function updateRowQty(product, idx, field, value) {
    const num = parseInt(value);
    const safe = isNaN(num) ? 0 : num;
    setProductBlocks((prev) =>
      prev.map((b) => {
        if (b.product !== product) return b;
        const rows = b.rows.map((r, i) => {
          if (i !== idx) return r;
          const next = { ...r, [field]: safe };
          // Mirror legacy syncRepairRemote: if changing CAR and REMOTE is still 0, mirror value
          if (field === 'carQty' && (r.remoteQty === 0 || r.remoteQty === '' || r.remoteQty == null)) {
            next.remoteQty = safe;
          }
          return next;
        });
        return { ...b, rows };
      }),
    );
  }

  function buildLines() {
    const lines = [];
    for (const block of productBlocks) {
      for (const row of block.rows) {
        const car = parseInt(row.carQty) || 0;
        const remote = parseInt(row.remoteQty) || 0;
        if (car <= 0 && remote <= 0) continue;
        lines.push({
          product: block.product,
          model: row.model || null,
          color: row.color || null,
          target_car_qty: car,
          target_remote_qty: remote,
        });
      }
    }
    return lines;
  }

  async function handleSubmit() {
    const lines = buildLines();
    if (!lines.length) {
      showToast('Add at least one row with a non-zero quantity', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await workerFetch(
        'createRepairRun',
        { data: { line, run_date: runDate, notes: notes.trim() || null, lines } },
        session,
      );
      const runNo = res?.data?.run_no || '?';
      showToast(`Repair run ${runNo} created`, 'success');
      setProductBlocks([]);
      setNotes('');
      onSuccess();
    } catch (e) {
      showToast(e.message || 'Failed to create repair run', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  const availableProducts = PRODUCTS.filter(
    (p) => !productBlocks.some((b) => b.product === p),
  );

  return (
    <div style={panel}>
      <div style={panelHdr}>
        <span>New Run — Repair</span>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <span style={lbl}>Run Date *</span>
            <input style={inp} type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} disabled={submitting} />
          </div>
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

        <div style={{ marginBottom: 14 }}>
          <span style={lbl}>Notes</span>
          <input style={inp} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} placeholder="Optional" />
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <span style={lbl}>Add Product</span>
            <select style={sel} value={productToAdd} onChange={(e) => setProductToAdd(e.target.value)} disabled={submitting}>
              <option value="">Select product…</option>
              {availableProducts.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <button style={btnSec} onClick={addProductBlock} disabled={submitting || !productToAdd}>+ Add</button>
        </div>

        {productBlocks.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '8px 0' }}>
            Add a product to get started.
          </div>
        ) : (
          productBlocks.map((block) => (
            <div
              key={block.product}
              style={{
                marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 4,
                background: 'var(--surface2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--yellow)' }}>
                  {block.product.toUpperCase()}
                </span>
                <button
                  style={{ background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}
                  onClick={() => removeBlock(block.product)}
                  disabled={submitting}
                  title="Remove product block"
                >
                  ×
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 90px 90px 30px',
                  gap: 6, marginBottom: 4, alignItems: 'center',
                }}
              >
                <span style={lbl}>Variant / Colour</span>
                <span style={{ ...lbl, textAlign: 'right' }}>Cars</span>
                <span style={{ ...lbl, textAlign: 'right' }}>Remotes</span>
                <span style={{ ...lbl, textAlign: 'center' }}>U</span>
              </div>
              {block.rows.map((row, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 90px 90px 30px',
                    gap: 6, alignItems: 'center', padding: '4px 0',
                  }}
                >
                  <div style={{ fontSize: 12 }}>{row.label}</div>
                  <input
                    style={{ ...inp, textAlign: 'right' }}
                    type="number"
                    min="0"
                    value={row.carQty || ''}
                    onChange={(e) => updateRowQty(block.product, idx, 'carQty', e.target.value)}
                    disabled={submitting}
                  />
                  <input
                    style={{ ...inp, textAlign: 'right' }}
                    type="number"
                    min="0"
                    value={row.remoteQty || ''}
                    onChange={(e) => updateRowQty(block.product, idx, 'remoteQty', e.target.value)}
                    disabled={submitting}
                  />
                  <span style={{ fontSize: 10, color: 'var(--t3)', textAlign: 'center' }}>units</span>
                </div>
              ))}
            </div>
          ))
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btnPri} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'CREATING…' : 'Create Repair Run'}
          </button>
        </div>

        <div
          style={{
            marginTop: 16, padding: '8px 12px', fontSize: 11,
            background: 'rgba(33,60,226,.08)', border: '1px solid rgba(33,60,226,.25)',
            color: '#7b93ff', borderRadius: 4,
          }}
        >
          ℹ Repair run created as Planned. No parts issue — operators scan units at the Repair station.
        </div>
      </div>
    </div>
  );
}
