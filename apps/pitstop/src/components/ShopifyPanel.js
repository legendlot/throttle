'use client';
import { useState, useEffect, useCallback } from 'react';
import { csopsGet } from '../lib/csopsFetch.js';
import { Search, ExternalLink } from 'lucide-react';

const money = (amt, cur) => amt == null ? '' : `${cur || '₹'}${Number(amt).toLocaleString('en-IN')}`;
const fmtDate = d => { try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d; } };

export function ShopifyPanel({ session, phone, email, onPick, autoLoad }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = useCallback(async () => {
    setLoading(true);
    try { setState(await csopsGet('searchShopifyCustomer', { phone: phone || '', email: email || '' }, session)); }
    catch (e) { setState({ error: e.message }); }
    finally { setLoading(false); }
  }, [session, phone, email]);

  // On the ticket Detail page (autoLoad), fetch the customer + orders on open
  // so the agent sees order history without a manual click. New Ticket stays manual.
  useEffect(() => {
    if (autoLoad && session && (phone || email)) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, session, phone, email]);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
      <button type="button" onClick={run} disabled={loading} style={{ display:'inline-flex', alignItems:'center', gap:6, background:'transparent', color:'var(--t2)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'6px 12px', fontFamily:'var(--font-mono)', fontSize:12, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
        <Search size={13} strokeWidth={1.75} /> {loading ? 'Searching…' : 'Search Shopify'}
      </button>
      {state && state.configured === false && <div style={{ color:'var(--t3)', fontSize:12, marginTop:8 }}>Shopify not configured yet.</div>}
      {state && state.error && <div style={{ color:'var(--state-error-fg)', fontSize:12, marginTop:8 }}>{state.error}</div>}
      {state && state.configured && !state.found && !state.error && <div style={{ color:'var(--t3)', fontSize:12, marginTop:8 }}>No customer found — enter details manually.</div>}
      {state?.found && (
        <div style={{ marginTop:10, fontFamily:'var(--font-mono)', fontSize:12 }}>
          {/* Customer header */}
          <div style={{ color:'var(--t1)', fontWeight:700, fontSize:13 }}>{state.customer.name}</div>
          <div style={{ color:'var(--t3)', marginTop:2 }}>
            {[state.customer.email, state.customer.phone].filter(Boolean).join(' · ')}
          </div>
          <div style={{ color:'var(--t3)', marginTop:2 }}>
            {state.customer.orders_count} orders · {money(state.customer.total_spent, state.customer.currency)} lifetime
            {state.customer.location ? ` · ${state.customer.location}` : ''}
            {state.customer.since ? ` · since ${fmtDate(state.customer.since)}` : ''}
          </div>

          {/* Per-order detail */}
          <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:8 }}>
            {state.recent_orders.map(o => (
              <div key={o.order_no} style={{ border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'8px 10px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:8, flexWrap:'wrap' }}>
                  <span style={{ color:'var(--t1)', fontWeight:600 }}>{o.order_no}</span>
                  <span style={{ color:'var(--t3)' }}>{fmtDate(o.created_at)}</span>
                  <span style={{ marginLeft:'auto', color:'var(--t1)', fontWeight:600 }}>{money(o.total, o.currency)}</span>
                </div>
                <div style={{ color:'var(--t3)', marginTop:3 }}>
                  {o.financial} · {o.fulfillment}{o.ship_to ? ` · ${o.ship_to}` : ''}
                </div>
                {/* Line items */}
                {(o.line_items || []).length > 0 && (
                  <div style={{ marginTop:6 }}>
                    {o.line_items.map((li, i) => (
                      <div key={i} style={{ color:'var(--t2)', display:'flex', justifyContent:'space-between', gap:8 }}>
                        <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>
                          <span style={{ color:'var(--t3)' }}>{li.quantity} ×</span> {li.title}
                          {li.variant && li.variant !== 'Default Title' ? ` — ${li.variant}` : ''}
                          {li.sku ? <span style={{ color:'var(--t3)' }}>{`  (${li.sku})`}</span> : ''}
                        </span>
                        {li.amount != null && <span style={{ color:'var(--t3)', whiteSpace:'nowrap' }}>{money(li.amount, o.currency)}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {/* Tracking / AWB */}
                {(o.tracking || []).length > 0 && (
                  <div style={{ marginTop:6 }}>
                    {o.tracking.map((t, i) => (
                      <div key={i} style={{ color:'var(--t2)' }}>
                        {t.company ? `${t.company}: ` : 'AWB: '}{t.number || '—'}
                        {t.url && <a href={t.url} target="_blank" rel="noreferrer" style={{ color:'var(--brand-red)', marginLeft:6, display:'inline-flex', alignItems:'center', gap:3 }}>track <ExternalLink size={11} /></a>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {onPick && <button onClick={() => onPick(state)} style={{ marginTop:10, background:'var(--brand-red)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'6px 12px', fontFamily:'var(--font-cond)', fontSize:12, cursor:'pointer' }}>Use this customer</button>}
        </div>
      )}
    </div>
  );
}
