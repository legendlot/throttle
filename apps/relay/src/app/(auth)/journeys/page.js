'use client';
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Minus, ArrowLeft, Check, Play, Pause, AlertTriangle, GitBranch } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Pipeline, Switch } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';
import { fromDefinition, toDefinition, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
import NodeDrawer from '@/components/journey-canvas/NodeDrawer.js';

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
function branchLabel(key) {
  if (key.startsWith('exit:')) return `exit → ${key.slice(5)}`;
  return key.replace(/^branch_/, '');
}
const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow', archived: 'gray' };

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
// Fallback only — the picker loads the live comms.event_definitions registry via
// getEventDefinitions. This list is what shows if that call fails; it was previously the
// ONLY source, which silently hid every event registered after it was written (the whole
// courier lifecycle, payment_link_*, segment_entered, whatsapp_*, shopflo_order_completed).
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_delivered',
  'add_to_cart', 'checkout_abandoned', 'return_created'];

function emptyJourney() {
  return { id: null, name: '', status: 'draft', active_version: null,
    triggerType: 'event', triggerEvent: 'checkout_started', triggerSegmentId: '',
    reenrolment: 'once_while_active', reenrolCooldown: 24,
    max_duration: '30 days', exit_rules: [], versions: [] };
}

function triggerSummary(t, segments) {
  if (!t || !t.type) return '—';
  if (t.type === 'event') return `event: ${t.name || '?'}`;
  if (t.type === 'segment_entry') {
    const s = (segments || []).find((x) => x.id === t.segment_id);
    return `enters: ${s ? s.name : (t.segment_id || '?')}`;
  }
  return t.type;
}

// Build the stored trigger jsonb from form state — the shape ingest.js (event) and
// segment-entry.js (segment_entry) each match on.
function buildTrigger(j) {
  return j.triggerType === 'segment_entry'
    ? { type: 'segment_entry', segment_id: j.triggerSegmentId }
    : { type: 'event', name: (j.triggerEvent || '').trim() };
}

export default function JourneysPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [segments, setSegments] = useState([]);
  const [eventDefs, setEventDefs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [j, setJ] = useState(emptyJourney());
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [compileErrors, setCompileErrors] = useState(null);
  const [funnel, setFunnel] = useState(null);
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
    if (!id) { setFunnel(null); return; }
    try { const f = await garageFetch('getJourneyFunnel', { id }, session); setFunnel(f || null); }
    catch { /* non-fatal */ }
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [js, tp, sg, ev, st] = await Promise.all([
        garageFetch('getJourneys', {}, session),
        garageFetch('getTemplates', {}, session),
        garageFetch('getSegments', {}, session),
        // Registry-backed trigger picker. Non-fatal: fall back to EVENT_SUGGEST rather
        // than failing the whole page load over a suggestion list.
        garageFetch('getEventDefinitions', {}, session).catch(() => null),
        // Non-fatal (review M12): a failed/denied fetch leaves settings null, which the banner
        // and the activate confirm below both read as "test mode unknown" and default to safe copy.
        garageFetch('getRelaySettings', {}, session).catch(() => null),
      ]);
      setRows(Array.isArray(js) ? js : []);
      setTemplates(Array.isArray(tp) ? tp : []);
      setSegments(Array.isArray(sg) ? sg : []);
      setEventDefs(Array.isArray(ev) && ev.length ? ev : EVENT_SUGGEST.map((name) => ({ name, description: null })));
      setSettings(st || null);
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
    if (next && !window.confirm(
      (settings?.test_mode === false
        ? `⚠️ TEST MODE IS OFF — this WILL enrol and message real customers.\n\n`
        : `INTERNAL TEST GATE — sends off the allowlist are blocked.\n\n`) +
      `Turn ON "${r.name}"?\n\nIt will start enrolling customers on every ${triggerSummary(r.trigger, segments)} and sending messages.`
    )) return;
    setTogglingId(r.id);
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: next ? 'active' : 'paused' } : x)));
    try {
      await workerFetch('setJourneyStatus', { id: r.id, status: next ? 'active' : 'paused' }, session);
      showToast(next ? `"${r.name}" is ON — now sending` : `"${r.name}" is OFF`, 'success');
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
    const t = r.trigger || {};
    setJ({
      id: r.id, name: r.name || '', status: r.status || 'draft', active_version: r.active_version ?? null,
      triggerType: t.type === 'segment_entry' ? 'segment_entry' : 'event',
      triggerEvent: t.name || 'checkout_started',
      triggerSegmentId: t.segment_id || '',
      reenrolment: r.reenrolment || 'once_while_active',
      reenrolCooldown: r.reenrol_cooldown_hours || 24,
      max_duration: r.max_duration || '30 days',
      exit_rules: Array.isArray(r.exit_rules) ? r.exit_rules : [],
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
  }, [j.triggerType, j.triggerEvent, j.triggerSegmentId, segments]);

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
    setBusy(true);
    try {
      await workerFetch('setJourneyStatus', { id: j.id, status }, session);
      showToast(status === 'active' ? 'Journey activated' : `Journey ${status}`, 'success');
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
                  color: isOn(j.status) ? 'var(--ok-fg, #2e7d32)' : 'var(--text-4)' }}>
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

        <Panel title="Trigger & enrolment" pad>
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
                  options={eventDefs.map((d) => ({ value: d.name, label: d.name, hint: d.description || '' }))}
                  onChange={(v) => set('triggerEvent', v || '')}
                  placeholder="Search 29 registered events…"
                  disabled={busy || !editable}
                  allowClear={false}
                  emptyLabel="No matching event — check the name is registered in comms.event_definitions"
                />
                <div className="kpi-sub" style={{ marginTop: 4, whiteSpace: 'normal' }}>
                  {eventDefs.length} registered event{eventDefs.length === 1 ? '' : 's'} — click to browse, type to filter
                </div>
              </div>
            ) : (
              <div className="ff"><div className="kv-k">Segment to watch</div>
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

          {j.triggerType === 'segment_entry' && (
            <div className="tw-note" style={{ marginTop: 14 }}>
              <b>People already in the segment will not be enrolled.</b> When this journey goes
              active, the segment&apos;s current members are recorded as a baseline (you&apos;ll get a
              Slack note saying how many) — only profiles who enter <i>after</i> that point start the
              journey. Entry is checked every 5 minutes.
              {(() => {
                const s = segments.find((x) => x.id === j.triggerSegmentId);
                return s ? <> Watching <b>{s.name}</b>.</> : null;
              })()}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div className="kv-k" style={{ marginBottom: 6 }}>Exit rules — event fires → journey exits early with this outcome</div>
            {(j.exit_rules || []).map((rule, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <Combobox
                    value={rule.event || ''}
                    options={eventDefs.map((d) => ({ value: d.name, label: d.name, hint: d.description || '' }))}
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

        <Panel title="Flow" pad>
          <JourneyCanvas nodes={nodes} edges={edges} setNodes={setNodes} setEdges={setEdges}
            onSelect={setSelected} readOnly={busy || !editable} />
          <NodeDrawer nodeId={selectedNode?.id} config={selectedNode?.data?.config} templates={templates}
            onChange={updateSelectedConfig} onDelete={deleteSelected} disabled={busy || !editable} />
        </Panel>

        <Panel title="Lifecycle" pad>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* On/off now lives on the ON/OFF switch in the header — one control, not two that can
                disagree. Archive stays a button: it is a retirement, not the everyday toggle. */}
            {!j.id && <span className="dim" style={{ fontSize: 13 }}>Save the journey to enable the ON/OFF switch.</span>}
            {j.id && (
              <span className="dim" style={{ fontSize: 13 }}>
                This journey is <strong style={{ color: isOn(j.status) ? 'var(--ok-fg, #2e7d32)' : 'var(--text-3)' }}>
                  {isOn(j.status) ? 'ON — enrolling and sending' : 'OFF — not enrolling anyone'}
                </strong>. Use the switch beside the title to change it.
              </span>
            )}
            {j.id && (j.status === 'draft' || j.status === 'paused') && j.active_version == null && (
              <span className="dim" style={{ fontSize: 13 }}>No published version yet — save first to enable the switch.</span>
            )}
            {j.id && j.status !== 'archived' && canBuild && (
              <Btn onClick={() => { if (window.confirm('Archive this journey? It stops sending and leaves the active list.')) setStatus('archived'); }}
                disabled={busy} style={{ marginLeft: 'auto' }}>Archive</Btn>
            )}
          </div>
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Triggers only fire while a journey is <strong>active</strong>. Editing republishes a new version; in-flight enrolments finish on their pinned version.
          </div>
        </Panel>

        {j.id && (
          <Panel title="Funnel" count={funnel?.total_enrolments ?? 0} pad>
            {!funnel || funnel.total_enrolments === 0 ? (
              <EmptyState icon="git-branch" title="No enrolments yet" hint="Once profiles enrol, each step shows how many entered and how they branched — e.g. a wait-for-response gate's responded vs timeout vs exit counts (across all versions)." />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {Object.entries(funnel.enrolments || {}).map(([st, n]) => (
                    <Badge key={st} label={`${st}: ${n}`} tone={st === 'completed' ? 'green' : st === 'active' ? 'blue' : st === 'exited' ? 'gray' : 'yellow'} dot />
                  ))}
                </div>
                <Pipeline stages={(funnel.steps || []).map((s) => ({ stage: `${s.step_id} · ${s.step_type}`, count: s.entered, tone: STEP_TONE[s.step_type] || 'gray' }))} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
                  {(funnel.steps || []).map((s) => {
                    const parked = Number((funnel.parked || {})[s.step_id] || 0);
                    const branches = Object.entries(s.results || {}).filter(([k]) => k !== 'entered');
                    return (
                      <div key={s.step_id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong className="mono" style={{ fontSize: 13 }}>{s.step_id}</strong>
                        <Badge label={s.step_type} tone={STEP_TONE[s.step_type] || 'gray'} />
                        <span className="dim" style={{ fontSize: 12 }}>{s.entered} resolved</span>
                        {parked > 0 && <Badge label={`⏳ ${parked} waiting`} tone="yellow" dot />}
                        <span style={{ flex: 1 }} />
                        {branches.length === 0
                          ? <span className="dim" style={{ fontSize: 12 }}>—</span>
                          : branches.map(([k, v]) => <Badge key={k} label={`${branchLabel(k)}: ${v}`} tone={branchTone(k)} />)}
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
              <table className="dt">
                <thead><tr><th style={{ width: 92 }}>On / Off</th><th>Name</th><th>Status</th><th className="num">Version</th><th>Trigger</th><th>Re-enrolment</th><th>Updated</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const g = toggleGuard(r, canActivate);
                    const on = isOn(r.status);
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
                          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: .3,
                            color: on ? 'var(--ok-fg, #2e7d32)' : 'var(--text-4)' }}>
                            {on ? 'ON' : 'OFF'}
                          </span>
                        </span>
                      </td>
                      <td><GitBranch size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--text-4)' }} />{r.name}</td>
                      {/* Kept alongside the switch: ON/OFF is the answer, but draft-vs-paused-vs-archived still matters. */}
                      <td><Badge label={r.status || 'draft'} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td className="num mono dim">{r.active_version ?? '—'}</td>
                      <td className="dim">{triggerSummary(r.trigger, segments)}</td>
                      <td className="dim">{r.reenrolment || '—'}</td>
                      <td className="mono dim">{fmtDate(r.updated_at)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}
    </div>
  );
}
