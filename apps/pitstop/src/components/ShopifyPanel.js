'use client';
import { useState } from 'react';
import { csopsGet } from '../lib/csopsFetch.js';
import { Search } from 'lucide-react';

export function ShopifyPanel({ session, phone, email, onPick }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  async function run() {
    setLoading(true);
    try { setState(await csopsGet('searchShopifyCustomer', { phone: phone || '', email: email || '' }, session)); }
    catch (e) { setState({ error: e.message }); }
    finally { setLoading(false); }
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
      <button onClick={run} disabled={loading} style={{ display:'inline-flex', alignItems:'center', gap:6, background:'transparent', color:'var(--t2)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'6px 12px', fontFamily:'var(--font-mono)', fontSize:12, cursor:'pointer' }}>
        <Search size={13} strokeWidth={1.75} /> {loading ? 'Searching…' : 'Search Shopify'}
      </button>
      {state && state.configured === false && <div style={{ color:'var(--t3)', fontSize:12, marginTop:8 }}>Shopify not configured yet.</div>}
      {state && state.error && <div style={{ color:'var(--state-error-fg)', fontSize:12, marginTop:8 }}>{state.error}</div>}
      {state && state.configured && !state.found && !state.error && <div style={{ color:'var(--t3)', fontSize:12, marginTop:8 }}>No customer found — enter details manually.</div>}
      {state?.found && (
        <div style={{ marginTop:8, fontFamily:'var(--font-mono)', fontSize:12 }}>
          <div style={{ color:'var(--t1)', fontWeight:600 }}>{state.customer.name}</div>
          <div style={{ color:'var(--t3)' }}>{state.customer.email} · {state.customer.orders_count} orders · {state.customer.total_spent} {state.customer.currency}</div>
          {state.recent_orders.map(o => (
            <div key={o.order_no} style={{ color:'var(--t2)', marginTop:4 }}>{o.order_no} · {o.financial}/{o.fulfillment} · {o.total} {o.currency}</div>
          ))}
          {onPick && <button onClick={() => onPick(state)} style={{ marginTop:8, background:'var(--brand-red)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'6px 12px', fontFamily:'var(--font-cond)', fontSize:12, cursor:'pointer' }}>Use this customer</button>}
        </div>
      )}
    </div>
  );
}
