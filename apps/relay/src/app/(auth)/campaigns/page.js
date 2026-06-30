'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Send, ShieldCheck, X, AlertTriangle, Clock } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';

const CHANNELS = ['email'];
const PURPOSES = ['marketing', 'transactional', 'utility'];
const STATUS_TONE = {
  draft: 'gray', pending_approval: 'yellow', approved: 'blue', scheduled: 'yellow',
  sending: 'orange', sent: 'green',
};

function emptyCampaign() {
  return { id: null, name: '', channel: 'email', purpose: 'marketing', segment_id: '', template_id: '', vars: '{}', scheduled_at: '', status: 'draft', audience_snapshot: null, reject_reason: null };
}

export default function CampaignsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [segments, setSegments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [c, setC] = useState(emptyCampaign());
  const [busy, setBusy] = useState(false);

  const canBuild = !perms || perms.campaign_build;
  const canApprove = !perms || perms.approve;
  const canSend = !perms || perms.send_activate;

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [cs, sg, tp] = await Promise.all([
        garageFetch('getCampaigns', {}, session),
        garageFetch('getSegments', {}, session),
        garageFetch('getTemplates', {}, session),
      ]);
      setRows(Array.isArray(cs) ? cs : []);
      setSegments(Array.isArray(sg) ? sg : []);
      setTemplates(Array.isArray(tp) ? tp : []);
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
  function startNew() { setC(emptyCampaign()); setView('form'); }
  async function open(r) {
    setC(fromRow(r));
    setView('form');
    try { const fresh = await garageFetch('getCampaign', { id: r.id }, session); if (fresh?.id) setC(fromRow(fresh)); }
    catch { /* non-fatal */ }
  }
  async function refresh() {
    if (!c.id) return;
    try { const fresh = await garageFetch('getCampaign', { id: c.id }, session); if (fresh?.id) setC(fromRow(fresh)); load(); }
    catch { /* non-fatal */ }
  }
  // While a broadcast is fanning out, poll so the detail auto-flips draft→sending→sent
  // without the operator hitting refresh (the Queue drains over a minute or two).
  useEffect(() => {
    if (view !== 'form' || c.status !== 'sending' || !c.id) return undefined;
    const t = setInterval(async () => {
      try {
        const fresh = await garageFetch('getCampaign', { id: c.id }, session);
        if (fresh?.id) { setC(fromRow(fresh)); if (fresh.status !== 'sending') load(); }
      } catch { /* non-fatal */ }
    }, 4000);
    return () => clearInterval(t);
  }, [view, c.status, c.id, session, load]);
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
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to campaigns</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{c.id ? (c.name || 'Campaign') : 'New Campaign'}</span>
            <Badge label={c.status.replace('_', ' ')} tone={STATUS_TONE[c.status] || 'gray'} />
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
                <thead><tr><th>Name</th><th>Channel</th><th>Purpose</th><th>Status</th><th className="num">Audience</th><th>Updated</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td>{r.name}</td>
                      <td><Badge label={r.channel} tone="blue" /></td>
                      <td className="dim">{r.purpose}</td>
                      <td><Badge label={(r.status || '').replace('_', ' ')} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td className="num mono dim">{r.audience_snapshot ?? '—'}</td>
                      <td className="mono dim">{fmtDate(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
