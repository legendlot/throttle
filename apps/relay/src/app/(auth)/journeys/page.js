'use client';
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Minus, Trash2, ArrowLeft, Check, Play, Pause, AlertTriangle, GitBranch } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Pipeline, Switch, InfoDot } from '@/components/ui.js';
import { useConfirm, useChoose } from '@/components/confirm.js';
import { humanStepId, humanStepType, humanOutcome, humanEnrolmentStatus } from '@/components/journey-canvas/labels.js';
import { fmtDateTime, inr } from '@/components/format.js';
import { fromDefinition, toDefinition, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
import { buildTrigger, triggerToForm, triggerSummary } from '@/lib/journeyTrigger.js';
import NodeDrawer from '@/components/journey-canvas/NodeDrawer.js';
import { UtmFields, UtmMarketingNote } from '@/components/utm.js';
import { useNewParam } from '@/lib/useNewParam.js';
import { loadEventDefs, eventComboOptions, normalizeEventDefs } from '@/lib/eventDefs.js';

// React Flow touches window — client-only.
const JourneyCanvas = dynamic(() => import('@/components/journey-canvas/JourneyCanvas.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const STEP_TONE = { wait: 'gray', wait_response: 'yellow', condition: 'yellow', send: 'blue', exit: 'green' };
// Per-branch outcome → chip tone (keys as emitted by journey_funnel results).
function branchTone(key) {
  if (key === 'responded' || key === 'sent' || key === 'branch_true' || key === 'completed') return 'green';
  if (key === 'timeout' || key === 'skipped' || key === 'branch_false') return 'yellow';
  if (key.startsWith('exit:') || key === 'exited' || key === 'expired' || key === 'failed') return 'red';
  return 'gray';
}
// (branchLabel removed S249 — humanOutcome in journey-canvas/labels.js is now the single
// labeller, shared with the canvas so the funnel and the nodes cannot disagree.)
const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow', archived: 'gray' };

// A null rate is "never ran", which is NOT the same as 0% — render an em dash so a
// draft journey never reads as a 0% result (same convention as the campaigns list).
const rate = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// Four statuses, but only one question anyone actually asks: is this sending right now?
// ON is exactly `active` — the same value the worker's trigger matcher gates on — so the switch
// can never disagree with what the engine does. Everything else is OFF.
const isOn = (s) => s === 'active';
// Turning OFF goes to `paused`, never `draft`: draft means "never been live", pausing a live
// journey must stay distinguishable from one that was never launched. `archived` is a deliberate
// retirement and is not re-armable from a list switch — reopen the journey to bring it back.
// Turning ON is live customer automation → needs send_activate (review H8), same as the worker's
// setJourneyStatus gate; turning OFF stays on campaign_build only, so `canActivate` only enters
// the check for the direction that matters.
function toggleGuard(r, canActivate) {
  if (r.status === 'archived') return { can: false, why: 'Archived — open the journey to restore it' };
  if (!isOn(r.status) && r.active_version == null) return { can: false, why: 'No published version yet — open and save one first' };
  if (!isOn(r.status) && !canActivate) return { can: false, why: 'Turning on needs the send/activate permission' };
  return { can: true, why: isOn(r.status) ? 'Sending — click to pause' : 'Paused — click to start sending' };
}
const REENROL = [
  { id: 'once_while_active', label: 'Once while active' },
  { id: 'once_ever', label: 'Once ever' },
  { id: 'cooldown', label: 'Cooldown (hours)' },
];
// Event names + their category grouping come from the LIVE comms.event_definitions
// registry via @/lib/eventDefs.js (shared with /segments and the journey canvas). The
// fallback that used to live here is now FALLBACK_EVENT_DEFS in that module — one list,
// one place.

// Trigger-property suggestions for the enrolment filter — the properties `order_placed` and
// the cart events actually carry. Mirrors NodeDrawer's EVENT_PROP_SUGGEST, plus the two that
// make a staged rollout possible: `variant_ids` (pin to a single test product) and
// `order_number` (pin to one specific order).
const TRIGGER_PROP_SUGGEST = ['is_cod', 'financial_status', 'total', 'variant_ids',
  'order_number', 'primary_category', 'primary_title', 'line_item_count', 'currency'];

function emptyJourney() {
  return { id: null, name: '', status: 'draft', active_version: null,
    triggerType: 'event', triggerEvent: 'checkout_started', triggerSegmentId: '',
    triggerFilter: [], triggerRequiresIdentifier: '',
    reenrolment: 'once_while_active', reenrolCooldown: 24,
    max_duration: '30 days', exit_rules: [], versions: [], utm: null };
}

// Trigger ⇄ form mapping lives in @/lib/journeyTrigger.js — extracted S243 so the
// round-trip is unit-tested. `buildTrigger` is the SOLE writer of `journeys.trigger` and
// every save REPLACES the whole object, so a key it forgets is DELETED, not left stale.
// That has silently widened a staged rollout (S241) and silently removed a reachability
// gate (S242). Adding a trigger key now breaks journeyTrigger.test.js until it is
// round-tripped, which is the point — the previous guard was a comment, and it did not hold.

export default function JourneysPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const choose = useChoose();
  const [rows, setRows] = useState([]);
  const [overview, setOverview] = useState({});   // journey_id → journey_stats_list row (campaign-style analytics)
  const [templates, setTemplates] = useState([]);
  const [senders, setSenders] = useState([]);
  const [segments, setSegments] = useState([]);
  const [eventDefs, setEventDefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [j, setJ] = useState(emptyJourney());
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [compileErrors, setCompileErrors] = useState(null);
  const [funnel, setFunnel] = useState(null);
  // M15 — a failed funnel fetch must not render as "no enrolments yet" (a real empty state).
  const [funnelError, setFunnelError] = useState(false);
  // canvas state — page-owned so save/drawer/canvas share one source of truth
  const [nodes, setNodesRaw] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  // Live test-mode flag (review M12) — undefined while unloaded/unreachable, which the banner
  // and activate confirm below both treat as "unknown → assume test mode is still ON" (fail safe).
  const [settings, setSettings] = useState(null);

  const canBuild = !perms || perms.campaign_build;
  const canActivate = !perms || perms.send_activate;

  // the trigger node must survive any change set (Backspace-delete guard)
  const setNodes = useCallback((updater) => setNodesRaw((prev) => {
    const next = typeof updater === 'function' ? updater(prev) : updater;
    return next.some((n) => n.id === TRIGGER_ID)
      ? next
      : [...next, prev.find((n) => n.id === TRIGGER_ID)].filter(Boolean);
  }), []);

  const loadFunnel = useCallback(async (id) => {
    if (!id) { setFunnel(null); setFunnelError(false); return; }
    setFunnelError(false);
    try { const f = await garageFetch('getJourneyFunnel', { id }, session); setFunnel(f || null); }
    catch { setFunnelError(true); }
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [js, tp, sg, ev, st, ov, sd] = await Promise.all([
        garageFetch('getJourneys', {}, session),
        // Archived templates are excluded from the picker (S252): archiving means
        // "retired, do not wire this up again". Templates already bound to an
        // existing journey keep working — the send path deliberately does not check
        // status, since silently breaking a live flow is worse than letting it send.
        garageFetch('getTemplates', {}, session).then((r) =>
          (Array.isArray(r) ? r : []).filter((x) => x.status !== 'archived')),
        garageFetch('getSegments', {}, session),
        // Registry-backed trigger picker. loadEventDefs never rejects — it falls back to
        // FALLBACK_EVENT_DEFS internally — so a suggestion list cannot fail a page load.
        loadEventDefs(garageFetch, session),
        // Non-fatal (review M12): a failed/denied fetch leaves settings null, which the banner
        // and the activate confirm below both read as "test mode unknown" and default to safe copy.
        garageFetch('getRelaySettings', {}, session).catch(() => null),
        // ONE set-based call for every journey's metrics — never per-row funnel calls.
        // Non-fatal: the list still renders (with — in the metric columns) if analytics fail.
        garageFetch('getJourneysOverview', {}, session).catch(() => null),
        // Senders, for the send-node "send from" picker. Non-fatal: without it the picker shows
        // only "auto", which is the pre-S243 behaviour rather than a broken page.
        garageFetch('getSenderIdentities', {}, session).catch(() => null),
      ]);
      setRows(Array.isArray(js) ? js : []);
      setTemplates(Array.isArray(tp) ? tp : []);
      setSenders(Array.isArray(sd) ? sd.filter((s) => s.status === 'active') : []);
      setSegments(Array.isArray(sg) ? sg : []);
      setEventDefs(normalizeEventDefs(ev));
      setSettings(st || null);
      setOverview(Array.isArray(ov) ? Object.fromEntries(ov.map((o) => [o.id, o])) : {});
    } catch (e) { showToast(e.message || 'Failed to load journeys', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function set(k, v) { setJ((p) => ({ ...p, [k]: v })); }

  function seedCanvas(journey, def) {
    const g = fromDefinition(journey || {}, def);
    setNodesRaw(g.nodes);
    setEdges(g.edges);
    setSelected(null);
  }

  // List-level on/off. Optimistic so the switch feels instant, reverted on failure — a control
  // that lies about whether a journey is sending is worse than a slow one.
  async function toggleRow(r, next) {
    const g = toggleGuard(r, canActivate);
    if (!g.can) { showToast(g.why, 'error'); return; }
    // Turning ON starts real customer messages; turning OFF is the safe direction and needs no
    // ceremony. Asymmetric on purpose.
    // Read the live flag, not a hardcoded assumption (review M12) — unknown/unloaded settings
    // (fetch failed or still loading) fall through to the safe, more-alarming copy.
    const live = settings?.test_mode === false;
    if (next && !(await confirm({
      tone: live ? 'danger' : 'warn',
      title: `Turn on "${r.name}"?`,
      lede: <>It starts enrolling customers on every <b>{triggerSummary(r.trigger, segments)}</b> and sending messages.</>,
      warning: live ? <><b>Test mode is OFF.</b> This will enrol and message real customers.</> : null,
      note: live ? null : 'Internal test gate — sends off the allowlist are blocked.',
      confirmLabel: 'Turn it on',
      cancelLabel: 'Leave it off',
    }))) return;
    // Turning a journey OFF only stops NEW enrolments. Anyone already mid-journey keeps
    // running on their own workflow instance and will still be messaged — which is how a real
    // customer nearly got a send three minutes after a test journey was switched off (S230),
    // recoverable then only via wrangler. Ask, because both answers are legitimate: draining
    // is right for a copy tweak, stopping is right for pulling a journey.
    // ⚠️ Turning OFF needs its own gate. Until 2026-08-14 the switch acted the moment it was
    // clicked and only THEN asked about draining — so a stray click silently stopped a live
    // journey enrolling, and the dialog that appeared was about something else entirely. The
    // "off is the safe direction" reasoning holds for customers, not for the business: a paused
    // journey sends nothing to anyone, which is its own kind of harm and nobody gets an alert.
    //
    // This was TWO stacked confirms: a stray-click guard, then a decision whose second answer
    // was carried by the Cancel button ("Cancel — let them finish"). Nobody reads Cancel as
    // choosing a branch, and the risk is real: someone meaning to drain presses Cancel on the
    // first dialog and stops nothing at all. Now one dialog, both answers stated, cancel
    // meaning only cancel.
    let stopInFlight = false;
    if (!next) {
      const pick = await choose({
        tone: 'warn',
        title: `Turn off "${r.name}"?`,
        lede: 'New enrolments stop straight away either way. The question is what happens to customers already part-way through.',
        actions: [
          { value: 'drain', label: 'Let them finish',
            hint: 'Anyone mid-journey still receives their remaining messages. Right for a copy tweak.' },
          { value: 'stop', label: 'Stop them too', tone: 'danger',
            hint: 'Nobody else hears from this journey. Right for pulling it.' },
        ],
        cancelLabel: 'Leave it running',
      });
      if (pick === null) return;
      stopInFlight = pick === 'stop';
    }
    setTogglingId(r.id);
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: next ? 'active' : 'paused' } : x)));
    try {
      const res = await workerFetch('setJourneyStatus',
        { id: r.id, status: next ? 'active' : 'paused', ...(stopInFlight ? { stop_in_flight: true } : {}) }, session);
      const n = Number(res?.in_flight_found || 0);
      showToast(next
        ? `"${r.name}" is ON — now sending`
        : (stopInFlight
            ? `"${r.name}" is OFF — ${n === 0 ? 'nobody was mid-journey' : `${n} mid-journey ${n === 1 ? 'customer' : 'customers'} stopped`}`
            : `"${r.name}" is OFF — anyone mid-journey will finish`), 'success');
      refresh();
    } catch (e) {
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: r.status } : x)));
      showToast(String(e.message) === 'no_published_version'
        ? "Can't turn on — no published version yet"
        : (e.message || 'Could not change the journey'), 'error');
    } finally { setTogglingId(null); }
  }

  function startNew() {
    setJ(emptyJourney()); setCompileErrors(null); setFunnel(null);
    seedCanvas({ trigger: { type: 'event', name: 'checkout_started' } }, null);
    setView('form');
  }
  // ⌘K "New journey" — cross-screen ?new=1 + same-screen relay:new event.
  useNewParam(canBuild, startNew);

  async function open(r) {
    setCompileErrors(null); setFunnel(null);
    seed(r, null);
    setView('form');
    loadFunnel(r.id);
    try {
      const fresh = await garageFetch('getJourney', { id: r.id }, session);
      if (fresh?.id) {
        const activeVer = (fresh.versions || []).find((v) => v.version === fresh.active_version)
          || (fresh.versions || [])[0];
        seed(fresh, activeVer?.definition || null);
      }
    } catch { /* non-fatal */ }
  }

  function seed(r, def) {
    setJ({
      id: r.id, name: r.name || '', status: r.status || 'draft', active_version: r.active_version ?? null,
      // Every trigger field comes from the tested mapper — never spelled out here, so a new
      // trigger key cannot be read in one place and forgotten in the other.
      ...triggerToForm(r.trigger),
      reenrolment: r.reenrolment || 'once_while_active',
      reenrolCooldown: r.reenrol_cooldown_hours || 24,
      max_duration: r.max_duration || '30 days',
      exit_rules: Array.isArray(r.exit_rules) ? r.exit_rules : [],
      utm: (r.utm && typeof r.utm === 'object') ? r.utm : null,
      versions: r.versions || [],
    });
    seedCanvas(r, def);
  }

  function addExitRule() { setJ((p) => ({ ...p, exit_rules: [...(p.exit_rules || []), { event: '', outcome: 'exited' }] })); }
  function removeExitRule(i) { setJ((p) => ({ ...p, exit_rules: (p.exit_rules || []).filter((_, idx) => idx !== i) })); }
  function setExitRule(i, k, v) {
    setJ((p) => ({ ...p, exit_rules: (p.exit_rules || []).map((r, idx) => (idx === i ? { ...r, [k]: v } : r)) }));
  }

  async function refresh() {
    if (!j.id) return;
    try {
      const fresh = await garageFetch('getJourney', { id: j.id }, session);
      if (fresh?.id) {
        const activeVer = (fresh.versions || []).find((v) => v.version === fresh.active_version)
          || (fresh.versions || [])[0];
        seed(fresh, activeVer?.definition || null);
      }
      loadFunnel(j.id);
      load();
    } catch { /* non-fatal */ }
  }

  // keep the canvas trigger node's summary in sync with the trigger form.
  // segment_name is DISPLAY-ONLY (toDefinition reads only layout off this node; the saved
  // trigger comes from buildTrigger(j)), so it can't leak into the stored definition.
  useEffect(() => {
    const t = buildTrigger(j);
    if (t.type === 'segment_entry') {
      t.segment_name = (segments.find((s) => s.id === t.segment_id) || {}).name || null;
    }
    setNodesRaw((ns) => ns.map((n) => n.id === TRIGGER_ID ? { ...n, data: { trigger: t } } : n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [j.triggerType, j.triggerEvent, j.triggerSegmentId, j.triggerFilter, segments]);

  const selectedNode = nodes.find((n) => n.id === selected && n.id !== TRIGGER_ID) || null;

  function updateSelectedConfig(cfg) {
    setNodesRaw((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: cfg } } : n)));
  }
  function deleteSelected() {
    setNodesRaw((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  }

  async function save() {
    if (!j.name.trim()) { showToast('Name required', 'error'); return; }
    if (j.triggerType === 'event' && !j.triggerEvent.trim()) { showToast('Trigger event name required', 'error'); return; }
    if (j.triggerType === 'segment_entry' && !j.triggerSegmentId) { showToast('Pick a segment to watch', 'error'); return; }
    setBusy(true);
    setCompileErrors(null);
    try {
      let definition;
      try { definition = toDefinition(nodes, edges); }
      catch { showToast('Connect the trigger to an entry step first', 'error'); setBusy(false); return; }
      // pre-validate so per-step compile errors surface (saveJourney's error drops details)
      const comp = await workerFetch('compileJourney', { definition }, session);
      if (comp?.data && comp.data.ok === false) {
        setCompileErrors(comp.data.errors || []);
        showToast('Journey has validation errors', 'error');
        setBusy(false);
        return;
      }
      const payload = {
        name: j.name.trim(),
        trigger: buildTrigger(j),
        reenrolment: j.reenrolment,
        reenrol_cooldown_hours: j.reenrolment === 'cooldown' ? (Number(j.reenrolCooldown) || null) : null,
        max_duration: (j.max_duration || '').trim() || null,
        exit_rules: (j.exit_rules || []).filter((r) => (r.event || '').trim() && (r.outcome || '').trim()),
        utm: j.utm || null,
        definition,
      };
      if (j.id) payload.id = j.id;
      const r = await workerFetch('saveJourney', payload, session);
      const jid = r?.data?.journey_id;
      if (jid && !j.id) set('id', jid);
      showToast(j.id ? 'Journey saved' : 'Journey created', 'success');
      refresh();
      load();
    } catch (e) {
      if (String(e.message) === 'invalid_definition') showToast('Journey has validation errors — check the nodes', 'error');
      else showToast(e.message || 'Save failed', 'error');
    } finally { setBusy(false); }
  }

  async function setStatus(status) {
    if (!j.id) { showToast('Save the journey first', 'error'); return; }
    if (status === 'active' && !j.active_version) { showToast('Save a version before activating', 'error'); return; }
    // Same ask as the list toggle — see the comment there. Flipping status only stops NEW
    // enrolments; anyone already mid-journey keeps sending unless explicitly stopped.
    let stopInFlight = false;
    if (status !== 'active') {
      const pick = await choose({
        tone: 'warn',
        title: status === 'archived' ? 'Archive this journey?' : 'Pause this journey?',
        lede: status === 'archived'
          ? 'It stops enrolling and leaves the active list. Customers already part-way through are a separate question.'
          : 'New enrolments stop straight away either way. The question is what happens to customers already part-way through.',
        actions: [
          { value: 'drain', label: 'Let them finish',
            hint: 'Anyone mid-journey still receives their remaining messages.' },
          { value: 'stop', label: 'Stop them too', tone: 'danger',
            hint: 'Nobody else hears from this journey.' },
        ],
        cancelLabel: 'Leave it running',
      });
      if (pick === null) return;
      stopInFlight = pick === 'stop';
    }
    setBusy(true);
    try {
      const res = await workerFetch('setJourneyStatus',
        { id: j.id, status, ...(stopInFlight ? { stop_in_flight: true } : {}) }, session);
      const n = Number(res?.in_flight_found || 0);
      showToast(status === 'active'
        ? 'Journey activated'
        : `Journey ${status}${stopInFlight ? ` — ${n} mid-journey stopped` : ''}`, 'success');
      refresh();
    } catch (e) {
      if (String(e.message) === 'no_published_version') showToast("Can't activate — no published version yet", 'error');
      else showToast(e.message || 'Status change failed', 'error');
    } finally { setBusy(false); }
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
    const editable = canBuild;
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to journeys</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{j.id ? (j.name || 'Journey') : 'New Journey'}</span>
            {/* Same control, same meaning as the list — one source of truth for "is it sending?". */}
            {j.id && (
              <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center', marginRight: 2 }}>
                <Switch
                  checked={isOn(j.status)} busy={busy}
                  disabled={!canBuild || j.status === 'archived' || (!isOn(j.status) && j.active_version == null)
                    || (!isOn(j.status) && !canActivate)}
                  label={`${isOn(j.status) ? 'Turn off' : 'Turn on'} this journey`}
                  title={j.status === 'archived' ? 'Archived'
                    : (!isOn(j.status) && j.active_version == null) ? 'Save a version before turning it on'
                    : (!isOn(j.status) && !canActivate) ? 'Turning on needs the send/activate permission'
                    : isOn(j.status) ? 'Sending — click to pause' : 'Paused — click to start sending'}
                  onChange={(next) => setStatus(next ? 'active' : 'paused')}
                />
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: .3,
                  color: isOn(j.status) ? 'var(--green, #34d399)' : 'var(--text-4)' }}>
                  {isOn(j.status) ? 'ON' : 'OFF'}
                </span>
              </span>
            )}
            <Badge label={(j.status || 'draft')} tone={STATUS_TONE[j.status] || 'gray'} />
            {j.active_version != null && <Badge label={`v${j.active_version}`} tone="blue" dot />}
          </div>
          <div className="po-head-r">
            {editable && <Btn kind="primary" onClick={save} disabled={busy}><Check size={14} /> {busy ? 'Saving…' : 'Save'}</Btn>}
          </div>
        </div>

        {gateBanner}

        {compileErrors && compileErrors.length > 0 && (
          <div className="info-bar" style={{ background: 'rgba(222,42,42,.07)', borderColor: 'var(--red-bd, rgba(222,42,42,.3))' }}>
            <AlertTriangle size={16} style={{ color: 'var(--red, #DE2A2A)' }} />
            <span><strong>Validation errors:</strong> {compileErrors.join(', ')}</span>
          </div>
        )}

        <Panel title="Trigger & enrolment" pad infoWidth={340} info={<>
          <p>Who enters this journey, and when. The trigger fires per <b>event</b>, or when a
          profile <b>enters a segment</b>.</p>
          <p>Filters below narrow that further — they are the only place an enrolment can be
          stopped <i>before</i> it happens. Everything after this point is the flow.</p>
          <p><b>Triggers only fire while the journey is ON.</b></p>
        </>}>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Name</div>
              <input className="f-inp" value={j.name} onChange={(e) => set('name', e.target.value)} placeholder="Abandoned cart" disabled={busy || !editable} />
            </div>
            <div className="ff"><div className="kv-k">Trigger</div>
              <select className="f-inp" value={j.triggerType} onChange={(e) => set('triggerType', e.target.value)} disabled={busy || !editable}>
                <option value="event">When an event happens</option>
                <option value="segment_entry">When a profile enters a segment</option>
              </select>
            </div>
            {j.triggerType === 'event' ? (
              <div className="ff"><div className="kv-k">Trigger event</div>
                {/* Combobox, not a <datalist>: a datalist filters its options against whatever
                    is ALREADY in the input, and this field is always pre-filled — so the list
                    collapsed to the single matching row and looked empty/broken. Combobox is
                    also the house standard for pickers (PATTERN-160). */}
                <Combobox
                  value={j.triggerEvent}
                  options={eventComboOptions(eventDefs)}
                  onChange={(v) => set('triggerEvent', v || '')}
                  placeholder={`Search ${eventDefs.length} registered events…`}
                  disabled={busy || !editable}
                  allowClear={false}
                  emptyLabel="No matching event — check the name is registered in comms.event_definitions"
                />
                <div className="kpi-sub" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                  {eventDefs.length} registered event{eventDefs.length === 1 ? '' : 's'} — click to browse, type to filter
                </div>

                {/* Trigger-property filter (S241). Narrows WHO enrols, at the trigger — the
                    only place that stops an enrolment before it happens. Built for staged
                    rollouts: point a money-moving journey at one test product first, prove it
                    with a real order, then remove the row. `=` or `≠` (S273), ANDed,
                    string-compared — matching ingest.js exactly. */}
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                  <div className="kv-k" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    Only enrol when…
                    <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>
                      optional — blank means every {j.triggerEvent || 'event'} enrols
                    </span>
                    <InfoDot label="About enrolment filters">
                      <p>Enrols only when <b>every</b> filter matches the event. Values are compared
                      as text, ignoring case — <code>true</code> and <code>True</code> both work.</p>
                      <p><b>=</b> requires the property to equal the value. <b>≠</b> requires it not to —
                      and an event <i>missing</i> that property <b>passes</b> a <b>≠</b> filter. That is
                      deliberate: it lets you exclude one category without also dropping every event
                      that was never classified.</p>
                      <p>Anything that does not match is skipped <b>silently</b>: it never enters the
                      journey, so it will not show up as a skip anywhere.</p>
                      <p>Built for staged rollouts — point a money-moving journey at one test product
                      first, prove it with a real order, then remove the row.</p>
                    </InfoDot>
                  </div>
                  {(j.triggerFilter || []).map((row, i) => (
                    <div key={i}>
                    {/* The ANDing was only described in the note underneath, so a two-row filter
                        read as if it might be an either/or. Say it between the rows instead. */}
                    {i > 0 && (
                      <div style={{ margin: '6px 0 0 2px', fontSize: 10.5, fontWeight: 700,
                        letterSpacing: '.06em', color: 'var(--dim, #8a8a8a)' }}>AND</div>
                    )}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                      <input className="f-inp" style={{ flex: '1 1 160px' }} list="trigger-prop-suggest"
                        value={row.prop} placeholder="event property (e.g. is_cod)"
                        disabled={busy || !editable}
                        onChange={(e) => set('triggerFilter', (j.triggerFilter || []).map((r, k) =>
                          k === i ? { ...r, prop: e.target.value } : r))} />
                      {/* S273 — the operator. `≠` exists because excluding a value via an
                          equality on the OTHER value silently drops every event where the
                          property is absent (42% of product_viewed carry no primary_category).
                          Rendering it as a plain "=" would state the opposite of what it does. */}
                      <select className="f-inp" style={{ flex: '0 0 62px', textAlign: 'center' }}
                        value={row.op || 'eq'} disabled={busy || !editable}
                        onChange={(e) => set('triggerFilter', (j.triggerFilter || []).map((r, k) =>
                          k === i ? { ...r, op: e.target.value } : r))}>
                        <option value="eq">=</option>
                        <option value="ne">≠</option>
                      </select>
                      <input className="f-inp" style={{ flex: '1 1 160px' }}
                        value={row.value} placeholder="value (e.g. true)"
                        disabled={busy || !editable}
                        onChange={(e) => set('triggerFilter', (j.triggerFilter || []).map((r, k) =>
                          k === i ? { ...r, value: e.target.value } : r))} />
                      <Btn kind="ghost" disabled={busy || !editable}
                        onClick={() => set('triggerFilter', (j.triggerFilter || []).filter((_, k) => k !== i))}>
                        <Trash2 size={14} />
                      </Btn>
                    </div>
                    </div>
                  ))}
                  <datalist id="trigger-prop-suggest">
                    {TRIGGER_PROP_SUGGEST.map((p) => <option key={p} value={p} />)}
                  </datalist>
                  <Btn kind="ghost" disabled={busy || !editable} style={{ marginTop: 6 }}
                    onClick={() => set('triggerFilter', [...(j.triggerFilter || []), { prop: '', value: '', op: 'eq' }])}>
                    {/* "filter", NOT "condition" — the canvas has its own "+ Condition" NODE, and
                        the collision already sent Afshaan looking in the wrong place. These are
                        enrolment filters on the trigger; a Condition node is a branch mid-journey. */}
                    <Plus size={14} /> Add filter
                  </Btn>

                  {/* Reachability gate (S242 engine, exposed here S243). Was data-only, which is
                      how TWO journeys shipped enrolling anonymous browsers: nothing in the UI
                      hinted the field existed, so nobody set it. Pixel events identify ~1.3% of
                      visitors, so for any pixel-fired trigger this is the difference between a
                      journey that works and one that burns a Workflow instance + a 30-minute
                      sleep per anonymous browser to reach nobody. */}
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                    <div className="kv-k" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      Only enrol if we can actually message them
                      <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>
                        recommended for pixel events
                      </span>
                      <InfoDot label="About the reachability check">
                        {j.triggerRequiresIdentifier ? (<>
                          <p>Profiles with no <b>{(j.triggerRequiresIdentifier || '').replace(',', ' or ')}</b> never
                          enrol. Checked at enrolment, so it costs nothing — the send gate would have
                          skipped them anyway, just 30 minutes and a Workflow instance later.</p>
                        </>) : (<>
                          <p><b>Leave this off only for events that always carry identity</b> — Shopify
                          and Shopflo order events.</p>
                          <p>For a <b>pixel</b> event like <span className="mono">product_viewed</span> or{' '}
                          <span className="mono">add_to_cart</span>, roughly <b>4 in 5 enrolments will
                          reach nobody</b>: pixel events identify about 1.3% of visitors.</p>
                          <p>Two journeys shipped enrolling anonymous browsers because nothing in the UI
                          hinted this field existed.</p>
                        </>)}
                      </InfoDot>
                    </div>
                    <select className="f-inp" style={{ marginTop: 6 }}
                      value={j.triggerRequiresIdentifier || ''}
                      disabled={busy || !editable}
                      onChange={(e) => set('triggerRequiresIdentifier', e.target.value)}>
                      <option value="">No check — enrol anyone (incl. anonymous visitors)</option>
                      <option value="phone">Needs a phone number (WhatsApp / SMS journeys)</option>
                      <option value="email">Needs an email address (email journeys)</option>
                      <option value="phone,email">Needs either a phone or an email</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ff">
                <div className="kv-k" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span>Segment to watch</span>
                  <InfoDot label="About segment-entry triggers">
                    <p><b>People already in the segment will not be enrolled.</b> When this journey
                    goes active, the segment&apos;s current members are recorded as a baseline (you
                    get a Slack note saying how many).</p>
                    <p>Only profiles who enter <i>after</i> that point start the journey. Entry is
                    checked every 5 minutes.</p>
                    {(() => {
                      const s = segments.find((x) => x.id === j.triggerSegmentId);
                      return s ? <p>Currently watching <b>{s.name}</b>.</p> : null;
                    })()}
                  </InfoDot>
                </div>
                <select className="f-inp" value={j.triggerSegmentId} onChange={(e) => set('triggerSegmentId', e.target.value)} disabled={busy || !editable}>
                  <option value="">— pick a segment —</option>
                  {segments.filter((s) => s.kind === 'dynamic').map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="ff"><div className="kv-k">Re-enrolment</div>
              <select className="f-inp" value={j.reenrolment} onChange={(e) => set('reenrolment', e.target.value)} disabled={busy || !editable}>
                {REENROL.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </div>
            {j.reenrolment === 'cooldown' && (
              <div className="ff"><div className="kv-k">Cooldown (hours)</div>
                <input className="f-inp mono" type="number" min="1" value={j.reenrolCooldown} onChange={(e) => set('reenrolCooldown', e.target.value)} disabled={busy || !editable} />
              </div>
            )}
            <div className="ff"><div className="kv-k">Max duration (auto-exit after)</div>
              <input className="f-inp mono" value={j.max_duration} onChange={(e) => set('max_duration', e.target.value)} placeholder="30 days" disabled={busy || !editable} />
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <UtmFields
              scope="journey"
              value={j.utm}
              onChange={(next) => set('utm', next)}
              disabled={busy || !editable}
              auto={{ utm_source: 'relay', utm_medium: 'whatsapp / email', utm_campaign: j.name || 'the journey name', utm_content: 'the template name' }}
            />
            <UtmMarketingNote />
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="kv-k" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span>Exit rules</span>
              <InfoDot label="About exit rules">
                <p>When the named event fires for a profile mid-journey, that enrolment <b>exits
                early</b> and is recorded with the outcome you give here.</p>
                <p>Typical use: leave a cart-recovery journey the moment{' '}
                <span className="mono">order_placed</span> arrives, so nobody is chased for a cart
                they already bought.</p>
              </InfoDot>
            </div>
            {(j.exit_rules || []).map((rule, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <Combobox
                    value={rule.event || ''}
                    options={eventComboOptions(eventDefs)}
                    onChange={(v) => setExitRule(i, 'event', v || '')}
                    placeholder="order_cancelled"
                    disabled={busy || !editable}
                    allowClear={false}
                    portal
                  />
                </div>
                <input className="f-inp mono" style={{ flex: 1 }} value={rule.outcome || ''}
                  onChange={(e) => setExitRule(i, 'outcome', e.target.value)} placeholder="exited" disabled={busy || !editable} />
                {editable && <Btn onClick={() => removeExitRule(i)} disabled={busy}><Minus size={14} /></Btn>}
              </div>
            ))}
            {editable && <Btn onClick={addExitRule} disabled={busy}><Plus size={14} /> Add exit rule</Btn>}
          </div>
        </Panel>

        <Panel title="Flow" pad infoWidth={340} info={<>
          <p>Click a node to configure it, drag from a right-side dot to connect, and press
          <span className="mono"> ⌫ </span> to delete the selected node.</p>
          <p>A node&apos;s right-side dots are its <b>outcomes</b> — a send has sent/failed, a
          wait-for-reply has replied/no-reply, and so on. Every outcome you leave unconnected
          simply ends the journey there.</p>
          <p>Editing republishes a new version. <b>In-flight enrolments finish on the version
          they started on</b>, so a change never rewrites a conversation already under way.</p>
        </>}>
          <JourneyCanvas nodes={nodes} edges={edges} setNodes={setNodes} setEdges={setEdges}
            onSelect={setSelected} readOnly={busy || !editable} />
          <NodeDrawer nodeId={selectedNode?.id} config={selectedNode?.data?.config} templates={templates} senders={senders}
            eventDefs={eventDefs}
            onChange={updateSelectedConfig} onDelete={deleteSelected} disabled={busy || !editable} />
        </Panel>

        <Panel title="Lifecycle" pad infoWidth={340} info={<>
          <p>Triggers only fire while a journey is <b>active</b>. Turning it off stops new
          enrolments; it does not stop enrolments already running.</p>
          <p>Editing republishes a new version — in-flight enrolments finish on their pinned
          version.</p>
          <p><b>Archive</b> is a retirement, not the everyday switch: it stops sending and leaves
          the active list.</p>
        </>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* On/off now lives on the ON/OFF switch in the header — one control, not two that can
                disagree. Archive stays a button: it is a retirement, not the everyday toggle. */}
            {!j.id && <span className="dim" style={{ fontSize: 13 }}>Save the journey to enable the ON/OFF switch.</span>}
            {j.id && (
              <span className="dim" style={{ fontSize: 13 }}>
                This journey is <strong style={{ color: isOn(j.status) ? 'var(--green, #34d399)' : 'var(--text-3)' }}>
                  {isOn(j.status) ? 'ON — enrolling and sending' : 'OFF — not enrolling anyone'}
                </strong>. Use the switch beside the title to change it.
              </span>
            )}
            {j.id && (j.status === 'draft' || j.status === 'paused') && j.active_version == null && (
              <span className="dim" style={{ fontSize: 13 }}>No published version yet — save first to enable the switch.</span>
            )}
            {j.id && j.status !== 'archived' && canBuild && (
              <Btn onClick={() => setStatus('archived')}
                disabled={busy} style={{ marginLeft: 'auto' }}>Archive</Btn>
            )}
          </div>
        </Panel>

        {j.id && (
          <Panel title="Funnel" count={funnel?.total_enrolments ?? 0} pad infoWidth={340} info={<>
          <p>Where enrolments actually went, across <b>all versions</b> of this journey.</p>
          <p>Each row is one step: how many reached it, how many are <b>waiting there right
          now</b>, and how they split across that step&apos;s outcomes.</p>
          <p>Step names are shown in plain English — hover one to see the engine&apos;s own id if
          you are editing the graph.</p>
        </>}>
            {funnelError ? (
              <>
                <EmptyState icon="info" title="Funnel unavailable — retry" hint="Could not load enrolment funnel data." />
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
                  <Btn onClick={() => loadFunnel(j.id)}>Retry</Btn>
                </div>
              </>
            ) : !funnel || funnel.total_enrolments === 0 ? (
              <EmptyState icon="git-branch" title="No enrolments yet" hint="Once profiles enrol, each step shows how many entered and how they branched — e.g. a wait-for-response gate's responded vs timeout vs exit counts (across all versions)." />
            ) : (
              <>
                {/* Every identifier here is rendered through labels.js. The engine's own
                    strings (`pay_wait`, `wait_response`, `no_reply`) are correct in the graph
                    and unreadable in a report — this panel was a list of truncated function
                    names. The raw id stays available on hover for anyone editing the graph. */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {Object.entries(funnel.enrolments || {}).map(([st, n]) => (
                    <Badge key={st} label={`${humanEnrolmentStatus(st)}: ${n}`} tone={st === 'completed' ? 'green' : st === 'active' ? 'blue' : st === 'exited' ? 'gray' : 'yellow'} dot />
                  ))}
                </div>
                <Pipeline stages={(funnel.steps || []).map((s) => ({ stage: humanStepId(s.step_id), count: s.entered, tone: STEP_TONE[s.step_type] || 'gray' }))} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                  {(funnel.steps || []).map((s) => {
                    const parked = Number((funnel.parked || {})[s.step_id] || 0);
                    const branches = Object.entries(s.results || {}).filter(([k]) => k !== 'entered');
                    return (
                      <div key={s.step_id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13 }} title={`step id: ${s.step_id}`}>{humanStepId(s.step_id)}</strong>
                        <Badge label={humanStepType(s.step_type)} tone={STEP_TONE[s.step_type] || 'gray'} />
                        <span className="dim" style={{ fontSize: 12 }}>{s.entered} reached this step</span>
                        {parked > 0 && <Badge label={`${parked} waiting here now`} tone="yellow" dot />}
                        <span style={{ flex: 1 }} />
                        {branches.length === 0
                          ? <span className="dim" style={{ fontSize: 12 }}>—</span>
                          : branches.map(([k, v]) => <Badge key={k} label={`${humanOutcome(k)}: ${v}`} tone={branchTone(k)} />)}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </Panel>
        )}

      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Journeys" sub="Multi-step automated flows triggered by customer events."
        actions={canBuild ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New journey</Btn> : null} />
      {gateBanner}
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="arrow-right" title="No journeys yet" hint="Create a journey — pick a trigger event, then build the flow on the canvas." /></Panel>
          : (
            <Panel title="Journeys" count={rows.length}
              action={(() => {
                const on = rows.filter((r) => isOn(r.status)).length;
                // The headline answer to "is anything running?", without reading every row.
                return (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Badge label={`${on} on`} tone={on ? 'green' : 'gray'} dot={on > 0} />
                    <Badge label={`${rows.length - on} off`} tone="gray" />
                  </span>
                );
              })()}>
              <div className="table-scroll">
              <table className="dt">
                {/* Lean COMMAND list (§7.3): On/Off · Journey (trigger·version) · Enrolled ·
                    Conv · Revenue · Read · Last activity. The full analytics set (cost, sent,
                    delivered, click, fail, skip) lives on /analytics and in the editor —
                    the list's job is "is it on, is it working, what is it worth".
                    Draft/archived (vs merely OFF) shows as a small pill beside the name. */}
                <thead><tr>
                  <th style={{ width: 96 }}>On / Off</th><th>Journey</th>
                  <th className="num">Enrolled</th><th className="num">Sent</th>
                  <th className="num">Delivered</th><th className="num">Read</th>
                  <th>Last activity</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const g = toggleGuard(r, canActivate);
                    const on = isOn(r.status);
                    const o = overview[r.id] || null;
                    return (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      {/* stopPropagation lives in Switch — the row opens the editor, the switch must not. */}
                      <td onClick={(e) => e.stopPropagation()}>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <Switch
                            checked={on}
                            busy={togglingId === r.id}
                            // Read-only for non-builders: everyone can SEE on/off, only builders flip it.
                            disabled={!canBuild || !g.can}
                            label={`${on ? 'Turn off' : 'Turn on'} journey ${r.name}`}
                            title={canBuild ? g.why : (on ? 'Sending' : 'Not sending')}
                            onChange={(next) => toggleRow(r, next)}
                          />
                          <span className="mono" style={{ fontSize: 10, fontWeight: 600,
                            color: on ? 'var(--green)' : 'var(--t5)' }}>
                            {on ? 'ON' : 'OFF'}
                          </span>
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <GitBranch size={15} style={{ color: 'var(--t4)', flexShrink: 0 }} />
                          <div>
                            <span style={{ fontWeight: 600, color: 'var(--t1)' }}>{r.name}</span>
                            {/* OFF alone hides WHY it's off — draft/archived still matter. */}
                            {(r.status === 'draft' || r.status === 'archived') && (
                              <span style={{ marginLeft: 8 }}><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></span>
                            )}
                            <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}
                              title={o?.attributed_revenue
                                ? `Attributed revenue ${inr(o.attributed_revenue)} across ${o.attributed_orders || 0} order(s) — meaningful on recovery journeys, incidental on notifications`
                                : undefined}>
                              {triggerSummary(r.trigger, segments)} · v{r.active_version ?? '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="num mono" title={o ? `${o.enrolled} lifetime · ${o.in_flight} in flight · ${o.completed} completed` : undefined}>
                        {o ? o.enrolled_30d : '—'}
                        {o?.in_flight > 0 && <div className="dim" style={{ fontSize: 10 }}>{o.in_flight} in flight</div>}
                      </td>
                      {/* SENT + DELIVERED replace Conv + Revenue here (S249, Afshaan).
                          Attributed revenue on a NOTIFICATION journey is noise: Order Cancelled
                          showed ₹12,580 because orders happen to follow a cancellation notice,
                          not because the notice earned them — and Conv read 0.0% on every row,
                          since purchase-exits are only wired on recovery journeys. Both remain
                          on /analytics and in the editor's Funnel; revenue is kept here as a
                          hover on the journey name so a cart-recovery journey does not lose it.
                          Did it send, and did it land, is the question this list should answer. */}
                      <td className="num mono" title={o ? `${o.sent} sent · ${o.failed} failed · ${o.skipped} skipped by the send gate` : undefined}>
                        {o?.sent ?? '—'}
                        {o?.failed > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--red-fg, #ff7a7a)' }}>{o.failed} failed</div>
                        )}
                      </td>
                      <td className="num mono" title={o ? `${o.delivered} delivered of ${o.sent} sent` : undefined}>
                        {o?.delivered ?? '—'}
                        {/* The rate is the point — a raw delivered count means nothing without
                            the denominator, and this is where a number quietly going wrong shows. */}
                        {o?.sent > 0 && (
                          <div className="dim" style={{ fontSize: 10 }}>
                            {((Number(o.delivered) / Number(o.sent)) * 100).toFixed(0)}%
                          </div>
                        )}
                      </td>
                      <td className="num mono dim">{rate(o?.read_rate)}</td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--t3)' }}>{o?.at ? fmtDateTime(o.at) : fmtDateTime(r.updated_at)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </Panel>
          )}
    </div>
  );
}
