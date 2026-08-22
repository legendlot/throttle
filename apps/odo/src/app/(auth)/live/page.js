'use client';
/* ════════════════════════════════════════════════════════════════════════════
   LIVE — near-live Website orders (S303).

   Exists so nobody has to sit in the Shopify dashboard during a sale or a
   launch. Orders arrive by webhook within seconds of being placed; the hourly
   poller stays behind it as a reconciler.

   ⚠️ WEBSITE ONLY, AND THE PAGE SAYS SO. Marketplaces cannot be near-live —
   Amazon's API is asynchronous batch and quick-commerce arrives from a
   human-maintained sheet. A "live" total quietly excluding Amazon reads as
   Amazon having stalled mid-sale, which is exactly the misreading this banner
   is here to prevent.

   Reads staging (f_live_orders / f_live_totals) rather than sales_fact, whose
   grain is a DATE and so cannot express an order's time. The day-grain numbers
   on the Dashboard remain the reconciled ones.
   ════════════════════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr, fmtInt } from '../../../lib/api.js';
import { PageHead, PanelHead, Nil } from '../../../components/prism.js';
import { SegmentedToggle } from '../../../components/kit.js';

const WINDOWS = [['6', '6h'], ['12', '12h'], ['24', '24h'], ['72', '3d']];
const POLL_MS = 20000;

/* "2m ago" — the feed's own freshness. Shown next to every order and in the
   header, because the honest claim is "last order N minutes ago", not "live". */
function ago(iso, nowMs) {
  if (!iso) return '—';
  const s = Math.max(0, (nowMs - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function istTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
}

export default function LivePage() {
  const { session, userId } = useAuth();
  // Read the token from a ref inside the callback rather than closing over `session`,
  // which goes stale — and key the loads on `userId` (CORE.md / AuthProvider).
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const [hours, setHours] = useState('12');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Ids seen on the previous poll — anything new gets a one-shot highlight so a
  // watcher notices an arrival without having to diff the list themselves.
  // ⚠️ null means "no baseline yet": the FIRST load after mount or after a window change
  // establishes the baseline and highlights nothing. Without that reset, switching 6h → 3d
  // marks every newly-visible OLDER order as a fresh arrival — a screenful of false
  // "just arrived" highlights at exactly the moment someone is watching for real ones.
  const seenRef = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());

  // Changing the window invalidates the baseline. Reset before the new load lands.
  useEffect(() => { seenRef.current = null; setFresh(new Set()); }, [hours]);

  // Make the highlight genuinely one-shot. Nothing cleared it before, so on a quiet spell the
  // last arrivals stayed lit indefinitely and the highlight stopped meaning "new".
  useEffect(() => {
    if (!fresh.size) return;
    const id = setTimeout(() => setFresh(new Set()), 8000);
    return () => clearTimeout(id);
  }, [fresh]);

  const load = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const r = await salesGet('getLiveSales', { hours, limit: 60 }, s);
      const orders = r?.orders || [];
      const ids = new Set(orders.map(o => o.source_order_id));
      if (seenRef.current) {
        const added = new Set([...ids].filter(id => !seenRef.current.has(id)));
        if (added.size) setFresh(added);
      }
      seenRef.current = ids;
      setData(r); setErr('');
    } catch (e) {
      // Keep the last good payload on screen rather than blanking it — a failed poll
      // during a sale should degrade to "stale", never to "no orders".
      setErr(e?.message || 'Failed to load');
    } finally { setLoading(false); }
  }, [hours]);

  useEffect(() => { if (userId) { setLoading(true); load(); } }, [userId, load]);

  useEffect(() => {
    if (!userId) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [userId, load]);

  // Ticks the relative times without refetching, so "3m ago" keeps counting between polls.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const totals = data?.totals || null;
  const orders = data?.orders || [];
  const newest = totals?.newest || null;
  // Staleness is measured against the SERVER's clock, not the browser's — a laptop with a
  // skewed clock would otherwise report the feed as minutes stale, or falsely fresh.
  const skewMs = useMemo(() => (data?.server_now ? Date.now() - Date.parse(data.server_now) : 0), [data]);
  const lastAgoS = newest ? Math.max(0, (nowMs - skewMs - Date.parse(newest)) / 1000) : null;
  // The webhook path should land orders within seconds. If the newest order is older than an
  // hour we are almost certainly back on the hourly poller, which is worth saying out loud.
  const onPollerOnly = lastAgoS != null && lastAgoS > 3900;

  return (
    <div className="so-page">
      <PageHead
        title="Live"
        sub={<>Website orders as they arrive <span className="so-qual">· last {WINDOWS.find(w => w[0] === hours)?.[1]}</span></>}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <SegmentedToggle options={WINDOWS} value={hours} onChange={setHours} size="sm" />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: onPollerOnly ? 'var(--amber, #d97706)' : 'var(--green, #16a34a)' }} />
          {newest ? `last order ${ago(newest, nowMs - skewMs)}` : 'no orders in window'}
        </span>
        {err && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>refresh failed — showing last good data</span>}
      </div>

      {/* Website-only is a correctness statement, not a footnote. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 13px', marginBottom: 14,
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 4px)',
        fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t2)' }}>
        <span>
          <b style={{ color: 'var(--t1)' }}>Website only.</b> Amazon, quick-commerce and offline are not on this page —
          their feeds are batch or hourly and cannot be live. For every channel together, use the Dashboard.
        </span>
      </div>

      {data && data.configured === false && (
        <div style={{ padding: '9px 13px', marginBottom: 14, background: 'var(--warn-bg, #2a2110)',
          border: '1px solid var(--warn-bd, #6b4d16)', borderRadius: 'var(--r-sm, 4px)',
          fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--warn-fg, #d97706)' }}>
          The Website connector is missing, so this page has nothing to read. The empty list below is
          <b> not</b> a quiet sales day — check Connectors.
        </div>
      )}

      {onPollerOnly && data?.configured !== false && (
        <div style={{ padding: '9px 13px', marginBottom: 14, background: 'var(--warn-bg, #2a2110)',
          border: '1px solid var(--warn-bd, #6b4d16)', borderRadius: 'var(--r-sm, 4px)',
          fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--warn-fg, #d97706)' }}>
          No order in over an hour. Either it is genuinely quiet, or live delivery has stopped and this is
          the hourly sync — check Shopify’s webhook subscriptions before trusting the gap.
        </div>
      )}

      {loading && !data ? (
        <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Tile label="Orders"   value={fmtInt(totals?.orders || 0)} />
            <Tile label="Units"    value={fmtInt(totals?.units || 0)} />
            <Tile label="Gross"    value={inr(totals?.gross || 0)} bright />
            <Tile label="Cancelled" value={totals?.cancelled ? fmtInt(totals.cancelled) : '—'} />
          </div>

          <div className="so-card flush">
            <PanelHead title="Orders" style={{ marginBottom: 0 }}
              qual={orders.length ? `· newest first` : undefined} />
            {orders.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t3)' }}>
                {data?.configured === false ? 'Feed unavailable — see the notice above.' : 'No Website orders in this window.'}
              </div>
            ) : (
              <table className="so-table">
                <thead><tr>
                  <th>Time</th><th>Order</th><th>Items</th>
                  <th className="so-num">Units</th><th className="so-num">Gross ₹</th>
                </tr></thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.source_order_id}
                      style={fresh.has(o.source_order_id)
                        ? { background: 'var(--ok-bg, rgba(22,163,74,0.10))' } : undefined}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {istTime(o.occurred_at)}
                        <span style={{ color: 'var(--t4)', marginLeft: 6 }}>{ago(o.occurred_at, nowMs - skewMs)}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        {o.order_name || '—'}
                        {o.is_cancelled && <span style={{ color: 'var(--red)', marginLeft: 6 }}>cancelled</span>}
                      </td>
                      <td style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t2)',
                        maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.items || '—'}
                        {o.line_count > 1 && <span style={{ color: 'var(--t4)' }}> · {o.line_count} lines</span>}
                      </td>
                      <td className="so-num">{fmtInt(o.units)}</td>
                      <td className="so-num bright">{o.gross ? inr(o.gross) : <Nil />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, bright }) {
  return (
    <div className="so-card" style={{ padding: '13px 15px' }}>
      <div className="so-stat-sub" style={{ marginTop: 0, marginBottom: 5 }}>{label}</div>
      <div className="num" style={{ fontFamily: 'var(--mono)', fontSize: 21, fontWeight: 700,
        color: bright ? 'var(--t1)' : 'var(--t2)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
