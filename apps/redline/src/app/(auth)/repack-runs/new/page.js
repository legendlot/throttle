'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch, garageFetch } from '@throttle/db';
import { EmptyState, Panel, useToast } from '@throttle/ui';

const input = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', outline: 'none', width: '100%' };
const lbl   = { fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'block' };
const btnP  = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '10px 18px', fontFamily: 'var(--cond)', fontSize: 13, color: '#0a0a0a', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' };
const btnS  = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t2)', cursor: 'pointer' };

export function canManageRepack(perms) {
  return hasPermission(perms, 'repack_run_manage')
      || hasPermission(perms, 'dispatch_restock')
      || hasPermission(perms, 'users_manage');
}

export default function RepackRunNewPage() {
  const router = useRouter();
  const { session, perms } = useAuth();
  const { toast } = useToast();
  const allowed = canManageRepack(perms);

  const [products, setProducts] = useState([]);
  const [f, setF] = useState({
    product: '', variant_model: '', colour: '',
    from_channel: 'retail', to_channel: 'ecom',
    target_qty: '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);

  function setField(k, v) { setF(prev => ({ ...prev, [k]: v })); }

  useEffect(() => {
    if (!session || !allowed) return;
    (async () => {
      try {
        const cat = await garageFetch('getProductCatalogue', {}, session);
        const items = Array.isArray(cat?.products) ? cat.products : (Array.isArray(cat) ? cat : []);
        const names = [...new Set(items.map(p => p.product || p.name || p.product_name).filter(Boolean))].sort();
        setProducts(names);
      } catch { /* datalist is optional — free-text still works */ }
    })();
  }, [session, allowed]);

  async function submit() {
    const product = f.product.trim();
    if (!product) { toast('Product required', 'err'); return; }
    if (f.from_channel === f.to_channel) { toast('From and To channel must differ', 'err'); return; }
    const qty = parseInt(f.target_qty, 10);
    if (!qty || qty < 1) { toast('Target quantity must be a positive number', 'err'); return; }
    setSubmitting(true);
    try {
      const r = await workerFetch('createRepackRun', { data: {
        product,
        variant_model: f.variant_model.trim() || null,
        colour:        f.colour.trim() || null,
        from_channel:  f.from_channel,
        to_channel:    f.to_channel,
        target_qty:    qty,
        notes:         f.notes.trim() || null,
      } }, session);
      if (!r?.ok) { toast(r?.error || 'Failed', 'err'); return; }
      toast(`${r.data.run_no} created`, 'ok');
      router.push(`/repack-runs/detail?id=${r.data.id}`);
    } catch (e) {
      toast(e.message || 'Failed', 'err');
    } finally { setSubmitting(false); }
  }

  if (!allowed) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState icon="🔒" message="Access denied — you need repack_run_manage (or dispatch) permission." />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <Panel header="New Repack Run · Channel Swap">
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t3)', marginBottom: 16, letterSpacing: '0.04em' }}>
          A repack run moves packed units from one packaging channel to the other. The product (and variant, if set) must match the units exactly — the floor scans the OLD box at <strong style={{ color: 'var(--t2)' }}>Repack In</strong>, then each car into a destination box at <strong style={{ color: 'var(--t2)' }}>Repack Out</strong>.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={lbl}>Product <span style={{ color: 'var(--red)' }}>*</span></label>
            <input list="rpk-products" value={f.product} onChange={e => setField('product', e.target.value)} placeholder="e.g. Flare" style={input} autoFocus />
            <datalist id="rpk-products">{products.map(p => <option key={p} value={p} />)}</datalist>
          </div>
          <div>
            <label style={lbl}>Target quantity <span style={{ color: 'var(--red)' }}>*</span></label>
            <input type="number" min="1" value={f.target_qty} onChange={e => setField('target_qty', e.target.value)} placeholder="units to repack" style={input} />
          </div>
          <div>
            <label style={lbl}>Variant / model <span style={{ color: 'var(--t3)' }}>· optional</span></label>
            <input value={f.variant_model} onChange={e => setField('variant_model', e.target.value)} placeholder="leave blank for all variants" style={input} />
          </div>
          <div>
            <label style={lbl}>Colour <span style={{ color: 'var(--t3)' }}>· optional</span></label>
            <input value={f.colour} onChange={e => setField('colour', e.target.value)} placeholder="leave blank for all colours" style={input} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr', gap: 12, alignItems: 'end', marginBottom: 14 }}>
          <div>
            <label style={lbl}>From channel</label>
            <select value={f.from_channel} onChange={e => setField('from_channel', e.target.value)} style={input}>
              <option value="retail">Retail</option>
              <option value="ecom">Ecom</option>
            </select>
          </div>
          <div style={{ textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--yellow)', paddingBottom: 8 }}>→</div>
          <div>
            <label style={lbl}>To channel</label>
            <select value={f.to_channel} onChange={e => setField('to_channel', e.target.value)} style={input}>
              <option value="ecom">Ecom</option>
              <option value="retail">Retail</option>
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Notes <span style={{ color: 'var(--t3)' }}>· optional</span></label>
          <textarea rows={2} value={f.notes} onChange={e => setField('notes', e.target.value)} style={{ ...input, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => router.push('/repack-runs')} style={btnS} disabled={submitting}>Cancel</button>
          <button onClick={submit} style={{ ...btnP, opacity: submitting ? 0.6 : 1 }} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Run'}
          </button>
        </div>
      </Panel>
    </div>
  );
}
