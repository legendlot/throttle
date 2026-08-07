'use client';
// M8 — Analytics. Pure render over the commsops analytics RPCs (sends_overview,
// deliverability_health, campaign_stats, campaign_attribution). All aggregation is
// SQL-side; this page never sees raw message/event rows.
import { useEffect, useState, useCallback, Fragment } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { BarChart3, RefreshCw, Download } from 'lucide-react';
import { PageHead, Panel, Kpi, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDateShort, inr } from '@/components/format.js';
import { istPresetRange, PRESETS } from '@/lib/dateRanges.js';

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

// Same escaping + "export exactly what is on screen" discipline as the campaigns and activity
// exports, so a shared CSV and a shared screenshot can never disagree.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(name, header, body) {
  const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// The journeys overview carries strictly MORE than the campaigns CSV already exports, and until
// now there was no way to get any of it out of the app. Rates go out as raw fractions alongside
// their counts so every figure is re-derivable in a sheet, and the failure classes are split out
// because a single `failed` column is 77% Meta declining to deliver.
function downloadJourneysCsv(rows) {
  downloadCsv('relay-journeys',
    ['Journey', 'Purpose', 'Status', 'Trigger', 'Re-enrolment', 'Last activity',
      'Enrolled', 'In flight', 'Completed', 'Sent', 'Delivered', 'Read', 'Clicked',
      'Failed (total)', 'Our defects', 'Meta declined', 'Invalid recipient', 'Transient', 'Other',
      'Skipped', 'Unsubscribes', 'Orders', 'Revenue (INR)', 'Spend (INR)', 'Unpriced', 'ROI',
      'Read rate', 'Click rate', 'Order rate', 'Defect rate', 'Fail rate', 'Skip rate',
      'Attribution window (days)'],
    rows.map((j) => {
      const f = j.by_failure_class || {};
      return [j.name, j.send_purpose || '', j.status, j.trigger?.name || '', j.reenrolment || '', j.at || '',
        j.enrolled ?? '', j.in_flight ?? '', j.completed ?? '', j.sent ?? '', j.delivered ?? '',
        j.opened ?? '', j.clicked ?? '',
        j.failed ?? '', f.our_defect ?? 0, f.meta_declined ?? 0, f.invalid_recipient ?? 0,
        f.transient ?? 0, f.other ?? 0,
        j.skipped ?? '', j.unsubscribes ?? '', j.attributed_orders ?? '',
        j.attributed_revenue ?? '', j.cost_inr ?? '', j.unpriced ?? '',
        j.send_purpose === 'utility' ? '' : (j.roi ?? ''),
        j.read_rate ?? '', j.click_rate ?? '', j.order_rate ?? '', j.defect_rate ?? '',
        j.fail_rate ?? '', j.skip_rate ?? '', j.window_days ?? ''];
    }));
}

// Per-sender failure export. The point of this one is triage: it answers "what broke, on which
// number, and is it ours" without anyone writing SQL — which is exactly what was needed the
// morning an OFD template started failing every send and nothing on any screen showed it.
function downloadFailuresCsv(health) {
  downloadCsv('relay-failures',
    ['Sender', 'Channel', 'Provider', 'Sent', 'Failed', 'Fail rate %',
      'Our defects', 'Meta declined', 'Invalid recipient', 'Transient', 'Other'],
    health.map((h) => {
      const f = h.by_failure_class || {};
      const sent = Number(h.sent || 0);
      return [h.address, h.channel, h.provider, sent, h.failed ?? 0,
        sent > 0 ? ((Number(h.failed || 0) / sent) * 100).toFixed(2) : '',
        f.our_defect ?? 0, f.meta_declined ?? 0, f.invalid_recipient ?? 0, f.transient ?? 0, f.other ?? 0];
    }));
}

export default function AnalyticsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [preset, setPreset] = useState('today');  // Afshaan: default every range picker to Today
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState([]);
  const [health, setHealth] = useState([]);
  const [camps, setCamps] = useState([]);
  const [journeys, setJourneys] = useState([]);
  // M15 — a failed RPC must not render as a fake zero. One flag for the whole data
  // domain (overview/health/campaigns/journeys load together); render an explicit
  // "unavailable" state instead of ₹0/empty rows when any of them fails.
  const [statsError, setStatsError] = useState(false);
  // Funnel, inline on this page. It previously existed ONLY inside the journey EDITOR — to see
  // why a journey was under-sending you had to open it for editing, one at a time, which is the
  // wrong posture for someone monitoring. Fetched lazily per journey and cached, so opening a
  // row costs one request and re-opening costs none.
  const [funnels, setFunnels] = useState({});   // {journeyId: funnel|'error'}
  const [openFunnel, setOpenFunnel] = useState(null);

  const toggleFunnel = useCallback(async (id) => {
    setOpenFunnel((cur) => (cur === id ? null : id));
    if (funnels[id] !== undefined) return;
    try {
      const f = await garageFetch('getJourneyFunnel', { id }, session);
      setFunnels((m) => ({ ...m, [id]: f || 'error' }));
    } catch { setFunnels((m) => ({ ...m, [id]: 'error' })); }
  }, [funnels, session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setStatsError(false);
    try {
      const [from, to] = istPresetRange(preset);
      const range = { from: from.toISOString(), to: to.toISOString() };
      const [ov, hl, cs, js] = await Promise.all([
        garageFetch('getSendsOverview', range, session).catch(() => { setStatsError(true); return null; }),
        garageFetch('getDeliverabilityHealth', range, session).catch(() => { setStatsError(true); return null; }),
        garageFetch('getCampaigns', {}, session).catch(() => { setStatsError(true); return null; }),
        // getJourneysOverview is ONE set-based RPC for every journey. It replaced a
        // getJourneys + per-journey getJourneyAttribution fan-out (an N+1 that made this page
        // cost one request per journey), and it is also the only source carrying `send_purpose`
        // and `by_failure_class` — both of which this page now needs.
        garageFetch('getJourneysOverview', {}, session).catch(() => { setStatsError(true); return null; }),
      ]);
      setOverview(Array.isArray(ov) ? ov : []);
      setHealth(Array.isArray(hl) ? hl : []);
      setJourneys(Array.isArray(js) ? js : []);

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
  }, [session, preset, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  // Overview totals + by-day series (aggregate across channel/purpose; chart oldest→newest).
  const totals = overview.reduce((a, r) => ({
    sent: a.sent + Number(r.sent || 0), delivered: a.delivered + Number(r.delivered || 0),
    opened: a.opened + Number(r.opened || 0),
    failed: a.failed + Number(r.failed || 0), skipped: a.skipped + Number(r.skipped || 0),
    spend: a.spend + Number(r.spend || 0),
  }), { sent: 0, delivered: 0, opened: 0, failed: 0, skipped: 0, spend: 0 });
  // ⚠️ REVENUE IS SPLIT BY SEND PURPOSE, and the headline is MARKETING ONLY.
  //
  // journey_attribution applies one 7-day last-touch window to every journey. That is meaningful
  // for a marketing nudge and meaningless for a message TRIGGERED BY an order: any later order in
  // the window gets credited to the confirmation that followed the first one, inverting cause and
  // effect. Measured 2026-08-07: utility journeys carried ₹236,978 — 39.9% of the old headline —
  // including ₹38,019 attributed to Order Cancelled, i.e. revenue credited to a cancellation notice.
  //
  // The number is still COMPUTED and still shown, just on its own line: suppressing it entirely
  // would hide a real signal (C2P genuinely converts COD→prepaid, and it is a utility journey).
  // Do NOT fold `utility` back into the headline.
  // Failure classes summed across senders. Sourced from deliverability health rather than
  // sends_overview because only the health RPC carries the classification.
  const failureTotals = health.reduce((a, h) => {
    const f = h.by_failure_class || {};
    a.our_defect += Number(f.our_defect || 0);
    a.meta_declined += Number(f.meta_declined || 0);
    a.invalid_recipient += Number(f.invalid_recipient || 0);
    return a;
  }, { our_defect: 0, meta_declined: 0, invalid_recipient: 0 });

  const campRevenue = camps.reduce((a, c) => a + Number(c.attr?.attributed_revenue || 0), 0);
  const jRevenue = journeys.reduce((acc, j) => {
    const v = Number(j.attributed_revenue || 0);
    if (j.send_purpose === 'utility') acc.utility += v; else acc.marketing += v;
    return acc;
  }, { marketing: 0, utility: 0 });
  const revenueTotal = campRevenue + jRevenue.marketing;   // headline: marketing only
  const utilityRevenue = jRevenue.utility;
  // Blended ROI must divide marketing revenue by MARKETING spend. Dividing by total spend would
  // charge the marketing return with the cost of every order confirmation and understate it —
  // a different wrong number in place of the one just fixed. sends_overview carries `purpose`,
  // so the denominator scopes to exactly the same set as the numerator.
  const marketingSpend = overview
    .filter((r) => r.purpose === 'marketing')
    .reduce((a, r) => a + Number(r.spend || 0), 0);
  const byDayMap = {};
  for (const r of overview) {
    const k = r.day;
    if (!byDayMap[k]) byDayMap[k] = { day: k, sent: 0, delivered: 0 };
    byDayMap[k].sent += Number(r.sent || 0);
    byDayMap[k].delivered += Number(r.delivered || 0);
  }
  const byDay = Object.values(byDayMap).sort((a, b) => (a.day < b.day ? -1 : 1));

  const presetLabel = (PRESETS.find((x) => x.key === preset) || {}).label || preset;
  const winPicker = (
    <div className="rtabs">
      {PRESETS.map((w) => (
        <button key={w.key} className={`rtab rtab-mono ${preset === w.key ? 'on' : ''}`} onClick={() => setPreset(w.key)}>{w.label}</button>
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
            <Kpi label={`Sent · ${presetLabel}`} value={totals.sent} tone="gray" sub="messages handed to provider" />
            <Kpi label="Delivery rate" value={pct(totals.delivered, totals.sent)} tone="green" format={(v) => v.toFixed(1) + '%'} sub={`${totals.delivered.toLocaleString('en-IN')} delivered`} />
            <Kpi label="Read rate" value={pct(totals.opened, totals.delivered)} tone="green" format={(v) => v.toFixed(1) + '%'} sub={`${totals.opened.toLocaleString('en-IN')} read · of delivered`} />
            {/* Split, because the single number was 77% Meta declining to deliver. A red tile
                driven by audience fatigue trains people to ignore it, which is how a genuine
                template defect sat unnoticed. `Our defects` is the only one worth alarming on. */}
            <Kpi label="Our defects" value={failureTotals.our_defect} tone={failureTotals.our_defect ? 'red' : 'gray'}
              sub="bugs — unresolved vars, template, config" />
            <Kpi label="Throttled by Meta" value={failureTotals.meta_declined} tone={failureTotals.meta_declined ? 'yellow' : 'gray'}
              sub="engagement limits — audience signal, not a fault" />
            <Kpi label="Skipped" value={totals.skipped} tone={totals.skipped ? 'yellow' : 'gray'} sub="gate-blocked (incl. test mode)" />
          </div>

          <div className="kpi-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 14 }}>
            <Kpi label={`Spend · ${presetLabel}`} value={totals.spend} tone="gray" format={(v) => inr(v)}
              sub={totals.spend > 0 ? 'per-conversation cost' : 'no priced sends (email is flat-rate)'} />
            <Kpi label="Attributed revenue" value={revenueTotal} tone="green" format={(v) => inr(v)}
              sub="campaigns + marketing journeys, last-touch" />
            <Kpi label="Transactional (excluded)" value={utilityRevenue} tone="gray" format={(v) => inr(v)}
              sub="utility journeys — order-triggered, not causal" />
            <Kpi label="Marketing ROI" value={roi(revenueTotal, marketingSpend) ?? 0}
              tone={roi(revenueTotal, marketingSpend) == null ? 'gray' : 'green'}
              format={() => fmtRoi(roi(revenueTotal, marketingSpend))}
              sub={marketingSpend > 0 ? 'marketing revenue ÷ marketing spend' : 'needs priced marketing sends'} />
          </div>

          <Panel title={`Sends by day · ${presetLabel}`} action={<span className="dim" style={{ fontSize: 12 }}><span style={{ color: 'var(--accent,#F2CD1A)' }}>■</span> sent&nbsp;&nbsp;<span style={{ color: 'var(--green, #34d399)' }}>■</span> delivered</span>} pad>
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
            action={journeys.length > 0
              ? <Btn onClick={() => downloadJourneysCsv(journeys)}><Download size={13} /> Export CSV</Btn>
              : <span className="dim" style={{ fontSize: 12 }}>revenue ÷ conversion per journey</span>}>
            {journeys.length === 0
              ? <EmptyState icon="git-branch" title="No journeys yet" hint="Triggered, revenue and conversion per journey appear here once enrolments run." />
              : (
                <div className="table-scroll">
                <table className="dt">
                  <thead><tr>
                    <th>Journey</th><th>Purpose</th><th>Status</th><th className="num">Triggered</th><th className="num">Sent</th>
                    <th className="num">Delivered</th><th className="num">Read</th><th className="num">Clicked</th>
                    <th className="num">Defects</th><th className="num">Throttled</th>
                    <th className="num">Orders</th><th className="num">Revenue</th><th className="num">Spend</th><th className="num">ROI</th>
                  </tr></thead>
                  <tbody>
                    {journeys.map((j) => {
                      const fc = j.by_failure_class || {};
                      const isUtility = j.send_purpose === 'utility';
                      const f = funnels[j.id];
                      const isOpen = openFunnel === j.id;
                      const maxEntered = (f && f !== 'error' && (f.steps || []).length)
                        ? Math.max(...f.steps.map((s) => Number(s.entered || 0)), 1) : 1;
                      return (
                        // Keyed FRAGMENT: the fragment is the mapped element, so the key belongs
                        // here — keys on the inner <tr>s would leave React warning on every render.
                        <Fragment key={j.id}>
                        <tr>
                          <td>
                            <button onClick={() => toggleFunnel(j.id)}
                              title="Show enrolment funnel"
                              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer',
                                       color: 'inherit', font: 'inherit', textAlign: 'left' }}>
                              <span className="dim" style={{ marginRight: 6 }}>{isOpen ? '▾' : '▸'}</span>{j.name}
                            </button>
                          </td>
                          {/* Purpose gets its OWN colour space: marketing green, utility blue.
                              It must never be gray — gray is the STATUS vocabulary (draft/archived),
                              and a utility badge sharing it reads as "inactive" rather than
                              "transactional". Different axis, different colour. */}
                          <td><Badge label={j.send_purpose || '—'} tone={isUtility ? 'blue' : 'green'} /></td>
                          <td><Badge label={j.status} tone={j.status === 'active' ? 'green' : 'gray'} /></td>
                          <td className="num mono">{j.enrolled ?? 0}</td>
                          <td className="num mono">{j.sent ?? 0}</td>
                          <td className="num mono">{j.delivered ?? 0}</td>
                          <td className="num mono">{j.opened ?? 0}</td>
                          <td className="num mono">{j.clicked ?? 0}</td>
                          {/* our_defect is the ONLY failure bucket anyone can act on — it is a bug.
                              Kept in its own column, and red at any non-zero value, because it was
                              previously averaged into a single `failed` number that is 77% Meta
                              declining to deliver and therefore never looked alarming. */}
                          <td className="num mono" style={fc.our_defect ? { color: 'var(--red,#f87171)', fontWeight: 600 } : undefined}>
                            {fc.our_defect || <span className="dim">—</span>}
                          </td>
                          {/* Meta declined: an AUDIENCE signal (fatigue / per-user limits), not a
                              fault. Amber, never red — nothing in the codebase can fix it. */}
                          <td className="num mono" style={fc.meta_declined ? { color: 'var(--yellow,#fbbf24)' } : undefined}>
                            {fc.meta_declined || <span className="dim">—</span>}
                          </td>
                          <td className="num mono">{j.attributed_orders ?? 0}</td>
                          <td className="num mono" title={isUtility ? 'Excluded from the headline — order-triggered, not causal' : undefined}>
                            {inr(j.attributed_revenue ?? 0)}{isUtility ? <span className="dim"> *</span> : null}
                          </td>
                          <td className="num mono">{Number(j.cost_inr) > 0 ? inr(j.cost_inr) : <span className="dim">—</span>}</td>
                          {/* ROI is SUPPRESSED for utility journeys. Their revenue is excluded
                              from the headline as non-causal, so dividing it by a tiny
                              transactional spend produces a spectacular and meaningless ratio —
                              Order Cancelled read 1806.56x purely because it costs Rs 21 and the
                              7-day window happened to catch Rs 38k of unrelated orders. A number
                              that large is read as a result no matter how much fine print sits
                              beside it. Computed and exported raw; hidden where it would mislead. */}
                          <td className="num mono">{isUtility ? <span className="dim" title="Not meaningful — transactional revenue is not attributable to this message">—</span> : fmtRoi(j.roi == null ? null : Number(j.roi))}</td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={14} style={{ background: 'var(--surface-2, rgba(0,0,0,.15))', padding: '10px 14px' }}>
                              {f === undefined ? <span className="dim" style={{ fontSize: 12 }}>Loading funnel…</span>
                                : f === 'error' ? <span className="dim" style={{ fontSize: 12 }}>Funnel unavailable — retry from the journey page.</span>
                                : (f.steps || []).length === 0 ? <span className="dim" style={{ fontSize: 12 }}>No enrolments yet.</span>
                                : (
                                  <div style={{ display: 'grid', gap: 4 }}>
                                    {f.steps.map((s) => {
                                      // Per-branch outcomes. A multi-step journey's real signal is
                                      // WHICH WAY people went — for C2P, 295 confirmed COD, 76
                                      // cancelled, 13 asked to pay. That was recorded from day one
                                      // and never rendered anywhere. Only shown when a step
                                      // actually branched; a single-outcome step is just its bar.
                                      const rk = Object.keys(s.results || {});
                                      const vals = s.result_values || {};
                                      return (
                                      <div key={s.step_id} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 70px', gap: 8, alignItems: 'center' }}>
                                        <span className="dim mono" style={{ fontSize: 11 }}>{s.step_type} · {s.step_id}</span>
                                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                          <span style={{ background: 'var(--accent,#F2CD1A)', height: 8, borderRadius: 4, flexShrink: 0,
                                                         width: `${Math.max(2, (Number(s.entered || 0) / maxEntered) * 100)}%` }} />
                                          {rk.length > 1 && (
                                            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                              {rk.sort((a, b) => Number(s.results[b]) - Number(s.results[a])).map((k) => (
                                                <span key={k} className="mono" style={{ fontSize: 10.5, color: 'var(--t3,#9aa0aa)',
                                                        border: '1px solid var(--line,rgba(255,255,255,.11))', borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap' }}
                                                      title={vals[k] != null ? `${inr(vals[k])} of triggering order value took this branch` : undefined}>
                                                  {k} {Number(s.results[k]).toLocaleString('en-IN')}
                                                  {vals[k] ? <span className="dim"> · {inr(vals[k])}</span> : null}
                                                </span>
                                              ))}
                                            </span>
                                          )}
                                        </span>
                                        <span className="num mono" style={{ fontSize: 12 }}>{Number(s.entered || 0).toLocaleString('en-IN')}</span>
                                      </div>
                                      );
                                    })}
                                    <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                                      {Object.entries(f.enrolments || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                                    </div>
                                  </div>
                                )}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
          </Panel>

          <Panel title={`Deliverability · ${presetLabel}`} count={health.length} pad
            action={health.length > 0
              ? <Btn onClick={() => downloadFailuresCsv(health)}><Download size={13} /> Export failures</Btn>
              : null}>
            {health.length === 0
              ? <EmptyState icon="mail" title="No sender activity" hint="Bounce and complaint rates per sender identity appear here once emails are sent." />
              : (
                <div className="table-scroll">
                <table className="dt">
                  <thead><tr>
                    <th>Sender</th><th>Channel</th><th>Quality</th><th className="num">Sent</th><th className="num">Delivered</th>
                    <th className="num">Delivery %</th><th className="num">Read %</th>
                    <th className="num">Defects</th><th className="num">Throttled</th><th className="num">Invalid</th>
                    <th className="num">Bounce %</th>
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
                        {/* The failure split. Before this the surface showed no `failed` at all,
                            so a 65.67% delivery rate on a sender had no visible explanation. */}
                        <td className="num mono" style={h.by_failure_class?.our_defect ? { color: 'var(--red,#ff7a7a)', fontWeight: 600 } : undefined}>
                          {h.by_failure_class?.our_defect || <span className="dim">—</span>}
                        </td>
                        <td className="num mono" style={h.by_failure_class?.meta_declined ? { color: 'var(--yellow,#fbbf24)' } : undefined}>
                          {h.by_failure_class?.meta_declined || <span className="dim">—</span>}
                        </td>
                        <td className="num mono">{h.by_failure_class?.invalid_recipient || <span className="dim">—</span>}</td>
                        {/* bounce/complaint are EMAIL concepts. The RPC returns null for other
                            channels now, so a WhatsApp sender shows a dash rather than a 0 that
                            reads as "measured, none happened". */}
                        <td className="num mono" style={{ color: Number(h.bounce_rate) > 2 ? '#ff7a7a' : undefined }}>
                          {h.bounce_rate == null ? <span className="dim">—</span> : `${Number(h.bounce_rate)}%`}
                        </td>
                        <td className="num mono" style={{ color: Number(h.complaint_rate) > 0.1 ? '#ff7a7a' : undefined }}>
                          {h.complaint_rate == null ? <span className="dim">—</span> : `${Number(h.complaint_rate)}%`}
                        </td>
                        <td className="num mono">{Number(h.spend) > 0 ? inr(h.spend) : <span className="dim">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
          </Panel>
        </>
      )}
    </div>
  );
}

