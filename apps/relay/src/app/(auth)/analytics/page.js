'use client';
// M8 — Analytics. Pure render over the commsops analytics RPCs (sends_overview,
// deliverability_health, campaign_stats, campaign_attribution). All aggregation is
// SQL-side; this page never sees raw message/event rows.
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { BarChart3 } from 'lucide-react';
import { PageHead, Panel, Kpi, Badge, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inr } from '@/components/format.js';

const WINDOWS = [7, 30, 90];
const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 1000) / 10 : 0);

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
              <div style={{ width: '100%', height: `${d.sent ? (d.delivered / d.sent) * 100 : 0}%`, background: '#22c55e', borderRadius: 4 }} />
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

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [ov, hl, cs] = await Promise.all([
        garageFetch('getSendsOverview', { days }, session),
        garageFetch('getDeliverabilityHealth', { days }, session),
        garageFetch('getCampaigns', {}, session),
      ]);
      setOverview(Array.isArray(ov) ? ov : []);
      setHealth(Array.isArray(hl) ? hl : []);
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
    } catch (e) { showToast(e.message || 'Failed to load analytics', 'error'); }
    finally { setLoading(false); }
  }, [session, days, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  // Overview totals + by-day series (aggregate across channel/purpose; chart oldest→newest).
  const totals = overview.reduce((a, r) => ({
    sent: a.sent + Number(r.sent || 0), delivered: a.delivered + Number(r.delivered || 0),
    failed: a.failed + Number(r.failed || 0), skipped: a.skipped + Number(r.skipped || 0),
  }), { sent: 0, delivered: 0, failed: 0, skipped: 0 });
  const byDayMap = {};
  for (const r of overview) {
    const k = r.day;
    if (!byDayMap[k]) byDayMap[k] = { day: k, sent: 0, delivered: 0 };
    byDayMap[k].sent += Number(r.sent || 0);
    byDayMap[k].delivered += Number(r.delivered || 0);
  }
  const byDay = Object.values(byDayMap).sort((a, b) => (a.day < b.day ? -1 : 1));

  const winPicker = (
    <div style={{ display: 'flex', gap: 6 }}>
      {WINDOWS.map((w) => (
        <button key={w} className={`badge-btn ${days === w ? 'accent' : ''}`} onClick={() => setDays(w)}>{w}d</button>
      ))}
    </div>
  );

  return (
    <div className="pg">
      <PageHead title="Analytics" sub="Delivery, engagement, and attribution across channels." actions={winPicker} />

      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
        <>
          <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
            <Kpi label={`Sent · ${days}d`} value={totals.sent} tone="gray" sub="messages handed to provider" />
            <Kpi label="Delivery rate" value={pct(totals.delivered, totals.sent)} tone="green" format={(v) => v.toFixed(1) + '%'} sub={`${totals.delivered.toLocaleString('en-IN')} delivered`} />
            <Kpi label="Failed / bounced" value={totals.failed} tone={totals.failed ? 'red' : 'gray'} sub="hard failures" />
            <Kpi label="Skipped" value={totals.skipped} tone={totals.skipped ? 'yellow' : 'gray'} sub="gate-blocked (incl. test mode)" />
          </div>

          <Panel title={`Sends by day · ${days}d`} action={<span className="dim" style={{ fontSize: 12 }}><span style={{ color: 'var(--accent,#F2CD1A)' }}>■</span> sent&nbsp;&nbsp;<span style={{ color: '#22c55e' }}>■</span> delivered</span>} pad>
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
                    <th>Sender</th><th>Channel</th><th className="num">Sent</th><th className="num">Delivered</th>
                    <th className="num">Delivery %</th><th className="num">Bounce %</th><th className="num">Complaint %</th>
                  </tr></thead>
                  <tbody>
                    {health.map((h) => (
                      <tr key={h.sender_identity_id}>
                        <td className="mono">{h.address}</td>
                        <td><Badge label={h.channel} tone="blue" /></td>
                        <td className="num mono">{h.sent}</td>
                        <td className="num mono">{h.delivered}</td>
                        <td className="num mono">{Number(h.delivered_rate ?? 0)}%</td>
                        <td className="num mono" style={{ color: Number(h.bounce_rate) > 2 ? '#ff7a7a' : undefined }}>{Number(h.bounce_rate ?? 0)}%</td>
                        <td className="num mono" style={{ color: Number(h.complaint_rate) > 0.1 ? '#ff7a7a' : undefined }}>{Number(h.complaint_rate ?? 0)}%</td>
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
