'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Send, ShieldCheck, X, AlertTriangle, Clock } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Kpi } from '@/components/ui.js';
import { fmtDate, inr } from '@/components/format.js';

const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 1000) / 10 : 0);
// campaign_stats_list returns rates as fractions; null = no denominator (nothing sent/delivered)
// which is NOT the same as 0% — render an em dash so an unsent draft never reads as a 0% result.
const rate = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

const CHANNELS = ['email'];
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
  const [segments, setSegments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [c, setC] = useState(emptyCampaign());
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState(null);
  const [attr, setAttr] = useState(null);
  const [reach, setReach] = useState(null);   // {loading}|{total,reachable} for the picked segment × (channel,purpose)

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
            <div className="ff ff-full"><div className="kv-k">Constants (JSON, optional)</div>
              <input className="f-inp mono" value={c.vars} onChange={(e) => set('vars', e.target.value)} placeholder='{"promo_code":"COMEBACK10"}' disabled={busy || !isDraft || !canBuild} />
            </div>
          </div>
        </Panel>

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
          : (
            <Panel title="Campaigns" count={rows.length}>
              <table className="dt">
                <thead><tr>
                  <th>Broadcast</th><th>Status</th><th>Sent / scheduled</th>
                  <th className="num">Revenue</th>
                  <th className="num">Sent</th><th className="num">Delivered</th>
                  <th className="num">Read</th><th className="num">Click</th><th className="num">Order</th>
                  <th className="num">Unsub</th><th className="num">Fail</th><th className="num">Skipped</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const o = overview[r.id] || null;
                    return (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td>
                        <div>{r.name}</div>
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
            </Panel>
          )}
    </div>
  );
}
