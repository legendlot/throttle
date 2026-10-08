'use client';
import { useState } from 'react';
import { useToast } from '@throttle/ui';
import { ignitionopsPost } from '../../../../../lib/ignitionopsFetch.js';
import ProductLinesEditor, { linesToPayload, linesAreValid } from '../../../../../components/ProductLinesEditor.js';
import { titleish } from '../../../../../lib/productLabel.js';
import { LockedNote, KV } from './shared.js';

// Multi-product lines (#4) with inline edit → setEngagementProducts (replace-set,
// rolls cost up on the worker). Legacy single-product deals show a synthesized line.
export function ProductsCard({ products, directedTo, engagementId, canEdit, locked, session, onSaved }) {
  const { showToast: toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [productsValid, setProductsValid] = useState(true);

  function startEdit() {
    setLines((products || []).map(p => ({
      product_code: p.product_code || '',
      // Carry the real reference + COGS snapshot through the editor — omitting them
      // here meant every edit-save silently wiped product_ref/cogs_inr on rows that
      // had them (linesToPayload nulls what the line object lacks).
      product_ref: p.product_ref || null,
      cogs_inr: p.cogs_inr ?? null,
      product_variant: p.product_variant || '',
      quantity: p.quantity ?? 1,
      goodies_cost: p.goodies_cost ?? '',
      shipping_cost: p.shipping_cost ?? '',
    })));
    setEditing(true);
  }
  async function save() {
    // Unresolved product line — refuse, don't just grey the button (2026-09-04).
    if (!productsValid || !linesAreValid(lines)) { toast('Pick a product from the list for every line', 'error'); return; }
    setBusy(true);
    try {
      await ignitionopsPost('setEngagementProducts', { engagement_id: engagementId, products: linesToPayload(lines) }, session);
      toast('Products updated', 'success');
      setEditing(false);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Products</h2>
        {canEdit && !locked && !editing && (
          <button onClick={startEdit} style={{ padding: '4px 10px', background: 'var(--surface-3)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
        )}
      </div>
      {locked && <LockedNote />}
      {editing && !locked ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProductLinesEditor value={lines} onChange={setLines} session={session} onValidityChange={setProductsValid} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={busy || !productsValid} style={{ padding: '6px 12px', background: '#FF6B00', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, cursor: (busy || !productsValid) ? 'not-allowed' : 'pointer', opacity: (busy || !productsValid) ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <>
          {(products || []).length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No products.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {products.map((p, i) => (
                <div key={p.id || i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                  {/* Cased through titleish (Reann, 2026-08-27) so CREST / Crest / crest all read
                      the same on screen. The stored strings are free text and inconsistent —
                      display normalisation is what makes the card legible today. */}
                  <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{titleish(p.product_code) || '—'}</span>
                  {p.product_variant && <span style={{ color: 'var(--text-2)' }}>{titleish(p.product_variant)}</span>}
                  {Number(p.quantity) > 1 && <span style={{ color: 'var(--text-3)' }}>×{p.quantity}</span>}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-3)', display: 'flex', gap: 10 }}>
                    {p.goodies_cost != null && <span title="Goodies">🎁 ₹{Number(p.goodies_cost).toLocaleString()}</span>}
                    {p.shipping_cost != null && <span title="Shipping">🚚 ₹{Number(p.shipping_cost).toLocaleString()}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <KV label="Directed to" value={directedTo || '—'} />
          </div>
        </>
      )}
    </section>
  );
}
