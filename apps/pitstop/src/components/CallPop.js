'use client';
import { useEffect, useRef, useState } from 'react';
import { notify } from '../lib/notify.js';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import {
  PhoneIncoming, PhoneOutgoing, X, ExternalLink, Package, Truck,
  AlertTriangle, MessageSquare, Clock, UserRound,
} from 'lucide-react';
import { csopsGet } from '../lib/csopsFetch.js';
import { fmtIstDayMonth } from '../lib/datetime.js';

/**
 * CallPop — the customer's whole picture, on screen before the agent says hello.
 *
 * Afshaan, 2026-08-20: "the agent doesn't waste time in digging for the basic info
 * with the customer - which is very irritating if the customer has a grievance."
 *
 * Timing: the worker warms this while the greeting plays (~6s) and the phone rings
 * (up to 30s), storing it on the call row. By the time the agent picks up, the card is
 * already assembled — this component only reads it.
 *
 * ⚠️ Mounted in the (auth) LAYOUT, not a page: a call can arrive while the agent is
 * anywhere in Pitstop, and a page-mounted pop would unmount on navigation mid-call.
 *
 * ⚠️ Polling is deliberate scaffolding. Once the softphone (Phase 6) lands, its SDK
 * fires an incoming-call event and this poll retires. Until then it is the only way the
 * browser learns a call is ringing. 4 agents x 1 request/5s is negligible.
 */
const POLL_MS = 5000;

export default function CallPop() {
  const { session, userId } = useAuth();
  const router = useRouter();
  const [state, setState] = useState(null);      // { call, context }
  const [dismissed, setDismissed] = useState(null); // call id the agent closed
  const alive = useRef(true);
  const notifiedCallRef = useRef(null);   // last call id we raised a desktop notification for

  // ⚠️ Keyed on userId, NEVER on `session` (CORE.md): a token refresh lands ~hourly and
  // hands the app a new session object. Re-keying on it would tear down and restart the
  // poll mid-call. The token is read inside the callback instead.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!userId) return;
    alive.current = true;
    async function tick() {
      try {
        const r = await csopsGet('getCallContext', { mine: 'true' }, sessionRef.current);
        if (!alive.current) return;
        setState(r?.active ? r : null);
        // Desktop notification for an incoming call, ONCE per call.
        //
        // ⚠️ This is the case the in-app pop cannot cover. The pop is only visible if Pitstop is
        // the tab the agent is looking at; a call arrives whenever it arrives. The phone ringing
        // is the primary alert — this exists so the agent knows WHO is calling before answering,
        // which is the whole point of the screen-pop.
        //
        // ⚠️ `requireInteraction` is true here and nowhere else: a message can wait, a ringing
        // phone cannot, and a notification that auto-dismisses after a few seconds is no use to
        // someone who glanced away. The agent closes it, or clicking it opens the call.
        const c = r?.active ? r.call : null;
        if (c?.id && notifiedCallRef.current !== c.id) {
          notifiedCallRef.current = c.id;
          const who = r.context?.customer?.name;
          const order = r.context?.last_order;
          notify(
            c.direction === 'outgoing' ? `Calling ${who || c.phone || ''}`.trim() : `📞 ${who || 'Unknown caller'}`,
            {
              // `order_no` is the field the card itself renders — not `name`/`order_number`,
              // which do not exist on this shape and would have printed a bare "Last order".
              body: [c.phone, order?.order_no ? `Last order ${order.order_no}` : null]
                .filter(Boolean).join(' · ') || undefined,
              tag: `call:${c.id}`,
              requireInteraction: true,
              onClick: () => router.push(c.ticket_id ? `/calls/detail?id=${c.id}` : `/new?phone=${encodeURIComponent(c.phone || '')}`),
            },
          );
        }
      } catch { /* a failed poll must never surface an error over a live call */ }
    }
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => { alive.current = false; clearInterval(iv); };
  }, [userId]);

  if (!state?.active) return null;
  if (dismissed && dismissed === state.call?.id) return null;

  const { call, context } = state;
  const c = context || {};
  const hist = c.call_history || {};
  const order = c.last_order;
  const ship = order?.shipment;

  const nthLabel = hist.is_first_call
    ? 'First-time caller'
    : `${ordinal(hist.prior_calls + 1)} call${hist.prior_calls >= 1 ? ` · ${hist.prior_calls} before` : ''}`;

  return (
    <div className="pt-callpop" style={wrap} role="dialog" aria-label="Incoming call">
      <div style={head}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {call.direction === 'outgoing'
            ? <PhoneOutgoing size={15} style={{ color: 'var(--info-fg)' }} />
            : <PhoneIncoming size={15} style={{ color: 'var(--ok-fg)' }} />}
          <strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.customer?.name || 'Unknown caller'}
          </strong>
        </span>
        <button onClick={() => setDismissed(call.id)} style={xBtn} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <code style={mono}>{call.phone}</code>
          <span style={hist.is_first_call ? chipNeutral : chipWarn}>
            <UserRound size={10} /> {nthLabel}
          </span>
          {hist.calls_last_24h > 0 && (
            // A repeat caller inside 24h is usually someone who could not get through -
            // 79% of July's "nobody spoke" tickets had repeat calls coalesced in.
            <span style={chipBad}><Clock size={10} /> {hist.calls_last_24h} today</span>
          )}
        </div>

        {!c.known && (
          <p style={muted}>No previous orders or calls found for this number.</p>
        )}

        {order && (
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                <Package size={12} /> {order.order_no}
              </span>
              {order.total != null && <span style={mono}>₹{order.total}</span>}
            </div>
            {ship && (
              <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {/* An RTO is the one an agent must not be surprised by mid-sentence. */}
                <span style={ship.alert ? chipBad : chipOk}>
                  {ship.alert ? <AlertTriangle size={10} /> : <Truck size={10} />} {ship.label}
                  {ship.delivered_at ? ` · ${fmtDay(ship.delivered_at)}` : ''}
                </span>
                {ship.awb && (
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>
                    {ship.courier || 'Courier'} · <code style={{ ...mono, fontSize: 10.5 }}>{ship.awb}</code>
                    {ship.tracking_link && (
                      <a href={ship.tracking_link} target="_blank" rel="noreferrer"
                         style={{ marginLeft: 6, color: 'var(--accent)' }}>
                        track <ExternalLink size={9} style={{ verticalAlign: -1 }} />
                      </a>
                    )}
                  </span>
                )}
                {ship.is_cod && ship.cod_collectable != null && (
                  <span style={{ fontSize: 11, color: 'var(--warn-fg)' }}>COD ₹{ship.cod_collectable} to collect</span>
                )}
              </div>
            )}
          </div>
        )}

        {c.open_ticket && (
          <button onClick={() => router.push(`/queue/detail?ticket_no=${c.open_ticket.ticket_no}`)} style={rowBtn}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={chipWarn}>OPEN</span>
              <code style={mono}>{c.open_ticket.ticket_no}</code>
            </span>
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>
              {c.open_ticket.assigned_agent_name || 'unassigned'} <ExternalLink size={10} />
            </span>
          </button>
        )}

        {c.open_conversation && (
          <span style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <MessageSquare size={11} />
            Open {c.open_conversation.channel || 'WhatsApp'} conversation
            {c.open_conversation.has_unread_inbound ? ' · unread' : ''}
          </span>
        )}

        {c.recent_tickets?.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {c.recent_tickets.slice(0, 4).map(t => (
              <span key={t.ticket_no} style={chipNeutral} title={`${t.disposition || ''} · ${fmtDay(t.created_at)}`}>
                {t.ticket_no.replace(/^CS-\d{4}-/, '#')}
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 7, marginTop: 2 }}>
          {call.ticket_id
            ? <button onClick={() => router.push(`/calls/detail?id=${call.id}`)} style={primaryBtn}>Open call</button>
            : <button onClick={() => router.push(`/new?phone=${encodeURIComponent(call.phone || '')}`)} style={primaryBtn}>New ticket</button>}
        </div>
      </div>
    </div>
  );
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
// Declared, not aliased with `const`: this is referenced above its definition, and a
// `const` alias would sit in the temporal dead zone. Also keeps the empty-string return
// for a missing date — the shared helper renders an em dash, which is right for a field
// label but wrong inside the ` · ${…}` fragments and title strings this feeds.
function fmtDay(iso) {
  return iso ? fmtIstDayMonth(iso) : '';
}

const wrap = {
  position: 'fixed', right: 18, bottom: 18, zIndex: 900, width: 330, maxWidth: 'calc(100vw - 36px)',
  background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 10,
  boxShadow: '0 12px 40px rgba(0,0,0,0.35)', overflow: 'hidden',
};
const head = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '10px 12px 10px 14px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border-1)',
};
const xBtn = { background: 'transparent', border: 'none', color: 'var(--t3)', cursor: 'pointer', display: 'inline-flex', padding: 2 };
const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };
const muted = { margin: 0, fontSize: 11.5, color: 'var(--t3)' };
const card = { background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 7, padding: '9px 11px' };
const chipBase = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
  borderRadius: 999, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
};
const chipNeutral = { ...chipBase, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border-1)' };
const chipOk   = { ...chipBase, background: 'rgba(34,197,94,0.12)',  color: 'var(--ok-fg)' };
const chipWarn = { ...chipBase, background: 'rgba(234,179,8,0.14)',  color: 'var(--warn-fg)' };
const chipBad  = { ...chipBase, background: 'rgba(239,68,68,0.12)',  color: 'var(--bad-fg, #dc2626)' };
const rowBtn = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%',
  padding: '7px 9px', background: 'var(--surface-2)', border: '1px solid var(--border-1)',
  borderRadius: 7, cursor: 'pointer', color: 'var(--t1)',
};
const primaryBtn = {
  flex: 1, padding: '7px 12px', background: 'var(--accent)', color: 'var(--accent-fg)',
  border: 'none', borderRadius: 6, fontFamily: 'var(--f-display)', fontWeight: 700,
  fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
};
