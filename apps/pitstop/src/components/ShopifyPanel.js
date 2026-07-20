'use client';
import { useState, useEffect, useCallback } from 'react';
import { csopsGet, csopsPost } from '../lib/csopsFetch.js';
import { Search, ExternalLink, RefreshCw } from 'lucide-react';

const money = (amt, cur) => amt == null ? '' : `${cur || '₹'}${Number(amt).toLocaleString('en-IN')}`;
const fmtDate = d => { try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return d; } };
const fmtShort = d => { try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch { return d; } };

// Courier lifecycle → dot colour. `rto` is the one an agent must not miss: a parcel heading
// back to us changes the whole conversation, so it reads as an alert, not a status.
const SHIP_TONE = {
  delivered: 'var(--ok, #3FB950)',
  out_for_delivery: 'var(--brand-yellow, #F2CD1A)',
  in_transit: 'var(--t2)',
  manifested: 'var(--t3)',
  pending: 'var(--t3)',
  rto: 'var(--brand-red, #DE2A2A)',
  cancelled: 'var(--t3)',
};

// The one-line answer to "where is my order" — no OTP, no leaving the app.
// ⟳ re-pulls THIS order from Uniware (csops → odoops over a service binding). The hourly poll
// can be up to an hour stale, which is exactly the moment an agent is on a call.
function ShipmentLine({ s: initial, orderNo, session }) {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState(null);
  useEffect(() => { setS(initial); }, [initial]);
  const refresh = async () => {
    if (busy || !orderNo || !session) return;
    setBusy(true); setErrMsg(null);
    try { setS(await csopsPost('refreshShipment', { order_no: orderNo }, session)); }
    catch (e) { setErrMsg(e?.message || 'refresh failed'); }
    finally { setBusy(false); }
  };
  const tone = SHIP_TONE[s.lifecycle] || 'var(--t2)';
  const when = s.lifecycle === 'delivered' ? s.delivered_at || s.as_of
             : s.lifecycle === 'rto' ? s.as_of
             : s.dispatched_at;
  return (
    <div style={{ marginBottom:4 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, color:tone, fontWeight:s.alert ? 600 : 400 }}>
        <span style={{ width:7, height:7, borderRadius:'50%', background:tone, flexShrink:0 }} />
        <span>{s.label}</span>
        {when && <span style={{ color:'var(--t3)', fontWeight:400 }}>· {fmtShort(when)}</span>}
        {s.parcels > 1 && <span style={{ color:'var(--t3)', fontWeight:400 }}>· {s.parcels} parcels</span>}
        {orderNo && session && (
          <button onClick={refresh} disabled={busy} title="Re-check with the courier now"
            style={{ background:'none', border:'none', padding:0, marginLeft:2, cursor:busy?'default':'pointer',
                     color:'var(--t3)', display:'inline-flex', alignItems:'center', opacity:busy?0.5:1 }}>
            {/* No spin animation — the app defines no `spin` keyframe, so it would be dead CSS.
                The disabled + dimmed state is the busy signal. */}
            <RefreshCw size={11} />
          </button>
        )}
      </div>
      {errMsg && <div style={{ color:'var(--t3)', marginLeft:13, fontSize:11 }}>{errMsg}</div>}
      {/* COD reconciliation — "was the money actually collected?" is a real CS question and
          the answer is otherwise nowhere in Pitstop. */}
      {s.is_cod && (
        <div style={{ color:'var(--t3)', marginLeft:13 }}>
          COD {money(s.cod_collectable)}{Number(s.cod_collected) > 0 ? ` · collected` : ` · not yet collected`}
        </div>
      )}
      {/* Raw courier code, so an agent can quote it verbatim to the courier on a call. */}
      {s.courier_status && (
        <div style={{ color:'var(--t3)', marginLeft:13, fontSize:11 }}>{s.courier_status}</div>
      )}
    </div>
  );
}

export function ShopifyPanel({ session, phone, email, onPick, autoLoad, onOrders }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = useCallback(async () => {
    setLoading(true);
    try {
      const r = await csopsGet('searchShopifyCustomer', { phone: phone || '', email: email || '' }, session);
      setState(r);
      // Hand the loaded orders up so the lifecycle spine can infer the forward leg on tickets
      // that were never linked to an order. Reuses THIS fetch rather than issuing a second one.
      if (onOrders) onOrders(r?.found ? (r.recent_orders || []) : []);
    }
    catch (e) { setState({ error: e.message }); }
    finally { setLoading(false); }
  }, [session, phone, email, onOrders]);

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
                {/* Tracking / AWB — Shopify only knows an AWB EXISTS (its fulfillment stops at
                    "dispatched" and never moves). The live courier state comes from Uniware via
                    public.ecom_shipments, attached by csops as o.shipment. The external `track`
                    link is kept: it is the only place with the full scan trail, it just costs an
                    OTP round-trip, so it is the deep dive rather than the first answer. */}
                {((o.tracking || []).length > 0 || o.shipment) && (
                  <div style={{ marginTop:6 }}>
                    {o.shipment && <ShipmentLine s={o.shipment} orderNo={o.order_no} session={session} />}
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
