'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Send, ShieldCheck, X, AlertTriangle, Clock, Mail, MessageCircle, Download, OctagonX } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi, KpiStrip, ChannelChip } from '@/components/ui.js';
import { fmtDateTime, inr } from '@/components/format.js';
import { TemplatePreview, TemplateValues } from '@/components/TemplatePreview.js';
import { UtmFields, UtmMarketingNote } from '@/components/utm.js';
import { useNewParam } from '@/lib/useNewParam.js';
import VariantSetup from './VariantSetup.js';
import VariantProgress from './VariantProgress.js';
import VariantResults, { STATE_META } from './VariantResults.js';

const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 1000) / 10 : 0);
// campaign_stats_list returns rates as fractions; null = no denominator (nothing sent/delivered)
// which is NOT the same as 0% — render an em dash so an unsent draft never reads as a 0% result.
const rate = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// Channel glyph — WhatsApp and email read very differently at a glance in a mixed list.
function ChannelIcon({ channel }) {
  const c = String(channel || '').toLowerCase();
  if (c === 'whatsapp') return <MessageCircle size={13} style={{ color: 'var(--wa, #25D366)' }} aria-label="WhatsApp" />;
  if (c === 'email') return <Mail size={13} style={{ color: 'var(--em, #a78bfa)' }} aria-label="Email" />;
  return <Send size={13} style={{ color: 'var(--text-4)' }} aria-label={c || 'channel'} />;
}

// ChannelChip moved to @/components/ui.js (2026-08-10) — the Analytics campaigns table had no
// channel marker at all because this definition was local to this page. One copy only.
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Which tab a campaign belongs to. Mirrors campaignStatus() so the chip and the tab can
// never disagree — a campaign filed under "Scheduled" must be the one showing a Scheduled chip.
function tabOf(r) {
  const s = r?.status || 'draft';
  const future = r?.scheduled_at && new Date(r.scheduled_at) > new Date();
  if ((s === 'approved' || s === 'scheduled') && future) return 'scheduled';
  if (s === 'sent' || s === 'sending' || s === 'paused' || s === 'stopped') return 'sent';
  if (s === 'draft' || s === 'pending_approval') return 'drafts';
  return 'other';
}
const TABS = [
  { id: 'all', label: 'All broadcasts' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'sent', label: 'Sent' },
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Export exactly what is on screen (same rows, same filter) so a shared CSV and a shared
// screenshot can never disagree. Rates go out as raw fractions AND counts so the numbers are
// re-derivable in a sheet; 'unpriced' rides along because a cost figure without it misleads.
//
// `experiments` is the SAME campaign_id-keyed map built for the A/B chip (one listExperiments
// call, not a per-row fetch — see load()). Per-arm numbers come from that row's verdict_snapshot,
// i.e. exactly what was decided and when — the same frozen data the experiment log renders, never
// a live recompute. A campaign whose test hasn't been decided yet exports as "in progress"; its
// live per-arm numbers are on its own detail page (VariantResults.js), which this bulk export is
// not trying to replace.
function downloadCampaignsCsv(rows, overview, tab, experiments = {}) {
  const header = ['Broadcast', 'Channel', 'Purpose', 'Status', 'Sent/scheduled at',
    'Revenue (INR)', 'Cost (INR)', 'Unpriced msgs', 'ROI',
    'Targeted', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Orders',
    'Unsubscribes', 'Failed', 'Skipped',
    'Read rate', 'Click rate', 'Order rate', 'Unsub rate', 'Fail rate', 'Skip rate',
    'Attribution window (days)',
    'A/B test', 'A/B verdict', 'A/B winner',
    'Arm A', 'Arm A sent', 'Arm A read', 'Arm A read rate',
    'Arm B', 'Arm B sent', 'Arm B read', 'Arm B read rate'];
  const body = rows.map((r) => {
    const o = overview[r.id] || {};
    const st = campaignStatus(r);
    const exp = experiments[r.id] || null;
    const snap = exp?.verdict_snapshot?.verdict || null;
    const armA = snap?.arms?.[0] || null, armB = snap?.arms?.[1] || null;
    const verdictLabel = !exp ? '' : snap ? (STATE_META[snap.state]?.label || snap.state) : 'In progress — not yet decided';
    return [r.name, r.channel, r.purpose, st.label, o.at || '',
      o.attributed_revenue ?? '', o.cost_inr ?? '', o.unpriced ?? '', o.roi ?? '',
      o.total ?? '', o.sent ?? '', o.delivered ?? '', o.opened ?? '', o.clicked ?? '',
      o.attributed_orders ?? '', o.unsubscribes ?? '', o.failed ?? '', o.skipped ?? '',
      o.read_rate ?? '', o.click_rate ?? '', o.order_rate ?? '', o.unsub_rate ?? '',
      o.fail_rate ?? '', o.skip_rate ?? '', o.window_days ?? '',
      exp ? 'Yes' : '', verdictLabel, snap?.winner || '',
      armA?.label ?? '', armA?.sent ?? '', armA?.read ?? '', armA?.readRate ?? '',
      armB?.label ?? '', armB?.sent ?? '', armB?.read ?? '', armB?.readRate ?? ''];
  });
  const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `relay-broadcasts-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Must track the adapters the worker actually has (send.js ADAPTERS). This read 'email' only
// from the original UI build, when email was the sole adapter — the WhatsApp adapter landed
// later and nothing widened it, so a channel the whole backend supports was unreachable from
// the UI. Same failure as the journey trigger picker's hardcoded 7-event list. If a new adapter
// is added to send.js, add it here in the same change.
const CHANNELS = ['email', 'sms', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATUS_TONE = {
  draft: 'gray', pending_approval: 'yellow', approved: 'blue', scheduled: 'yellow',
  sending: 'orange', sent: 'green', stopped: 'red',
};

// Friendly, at-a-glance campaign state derived from the raw lifecycle status.
// "Scheduled" is NOT a stored status — it's approved with a future scheduled_at.
// Failed/Paused are intentionally omitted: the engine has no such states (a dead
// fan-out surfaces via comms.queue_failures, not a campaign status) — BACKLOG [relay].
function campaignStatus(r) {
  const s = r?.status || 'draft';
  const future = r?.scheduled_at && new Date(r.scheduled_at) > new Date();
  if ((s === 'approved' || s === 'scheduled') && future)
    return { label: 'Scheduled', tone: 'blue', dot: true,
      sub: `fires ${new Date(r.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` };
  switch (s) {
    case 'draft':            return { label: 'Draft', tone: 'gray' };
    case 'pending_approval': return { label: 'Pending approval', tone: 'yellow', dot: true };
    case 'approved':
    case 'scheduled':        return { label: 'Approved', tone: 'blue' };
    case 'sending':          return { label: 'In progress', tone: 'orange', dot: true };
    case 'sent':             return { label: 'Sent', tone: 'green', dot: true };
    // Stopped is a PAUSE, not a failure — "Send now" resumes it and already-sent people are
    // deduped. Say so in the label, or it reads as a dead campaign nobody dares touch.
    case 'stopped':          return { label: 'Stopped — resumable', tone: 'red', dot: true };
    case 'paused':           return { label: 'Paused — template blocked by Meta', tone: 'red', dot: true };
    default:                 return { label: s.replace(/_/g, ' '), tone: STATUS_TONE[s] || 'gray' };
  }
}

// A WhatsApp url-button's address is frozen when Meta approves the template, and the send path
// deliberately never rewrites a button parameter (appending utm_* to what is only a SUFFIX would
// corrupt the resolved link). So a url button WITHOUT `target_base` — i.e. one not re-approved in
// the `https://host/r/{{1}}` redirect form — cannot carry UTMs and cannot be click-tracked, no
// matter how completely the UTM fields are filled in.
//
// This warning exists because the UI otherwise promises the opposite. "Freedom to Play Sale_14 Aug"
// went out on 2026-08-14 with a full UTM set on BOTH the campaign and the template, and recorded
// 3,528 sent / 1,958 delivered / 0 clicks / 0 attributed orders — permanently. Nothing on screen
// had said the link was untaggable, and `target_base` is not settable anywhere in this app, so the
// only signal available to whoever built it was a UTM panel that looked correctly configured.
function untrackableButtons(tpl) {
  const btns = tpl?.content?.buttons;
  if (!Array.isArray(btns)) return [];
  return btns.filter((b) => String(b?.type || '').toUpperCase() === 'URL' && b?.url && !b?.target_base);
}

function emptyCampaign() {
  return { id: null, name: '', channel: 'email', purpose: 'marketing', segment_id: '', template_id: '', vars: '{}', scheduled_at: '', status: 'draft', audience_snapshot: null, reject_reason: null, utm: null,
    // Audience exclusions (S276) — all three optional, all evaluated live during the fan-out.
    exclude_segment_ids: [], exclude_campaign_ids: [], exclude_contacted_hours: '' };
}

// Presets for "don't contact anyone messaged in the last N hours". Free entry is still allowed;
// these just cover what people actually ask for ("not again today", "not this week").
const CONTACTED_WINDOWS = [
  { v: '', label: 'Off — no time-based exclusion' },
  { v: '6', label: '6 hours' },
  { v: '24', label: '24 hours (a day)' },
  { v: '48', label: '48 hours' },
  { v: '72', label: '72 hours (3 days)' },
  { v: '168', label: '7 days' },
  { v: '336', label: '14 days' },
  { v: '720', label: '30 days' },
];

// Compact multi-select: a scrollable checkbox list. Deliberately not a <select multiple> —
// ctrl-clicking to keep a selection is the single most misused control on the web, and losing
// an exclusion by mis-clicking means a customer gets a message they were meant to be spared.
function ExcludePicker({ options, selected, onToggle, disabled, empty, renderLabel }) {
  if (!options.length) return <div className="dim" style={{ fontSize: 12 }}>{empty}</div>;
  return (
    <div style={{ maxHeight: 132, overflowY: 'auto', border: '1px solid var(--border)',
      borderRadius: 6, padding: '4px 6px', background: 'var(--surface-2, transparent)' }}>
      {options.map((o) => (
        <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 2px',
          fontSize: 12.5, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
          <input type="checkbox" checked={selected.includes(o.id)} disabled={disabled}
            onChange={() => onToggle(o.id)} style={{ cursor: disabled ? 'default' : 'pointer' }} />
          <span>{renderLabel(o)}</span>
        </label>
      ))}
    </div>
  );
}

export default function CampaignsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [overview, setOverview] = useState({});
  // A/B chip + CSV per-arm export both key off this — ONE listExperiments call for the whole
  // list (already built for the experiment log, S272), never a per-row fetch. campaign_id →
  // experiment row (hypothesis/verdict_snapshot/learning). Presence of a row is the chip's
  // signal: an experiment row is created in the SAME write as arm B (saveCampaignVariant), so
  // "has an experiment" tracks "was ever a 2+-arm test" — it does not un-flag a campaign whose
  // arm B was later deleted back down to one, which is an accepted, rare edge case absent a
  // bulk variant-count endpoint (adding one means touching the worker, out of scope here).
  const [experiments, setExperiments] = useState({});
  const [tab, setTab] = useState('all');
  const [segments, setSegments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [c, setC] = useState(emptyCampaign());
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState(null);
  const [attr, setAttr] = useState(null);
  const [reach, setReach] = useState(null);   // {loading}|{total,reachable} for the picked segment × (channel,purpose)
  const [testTo, setTestTo] = useState('');
  // WA tests: country code is a selector (default +91) so nobody hand-types prefixes.
  // Bare-digit entries get the selected code; entries pasted with a leading + pass through.
  const [testCc, setTestCc] = useState('+91');
  const composeTestTo = () => c.channel !== 'whatsapp' ? testTo
    : testTo.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.startsWith('+') ? s.replace(/[^\d+]/g, '') : testCc + s.replace(/\D/g, '').replace(/^0+/, ''))
        .join(',');
  const [testBusy, setTestBusy] = useState(false);
  const [testResults, setTestResults] = useState(null);
  // Live test-mode flag (review M12) — undefined while unloaded/unreachable, which the banner
  // and confirm text below both treat as "unknown → assume test mode is still ON" (fail safe).
  const [settings, setSettings] = useState(null);

  const canBuild = !perms || perms.campaign_build;
  const canApprove = !perms || perms.approve;
  const canSend = !perms || perms.send_activate;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [cs, sg, tp, ov, st, ex] = await Promise.all([
        garageFetch('getCampaigns', {}, session),
        garageFetch('getSegments', {}, session),
        // Archived templates are excluded from the picker (S252): archiving means
        // "retired, do not wire this up again". Templates already bound to an
        // existing campaign keep working — the send path deliberately does not check
        // status, since silently breaking a live flow is worse than letting it send.
        garageFetch('getTemplates', {}, session).then((r) =>
          (Array.isArray(r) ? r : []).filter((x) => x.status !== 'archived')),
        // ONE set-based call for every campaign's metrics — never per-row getCampaignStats.
        // Non-fatal: the list still renders (with — in the metric columns) if analytics fail.
        garageFetch('getCampaignsOverview', {}, session).catch(() => null),
        // Non-fatal (review M12): a failed/denied fetch leaves settings null, which the banner
        // and sendNow() confirm both read as "test mode unknown" and default to the SAFE copy.
        garageFetch('getRelaySettings', {}, session).catch(() => null),
        // A/B chip (S272) — ONE bulk call, not one per row. Non-fatal: the list still renders,
        // just without the chip / per-arm CSV columns, if this fails.
        garageFetch('listExperiments', {}, session).catch(() => null),
      ]);
      setRows(Array.isArray(cs) ? cs : []);
      setSegments(Array.isArray(sg) ? sg : []);
      setTemplates(Array.isArray(tp) ? tp : []);
      setOverview(Array.isArray(ov) ? Object.fromEntries(ov.map((o) => [o.id, o])) : {});
      setSettings(st || null);
      setExperiments(Array.isArray(ex) ? Object.fromEntries(ex.map((e) => [e.campaign_id, e])) : {});
    } catch (e) { showToast(e.message || 'Failed to load campaigns', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function fromRow(r) {
    return {
      id: r.id, name: r.name || '', channel: r.channel || 'email', purpose: r.purpose || 'marketing',
      segment_id: r.segment_id || '', template_id: r.template_id || '',
      vars: JSON.stringify(r.vars || {}, null, 0), scheduled_at: r.scheduled_at ? String(r.scheduled_at).slice(0, 16) : '',
      status: r.status || 'draft', audience_snapshot: r.audience_snapshot ?? null, reject_reason: r.reject_reason || null,
      utm: (r.utm && typeof r.utm === 'object') ? r.utm : null,
      exclude_segment_ids: Array.isArray(r.exclude_segment_ids) ? r.exclude_segment_ids : [],
      exclude_campaign_ids: Array.isArray(r.exclude_campaign_ids) ? r.exclude_campaign_ids : [],
      exclude_contacted_hours: r.exclude_contacted_hours == null ? '' : String(r.exclude_contacted_hours),
    };
  }
  function startNew() { setC(emptyCampaign()); setStats(null); setAttr(null); setView('form'); }
  // ⌘K "New campaign" — cross-screen ?new=1 + same-screen relay:new event.
  useNewParam(canBuild, startNew);
  // Deep-link from the experiment log ("open this campaign") — ?open=<id> opens straight into
  // the detail view. Same one-shot-consume-then-clean-the-URL shape as useNewParam.js's ?new=1,
  // kept inline here rather than a second hook since it fires `open(row)` with an id, not a
  // no-arg callback. `open` is a hoisted function declaration, so referencing it before its own
  // line below is safe.
  useEffect(() => {
    if (typeof window === 'undefined' || !session) return;
    const id = new URLSearchParams(window.location.search).get('open');
    if (!id) return;
    window.history.replaceState(null, '', window.location.pathname);
    open({ id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  // Per-campaign performance (M8) — only meaningful once the campaign has actually sent
  // (incl. 'paused': Meta blocking a bound template mid-send does not undo the messages that
  // already went out before the block — hiding stats then hides an incident, not nothing).
  const loadStats = useCallback(async (id, status) => {
    if (!id || !['sending', 'sent', 'paused', 'stopped'].includes(status)) { setStats(null); setAttr(null); return; }
    try {
      const [st, at] = await Promise.all([
        garageFetch('getCampaignStats', { id }, session),
        garageFetch('getCampaignAttribution', { id }, session),
      ]);
      setStats(st || null); setAttr(at || null);
    } catch { /* non-fatal */ }
  }, [session]);
  async function open(r) {
    setC(fromRow(r)); setStats(null); setAttr(null);
    setView('form');
    try {
      const fresh = await garageFetch('getCampaign', { id: r.id }, session);
      if (fresh?.id) { setC(fromRow(fresh)); loadStats(fresh.id, fresh.status); }
    } catch { /* non-fatal */ }
  }
  async function refresh() {
    if (!c.id) return;
    try {
      const fresh = await garageFetch('getCampaign', { id: c.id }, session);
      if (fresh?.id) { setC(fromRow(fresh)); loadStats(fresh.id, fresh.status); } load();
    } catch { /* non-fatal */ }
  }
  // While a broadcast is fanning out, poll so the detail auto-flips draft→sending→sent
  // without the operator hitting refresh (the Queue drains over a minute or two).
  // ⚠️ Verified for 'paused' (review gap b): the effect keys on c.status, so the moment a
  // mid-flight campaign flips to 'paused' this condition goes true and the interval is never
  // (re-)armed — it does NOT spin forever polling a campaign that stopped progressing.
  useEffect(() => {
    if (view !== 'form' || c.status !== 'sending' || !c.id) return undefined;
    const t = setInterval(async () => {
      try {
        const fresh = await garageFetch('getCampaign', { id: c.id }, session);
        if (fresh?.id) { setC(fromRow(fresh)); loadStats(fresh.id, fresh.status); if (fresh.status !== 'sending') load(); }
      } catch { /* non-fatal */ }
    }, 4000);
    return () => clearInterval(t);
  }, [view, c.status, c.id, session, load, loadStats]);

  // Reachable-audience preview (Pruthvi) — how many recipients are actually reachable
  // for the chosen segment on this (channel, purpose), BEFORE send. Debounced so flipping
  // segment/channel/purpose doesn't spam. reachable = segment total − channel suppressions
  // − (marketing) not-opted-in consent — the STABLE gate subset; the per-send freq-cap +
  // quiet-hours gates are time-dependent and deliberately NOT counted here.
  // S276: this now calls campaignReach, not previewSegment, so the number shown INCLUDES the
  // campaign's exclusion rules and matches what the fan-out will actually send (both sides run
  // comms.campaign_excluded — one predicate, no drift). `excludeKey` is a stable string so the
  // effect re-fires when an exclusion changes without making the array identity a dependency.
  const excludeKey = `${(c.exclude_segment_ids || []).join(',')}|${(c.exclude_campaign_ids || []).join(',')}|${c.exclude_contacted_hours}`;
  useEffect(() => {
    if (view !== 'form' || !c.segment_id) { setReach(null); return undefined; }
    let cancelled = false;
    setReach({ loading: true });
    const t = setTimeout(async () => {
      try {
        const r = await workerFetch('campaignReach', {
          segment_id: c.segment_id, channel: c.channel, purpose: c.purpose,
          exclude_segment_ids: c.exclude_segment_ids || [],
          exclude_campaign_ids: c.exclude_campaign_ids || [],
          exclude_contacted_hours: c.exclude_contacted_hours === '' ? null : Number(c.exclude_contacted_hours),
        }, session);
        if (!cancelled) setReach(r?.data ? {
          total: Number(r.data.total || 0), reachable: Number(r.data.reachable || 0),
          excluded: Number(r.data.excluded || 0), sendable: Number(r.data.sendable || 0),
        } : null);
      } catch { if (!cancelled) setReach(null); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, c.segment_id, c.channel, c.purpose, excludeKey, session]);

  // Only DRAFT campaigns may be excluded-against meaningfully? No — any campaign that has sent
  // is a valid exclusion source, and one still sending is the most valuable (that is the
  // "don't double-hit while both are running" case). Excluded: this campaign itself (the worker
  // also strips it — self-exclusion would stall the fan-out on its own in-flight rows).
  const excludableCampaigns = useMemo(
    () => rows.filter((r) => r.id !== c.id && r.status !== 'draft'),
    [rows, c.id]);

  function set(k, v) { setC((p) => ({ ...p, [k]: v })); }

  const isDraft = c.status === 'draft';

  async function save() {
    if (!c.name.trim()) { showToast('Name required', 'error'); return; }
    let vars = {};
    try { vars = c.vars.trim() ? JSON.parse(c.vars) : {}; } catch { showToast('Constants must be valid JSON', 'error'); return; }
    setBusy(true);
    try {
      const payload = {
        name: c.name.trim(), channel: c.channel, purpose: c.purpose,
        segment_id: c.segment_id || null, template_id: c.template_id || null,
        vars, scheduled_at: c.scheduled_at ? new Date(c.scheduled_at).toISOString() : null,
        utm: c.utm || null,
        exclude_segment_ids: c.exclude_segment_ids || [],
        exclude_campaign_ids: c.exclude_campaign_ids || [],
        // '' → null server-side ("rule off"); the worker re-validates rather than trusting this.
        exclude_contacted_hours: c.exclude_contacted_hours === '' ? null : Number(c.exclude_contacted_hours),
      };
      if (c.id) payload.id = c.id;
      const r = await workerFetch('saveCampaign', payload, session);
      if (r?.data?.id && !c.id) set('id', r.data.id);
      showToast(c.id ? 'Campaign saved' : 'Campaign created', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setBusy(false); }
  }

  async function sendTest() {
    setTestBusy(true); setTestResults(null);
    try {
      // Send the ON-SCREEN form, not the last-saved row — otherwise the preview shows your
      // values while the test quietly uses the saved ones, and they disagree.
      let draftVars = {};
      try { draftVars = c.vars && c.vars.trim() ? JSON.parse(c.vars) : {}; } catch { draftVars = {}; }
      const r = await workerFetch('sendCampaignTest', {
        id: c.id, to: composeTestTo(),
        draft: { channel: c.channel, purpose: c.purpose, template_id: c.template_id, vars: draftVars },
      }, session);
      const rows = r?.data?.results || r?.results || [];
      setTestResults(rows);
      // A test that was gated is NOT a success — say so, or the operator reads green and ships.
      const ok = rows.filter((x) => x.status === 'sent' || x.status === 'queued').length;
      showToast(ok === rows.length ? `Test sent to ${ok}` : `${ok}/${rows.length} sent — see the reasons below`,
        ok === rows.length ? 'success' : 'error');
    } catch (e) {
      showToast(e.message || 'Test send failed', 'error');
    } finally { setTestBusy(false); }
  }

  // Add one blocked test recipient to the builder-managed TEST allowlist, then re-run the test.
  async function allowAndRetest(addr) {
    setTestBusy(true);
    try {
      await workerFetch('addTestAllowlist', { entry: addr }, session);
      showToast('Added to test allowlist', 'success');
    } catch (e) { showToast(e.message || 'Could not add to allowlist', 'error'); setTestBusy(false); return; }
    setTestBusy(false);
    await sendTest();
  }

  async function submit() {
    if (!c.id) { showToast('Save the campaign first', 'error'); return; }
    if (!c.segment_id || !c.template_id) { showToast('Pick a segment and a template first', 'error'); return; }
    setBusy(true);
    try {
      const r = await workerFetch('submitCampaign', { id: c.id }, session);
      const d = r?.data || {};
      showToast(d.status === 'approved' ? `Approved automatically — ${d.reachable} reachable` : `Submitted for approval — ${d.reachable} reachable`, 'success');
      refresh();
    } catch (e) { showToast(e.message || 'Submit failed', 'error'); }
    finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true);
    try { await workerFetch('approveCampaign', { id: c.id }, session); showToast('Approved', 'success'); refresh(); }
    catch (e) { showToast(e.message || 'Approve failed', 'error'); }
    finally { setBusy(false); }
  }
  async function reject() {
    const reason = window.prompt('Reason for rejection (sends back to draft):', '');
    if (reason === null) return;
    setBusy(true);
    try { await workerFetch('rejectCampaign', { id: c.id, reason: reason || null }, session); showToast('Rejected — back to draft', 'success'); refresh(); }
    catch (e) { showToast(e.message || 'Reject failed', 'error'); }
    finally { setBusy(false); }
  }
  async function cancelSchedule() {
    if (!window.confirm('Cancel the scheduled send? The campaign stays approved and can be sent or re-scheduled.')) return;
    setBusy(true);
    try { await workerFetch('cancelSchedule', { id: c.id }, session); showToast('Schedule cleared', 'success'); refresh(); }
    catch (e) { showToast(e.message || 'Cancel failed', 'error'); }
    finally { setBusy(false); }
  }
  // `resume` is the same worker action (startCampaign now accepts 'stopped'), but the confirm
  // must NOT say "fans out real messages to everyone reachable" — on a resume most of that
  // audience has already been messaged and will be deduped. Overstating it invites someone to
  // cancel a safe resume for fear of double-sending.
  async function sendNow({ resume = false } = {}) {
    const seg = segments.find((s) => s.id === c.segment_id);
    // Read the live flag, not a hardcoded assumption (review M12) — the day test_mode goes OFF,
    // a stale "internal test gate" confirm would lie in the dangerous direction. Unknown/unloaded
    // settings (fetch failed or still loading) fall through to the safe, more-alarming copy.
    const gateLine = settings?.test_mode === false
      ? '⚠️ TEST MODE IS OFF — this WILL send to real customers.'
      : 'INTERNAL TEST GATE — sends off the allowlist are blocked.';
    // Spell the exclusions out in the confirm. A rule you set days ago and forgot is exactly
    // the thing that makes a send look mysteriously small afterwards — say it before, not after.
    const exclusionLines = [];
    if ((c.exclude_segment_ids || []).length) exclusionLines.push(`· not in segment: ${c.exclude_segment_ids.map((id) => segments.find((s) => s.id === id)?.name || id).join(', ')}`);
    if ((c.exclude_campaign_ids || []).length) exclusionLines.push(`· not already reached by: ${c.exclude_campaign_ids.map((id) => rows.find((r) => r.id === id)?.name || id).join(', ')}`);
    if (c.exclude_contacted_hours) exclusionLines.push(`· not contacted on ${c.channel} in the last ${c.exclude_contacted_hours}h`);
    const exclusionBlock = exclusionLines.length ? `\n\nExclusions in force:\n${exclusionLines.join('\n')}` : '';
    const done = stats ? Number(stats.sent || 0) : 0;
    const body = resume
      ? `Resume "${c.name}"?\n\n`
        + (done ? `About ${done.toLocaleString('en-IN')} people have already been messaged — they are skipped automatically, nobody hears from this twice.\n\n` : '')
        + `Sending picks up where it stopped, plus anyone it previously failed to reach.`
      : `Send "${c.name}" to audience "${seg?.name || c.segment_id}" now?\n\nThis fans out real messages to everyone reachable in the segment.`;
    // Repeat it in the confirm: the inline banner sits in a panel that is easy to scroll past,
    // and this is the last moment anyone can act on it.
    const tpl = templates.find((t) => t.id === c.template_id) || null;
    const untrackable = c.purpose === 'marketing' ? untrackableButtons(tpl) : [];
    const trackingWarn = untrackable.length
      ? `\n\n⚠️ NO LINK TRACKING — this send will record no clicks and no attributed revenue. `
        + `Its button address is fixed at Meta and cannot be tagged.`
      : '';
    if (!window.confirm(`${gateLine}\n\n${body}${exclusionBlock}${trackingWarn}`)) return;
    setBusy(true);
    try {
      const r = await workerFetch('sendCampaign', { id: c.id }, session);
      showToast(`${resume ? 'Resumed' : 'Sending started'} — ${r?.data?.audience ?? '?'} recipients`, 'success');
      refresh();
    } catch (e) { showToast(e.message || 'Send failed', 'error'); }
    finally { setBusy(false); }
  }

  // EMERGENCY STOP (S279). Halts a fan-out already in flight. The worker flips status
  // sending → stopped; processQueueMessage re-reads the campaign at the top of every page and
  // returns early, so nothing further is queued.
  //
  // ⚠️ The confirm must NOT read like an undo. Messages already delivered cannot be recalled —
  // the honest promise is "no NEW messages", and saying anything softer invites someone to press
  // this expecting the send to disappear.
  async function stopNow() {
    const done = stats ? Number(stats.sent || 0) : null;
    const of = Number(c.audience_snapshot || 0);
    const progress = done != null && of > 0 ? `\n\nAbout ${done.toLocaleString('en-IN')} of ${of.toLocaleString('en-IN')} have been attempted so far.` : '';
    if (!window.confirm(
      `Stop "${c.name}" now?${progress}\n\nMessages already sent CANNOT be recalled — this only stops new ones. `
      + `The batch in flight finishes first, so a few more may still go out.\n\n`
      + `You can resume later with "Send now": anyone already messaged is skipped automatically.`)) return;
    setBusy(true);
    try {
      await workerFetch('stopCampaign', { id: c.id }, session);
      showToast('Stopped — no further messages will be queued', 'success');
      refresh();
    } catch (e) { showToast(e.message || 'Stop failed', 'error'); }
    finally { setBusy(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  // Read live (review M12): render ONLY while test mode is on or unknown (settings still
  // loading, or the fetch failed) — never hardcoded, and unknown fails toward showing it.
  const gateBanner = settings?.test_mode === false ? null : (
    <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)' }}>
      <AlertTriangle size={16} style={{ color: 'var(--accent)' }} />
      <span><strong>Internal testing only.</strong> Relay must not send to real customers until sign-off. Validate with an internal-staff segment first.</span>
    </div>
  );

  if (view === 'form') {
    const chTemplates = templates.filter((t) => t.channel === c.channel);
    const selTpl = templates.find((t) => t.id === c.template_id) || null;
    // c.vars is held as a JSON STRING (that is what save() posts). The editor works in objects,
    // so parse for display and re-stringify on change — a malformed string degrades to {} rather
    // than throwing mid-render and blanking the page.
    let varsObj = {};
    try { varsObj = c.vars && c.vars.trim() ? JSON.parse(c.vars) : {}; } catch { varsObj = {}; }
    const setVarsObj = (o) => set('vars', JSON.stringify(o));
    const segName = segments.find((s) => s.id === c.segment_id)?.name;
    const tplName = templates.find((t) => t.id === c.template_id)?.name;
    const cStatus = campaignStatus(c);
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to campaigns</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{c.id ? (c.name || 'Campaign') : 'New Campaign'}</span>
            <Badge label={cStatus.label} tone={cStatus.tone} dot={cStatus.dot} />
            {c.audience_snapshot != null && <Badge label={`${c.audience_snapshot} reachable`} tone="blue" dot />}
          </div>
          <div className="po-head-r">
            {isDraft && canBuild && <Btn kind="primary" onClick={save} disabled={busy}><Check size={14} /> {busy ? 'Saving…' : 'Save draft'}</Btn>}
          </div>
        </div>

        {gateBanner}

        {c.reject_reason && c.status === 'draft' && (
          <div className="info-bar" style={{ background: 'rgba(222,42,42,.07)', borderColor: 'var(--red-bd, rgba(222,42,42,.3))' }}>
            <X size={16} style={{ color: 'var(--red, #DE2A2A)' }} />
            <span><strong>Returned to draft.</strong> {c.reject_reason}</span>
          </div>
        )}

        <Panel title="Setup" pad>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Name</div>
              <input className="f-inp" value={c.name} onChange={(e) => set('name', e.target.value)} placeholder="June win-back" disabled={busy || !isDraft || !canBuild} />
            </div>
            <div className="ff"><div className="kv-k">Channel</div>
              <select className="f-inp" value={c.channel} onChange={(e) => set('channel', e.target.value)} disabled={busy || !isDraft || !canBuild}>
                {CHANNELS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Purpose</div>
              <select className="f-inp" value={c.purpose} onChange={(e) => set('purpose', e.target.value)} disabled={busy || !isDraft || !canBuild}>
                {PURPOSES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Schedule (optional)</div>
              <input className="f-inp mono" type="datetime-local" value={c.scheduled_at} onChange={(e) => set('scheduled_at', e.target.value)} disabled={busy || !isDraft || !canBuild} />
            </div>
            <div className="ff"><div className="kv-k">Audience (segment)</div>
              {isDraft && canBuild
                ? <select className="f-inp" value={c.segment_id} onChange={(e) => set('segment_id', e.target.value)} disabled={busy}>
                    <option value="">— pick a segment —</option>
                    {segments.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>)}
                  </select>
                : <div className="kv-v">{segName || <span className="dim">—</span>}</div>}
              {c.segment_id && reach && (
                <div className="dim" style={{ fontSize: 12, marginTop: 5 }}>
                  {reach.loading ? 'Checking reachable audience…'
                    : <span title="After channel suppression + marketing consent, then minus your exclusion rules. The per-send frequency cap and quiet-hours gates are applied per recipient at send time and are not counted here.">
                        <strong style={{ color: 'var(--text-1)' }}>{(reach.sendable ?? reach.reachable).toLocaleString('en-IN')}</strong> will receive
                        {' · '}{reach.total.toLocaleString('en-IN')} in segment
                        {reach.total > reach.reachable ? ` · ${(reach.total - reach.reachable).toLocaleString('en-IN')} suppressed/opted-out` : ''}
                        {reach.excluded > 0 ? ` · ${reach.excluded.toLocaleString('en-IN')} excluded by your rules` : ''}
                      </span>}
                </div>
              )}
            </div>

            {/* ── Audience exclusions (S276) ────────────────────────────────────────────
                Three independent rules, ORed together: a profile matching ANY of them is
                dropped. Re-checked on every page of the fan-out, so someone contacted while
                this broadcast is still running is skipped for the rest of the run. */}
            <div className="ff" style={{ gridColumn: '1 / -1' }}>
              <div className="kv-k">Exclusions (optional)</div>
              <div className="dim" style={{ fontSize: 11.5, margin: '2px 0 8px' }}>
                Anyone matching a rule below is skipped. Checked continuously while the campaign
                sends — not just at the start.
              </div>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
                <div>
                  <div className="kv-k" style={{ fontSize: 12 }}>Don&apos;t send to these segments</div>
                  {isDraft && canBuild
                    ? <ExcludePicker
                        options={segments.filter((s) => s.id !== c.segment_id)}
                        selected={c.exclude_segment_ids || []}
                        onToggle={(id) => set('exclude_segment_ids',
                          (c.exclude_segment_ids || []).includes(id)
                            ? c.exclude_segment_ids.filter((x) => x !== id)
                            : [...(c.exclude_segment_ids || []), id])}
                        disabled={busy}
                        empty="No other segments yet."
                        renderLabel={(s) => `${s.name} (${s.kind})`} />
                    : <div className="kv-v">{(c.exclude_segment_ids || []).length
                        ? c.exclude_segment_ids.map((id) => segments.find((s) => s.id === id)?.name || id).join(', ')
                        : <span className="dim">—</span>}</div>}
                </div>

                <div>
                  <div className="kv-k" style={{ fontSize: 12 }}>Already reached by these campaigns</div>
                  {isDraft && canBuild
                    ? <ExcludePicker
                        options={excludableCampaigns}
                        selected={c.exclude_campaign_ids || []}
                        onToggle={(id) => set('exclude_campaign_ids',
                          (c.exclude_campaign_ids || []).includes(id)
                            ? c.exclude_campaign_ids.filter((x) => x !== id)
                            : [...(c.exclude_campaign_ids || []), id])}
                        disabled={busy}
                        empty="No sent or sending campaigns to exclude yet."
                        renderLabel={(r) => `${r.name} · ${r.channel} · ${r.status}`} />
                    : <div className="kv-v">{(c.exclude_campaign_ids || []).length
                        ? c.exclude_campaign_ids.map((id) => rows.find((r) => r.id === id)?.name || id).join(', ')
                        : <span className="dim">—</span>}</div>}
                  <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                    Counts any channel — a campaign has only one.
                  </div>
                </div>

                <div>
                  <div className="kv-k" style={{ fontSize: 12 }}>Recently contacted on {c.channel}</div>
                  {isDraft && canBuild
                    ? <select className="f-inp" value={c.exclude_contacted_hours} disabled={busy}
                        onChange={(e) => set('exclude_contacted_hours', e.target.value)}>
                        {CONTACTED_WINDOWS.map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
                      </select>
                    : <div className="kv-v">{c.exclude_contacted_hours
                        ? `Contacted within ${c.exclude_contacted_hours}h` : <span className="dim">—</span>}</div>}
                  <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                    Same channel only. Counts messages actually sent — journeys included, gate-skipped
                    attempts excluded.
                  </div>
                </div>
              </div>
            </div>
            <div className="ff"><div className="kv-k">Template</div>
              {isDraft && canBuild
                ? <select className="f-inp" value={c.template_id} onChange={(e) => set('template_id', e.target.value)} disabled={busy}>
                    <option value="">— pick a template —</option>
                    {chTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} · v{t.version} ({t.status})</option>)}
                  </select>
                : <div className="kv-v">{tplName || <span className="dim">—</span>}</div>}
            </div>
          </div>

          {c.purpose === 'marketing' && (
            <div style={{ marginTop: 14 }}>
              <UtmFields
                scope="campaign"
                value={c.utm}
                onChange={(next) => set('utm', next)}
                disabled={busy || !isDraft || !canBuild}
                auto={{ utm_source: 'relay', utm_medium: c.channel, utm_campaign: c.name || 'the campaign name', utm_content: 'the template name' }}
              />
              <UtmMarketingNote />
              {untrackableButtons(selTpl).length > 0 && (
                <div className="info-bar" style={{ marginTop: 10, background: 'rgba(248,113,113,.07)', borderColor: 'var(--red)' }}>
                  <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0 }} />
                  <span>
                    <strong>These UTMs will not reach anyone.</strong> “{selTpl?.name}” sends its link as a
                    fixed button (<span className="mono">{untrackableButtons(selTpl)[0].url}</span>). A WhatsApp
                    button’s address is locked when Meta approves the template, so nothing can be added to it
                    when the message is sent. This campaign will record <strong>no clicks and no attributed
                    revenue</strong>, whatever is set above. To track it, the template has to be re-approved at
                    Meta with a redirect link — ask Afshaan before you schedule the send.
                  </span>
                </div>
              )}
            </div>
          )}
        </Panel>

        <VariantSetup campaign={c} session={session} perms={perms} reach={reach} onChanged={refresh} />

        {/* Fill the template's variables as labelled fields and watch the message render, instead
            of hand-writing JSON against token names you have to already know. The raw JSON stays
            available underneath for anything the declared variables don't cover.
            auto-fit collapses the two columns to one below ~700px without a media query. */}
        {selTpl && (
          <div className="tpl-split" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
            <Panel title="Values" pad>
              <TemplateValues template={selTpl} values={varsObj}
                onChange={setVarsObj} disabled={busy || !isDraft || !canBuild} />
              <details style={{ marginTop: 14 }}>
                <summary className="dim" style={{ fontSize: 12, cursor: 'pointer' }}>Advanced — raw JSON</summary>
                <input className="f-inp mono" style={{ marginTop: 8 }} value={c.vars}
                  onChange={(e) => set('vars', e.target.value)} placeholder='{"promo_code":"COMEBACK10"}'
                  disabled={busy || !isDraft || !canBuild} />
              </details>
            </Panel>
            <Panel title="Preview" pad>
              <TemplatePreview template={selTpl} values={varsObj} />
              <div className="tw-note" style={{ marginTop: 12, marginBottom: 0 }}>
                Greyed words are examples or fallbacks, not what will send — fill a value to replace them.
              </div>
            </Panel>
          </div>
        )}

        {/* Deliberately ABOVE Lifecycle: test before you submit, not after. */}
        {c.id && canBuild && (
          <Panel title="Send a test" pad>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {c.channel === 'whatsapp' && (
                <select className="f-inp mono" value={testCc} onChange={(e) => setTestCc(e.target.value)}
                  disabled={testBusy} style={{ width: 96, flex: '0 0 auto' }} aria-label="Country code">
                  {['+91', '+1', '+44', '+971', '+65'].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              )}
              <input className="f-inp" style={{ flex: '1 1 320px' }} value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder={c.channel === 'whatsapp' ? '9876543210, 9876543211' : 'you@legendoftoys.com'}
                disabled={testBusy || !c.template_id} />
              <Btn onClick={sendTest} disabled={testBusy || !c.template_id || !testTo.trim()}>
                <Send size={14} /> {testBusy ? 'Sending…' : 'Send test'}
              </Btn>
            </div>
            <div className="tw-note" style={{ marginTop: 10, marginBottom: 0 }}>
              {!c.template_id
                ? 'Pick a template first — the test sends that template.'
                : <>Up to 5 addresses, comma-separated. Test sends reach <strong>approved test addresses only</strong>
                  {' '}and skip consent / quiet hours / frequency caps so they always deliver on demand
                  (suppression still applies). Recorded but <strong>excluded from this campaign&apos;s stats</strong>.</>}
            </div>
            {testResults && (
              <table className="dt" style={{ marginTop: 12 }}>
                <thead><tr><th>To</th><th>Result</th><th>Detail</th></tr></thead>
                <tbody>
                  {testResults.map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.to}</td>
                      <td><Badge label={r.status}
                        tone={r.status === 'sent' || r.status === 'queued' ? 'green' : r.status === 'skipped' ? 'yellow' : 'red'} /></td>
                      <td className="dim" style={{ fontSize: 12 }}>
                        {r.reason === 'not_on_test_allowlist'
                          ? <>not on the test allowlist{' '}
                            <Btn kind="ghost" onClick={() => allowAndRetest(r.to)} disabled={testBusy}>Add &amp; resend</Btn></>
                          : (r.reason || (r.profile_matched ? 'rendered with this contact’s data' : 'no matching contact — variables used defaults'))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        <Panel title="Lifecycle" pad>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {!c.id && <span className="dim" style={{ fontSize: 13 }}>Save the draft to enable submit & send.</span>}

            {c.id && isDraft && (
              <Btn kind="primary" onClick={submit} disabled={busy || !canBuild}><ShieldCheck size={14} /> Submit for approval</Btn>
            )}
            {c.status === 'pending_approval' && (
              <>
                <span className="dim" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> Awaiting approval.</span>
                {canApprove && <Btn kind="primary" onClick={approve} disabled={busy}><Check size={14} /> Approve</Btn>}
                {canApprove && <Btn onClick={reject} disabled={busy}><X size={14} /> Reject</Btn>}
              </>
            )}
            {(c.status === 'approved' || c.status === 'scheduled') && (
              <>
                <Badge label="approved" tone="blue" />
                {c.scheduled_at && new Date(c.scheduled_at) > new Date() && (
                  <span className="dim" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Clock size={14} /> Scheduled — fires {new Date(c.scheduled_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    {canBuild && <button className="badge-btn" onClick={cancelSchedule} disabled={busy} style={{ marginLeft: 8 }}>cancel schedule</button>}
                  </span>
                )}
                {canSend && <Btn kind="primary" onClick={() => sendNow()} disabled={busy}><Send size={14} /> Send now</Btn>}
              </>
            )}
            {c.status === 'sending' && (
              <>
                <span className="dim" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> Fan-out in progress — <button className="badge-btn accent" onClick={refresh}>refresh</button></span>
                {canSend && <Btn kind="danger" onClick={stopNow} disabled={busy}><OctagonX size={14} /> Stop sending</Btn>}
              </>
            )}
            {c.status === 'stopped' && (
              <>
                <Badge label="stopped mid-send" tone="red" dot />
                {canSend && <Btn kind="primary" onClick={() => sendNow({ resume: true })} disabled={busy}><Send size={14} /> Resume sending</Btn>}
              </>
            )}
            {c.status === 'sent' && <Badge label={`sent · ${c.audience_snapshot ?? ''} recipients`} tone="green" dot />}
          </div>
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Marketing sends above the approval threshold need an approver; below it (or non-marketing) auto-approve on submit. The send gate (suppression → consent → frequency cap → quiet hours) still applies per recipient.
          </div>
        </Panel>

        <VariantProgress campaign={c} />
        <VariantResults campaign={c} perms={perms} onChanged={refresh} />

        {stats && (
          <Panel title="Performance" pad>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
              {/* PLANNED, from audience_snapshot — the reachable count startCampaign claimed the
                  send against. `stats.total` (which "Sent" used to be measured against) counts
                  comms.messages ROWS, and the fan-out creates those just ahead of sending, so it
                  reported ~100% for a campaign that had barely started. Same defect as the Control
                  Tower bar, fixed 2026-08-14. */}
              <Kpi label="Planned" value={c.audience_snapshot ?? '—'} tone="gray"
                   sub={c.audience_snapshot ? 'reachable when the send began' : 'not yet sent'} />
              <Kpi label="Sent" value={stats.sent ?? 0} tone="gray"
                   sub={c.audience_snapshot ? `${pct(stats.sent, c.audience_snapshot)}% of planned` : `${stats.total ?? 0} queued so far`} />
              {/* FAILED was returned by campaign_stats_list all along and rendered NOWHERE, while
                  Bounced/Complaints/Skipped each had a tile. A WhatsApp broadcast can fail ~40% at
                  Meta's engagement-quality block (wa_131049) with nothing on this page saying so —
                  the operator saw "Delivered" and no reason for the gap. */}
              <Kpi label="Failed" value={stats.failed ?? 0} tone={stats.failed ? 'red' : 'gray'}
                   sub={stats.sent ? `${pct(stats.failed, stats.sent)}% of sent · rejected by the provider` : 'rejected by the provider'} />
              <Kpi label="Delivered" value={stats.delivered ?? 0} tone="green" sub={`${pct(stats.delivered, stats.sent)}% of sent`} />
              <Kpi label="Opened" value={stats.opened ?? 0} tone="blue" sub={`${pct(stats.opened, stats.delivered)}% of delivered`} />
              {/* Click-through. A campaign-kind (slug) link is ONE shared code sent to everyone, so
                  it deliberately emits no per-recipient `link_clicked` event and its taps live in
                  comms.link_click instead. Reading `stats.clicked` alone printed a confident 0 on
                  every slug campaign while real clicks were accruing (S269). Prefer the slug number
                  whenever the template actually carries a slug link. */}
              {stats.slug_codes?.length ? (
                <Kpi label="Clicked" value={stats.slug_clicks ?? 0} tone="blue"
                     sub={`${pct(stats.slug_clicks, stats.delivered)}% of delivered · ${stats.slug_unique ?? 0} unique`} />
              ) : (
                <Kpi label="Clicked" value={stats.clicked ?? 0} tone="blue"
                     sub={`${pct(stats.clicked, stats.delivered)}% of delivered`} />
              )}
              {/* Both can coexist if a template mixes a shared slug with per-recipient links. */}
              {stats.slug_codes?.length > 0 && stats.clicked > 0 && (
                <Kpi label="Clicked (per-recipient)" value={stats.clicked} tone="blue"
                     sub={`${pct(stats.clicked, stats.delivered)}% · attributable to a person`} />
              )}
              <Kpi label="Bounced" value={stats.bounced ?? 0} tone={stats.bounced ? 'red' : 'gray'} sub="hard bounces" />
              <Kpi label="Complaints" value={stats.complained ?? 0} tone={stats.complained ? 'red' : 'gray'} sub="spam reports" />
              <Kpi label="Unsubscribes" value={stats.unsubscribes ?? 0} tone={stats.unsubscribes ? 'yellow' : 'gray'} sub="opted out after send" />
              <Kpi label="Skipped" value={(stats.skipped ?? 0) + (stats.suppressed ?? 0)} tone={((stats.skipped ?? 0) + (stats.suppressed ?? 0)) ? 'yellow' : 'gray'} sub="gate-blocked" />
              {attr && <Kpi label="Attributed orders" value={attr.attributed_orders ?? 0} tone="green" sub={`${inr(attr.attributed_revenue ?? 0)} · ${attr.window_days ?? 7}d window`} />}
            </div>
            {stats.slug_codes?.length > 0 && (
              <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
                <strong>Clicks are measured on the shared campaign link</strong>{' '}
                <span className="mono">/r/{stats.slug_codes.join(', /r/')}</span>{' '}
                — one code sent to everyone, so these are taps and unique visitors,{' '}
                <strong>not</strong> per-recipient attribution: they cannot say <em>who</em> clicked,
                and cannot feed order attribution. Counted from the first send
                {stats.slug_window_from ? ` (${fmtDateTime(stats.slug_window_from)})` : ''}, so
                earlier taps on this permanent link are excluded.
              </div>
            )}
            {stats.skipped_by_reason && Object.keys(stats.skipped_by_reason).length > 0 && (
              <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
                <strong>Skipped by reason:</strong>{' '}
                {Object.entries(stats.skipped_by_reason).map(([k, v]) => `${k}: ${v}`).join(' · ')}
              </div>
            )}
          </Panel>
        )}
      </div>
    );
  }

  // KPI strip — aggregated from the SAME campaign_stats_list rows the table reads
  // (§7.2: no extra RPC). Weighted rates; ROI only where cost is actually priced.
  const kpiCells = (() => {
    const os = Object.values(overview);
    const sum = (k) => os.reduce((a, o) => a + Number(o?.[k] || 0), 0);
    const sent = sum('sent'), delivered = sum('delivered'), opened = sum('opened');
    const rev = sum('attributed_revenue'), cost = sum('cost_inr');
    const pc = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
    return [
      { label: 'Sent · all time', value: sent.toLocaleString('en-IN'), delta: `${delivered.toLocaleString('en-IN')} delivered`, lead: true },
      { label: 'Delivery', value: pc(delivered, sent), delta: 'of sent' },
      { label: 'Read rate', value: pc(opened, delivered), delta: 'of delivered' },
      { label: 'Attr. revenue', value: rev ? inr(rev) : '—', delta: 'last-touch' },
      { label: 'Blended ROI', value: cost > 0 ? `${(rev / cost).toFixed(1)}×` : '—', delta: 'rev ÷ spend', color: cost > 0 ? 'var(--accent)' : undefined },
    ];
  })();

  // The CSV exports the tab-filtered set — disable on THAT set, not the full list
  // (an empty Scheduled tab must not offer a header-only export).
  const shownCount = tab === 'all' ? rows.length : rows.filter((r) => tabOf(r) === tab).length;

  return (
    <div className="pg">
      <PageHead title="Campaigns" sub="One-shot broadcasts. Build a draft, submit for approval, then send."
        actions={
          <>
            <Btn onClick={() => {
              const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
              downloadCampaignsCsv(shown, overview, tab, experiments);
            }} disabled={!shownCount}><Download size={13} /> CSV</Btn>
            {canBuild && <Btn kind="primary" onClick={startNew}><Plus size={14} /> New campaign</Btn>}
          </>
        } />
      {gateBanner}
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="send" title="No campaigns yet" hint="Create a campaign, choose an audience and template, then send." /></Panel>
          : (() => {
            const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
            const countFor = (id) => (id === 'all' ? rows.length : rows.filter((r) => tabOf(r) === id).length);
            return (
            <>
            <KpiStrip cells={kpiCells} />
            <Panel
              title={(
                <span className="rtabs" style={{ margin: '-4px 0' }}>
                  {TABS.map((t2) => (
                    <button key={t2.id} onClick={() => setTab(t2.id)} className={`rtab ${tab === t2.id ? 'on' : ''}`}>
                      {t2.label}<span className="rtab-n">{countFor(t2.id)}</span>
                    </button>
                  ))}
                </span>
              )}
              action={<span className="mono dim" style={{ fontSize: 11 }}>{shown.length} broadcast{shown.length === 1 ? '' : 's'}</span>}>
              {/* Lean list (§7.2) — the old 14-column set stays in the CSV export. */}
              <table className="dt">
                <thead><tr>
                  <th>Broadcast</th><th>Status</th><th>When</th>
                  <th className="num">Delivered</th><th className="num">Read</th>
                  <th className="num">Click</th><th className="num">Revenue</th><th className="num">ROI</th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const o = overview[r.id] || null;
                    const st = campaignStatus(r);
                    return (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <ChannelChip channel={r.channel} />
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              {r.name}
                              {/* A test is identifiable without opening it (Afshaan). Presence of an
                                  experiment row, not a live variant count — see the `experiments`
                                  state comment above for why. */}
                              {experiments[r.id] && <Badge label="A/B" tone="blue" />}
                            </div>
                            <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}>{cap(r.purpose)} · {cap(r.channel)}</div>
                          </div>
                        </div>
                      </td>
                      <td><Badge label={st.label} tone={st.tone} dot /></td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>
                        {st.sub ? st.sub : (o?.at ? `${st.label === 'Sent' ? 'Sent ' : ''}${fmtDateTime(o.at)}` : '—')}
                      </td>
                      <td className="num mono">
                        {o?.delivered != null && o?.sent > 0
                          ? <><span style={{ color: 'var(--t1)' }}>{Number(o.delivered).toLocaleString('en-IN')}</span>{' '}
                              <span style={{ color: 'var(--t5)', fontSize: 11 }}>{pct(o.delivered, o.sent)}%</span></>
                          : <span style={{ color: 'var(--t5)' }}>—</span>}
                      </td>
                      <td className="num mono dim">{rate(o?.read_rate)}</td>
                      {/* Slug campaigns have no per-recipient click_rate — fall back to the shared
                          link's rate rather than printing 0.0% (S269). */}
                      <td className="num mono dim" title={o?.slug_codes?.length ? `Shared campaign link: /r/${o.slug_codes.join(', /r/')} · ${o.slug_unique ?? 0} unique visitor(s)` : undefined}>
                        {rate(o?.slug_click_rate ?? o?.click_rate)}
                        {o?.slug_codes?.length ? <span style={{ color: 'var(--t5)', fontSize: 10 }}> ↗</span> : null}
                      </td>
                      <td className="num mono">
                        {o?.attributed_revenue ? inr(o.attributed_revenue) : <span style={{ color: 'var(--t5)' }}>—</span>}
                        {o?.unpriced > 0 && (
                          <div className="dim" style={{ fontSize: 10 }} title={`${o.unpriced} sent message(s) have no rate card entry — spend is understated`}>
                            +{o.unpriced} unpriced
                          </div>
                        )}
                      </td>
                      <td className="num mono" style={{ fontWeight: 600, color: o?.roi != null ? 'var(--green)' : 'var(--t4)' }}>
                        {o?.roi != null ? `${Number(o.roi).toFixed(1)}×` : '—'}
                      </td>
                    </tr>);
                  })}
                </tbody>
              </table>
              {shown.length === 0 && (
                <div className="tw-note" style={{ margin: '10px 16px' }}>No broadcasts in this view.</div>
              )}
            </Panel>
            </>);
          })()}
    </div>
  );
}
