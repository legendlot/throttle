'use client';
// Activity (S232) — live customer-event monitor, the in-house equivalent of Shopflo's
// "Abandoned Checkout" list, over comms.events. Two columns Shopflo cannot show:
// whether Relay actually messaged the person (journey send within 48h) and whether
// they came back and ordered. Read path: getEventFeed → event_feed/_stats RPCs
// (set-based; the page never sees raw event rows beyond the fetched page).
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Download } from 'lucide-react';
import { PageHead, Panel, Kpi, Badge, Btn, EmptyState } from '@/components/ui.js';
import { istPresetRange, PRESETS } from '@/lib/dateRanges.js';

const EVENTS = [
  { key: 'checkout_abandoned', label: 'Checkout abandoned' },
  { key: 'checkout_started', label: 'Checkout started' },
  { key: 'add_to_cart', label: 'Added to cart' },
  { key: 'product_viewed', label: 'Product viewed' },
  { key: 'order_placed', label: 'Order placed' },
  { key: 'order_cancelled', label: 'Order cancelled' },
];
const PAGE = 50;

const fmtIst = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtVal = (v, cur) => (v == null || v === '' ? '—' : `${cur === 'INR' || !cur ? '₹' : cur + ' '}${Number(v).toLocaleString('en-IN')}`);

const MSG_TONE = { delivered: 'green', read: 'green', opened: 'green', sent: 'yellow', queued: 'yellow', failed: 'red', skipped: 'gray', suppressed: 'gray' };

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Export exactly the rows on screen (loaded pages, active event + date filter) — a shared
// CSV and a shared screenshot can never disagree. Same discipline as the campaigns export.
function downloadActivityCsv(rows, event, preset) {
  const header = ['When (IST)', 'Customer', 'Phone', 'Email', 'Items', 'Value', 'Currency',
    'Message', 'Message reason', 'Recovered', 'Checkout URL', 'Profile ID'];
  const body = rows.map((r) => [
    fmtIst(r.occurred_at), r.display_name || 'anonymous', r.phone || '', r.email || '',
    r.item || '', r.value ?? '', r.currency || '',
    r.msg_status || '', r.msg_reason || '', r.recovered ? 'yes' : 'no', r.checkout_url || '', r.profile_id || '',
  ]);
  const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `relay-activity-${event}-${preset}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function ActivityPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [event, setEvent] = useState('checkout_abandoned');
  const [preset, setPreset] = useState('today');
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(async (offset) => {
    const [from, to] = istPresetRange(preset);
    const r = await garageFetch('getEventFeed', {
      event, from: from.toISOString(), to: to.toISOString(), limit: PAGE, offset,
    }, session);
    return r || { rows: [], stats: null };
  }, [session, event, preset]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await fetchPage(0);
      setRows(r.rows || []);
      setStats(r.stats || null);
      setMore((r.rows || []).length === PAGE);
    } catch (e) { showToast(e.message || 'Failed to load activity', 'error'); }
    finally { setLoading(false); }
  }, [session, fetchPage, showToast]);
  useEffect(() => { load(); }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await fetchPage(rows.length);
      setRows((prev) => [...prev, ...(r.rows || [])]);
      setMore((r.rows || []).length === PAGE);
    } catch (e) { showToast(e.message || 'Failed to load more', 'error'); }
    finally { setLoadingMore(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  const evLabel = (EVENTS.find((x) => x.key === event) || {}).label || event;
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

  return (
    <div className="pg">
      <PageHead title="Activity" sub="Live customer events — who abandoned, who was messaged, who came back."
        actions={
          <div className="rtabs">
            {PRESETS.map((w) => (
              <button key={w.key} className={`rtab rtab-mono ${preset === w.key ? 'on' : ''}`} onClick={() => setPreset(w.key)}>{w.label}</button>
            ))}
          </div>
        } />

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
        {EVENTS.map((e) => (
          <Btn key={e.key} kind={event === e.key ? 'primary' : 'ghost'} onClick={() => setEvent(e.key)}>{e.label}</Btn>
        ))}
      </div>

      {stats && (
        <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 14 }}>
          <Kpi label={evLabel} value={Number(stats.total || 0)} tone="gray" sub="events in range" />
          <Kpi label="Identified" value={Number(stats.identified || 0)} tone="gray" sub={`${pct(stats.identified, stats.total)} have phone/email`} />
          <Kpi label="Messaged" value={Number(stats.messaged || 0)} tone="yellow" sub="journey send within 48h" />
          <Kpi label="Recovered" value={Number(stats.recovered || 0)} tone="green" sub={`${pct(stats.recovered, stats.total)} ordered after`} />
        </div>
      )}

      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="activity" title="No events in this range" hint="Try a wider date range or another event type." /></Panel>
          : (
            <Panel title={evLabel} count={stats ? Number(stats.total || rows.length) : rows.length}
              action={
                // NB Panel takes `action`, not `actions` — the campaigns CSV button silently
                // vanished on that prop name once already (S220 gotcha).
                <Btn onClick={() => downloadActivityCsv(rows, event, preset)} disabled={!rows.length}>
                  <Download size={14} /> Download CSV
                </Btn>
              }>
              <div className="table-scroll">
              <table className="dt">
                <thead><tr><th>When (IST)</th><th>Customer</th><th>Phone</th><th>Items</th><th>Value</th><th>Message</th><th>Recovered</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtIst(r.occurred_at)}</td>
                      <td style={{ fontWeight: 600 }}>{r.display_name || <span className="dim">anonymous</span>}</td>
                      <td className="mono dim" style={{ fontSize: 12 }}>{r.phone || r.email || '—'}</td>
                      <td className="dim" style={{ fontSize: 12.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.item || ''}>{r.item || '—'}</td>
                      <td className="mono">{fmtVal(r.value, r.currency)}</td>
                      <td>{r.msg_status
                        ? <span title={r.msg_reason || ''} style={r.msg_reason ? { cursor: 'help' } : undefined}>
                            <Badge label={r.msg_status} tone={MSG_TONE[r.msg_status] || 'gray'} />
                          </span>
                        : <span className="dim">—</span>}</td>
                      <td>{r.recovered
                        ? <Badge label="recovered" tone="green" />
                        : <span className="dim" style={{ fontSize: 12 }}>not yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {more && (
                <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
                  <Btn onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Btn>
                </div>
              )}
            </Panel>
          )}
    </div>
  );
}
