'use client';
import { useEffect, useState } from 'react';
import { ignitionopsGet } from '../lib/ignitionopsFetch.js';

// Multi-row product picker (#4). Each row = product (dropdown from getCatalogs,
// with free-text fallback) → variant (free text) + quantity + goodies cost.
// Catalog only carries product names/skus (no variant taxonomy), so variant
// stays free text — mirrors the legacy single-product fields.
//
// `value` is an array of line objects; `onChange(nextLines)` reports edits up.
// Each line: { product_code, product_variant, quantity, goodies_cost, shipping_cost }.

export function emptyLine() {
  return { product_code: '', product_variant: '', quantity: 1, goodies_cost: '', shipping_cost: '' };
}

export default function ProductLinesEditor({ value, onChange, session }) {
  const lines = value && value.length ? value : [emptyLine()];
  const [catalog, setCatalog] = useState([]);

  useEffect(() => {
    if (!session) return;
    ignitionopsGet('getCatalogs', {}, session)
      .then(r => setCatalog(r.products || []))
      .catch(() => setCatalog([]));
  }, [session]);

  function setRow(i, patch) {
    const next = lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    onChange(next);
  }
  function addRow() { onChange([...lines, emptyLine()]); }
  function removeRow(i) {
    const next = lines.filter((_, idx) => idx !== i);
    onChange(next.length ? next : [emptyLine()]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.2fr 70px 1fr auto', gap: 8, alignItems: 'end' }}>
          <div>
            {i === 0 && <div style={lbl}>Product</div>}
            <input
              list="ign-product-list"
              value={l.product_code}
              onChange={e => setRow(i, { product_code: e.target.value })}
              placeholder="e.g. Brutus"
              style={inp}
            />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Variant / colour</div>}
            <input
              value={l.product_variant || ''}
              onChange={e => setRow(i, { product_variant: e.target.value })}
              placeholder="e.g. Burnout Yellow"
              style={inp}
            />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Qty</div>}
            <input type="number" min="1" value={l.quantity}
              onChange={e => setRow(i, { quantity: e.target.value })} style={inp} />
          </div>
          <div>
            {i === 0 && <div style={lbl}>Goodies ₹</div>}
            <input type="number" min="0" value={l.goodies_cost ?? ''}
              onChange={e => setRow(i, { goodies_cost: e.target.value })} placeholder="0" style={inp} />
          </div>
          <button type="button" onClick={() => removeRow(i)} title="Remove" style={removeBtn}>×</button>
        </div>
      ))}
      <datalist id="ign-product-list">
        {catalog.map(p => <option key={p.sku || p.name} value={p.name} />)}
      </datalist>
      <div>
        <button type="button" onClick={addRow} style={addBtn}>+ Add product</button>
      </div>
    </div>
  );
}

// Normalise editor rows into the worker `products[]` payload (drops blank rows,
// coerces numerics). Returns [] when nothing meaningful is filled in.
export function linesToPayload(lines) {
  return (lines || [])
    .filter(l => (l.product_code || '').trim())
    .map((l, idx) => ({
      product_code: l.product_code.trim(),
      product_variant: (l.product_variant || '').trim() || null,
      quantity: Number(l.quantity) || 1,
      goodies_cost: l.goodies_cost === '' || l.goodies_cost == null ? null : Number(l.goodies_cost),
      shipping_cost: l.shipping_cost === '' || l.shipping_cost == null ? null : Number(l.shipping_cost),
      sort_order: idx,
    }));
}

const lbl = { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 };
const removeBtn = { padding: '6px 10px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 16, lineHeight: 1, cursor: 'pointer' };
const addBtn = { padding: '6px 12px', background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' };
