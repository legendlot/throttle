'use client';
// Overview / Control tower (handoff §7.1) — NEW screen at `/`.
// Answers "what's on air and how are we doing." Assembled ENTIRELY from
// existing RPCs (§9: no new endpoint): getSendsOverview + getDeliverabilityHealth
// + getCampaigns + getCampaignsOverview (+ getJourneysOverview for journey
// revenue, getRelaySettings for the test-mode lock chip). No write path.
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  Plus, Mail, MessageCircle, Send, Lock, ShieldAlert, CheckCircle2, Clock,
  GitBranch, FileEdit, RefreshCw,
} from 'lucide-react';
import { KpiStrip, Btn, EmptyState } from '@/components/ui.js';
import { TONES, fmtDateShort, inr } from '@/components/format.js';

const pctS = (num, den) => (den ? `${(Math.round((Number(num) / Number(den)) * 1000) / 10).toFixed(1)}%` : '—');

function ChIcon({ channel, size = 19 }) {
  const c = String(channel || '').toLowerCase();
  if (c === 'whatsapp') return <MessageCircle size={size} />;
  if (c === 'email') return <Mail size={size} />;
  return <Send size={size} />;
}
const CH_TONE = {
  whatsapp: { fg: '#25D366', bg: 'rgba(37,211,102,.13)' },
  email:    { fg: 'var(--em, #a78bfa)', bg: 'rgba(167,139,250,.13)' },
};

// Derived activity feed — synthesized from campaign rows (no activity RPC
// exists; this reads state honestly rather than inventing history).
function activityFrom(campaigns, overview) {
  const rows = [...campaigns]
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 8)
    .map((c) => {
      const o = overview[c.id] || {};
      const when = c.updated_at ? fmtDateShort(c.updated_at) : '';
      if (c.status === 'sent') return { icon: CheckCircle2, color: 'var(--green)', text: `“${c.name}” finished sending${o.delivered ? ` — ${Number(o.delivered).toLocaleString('en-IN')} delivered` : ''}`, time: when };
      if (c.status === 'sending') return { icon: RefreshCw, color: 'var(--orange)', text: `“${c.name}” is sending now`, time: when };
      if (c.status === 'pending_approval') return { icon: Clock, color: 'var(--accent)', text: `“${c.name}” submitted for approval`, time: when };
      if ((c.status === 'approved' || c.status === 'scheduled') && c.scheduled_at && new Date(c.scheduled_at) > new Date())
        return { icon: Clock, color: 'var(--blue)', text: `“${c.name}” scheduled for ${new Date(c.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`, time: when };
      if (c.status === 'draft') return { icon: FileEdit, color: 'var(--t2)', text: `“${c.name}” draft edited`, time: when };
      return { icon: Send, color: 'var(--t2)', text: `“${c.name}” — ${String(c.status || '').replace(/_/g, ' ')}`, time: when };
    });
  return rows.slice(0, 5);
}

export default function OverviewPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [overview7, setOverview7] = useState([]);
  const [health, setHealth] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [campOv, setCampOv] = useState({});
  const [journeyOv, setJourneyOv] = useState([]);
  const [settings, setSettings] = useState(null);

  // `silent` (the 15s sending-poll) refreshes data WITHOUT flipping the whole
  // page to a spinner — load() used to setLoading(true) on every tick, blanking
  // the Control tower mid-send every 15 seconds (hostile-review fix).
  const load = useCallback(async (silent = false) => {
    if (!session) return;
    if (!silent) setLoading(true);
    try {
      const [ov, hl, cs, co, jo, st] = await Promise.all([
        garageFetch('getSendsOverview', { days: 7 }, session).catch(() => null),
        garageFetch('getDeliverabilityHealth', { days: 7 }, session).catch(() => null),
        garageFetch('getCampaigns', {}, session),
        garageFetch('getCampaignsOverview', {}, session).catch(() => null),
        garageFetch('getJourneysOverview', {}, session).catch(() => null),
        // Non-fatal — unknown settings read as "test mode still ON" (fail safe).
        garageFetch('getRelaySettings', {}, session).catch(() => null),
      ]);
      setOverview7(Array.isArray(ov) ? ov : []);
      setHealth(Array.isArray(hl) ? hl : []);
      setCampaigns(Array.isArray(cs) ? cs : []);
      setCampOv(Array.isArray(co) ? Object.fromEntries(co.map((o) => [o.id, o])) : {});
      setJourneyOv(Array.isArray(jo) ? jo : []);
      setSettings(st || null);
    } catch (e) { if (!silent) showToast(e.message || 'Failed to load overview', 'error'); }
    finally { if (!silent) setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  // While a broadcast is fanning out, keep the "Sending now" card live —
  // silently: no spinner swap, no toast on a transient blip.
  const anySending = campaigns.some((c) => c.status === 'sending');
  useEffect(() => {
    if (!anySending) return undefined;
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [anySending, load]);

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  // ── derived ──
  const totals = overview7.reduce((a, r) => ({
    sent: a.sent + Number(r.sent || 0), delivered: a.delivered + Number(r.delivered || 0),
    opened: a.opened + Number(r.opened || 0), failed: a.failed + Number(r.failed || 0),
    spend: a.spend + Number(r.spend || 0),
  }), { sent: 0, delivered: 0, opened: 0, failed: 0, spend: 0 });
  const revenue = [...Object.values(campOv), ...journeyOv]
    .reduce((a, o) => a + Number(o?.attributed_revenue || 0), 0);
  const cost = [...Object.values(campOv), ...journeyOv]
    .reduce((a, o) => a + Number(o?.cost_inr || 0), 0);
  const roi = cost > 0 ? revenue / cost : null;

  const liveSends = campaigns.filter((c) => c.status === 'sending').map((c) => {
    const o = campOv[c.id] || {};
    const sent = Number(o.sent || 0);
    const total = Number(o.total || c.audience_snapshot || 0);
    return { id: c.id, name: c.name, channel: c.channel, sent, total,
      pct: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0 };
  });
  const pendingApproval = campaigns.filter((c) => c.status === 'pending_approval').length;
  const inQueue = liveSends.reduce((a, s) => a + Math.max(0, s.total - s.sent), 0);
  const locked = settings?.test_mode !== false;   // unknown fails toward LOCKED copy
  const activity = activityFrom(campaigns, campOv);

  // Deliverability quality per sender — same thresholds the Analytics page colors on.
  const senderRows = health.slice(0, 5).map((h) => {
    let quality, toneKey;
    if (h.channel === 'whatsapp') {
      quality = h.quality_rating ? String(h.quality_rating).toUpperCase() : 'NO SIGNAL';
      toneKey = quality === 'GREEN' || quality === 'HIGH' ? 'green'
        : quality === 'NO SIGNAL' ? 'gray'
        : quality === 'YELLOW' || quality === 'MEDIUM' ? 'yellow' : 'red';
      if (toneKey === 'green') quality = 'HIGH';
    } else {
      const watch = Number(h.bounce_rate) > 2 || Number(h.complaint_rate) > 0.1;
      quality = watch ? 'WATCH' : 'HEALTHY';
      toneKey = watch ? 'yellow' : 'green';
    }
    return { ...h, quality, tone: TONES[toneKey] || TONES.gray };
  });

  const kpis = [
    { label: 'Sent · 7d', value: totals.sent.toLocaleString('en-IN'), delta: `${totals.delivered.toLocaleString('en-IN')} delivered`, lead: true },
    { label: 'Delivery', value: pctS(totals.delivered, totals.sent), delta: 'of sent' },
    { label: 'Read rate', value: pctS(totals.opened, totals.delivered), delta: 'of delivered' },
    // Revenue/ROI come from campaign_stats_list + journey_stats_list, which have
    // no window param — they are ALL-TIME figures and must not read as 7d.
    { label: 'Attr. revenue', value: revenue ? inr(revenue) : '—', delta: 'last-touch · all time' },
    { label: 'Blended ROI', value: roi == null ? '—' : `${roi.toFixed(1)}×`, delta: 'rev ÷ spend · all time', color: roi != null ? 'var(--accent)' : undefined },
  ];

  return (
    <div className="pg">
      <div className="page-head" style={{ marginBottom: 22 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 30 }}>Control tower</h1>
          <p className="page-sub">Everything sending, right now — and how the last 7 days are landing.</p>
        </div>
        {(!perms || perms.campaign_build) && (
          <Btn kind="primary" onClick={() => router.push('/campaigns?new=1')}><Plus size={15} /> New campaign</Btn>
        )}
      </div>

      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
        <>
          <div className="ov-grid">
            {/* Sending now */}
            <div className="ov-card ov-card-live">
              <div className="ov-live-head">
                <span className="sb-onair-dot" />
                <span className="ov-live-l">SENDING NOW</span>
                <span className="ov-live-n">{liveSends.length} active</span>
              </div>
              {liveSends.length === 0
                ? <div style={{ padding: '18px 0 6px', fontSize: 13, color: 'var(--t3)' }}>Nothing on air. Approved broadcasts appear here the moment they start fanning out.</div>
                : liveSends.map((s) => {
                  const ct = CH_TONE[String(s.channel || '').toLowerCase()] || CH_TONE.email;
                  return (
                    <div key={s.id} className="ov-send-row" style={{ cursor: 'pointer' }} onClick={() => router.push('/campaigns')}>
                      <div className="ov-ch" style={{ color: ct.fg, background: ct.bg }}><ChIcon channel={s.channel} /></div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</div>
                        <div className="sb-onair-track" style={{ marginTop: 8 }}>
                          <span className="sb-onair-fill" style={{ display: 'block', width: `${s.pct}%` }} />
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>
                          {s.total > 0 ? `${s.sent.toLocaleString('en-IN')} / ${s.total.toLocaleString('en-IN')}` : `${s.sent.toLocaleString('en-IN')} sent`}
                        </div>
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 2 }}>{s.pct}%</div>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Queue & gates */}
            <div className="ov-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="ov-eyebrow">Queue &amp; gates</div>
              <div className="ov-qrow">
                <span className="ov-qlbl">In queue</span>
                <span className="ov-qval">{inQueue.toLocaleString('en-IN')}</span>
              </div>
              <div className="ov-qrow">
                <span className="ov-qlbl">Awaiting approval</span>
                {pendingApproval > 0
                  ? <span className="badge" style={{ color: TONES.yellow.fg, background: TONES.yellow.bg, border: `1px solid ${TONES.yellow.bd}` }}>{pendingApproval} pending</span>
                  : <span className="ov-qval">0</span>}
              </div>
              <div className="ov-qrow" style={{ marginBottom: 0 }}>
                <span className="ov-qlbl">Failed · 7d</span>
                <span className="ov-qval" style={totals.failed ? { color: 'var(--red)' } : undefined}>{totals.failed.toLocaleString('en-IN')}</span>
              </div>
              <div className={`ov-lock ${locked ? '' : 'ov-lock-open'}`} style={{ marginTop: 16 }}>
                {locked ? <Lock size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} /> : <ShieldAlert size={18} style={{ color: 'var(--red)', flexShrink: 0 }} />}
                <div>
                  {locked
                    ? <><strong>Test mode LOCKED</strong> — sends limited to the allowlist.</>
                    : <><strong>Test mode OPEN</strong> — real customers can be messaged.</>}
                </div>
              </div>
            </div>
          </div>

          <KpiStrip cells={kpis} />

          <div className="ov-2col">
            {/* Recent activity (derived from campaign state) */}
            <div className="ov-panel">
              <div className="ov-panel-head">Recent activity</div>
              <div style={{ padding: '6px 0' }}>
                {activity.length === 0
                  ? <EmptyState icon="send" title="No activity yet" hint="Campaign lifecycle events appear here." />
                  : activity.map((a, i) => {
                    const AIcon = a.icon;
                    return (
                      <div key={i} className="ov-act-row">
                        <AIcon size={17} strokeWidth={1.75} style={{ color: a.color, flexShrink: 0, marginTop: 1 }} />
                        <div className="ov-act-txt">{a.text}</div>
                        <span className="ov-act-time">{a.time}</span>
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Deliverability · 7d */}
            <div className="ov-panel">
              <div className="ov-panel-head">
                Deliverability · 7d
                <button className="ov-view-all" onClick={() => router.push('/analytics')}>VIEW ALL →</button>
              </div>
              {senderRows.length === 0
                ? <EmptyState icon="inbox" title="No sender activity" hint="Per-sender quality appears once messages send." />
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <tbody>
                      {senderRows.map((h) => (
                        <tr key={h.sender_identity_id || h.address}>
                          <td style={{ padding: '11px 18px', borderTop: '1px solid var(--row-border)' }}>
                            <div className="mono" style={{ fontSize: 12, color: '#d6d9dd' }}>{h.address}</div>
                            <div className="mono" style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2 }}>{h.channel}</div>
                          </td>
                          <td style={{ padding: '11px 12px', borderTop: '1px solid var(--row-border)', textAlign: 'right' }}>
                            <div className="mono" style={{ fontSize: 12, color: 'var(--t2)' }}>{Number(h.delivered || 0).toLocaleString('en-IN')}</div>
                            <div className="mono" style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2 }}>delivered</div>
                          </td>
                          <td style={{ padding: '11px 18px', borderTop: '1px solid var(--row-border)', textAlign: 'right' }}>
                            <span className="badge" style={{ color: h.tone.fg, background: h.tone.bg, border: `1px solid ${h.tone.bd}` }}>{h.quality}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </div>

          {/* Journeys on air — quick glance without leaving the tower */}
          {journeyOv.length > 0 && (
            <div className="ov-panel" style={{ marginTop: 16 }}>
              <div className="ov-panel-head">
                Journeys
                <button className="ov-view-all" onClick={() => router.push('/journeys')}>OPEN →</button>
              </div>
              <table className="dt">
                <thead><tr>
                  <th>Journey</th><th className="num">Enrolled · 30d</th><th className="num">In flight</th>
                  <th className="num">Revenue</th><th>Last activity</th>
                </tr></thead>
                <tbody>
                  {journeyOv.slice(0, 5).map((j) => (
                    <tr key={j.id} className="row-click" onClick={() => router.push('/journeys')}>
                      <td><GitBranch size={13} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--t4)' }} />{j.name}</td>
                      <td className="num mono">{j.enrolled_30d ?? '—'}</td>
                      <td className="num mono dim">{j.in_flight ?? '—'}</td>
                      <td className="num mono">{j.attributed_revenue ? inr(j.attributed_revenue) : '—'}</td>
                      <td className="mono dim">{j.at ? fmtDateShort(j.at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
