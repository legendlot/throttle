'use client';
// A/B test setup (S272 UI). Mounted inside campaigns/page.js's detail view, after the
// existing "Setup" panel. Kept in its own file on purpose — page.js is already 742 lines
// and must not grow (see CLAUDE.md for this worktree).
//
// Governing constraint: the team runs this end to end without Claude. Every number a
// marketer needs — power, pre-flight status, audience — is on screen here, never
// something to go ask an engineer to query.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Send, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { garageFetch, workerFetch } from '@throttle/db';
import { Combobox, useToast } from '@throttle/ui';
import { Panel, Badge, Btn, FieldLabel } from '@/components/ui.js';

// ── Power / MDE math ────────────────────────────────────────────────────────────────
// Mirrors commsops-worker/src/ab-stats.js's mde(p, n): 2.8·√(2p(1-p)/n)·100, at the
// SAME measured baseline (p≈0.40, the real broadcast read-rate the curve was fit
// against — see ab-stats.js's simulation note). One constant, one place: if real
// campaign data moves the baseline, update it here AND in ab-stats.js together, or the
// setup screen's power promise and the backend's own verdict will quietly disagree.
const MDE_Z = 2.8;
const MDE_BASELINE_P = 0.40;
function mde(n) {
  if (!(n > 0)) return null;
  return MDE_Z * Math.sqrt((2 * MDE_BASELINE_P * (1 - MDE_BASELINE_P)) / n) * 100;
}

const CHECK_LABELS = {
  variables_match: 'Merge variables match across arms',
  templates_approved: 'Templates are approved to send',
  same_channel_purpose: 'Arms use the campaign’s channel',
  quiet_hours_risk: 'Quiet-hours risk',
};

// campaign_experiments.planned_read_at travels as an ISO string. The rest of this
// screen (and campaigns/page.js's own scheduled_at field) treats a sliced ISO string
// as the datetime-local value rather than converting timezones — matching that
// existing convention instead of inventing a second one.
const toLocalInput = (iso) => (iso ? String(iso).slice(0, 16) : '');
const fourHoursFromNowIso = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString();

export default function VariantSetup({ campaign, session, perms, reach, onChanged }) {
  const { showToast } = useToast();
  const canBuild = !perms || perms.campaign_build;

  const [variants, setVariants] = useState([]);
  const [experiment, setExperiment] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [hypothesis, setHypothesis] = useState('');
  const [plannedReadAt, setPlannedReadAt] = useState('');
  // Guards the one-time auto-save of the "+4h" default (see effect below) against a
  // duplicate POST from React StrictMode's double-invoke in dev.
  const autoDefaultedRef = useRef(false);

  const [testTo, setTestTo] = useState('');
  const [testCc, setTestCc] = useState('+91');
  const [testBusyId, setTestBusyId] = useState(null);
  const [testResult, setTestResult] = useState(null); // { label, rows } | { label, error }

  const campaignId = campaign?.id || null;

  const reloadAll = useCallback(async () => {
    if (!campaignId) return;
    try {
      const [vr, pf] = await Promise.all([
        garageFetch('getCampaignVariants', { id: campaignId }, session),
        garageFetch('getVariantPreflight', { id: campaignId }, session),
      ]);
      setVariants(Array.isArray(vr?.variants) ? vr.variants : []);
      setExperiment(vr?.experiment || null);
      setPreflight(pf && Array.isArray(pf.checks) ? pf : { checks: [] });
    } catch (e) { showToast(e.message || 'Failed to load A/B setup', 'error'); }
  }, [campaignId, session, showToast]);

  useEffect(() => {
    if (!campaignId) { setLoading(false); return; }
    autoDefaultedRef.current = false; // new campaign — allow the +4h default to (re-)fire
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [vr, pf, tp] = await Promise.all([
          garageFetch('getCampaignVariants', { id: campaignId }, session),
          garageFetch('getVariantPreflight', { id: campaignId }, session),
          garageFetch('getTemplates', {}, session).then((r) =>
            (Array.isArray(r) ? r : []).filter((x) => x.status !== 'archived')),
        ]);
        if (cancelled) return;
        setVariants(Array.isArray(vr?.variants) ? vr.variants : []);
        setExperiment(vr?.experiment || null);
        setPreflight(pf && Array.isArray(pf.checks) ? pf : { checks: [] });
        setTemplates(Array.isArray(tp) ? tp : []);
      } catch (e) { if (!cancelled) showToast(e.message || 'Failed to load A/B setup', 'error'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, session]);

  // Sync the hypothesis/read-time inputs whenever the experiment row (re)loads. If no
  // read-time is set yet, compute + persist the "+4h from now" default immediately so
  // the field on screen is always the real, saved value — never a suggestion that
  // silently reverts if nobody touches it.
  useEffect(() => {
    if (!experiment) { setHypothesis(''); setPlannedReadAt(''); return; }
    setHypothesis(experiment.hypothesis || '');
    if (experiment.planned_read_at) {
      setPlannedReadAt(toLocalInput(experiment.planned_read_at));
    } else if (!autoDefaultedRef.current) {
      autoDefaultedRef.current = true;
      const def = fourHoursFromNowIso();
      setPlannedReadAt(toLocalInput(def));
      workerFetch('saveExperimentMeta', { campaignId, plannedReadAt: def }, session)
        .then(reloadAll).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment?.id, experiment?.planned_read_at, experiment?.hypothesis]);

  if (!campaignId) return null;

  const chTemplates = templates.filter((t) => t.channel === campaign.channel);
  const tplOptions = chTemplates.map((t) => ({
    value: t.id, label: `${t.name} · v${t.version}`, hint: t.status,
  }));

  const canEditArms = canBuild && !['sending', 'sent', 'paused'].includes(campaign.status);
  // The worker deliberately reverts an approved/scheduled campaign to draft the moment an arm is
  // edited, added, or deleted — an arm changed after approval was approved by nobody. That revert
  // is silent from the caller's side (saveCampaignVariant/deleteCampaignVariant just do it), so
  // the ONLY place to warn is here, before the mutation fires.
  const needsApprovalWarning = campaign.status === 'approved' || campaign.status === 'scheduled';
  const APPROVAL_WARNING = 'This campaign is approved. Changing a version sends it back for approval.';

  async function updateVariant(v, patch) {
    if (needsApprovalWarning && !window.confirm(`${APPROVAL_WARNING}\n\nContinue?`)) return;
    setBusy(true);
    try {
      await workerFetch('saveCampaignVariant', {
        campaignId,
        id: v.id,
        label: patch.label !== undefined ? patch.label : v.label,
        templateId: patch.templateId !== undefined ? patch.templateId : (v.template_id || null),
        weight: patch.weight !== undefined ? patch.weight : v.weight,
      }, session);
      await reloadAll();
      onChanged?.();
    } catch (e) { showToast(e.message || 'Could not save arm', 'error'); }
    finally { setBusy(false); }
  }

  async function addArmB() {
    if (needsApprovalWarning && !window.confirm(`${APPROVAL_WARNING}\n\nContinue?`)) return;
    setBusy(true);
    try {
      await workerFetch('saveCampaignVariant', { campaignId, label: 'B', templateId: null, weight: 50 }, session);
      await reloadAll();
      onChanged?.();
    } catch (e) { showToast(e.message || 'Could not add a B version', 'error'); }
    finally { setBusy(false); }
  }

  async function deleteArm(v) {
    const msg = needsApprovalWarning
      ? `${APPROVAL_WARNING}\n\nDelete arm "${v.label}"? This cannot be undone.`
      : `Delete arm "${v.label}"? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await workerFetch('deleteCampaignVariant', { campaignId, id: v.id }, session);
      await reloadAll();
      onChanged?.();
    } catch (e) { showToast(e.message || 'Could not delete arm', 'error'); }
    finally { setBusy(false); }
  }

  function setLocalWeight(id, raw) {
    setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, weight: raw } : v)));
  }
  async function commitWeight(v) {
    const w = Number(v.weight);
    if (!Number.isFinite(w) || w <= 0) { showToast('Weight must be a positive number', 'error'); return; }
    await updateVariant(v, { weight: w });
  }

  async function saveHypothesis() {
    try { await workerFetch('saveExperimentMeta', { campaignId, hypothesis: hypothesis.trim() || null }, session); await reloadAll(); }
    catch (e) { showToast(e.message || 'Could not save hypothesis', 'error'); }
  }
  async function savePlannedReadAt(v) {
    setPlannedReadAt(v);
    try {
      const iso = v ? new Date(v).toISOString() : null;
      await workerFetch('saveExperimentMeta', { campaignId, plannedReadAt: iso }, session);
      await reloadAll();
    } catch (e) { showToast(e.message || 'Could not save read time', 'error'); }
  }

  function composeTestTo() {
    if (campaign.channel !== 'whatsapp') return testTo;
    return testTo.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.startsWith('+') ? s.replace(/[^\d+]/g, '') : testCc + s.replace(/\D/g, '').replace(/^0+/, ''))
      .join(',');
  }
  async function sendArmTest(v) {
    if (!testTo.trim() || !v.template_id) return;
    setTestBusyId(v.id); setTestResult(null);
    try {
      const r = await workerFetch('sendCampaignTest', { id: campaignId, to: composeTestTo(), variantId: v.id }, session);
      const rows = r?.data?.results || [];
      setTestResult({ label: v.label, rows });
      const ok = rows.filter((x) => x.status === 'sent' || x.status === 'queued').length;
      showToast(ok === rows.length ? `Test of ${v.label} sent to ${ok}` : `${ok}/${rows.length} sent — see reasons below`,
        ok === rows.length ? 'success' : 'error');
    } catch (e) {
      setTestResult({ label: v.label, error: e.message || 'Test send failed' });
      showToast(e.message || 'Test send failed', 'error');
    } finally { setTestBusyId(null); }
  }

  // ── Power line ──────────────────────────────────────────────────────────────────
  const audience = campaign.audience_snapshot != null
    ? Number(campaign.audience_snapshot)
    : (reach && !reach.loading && Number.isFinite(reach.reachable) ? reach.reachable : null);
  const totalWeight = variants.reduce((s, v) => s + (Number(v.weight) || 0), 0);
  const minWeight = variants.length ? Math.min(...variants.map((v) => Number(v.weight) || 0)) : 0;
  // ⚠️ NOT audience / armCount — weights are editable and power is set by the SMALLEST
  // arm. An 80/20 split's small arm gets 20% of the audience, not 1/N of it.
  const nPerArm = (audience != null && totalWeight > 0)
    ? Math.floor(audience * (minWeight / totalWeight)) : null;
  const mdeVal = nPerArm != null ? mde(nPerArm) : null;
  const powerTone = nPerArm == null ? 'gray' : nPerArm >= 800 ? 'green' : nPerArm >= 400 ? 'yellow' : 'red';

  // ── Pre-flight ──────────────────────────────────────────────────────────────────
  const checks = preflight?.checks || [];
  const blockingFail = checks.some((c) => c.blocking && !c.pass);

  return (
    <Panel title="A/B test setup" pad
      info="Add a second arm to split this send between two templates. The power line and pre-flight checks below only run once there are two or more arms.">
      {loading ? <div className="dim" style={{ fontSize: 13 }}>Loading…</div> : (
        <>
          {/* 1. Arms ------------------------------------------------------------ */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {variants.map((v) => (
              <div key={v.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                border: '1px solid var(--border)', borderRadius: 8, padding: 10,
              }}>
                <Badge label={v.label} tone={v.label === 'A' ? 'blue' : 'orange'} />
                <div style={{ width: 260, flex: '1 1 220px' }}>
                  <Combobox
                    value={v.template_id || ''}
                    options={tplOptions}
                    onChange={(templateId) => updateVariant(v, { templateId: templateId || null })}
                    placeholder="Pick a template…"
                    disabled={busy || !canEditArms}
                    portal
                    emptyLabel={`No ${campaign.channel} templates available`}
                  />
                </div>
                <input
                  className="f-inp mono" type="number" min="1" style={{ width: 84, flex: '0 0 auto' }}
                  value={v.weight ?? ''}
                  onChange={(e) => setLocalWeight(v.id, e.target.value)}
                  onBlur={() => commitWeight(v)}
                  disabled={busy || !canEditArms}
                  title="Send weight"
                />
                <span className="dim" style={{ fontSize: 11 }}>weight</span>
                {canEditArms && (
                  <Btn kind="ghost" onClick={() => deleteArm(v)} disabled={busy}>
                    <Trash2 size={14} />
                  </Btn>
                )}
              </div>
            ))}
            {variants.length === 0 && (
              <div className="dim" style={{ fontSize: 13 }}>No arms yet — this campaign sends its single template as-is.</div>
            )}
          </div>

          {canEditArms && needsApprovalWarning && (
            <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)', marginTop: 10, marginBottom: 0 }}>
              <AlertTriangle size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
              <span><strong>{APPROVAL_WARNING}</strong> Editing, adding, or deleting an arm below will ask you to confirm this first.</span>
            </div>
          )}

          {variants.length < 2 && canEditArms && (
            <div style={{ marginTop: 10 }}>
              <Btn onClick={addArmB} disabled={busy}><Plus size={14} /> Add a B version</Btn>
            </div>
          )}

          {!canEditArms && (
            <div className="tw-note" style={{ marginTop: 10, marginBottom: 0 }}>
              Arms are locked once a campaign starts sending.
            </div>
          )}

          {/* 2. Power line ------------------------------------------------------ */}
          {variants.length >= 2 && (
            <div style={{ marginTop: 16 }}>
              <FieldLabel info="nPerArm = audience × (smallest arm's weight ÷ total weight). Power is set by the smaller arm, not audience ÷ arm count.">
                Statistical power
              </FieldLabel>
              {audience == null ? (
                <div className="tw-note" style={{ margin: 0 }}>
                  Audience size is unknown — pick a segment (or send the campaign) to see detectable difference.
                </div>
              ) : nPerArm == null ? (
                <div className="tw-note" style={{ margin: 0 }}>Set arm weights to see the power estimate.</div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Badge tone={powerTone} dot
                    label={`~${nPerArm.toLocaleString('en-IN')} per arm`} />
                  <span style={{ fontSize: 13, color: 'var(--t1)' }}>
                    {powerTone === 'green' && `you can detect a difference of about ${mdeVal.toFixed(1)} points.`}
                    {powerTone === 'yellow' && `only a large difference will show up (about ${mdeVal.toFixed(1)} points or more).`}
                    {powerTone === 'red' && 'this audience cannot answer the question — send it as a normal campaign.'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 3. Pre-flight -------------------------------------------------------- */}
          {variants.length >= 2 && (
            <div style={{ marginTop: 16 }}>
              <FieldLabel>Pre-flight checks</FieldLabel>
              {blockingFail && (
                <div className="info-bar" style={{ background: 'rgba(222,42,42,.07)', borderColor: 'var(--red-bd, rgba(222,42,42,.3))', marginBottom: 8 }}>
                  <XCircle size={16} style={{ color: 'var(--red, #f87171)' }} />
                  <span><strong>This campaign is not sendable yet.</strong> Fix the blocking check(s) below before sending.</span>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {checks.map((c) => {
                  const Icon = c.pass ? CheckCircle2 : (c.blocking ? XCircle : AlertTriangle);
                  const color = c.pass ? 'var(--green, #34d399)' : (c.blocking ? 'var(--red, #f87171)' : 'var(--accent, #f2cd1a)');
                  return (
                    <div key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                      <Icon size={15} style={{ color, flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <span style={{ color: 'var(--t1)' }}>{CHECK_LABELS[c.key] || c.key}</span>
                        {c.blocking && <span className="dim" style={{ fontSize: 10.5, marginLeft: 6 }}>BLOCKING</span>}
                        {!c.pass && c.detail && <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{c.detail}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 4. Hypothesis + read-time -------------------------------------------- */}
          {experiment && (
            <div style={{ marginTop: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              <div className="ff">
                <FieldLabel>What is the one thing that differs between A and B?</FieldLabel>
                <input className="f-inp" value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  onBlur={saveHypothesis}
                  placeholder="e.g. subject line urgency" disabled={!canBuild} />
              </div>
              <div className="ff">
                <FieldLabel hint="half of reads land within ~30 min, but 20% take over 3.6h">Check back after</FieldLabel>
                <input className="f-inp mono" type="datetime-local" value={plannedReadAt}
                  onChange={(e) => savePlannedReadAt(e.target.value)} disabled={!canBuild} />
              </div>
            </div>
          )}

          {/* 5. Per-arm test send --------------------------------------------------- */}
          {variants.length >= 2 && canBuild && (
            <div style={{ marginTop: 16 }}>
              <FieldLabel>Send a test of each arm</FieldLabel>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {campaign.channel === 'whatsapp' && (
                  <select className="f-inp mono" value={testCc} onChange={(e) => setTestCc(e.target.value)}
                    disabled={testBusyId != null} style={{ width: 96, flex: '0 0 auto' }} aria-label="Country code">
                    {['+91', '+1', '+44', '+971', '+65'].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                )}
                <input className="f-inp" style={{ flex: '1 1 260px' }} value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder={campaign.channel === 'whatsapp' ? '9876543210, 9876543211' : 'you@legendoftoys.com'}
                  disabled={testBusyId != null} />
                {variants.map((v) => (
                  <Btn key={v.id} onClick={() => sendArmTest(v)}
                    disabled={testBusyId != null || !testTo.trim() || !v.template_id}>
                    <Send size={14} /> {testBusyId === v.id ? 'Sending…' : `Send test of ${v.label}`}
                  </Btn>
                ))}
              </div>
              <div className="tw-note" style={{ marginTop: 10, marginBottom: 0 }}>
                Up to 5 addresses, comma-separated. Reaches approved test addresses only and is excluded from this campaign's stats. A holdout arm (no template) has nothing to test.
              </div>
              {testResult && (
                <div style={{ marginTop: 10 }}>
                  <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Arm {testResult.label}:</div>
                  {testResult.error ? (
                    <div style={{ fontSize: 12.5, color: 'var(--red, #f87171)' }}>{testResult.error}</div>
                  ) : (
                    <table className="dt">
                      <thead><tr><th>To</th><th>Result</th><th>Detail</th></tr></thead>
                      <tbody>
                        {testResult.rows.map((r, i) => (
                          <tr key={i}>
                            <td className="mono">{r.to}</td>
                            <td><Badge label={r.status}
                              tone={r.status === 'sent' || r.status === 'queued' ? 'green' : r.status === 'skipped' ? 'yellow' : 'red'} /></td>
                            <td className="dim" style={{ fontSize: 12 }}>{r.reason || (r.profile_matched ? 'rendered with this contact’s data' : 'no matching contact')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
