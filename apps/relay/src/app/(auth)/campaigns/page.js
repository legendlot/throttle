'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Send, ShieldCheck, X, AlertTriangle, Clock, Mail, MessageCircle, Download } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi } from '@/components/ui.js';
import { fmtDate, inr } from '@/components/format.js';
import { TemplatePreview, TemplateValues } from '@/components/TemplatePreview.js';

const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 1000) / 10 : 0);
// campaign_stats_list returns rates as fractions; null = no denominator (nothing sent/delivered)
// which is NOT the same as 0% — render an em dash so an unsent draft never reads as a 0% result.
const rate = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// Channel glyph — WhatsApp and email read very differently at a glance in a mixed list.
function ChannelIcon({ channel }) {
  const c = String(channel || '').toLowerCase();
  if (c === 'whatsapp') return <MessageCircle size={13} style={{ color: 'var(--ok, #25D366)' }} aria-label="WhatsApp" />;
  if (c === 'email') return <Mail size={13} style={{ color: 'var(--text-3)' }} aria-label="Email" />;
  return <Send size={13} style={{ color: 'var(--text-4)' }} aria-label={c || 'channel'} />;
}

// Which tab a campaign belongs to. Mirrors campaignStatus() so the chip and the tab can
// never disagree — a campaign filed under "Scheduled" must be the one showing a Scheduled chip.
function tabOf(r) {
  const s = r?.status || 'draft';
  const future = r?.scheduled_at && new Date(r.scheduled_at) > new Date();
  if ((s === 'approved' || s === 'scheduled') && future) return 'scheduled';
  if (s === 'sent' || s === 'sending') return 'sent';
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
function downloadCampaignsCsv(rows, overview, tab) {
  const header = ['Broadcast', 'Channel', 'Purpose', 'Status', 'Sent/scheduled at',
    'Revenue (INR)', 'Cost (INR)', 'Unpriced msgs', 'ROI',
    'Targeted', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Orders',
    'Unsubscribes', 'Failed', 'Skipped',
    'Read rate', 'Click rate', 'Order rate', 'Unsub rate', 'Fail rate', 'Skip rate',
    'Attribution window (days)'];
  const body = rows.map((r) => {
    const o = overview[r.id] || {};
    const st = campaignStatus(r);
    return [r.name, r.channel, r.purpose, st.label, o.at || '',
      o.attributed_revenue ?? '', o.cost_inr ?? '', o.unpriced ?? '', o.roi ?? '',
      o.total ?? '', o.sent ?? '', o.delivered ?? '', o.opened ?? '', o.clicked ?? '',
      o.attributed_orders ?? '', o.unsubscribes ?? '', o.failed ?? '', o.skipped ?? '',
      o.read_rate ?? '', o.click_rate ?? '', o.order_rate ?? '', o.unsub_rate ?? '',
      o.fail_rate ?? '', o.skip_rate ?? '', o.window_days ?? ''];
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
const CHANNELS = ['email', 'whatsapp'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATUS_TONE = {
  draft: 'gray', pending_approval: 'yellow', approved: 'blue', scheduled: 'yellow',
  sending: 'orange', sent: 'green',
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
    default:                 return { label: s.replace(/_/g, ' '), tone: STATUS_TONE[s] || 'gray' };
  }
}

function emptyCampaign() {
  return { id: null, name: '', channel: 'email', purpose: 'marketing', segment_id: '', template_id: '', vars: '{}', scheduled_at: '', status: 'draft', audience_snapshot: null, reject_reason: null };
}

export default function CampaignsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [overview, setOverview] = useState({});
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
  const [testBusy, setTestBusy] = useState(false);
  const [testResults, setTestResults] = useState(null);

  const canBuild = !perms || perms.campaign_build;
  const canApprove = !perms || perms.approve;
  const canSend = !perms || perms.send_activate;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [cs, sg, tp, ov] = await Promise.all([
        garageFetch('getCampaigns', {}, session),
        garageFetch('getSegments', {}, session),
        garageFetch('getTemplates', {}, session),
        // ONE set-based call for every campaign's metrics — never per-row getCampaignStats.
        // Non-fatal: the list still renders (with — in the metric columns) if analytics fail.
        garageFetch('getCampaignsOverview', {}, session).catch(() => null),
      ]);
      setRows(Array.isArray(cs) ? cs : []);
      setSegments(Array.isArray(sg) ? sg : []);
      setTemplates(Array.isArray(tp) ? tp : []);
      setOverview(Array.isArray(ov) ? Object.fromEntries(ov.map((o) => [o.id, o])) : {});
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
    };
  }
  function startNew() { setC(emptyCampaign()); setStats(null); setAttr(null); setView('form'); }
  // Per-campaign performance (M8) — only meaningful once the campaign has sent.
  const loadStats = useCallback(async (id, status) => {
    if (!id || !['sending', 'sent'].includes(status)) { setStats(null); setAttr(null); return; }
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
  useEffect(() => {
    if (view !== 'form' || !c.segment_id) { setReach(null); return undefined; }
    const seg = segments.find((s) => s.id === c.segment_id);
    if (!seg?.definition) { setReach(null); return undefined; }
    let cancelled = false;
    setReach({ loading: true });
    const t = setTimeout(async () => {
      try {
        const r = await workerFetch('previewSegment', { definition: seg.definition, channel: c.channel, purpose: c.purpose }, session);
        if (!cancelled) setReach(r?.data ? { total: Number(r.data.total || 0), reachable: Number(r.data.reachable || 0) } : null);
      } catch { if (!cancelled) setReach(null); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [view, c.segment_id, c.channel, c.purpose, segments, session]);

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
      const r = await workerFetch('sendCampaignTest', { id: c.id, to: testTo }, session);
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
  async function sendNow() {
    const seg = segments.find((s) => s.id === c.segment_id);
    if (!window.confirm(`INTERNAL TEST GATE — no customer sends are authorized yet.\n\nSend "${c.name}" to audience "${seg?.name || c.segment_id}" now?\n\nThis fans out real emails to everyone reachable in the segment.`)) return;
    setBusy(true);
    try {
      const r = await workerFetch('sendCampaign', { id: c.id }, session);
      showToast(`Sending started — ${r?.data?.audience ?? '?'} recipients`, 'success');
      refresh();
    } catch (e) { showToast(e.message || 'Send failed', 'error'); }
    finally { setBusy(false); }
  }

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  const gateBanner = (
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
                    : <span title="After channel suppression + marketing consent. The per-send frequency cap and quiet-hours gates are applied per recipient at send time and are not counted here.">
                        <strong style={{ color: 'var(--text-1)' }}>{reach.reachable.toLocaleString('en-IN')}</strong> reachable
                        {' · '}{reach.total.toLocaleString('en-IN')} in segment
                        {reach.total > reach.reachable ? ` · ${(reach.total - reach.reachable).toLocaleString('en-IN')} suppressed/opted-out` : ''}
                      </span>}
                </div>
              )}
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
        </Panel>

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
              <input className="f-inp" style={{ flex: '1 1 320px' }} value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder={c.channel === 'whatsapp' ? '+919876543210, +919876543211' : 'you@legendoftoys.com'}
                disabled={testBusy || !c.template_id} />
              <Btn onClick={sendTest} disabled={testBusy || !c.template_id || !testTo.trim()}>
                <Send size={14} /> {testBusy ? 'Sending…' : 'Send test'}
              </Btn>
            </div>
            <div className="tw-note" style={{ marginTop: 10, marginBottom: 0 }}>
              {!c.template_id
                ? 'Pick a template first — the test sends that template.'
                : <>Up to 5 addresses, comma-separated. Goes through the <strong>same gate as a real send</strong>
                  {' '}(test mode, suppression, consent, quiet hours, frequency cap), so what you see here is what
                  a customer would get. Test sends are recorded but <strong>excluded from this campaign&apos;s stats</strong>.</>}
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
                        {r.reason || (r.profile_matched ? 'rendered with this contact’s data' : 'no matching contact — variables used defaults')}
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
                {canSend && <Btn kind="primary" onClick={sendNow} disabled={busy}><Send size={14} /> Send now</Btn>}
              </>
            )}
            {c.status === 'sending' && <span className="dim" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={14} /> Fan-out in progress — <button className="badge-btn accent" onClick={refresh}>refresh</button></span>}
            {c.status === 'sent' && <Badge label={`sent · ${c.audience_snapshot ?? ''} recipients`} tone="green" dot />}
          </div>
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Marketing sends above the approval threshold need an approver; below it (or non-marketing) auto-approve on submit. The send gate (suppression → consent → frequency cap → quiet hours) still applies per recipient.
          </div>
        </Panel>

        {stats && (
          <Panel title="Performance" pad>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
              <Kpi label="Sent" value={stats.sent ?? 0} tone="gray" sub={`${stats.total ?? 0} targeted`} />
              <Kpi label="Delivered" value={stats.delivered ?? 0} tone="green" sub={`${pct(stats.delivered, stats.sent)}% of sent`} />
              <Kpi label="Opened" value={stats.opened ?? 0} tone="blue" sub={`${pct(stats.opened, stats.delivered)}% of delivered`} />
              <Kpi label="Clicked" value={stats.clicked ?? 0} tone="blue" sub={`${pct(stats.clicked, stats.delivered)}% of delivered`} />
              <Kpi label="Bounced" value={stats.bounced ?? 0} tone={stats.bounced ? 'red' : 'gray'} sub="hard bounces" />
              <Kpi label="Complaints" value={stats.complained ?? 0} tone={stats.complained ? 'red' : 'gray'} sub="spam reports" />
              <Kpi label="Unsubscribes" value={stats.unsubscribes ?? 0} tone={stats.unsubscribes ? 'yellow' : 'gray'} sub="opted out after send" />
              <Kpi label="Skipped" value={(stats.skipped ?? 0) + (stats.suppressed ?? 0)} tone={((stats.skipped ?? 0) + (stats.suppressed ?? 0)) ? 'yellow' : 'gray'} sub="gate-blocked" />
              {attr && <Kpi label="Attributed orders" value={attr.attributed_orders ?? 0} tone="green" sub={`${inr(attr.attributed_revenue ?? 0)} · ${attr.window_days ?? 7}d window`} />}
            </div>
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

  return (
    <div className="pg">
      <PageHead title="Campaigns" sub="One-shot broadcasts. Build a draft, submit for approval, then send."
        actions={canBuild ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New campaign</Btn> : null} />
      {gateBanner}
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="send" title="No campaigns yet" hint="Create a campaign, choose an audience and template, then send." /></Panel>
          : (() => {
            const shown = tab === 'all' ? rows : rows.filter((r) => tabOf(r) === tab);
            const countFor = (id) => (id === 'all' ? rows.length : rows.filter((r) => tabOf(r) === id).length);
            return (
            <Panel title="Campaigns" count={shown.length}
              action={<Btn onClick={() => downloadCampaignsCsv(shown, overview, tab)} disabled={!shown.length}>
                <Download size={13} /> CSV
              </Btn>}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                {TABS.map((t2) => (
                  <button key={t2.id} onClick={() => setTab(t2.id)} className="mono"
                    style={{ padding: '5px 11px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                      border: '1px solid ' + (tab === t2.id ? 'var(--accent)' : 'var(--border)'),
                      background: tab === t2.id ? 'var(--accent-soft, rgba(255,214,0,.10))' : 'transparent',
                      color: tab === t2.id ? 'var(--accent)' : 'var(--text-3)' }}>
                    {t2.label} <span style={{ opacity: .65 }}>{countFor(t2.id)}</span>
                  </button>
                ))}
              </div>
              <table className="dt">
                <thead><tr>
                  <th>Broadcast</th><th>Status</th><th>Sent / scheduled</th>
                  <th className="num">Revenue</th><th className="num">Cost</th><th className="num">ROI</th>
                  <th className="num">Sent</th><th className="num">Delivered</th>
                  <th className="num">Read</th><th className="num">Click</th><th className="num">Order</th>
                  <th className="num">Unsub</th><th className="num">Fail</th><th className="num">Skipped</th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const o = overview[r.id] || null;
                    return (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <ChannelIcon channel={r.channel} />{r.name}
                        </div>
                        <span className="mono dim" style={{ fontSize: 11 }}>{r.channel} · {r.purpose}</span>
                      </td>
                      <td>{(() => { const st = campaignStatus(r); return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                          <Badge label={st.label} tone={st.tone} dot={st.dot} />
                          {st.sub && <span className="mono dim" style={{ fontSize: 11 }}>{st.sub}</span>}
                        </div>); })()}</td>
                      <td className="mono dim">
                        {o?.at ? fmtDate(o.at) : '—'}
                        {o?.is_scheduled && <span className="dim"> (sched)</span>}
                      </td>
                      <td className="num mono">{o?.attributed_revenue ? inr(o.attributed_revenue) : '—'}</td>
                      <td className="num mono">
                        {o && Number(o.cost_inr) > 0 ? inr(o.cost_inr) : '—'}
                        {/* An unpriced send is NOT a free one — say so rather than let a small
                            ₹ figure read as the whole spend. */}
                        {o?.unpriced > 0 && (
                          <div className="dim" style={{ fontSize: 10 }} title={`${o.unpriced} sent message(s) have no rate card entry — spend is understated`}>
                            +{o.unpriced} unpriced
                          </div>
                        )}
                      </td>
                      <td className="num mono">{o?.roi != null ? `${Number(o.roi).toFixed(2)}x` : '—'}</td>
                      <td className="num mono dim">{o ? o.sent : '—'}</td>
                      <td className="num mono dim">{o ? o.delivered : '—'}</td>
                      <td className="num mono">{rate(o?.read_rate)}</td>
                      <td className="num mono">{rate(o?.click_rate)}</td>
                      <td className="num mono">{rate(o?.order_rate)}</td>
                      <td className="num mono">{rate(o?.unsub_rate)}</td>
                      <td className="num mono">{rate(o?.fail_rate)}</td>
                      <td className="num mono">{rate(o?.skip_rate)}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
              {shown.length === 0 && (
                <div className="tw-note" style={{ marginBottom: 0 }}>No broadcasts in this view.</div>
              )}
            </Panel>);
          })()}
    </div>
  );
}
