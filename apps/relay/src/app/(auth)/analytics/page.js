'use client';
// M8 — Analytics. Pure render over the commsops analytics RPCs (sends_overview,
// deliverability_health, campaign_stats, campaign_attribution). All aggregation is
// SQL-side; this page never sees raw message/event rows.
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { BarChart3, RefreshCw } from 'lucide-react';
import { PageHead, Panel, Kpi, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inr } from '@/components/format.js';

const WINDOWS = [7, 30, 90];
const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 1000) / 10 : 0);

// ROI = attributed revenue ÷ spend. Only meaningful where sends are actually priced
// (WhatsApp bills per conversation; Resend email is a flat plan and reports no per-message
// cost), so this returns null rather than a fake ∞/0× when spend is 0.
const roi = (revenue, spend) => (Number(spend) > 0 ? Number(revenue) / Number(spend) : null);
const fmtRoi = (r) => (r == null ? '—' : `${r.toFixed(2)}×`);

const QUALITY_TONE = { GREEN: 'green', YELLOW: 'yellow', RED: 'red', FLAGGED: 'red', RESTRICTED: 'red' };

// Sends-by-day bars: yellow column = sent, green fill from the bottom = delivered share.
function SendsBars({ data }) {
  if (!data.length) return <EmptyState icon="bar-chart-3" title="No sends in this window" />;
  const max = Math.max(...data.map((d) => d.sent), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 168, padding: '10px 4px', overflowX: 'auto' }}>
      {data.map((d) => (
        <div key={d.day} title={`${d.day} — ${d.sent} sent, ${d.delivered} delivered`}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 28 }}>
          <div style={{ width: 22, height: 120, background: 'rgba(255,255,255,.04)', borderRadius: 4, display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ width: '100%', height: `${(d.sent / max) * 100}%`, background: 'var(--accent, #F2CD1A)', borderRadius: 4, display: 'flex', alignItems: 'flex-end', minHeight: d.sent ? 2 : 0 }}>
              <div style={{ width: '100%', height: `${d.sent ? (d.delivered / d.sent) * 100 : 0}%`, background: 'var(--green, #34d399)', borderRadius: 4 }} />
            </div>
          </div>
          <div className="mono dim" style={{ fontSize: 10 }}>{fmtDateShort(d.day)}</div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState([]);
  const [health, setHealth] = useState([]);
  const [camps, setCamps] = useState([]);
  const [journeys, setJourneys] = useState([]);
  // M15 — a failed RPC must not render as a fake zero. One flag for the whole data
  // domain (overview/health/campaigns/journeys load together); render an explicit
  // "unavailable" state instead of ₹0/empty rows when any of them fails.
  const [statsError, setStatsError] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setStatsError(false);
    try {
      const [ov, hl, cs, js] = await Promise.all([
        garageFetch('getSendsOverview', { days }, session).catch(() => { setStatsError(true); return null; }),
        garageFetch('getDeliverabilityHealth', { days }, session).catch(() => { setStatsError(true); return null; }),
        garageFetch('getCampaigns', {}, session).catch(() => { setStatsError(true); return null; }),
        garageFetch('getJourneys', {}, session).catch(() => { setStatsError(true); return null; }),
      ]);
      setOverview(Array.isArray(ov) ? ov : []);
      setHealth(Array.isArray(hl) ? hl : []);

      // Journeys drive far more revenue than broadcasts (BiteSpeed: ₹39.1L vs ₹80k/30d),
      // so they get the same revenue treatment campaigns already had.
      const jlist = Array.isArray(js) ? js : [];
      setJourneys(await Promise.all(jlist.map(async (j) => {
        try { return { ...j, attr: (await garageFetch('getJourneyAttribution', { id: j.id }, session)) || {} }; }
        catch { return { ...j, attr: {} }; }
      })));

      const list = Array.isArray(cs) ? cs : [];
      // Pull per-campaign stats + attribution only for campaigns that have actually sent.
      const sent = list.filter((c) => ['sending', 'sent'].includes(c.status));
      const enriched = await Promise.all(sent.map(async (c) => {
        try {
          const [st, at] = await Promise.all([
            garageFetch('getCampaignStats', { id: c.id }, session),
            garageFetch('getCampaignAttribution', { id: c.id }, session),
          ]);
          return { ...c, stats: st || {}, attr: at || {} };
        } catch { return { ...c, stats: {}, attr: {} }; }
      }));
      setCamps(enriched);
    } catch (e) { setStatsError(true); showToast(e.message || 'Failed to load analytics', 'error'); }
    finally { setLoading(false); }
  }, [session, days, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  // Overview totals + by-day series (aggregate across channel/purpose; chart oldest→newest).
  const totals = overview.reduce((a, r) => ({
    sent: a.sent + Number(r.sent || 0), delivered: a.delivered + Number(r.delivered || 0),
    opened: a.opened + Number(r.opened || 0),
    failed: a.failed + Number(r.failed || 0), skipped: a.skipped + Number(r.skipped || 0),
    spend: a.spend + Number(r.spend || 0),
  }), { sent: 0, delivered: 0, opened: 0, failed: 0, skipped: 0, spend: 0 });
  const revenueTotal = [...camps.map((c) => c.attr), ...journeys.map((j) => j.attr)]
    .reduce((a, x) => a + Number(x?.attributed_revenue || 0), 0);
  const byDayMap = {};
  for (const r of overview) {
    const k = r.day;
    if (!byDayMap[k]) byDayMap[k] = { day: k, sent: 0, delivered: 0 };
    byDayMap[k].sent += Number(r.sent || 0);
    byDayMap[k].delivered += Number(r.delivered || 0);
  }
  const byDay = Object.values(byDayMap).sort((a, b) => (a.day < b.day ? -1 : 1));

  const winPicker = (
    <div className="rtabs">
      {WINDOWS.map((w) => (
        <button key={w} className={`rtab rtab-mono ${days === w ? 'on' : ''}`} onClick={() => setDays(w)}>{w}d</button>
      ))}
    </div>
  );

  return (
    <div className="pg">
      <PageHead title="Analytics" sub="Delivery, engagement, and attribution across channels." actions={winPicker} />

      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : statsError ? (
          <Panel pad>
            <EmptyState icon="info" title="Analytics unavailable — retry" hint="Could not load one or more analytics sources. Numbers below would be misleading, so nothing is shown instead of fake zeros." />
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
              <Btn onClick={load}><RefreshCw size={14} /> Retry</Btn>
            </div>
          </Panel>
        ) : (
        <>
          <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
            <Kpi label={`Sent · ${days}d`} value={totals.sent} tone="gray" sub="messages handed to provider" />
            <Kpi label="Delivery rate" value={pct(totals.delivered, totals.sent)} tone="green" format={(v) => v.toFixed(1) + '%'} sub={`${totals.delivered.toLocaleString('en-IN')} delivered`} />
            <Kpi label="Read rate" value={pct(totals.opened, totals.delivered)} tone="green" format={(v) => v.toFixed(1) + '%'} sub={`${totals.opened.toLocaleString('en-IN')} read · of delivered`} />
            <Kpi label="Failed / bounced" value={totals.failed} tone={totals.failed ? 'red' : 'gray'} sub="hard failures" />
            <Kpi label="Skipped" value={totals.skipped} tone={totals.skipped ? 'yellow' : 'gray'} sub="gate-blocked (incl. test mode)" />
          </div>

          <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
            <Kpi label={`Spend · ${days}d`} value={totals.spend} tone="gray" format={(v) => inr(v)}
              sub={totals.spend > 0 ? 'per-conversation cost' : 'no priced sends (email is flat-rate)'} />
            <Kpi label="Attributed revenue" value={revenueTotal} tone="green" format={(v) => inr(v)}
              sub="campaigns + journeys, last-touch" />
            <Kpi label="Blended ROI" value={roi(revenueTotal, totals.spend) ?? 0}
              tone={roi(revenueTotal, totals.spend) == null ? 'gray' : 'green'}
              format={() => fmtRoi(roi(revenueTotal, totals.spend))}
              sub={totals.spend > 0 ? 'revenue ÷ spend' : 'needs priced sends'} />
          </div>

          <Panel title={`Sends by day · ${days}d`} action={<span className="dim" style={{ fontSize: 12 }}><span style={{ color: 'var(--accent,#F2CD1A)' }}>■</span> sent&nbsp;&nbsp;<span style={{ color: 'var(--green, #34d399)' }}>■</span> delivered</span>} pad>
            <SendsBars data={byDay} />
          </Panel>

          <Panel title="Campaigns" count={camps.length} pad>
            {camps.length === 0
              ? <EmptyState icon="send" title="No sent campaigns yet" hint="Per-campaign delivery, engagement, and attribution appear here once a campaign sends." />
              : (
                <table className="dt">
                  <thead><tr>
                    <th>Campaign</th><th className="num">Sent</th><th className="num">Delivered</th>
                    <th className="num">Opened</th><th className="num">Clicked</th><th className="num">Bounced</th>
                    <th className="num">Unsub</th><th className="num">Attr. orders</th><th className="num">Attr. revenue</th>
                    <th className="num">Spend</th><th className="num">ROI</th>
                  </tr></thead>
                  <tbody>
                    {camps.map((c) => {
                      const s = c.stats || {}, a = c.attr || {};
                      return (
                        <tr key={c.id}>
                          <td>{c.name} <Badge label={c.purpose} tone="blue" /></td>
                          <td className="num mono">{s.sent ?? 0}</td>
                          <td className="num mono">{s.delivered ?? 0}<span className="dim"> · {pct(s.delivered, s.sent)}%</span></td>
                          <td className="num mono">{s.opened ?? 0}</td>
                          <td className="num mono">{s.clicked ?? 0}</td>
                          <td className="num mono" style={{ color: s.bounced ? '#ff7a7a' : undefined }}>{s.bounced ?? 0}</td>
                          <td className="num mono">{s.unsubscribes ?? 0}</td>
                          <td className="num mono">{a.attributed_orders ?? 0}</td>
                          <td className="num mono">{inr(a.attributed_revenue ?? 0)}</td>
                          <td className="num mono">{Number(s.spend) > 0 ? inr(s.spend) : <span className="dim">—</span>}</td>
                          <td className="num mono">{fmtRoi(roi(a.attributed_revenue, s.spend))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
          </Panel>

          <Panel title="Journeys" count={journeys.length} pad
            action={<span className="dim" style={{ fontSize: 12 }}>revenue ÷ conversion per journey</span>}>
            {journeys.length === 0
              ? <EmptyState icon="git-branch" title="No journeys yet" hint="Triggered, revenue and conversion per journey appear here once enrolments run." />
              : (
                <table className="dt">
                  <thead><tr>
                    <th>Journey</th><th>Status</th><th className="num">Triggered</th><th className="num">Sent</th>
                    <th className="num">Engaged</th><th className="num">Orders</th><th className="num">Conv %</th>
                    <th className="num">Revenue</th><th className="num">Spend</th><th className="num">ROI</th>
                  </tr></thead>
                  <tbody>
                    {journeys.map((j) => {
                      const a = j.attr || {};
                      return (
                        <tr key={j.id}>
                          <td>{j.name}</td>
                          <td><Badge label={j.status} tone={j.status === 'active' ? 'green' : 'gray'} /></td>
                          <td className="num mono">{a.triggered ?? 0}</td>
                          <td className="num mono">{a.messages_sent ?? 0}</td>
                          <td className="num mono">{a.engaged_profiles ?? 0}</td>
                          <td className="num mono">{a.attributed_orders ?? 0}</td>
                          <td className="num mono">{a.conversion_rate == null ? <span className="dim">—</span> : `${Number(a.conversion_rate)}%`}</td>
                          <td className="num mono">{inr(a.attributed_revenue ?? 0)}</td>
                          <td className="num mono">{Number(a.spend) > 0 ? inr(a.spend) : <span className="dim">—</span>}</td>
                          <td className="num mono">{fmtRoi(roi(a.attributed_revenue, a.spend))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
          </Panel>

          <Panel title={`Deliverability · ${days}d`} count={health.length} pad>
            {health.length === 0
              ? <EmptyState icon="mail" title="No sender activity" hint="Bounce and complaint rates per sender identity appear here once emails are sent." />
              : (
                <table className="dt">
                  <thead><tr>
                    <th>Sender</th><th>Channel</th><th>Quality</th><th className="num">Sent</th><th className="num">Delivered</th>
                    <th className="num">Delivery %</th><th className="num">Read %</th><th className="num">Bounce %</th>
                    <th className="num">Complaint %</th><th className="num">Spend</th>
                  </tr></thead>
                  <tbody>
                    {health.map((h) => (
                      <tr key={h.sender_identity_id}>
                        <td className="mono">{h.address}</td>
                        <td><Badge label={h.channel} tone="blue" /></td>
                        {/* WA quality/limit gate throughput — a drop means Meta is throttling us.
                            Only WhatsApp carries these; email senders show a dash. */}
                        <td>{h.channel === 'whatsapp'
                          ? (h.quality_rating
                            ? <span title={`Limit: ${h.messaging_limit || 'unknown'}${h.quality_updated_at ? ` · updated ${h.quality_updated_at}` : ''}`}>
                                <Badge label={h.quality_rating} tone={QUALITY_TONE[String(h.quality_rating).toUpperCase()] || 'gray'} />
                                {h.messaging_limit && <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>{h.messaging_limit}</span>}
                              </span>
                            : <span className="dim" style={{ fontSize: 12 }}>no signal yet</span>)
                          : <span className="dim">—</span>}</td>
                        <td className="num mono">{h.sent}</td>
                        <td className="num mono">{h.delivered}</td>
                        <td className="num mono">{Number(h.delivered_rate ?? 0)}%</td>
                        <td className="num mono">{h.read_rate == null ? <span className="dim">—</span> : `${Number(h.read_rate)}%`}</td>
                        <td className="num mono" style={{ color: Number(h.bounce_rate) > 2 ? '#ff7a7a' : undefined }}>{Number(h.bounce_rate ?? 0)}%</td>
                        <td className="num mono" style={{ color: Number(h.complaint_rate) > 0.1 ? '#ff7a7a' : undefined }}>{Number(h.complaint_rate ?? 0)}%</td>
                        <td className="num mono">{Number(h.spend) > 0 ? inr(h.spend) : <span className="dim">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Panel>
        </>
      )}
    </div>
  );
}

