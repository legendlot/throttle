'use client';
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Play, Pause, AlertTriangle, GitBranch } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Pipeline } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';
import { fromDefinition, toDefinition, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
import NodeDrawer from '@/components/journey-canvas/NodeDrawer.js';

// React Flow touches window — client-only.
const JourneyCanvas = dynamic(() => import('@/components/journey-canvas/JourneyCanvas.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const STEP_TONE = { wait: 'gray', condition: 'yellow', send: 'blue', exit: 'green' };
const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow', archived: 'gray' };
const REENROL = [
  { id: 'once_while_active', label: 'Once while active' },
  { id: 'once_ever', label: 'Once ever' },
  { id: 'cooldown', label: 'Cooldown (hours)' },
];
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_delivered',
  'add_to_cart', 'checkout_abandoned', 'return_created'];

function emptyJourney() {
  return { id: null, name: '', status: 'draft', active_version: null,
    triggerEvent: 'checkout_started', reenrolment: 'once_while_active', reenrolCooldown: 24, versions: [] };
}

function triggerSummary(t) {
  if (!t || !t.type) return '—';
  if (t.type === 'event') return `event: ${t.name || '?'}`;
  return t.type;
}

export default function JourneysPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [j, setJ] = useState(emptyJourney());
  const [busy, setBusy] = useState(false);
  const [compileErrors, setCompileErrors] = useState(null);
  const [funnel, setFunnel] = useState(null);
  // canvas state — page-owned so save/drawer/canvas share one source of truth
  const [nodes, setNodesRaw] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);

  const canBuild = !perms || perms.campaign_build;

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
      const [js, tp] = await Promise.all([
        garageFetch('getJourneys', {}, session),
        garageFetch('getTemplates', {}, session),
      ]);
      setRows(Array.isArray(js) ? js : []);
      setTemplates(Array.isArray(tp) ? tp : []);
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
      triggerEvent: t.name || 'checkout_started',
      reenrolment: r.reenrolment || 'once_while_active',
      reenrolCooldown: r.reenrol_cooldown_hours || 24,
      versions: r.versions || [],
    });
    seedCanvas(r, def);
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

  // keep the canvas trigger node's summary in sync with the trigger form
  useEffect(() => {
    setNodesRaw((ns) => ns.map((n) => n.id === TRIGGER_ID
      ? { ...n, data: { trigger: { type: 'event', name: j.triggerEvent } } } : n));
  }, [j.triggerEvent]);

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
    if (!j.triggerEvent.trim()) { showToast('Trigger event name required', 'error'); return; }
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
        trigger: { type: 'event', name: j.triggerEvent.trim() },
        reenrolment: j.reenrolment,
        reenrol_cooldown_hours: j.reenrolment === 'cooldown' ? (Number(j.reenrolCooldown) || null) : null,
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

  const gateBanner = (
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
            <div className="ff"><div className="kv-k">Trigger event</div>
              <input className="f-inp mono" list="journey-event-suggest" value={j.triggerEvent} onChange={(e) => set('triggerEvent', e.target.value)} placeholder="checkout_started" disabled={busy || !editable} />
            </div>
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
            {!j.id && <span className="dim" style={{ fontSize: 13 }}>Save the journey to enable activate.</span>}
            {j.id && j.status !== 'active' && canBuild && (
              <Btn kind="primary" onClick={() => setStatus('active')} disabled={busy}><Play size={14} /> Activate</Btn>
            )}
            {j.id && j.status === 'active' && canBuild && (
              <Btn onClick={() => setStatus('paused')} disabled={busy}><Pause size={14} /> Pause</Btn>
            )}
            {j.id && (j.status === 'draft' || j.status === 'paused') && j.active_version == null && (
              <span className="dim" style={{ fontSize: 13 }}>No published version yet — save first to enable activation.</span>
            )}
          </div>
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Triggers only fire while a journey is <strong>active</strong>. Editing republishes a new version; in-flight enrolments finish on their pinned version.
          </div>
        </Panel>

        {j.id && (
          <Panel title="Funnel" count={funnel?.total_enrolments ?? 0} pad>
            {!funnel || funnel.total_enrolments === 0 ? (
              <EmptyState icon="git-branch" title="No enrolments yet" hint="Once profiles enrol, each step's entered count and branch/send/exit results appear here (across all versions)." />
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {Object.entries(funnel.enrolments || {}).map(([st, n]) => (
                    <Badge key={st} label={`${st}: ${n}`} tone={st === 'completed' ? 'green' : st === 'active' ? 'blue' : st === 'exited' ? 'gray' : 'yellow'} dot />
                  ))}
                </div>
                <Pipeline stages={(funnel.steps || []).map((s) => ({ stage: `${s.step_id} · ${s.step_type}`, count: s.entered, tone: STEP_TONE[s.step_type] || 'gray' }))} />
                <div className="tw-note" style={{ marginBottom: 0, marginTop: 14 }}>
                  {(funnel.steps || []).map((s) => {
                    const res = Object.entries(s.results || {}).map(([k, v]) => `${k} ${v}`).join(', ');
                    return <div key={s.step_id} style={{ marginBottom: 2 }}><strong className="mono">{s.step_id}</strong>: {res || '—'}</div>;
                  })}
                </div>
              </>
            )}
          </Panel>
        )}

        <datalist id="journey-event-suggest">{EVENT_SUGGEST.map((a) => <option key={a} value={a} />)}</datalist>
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
            <Panel title="Journeys" count={rows.length}>
              <table className="dt">
                <thead><tr><th>Name</th><th>Status</th><th className="num">Version</th><th>Trigger</th><th>Re-enrolment</th><th>Updated</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="row-click" onClick={() => open(r)}>
                      <td><GitBranch size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--text-4)' }} />{r.name}</td>
                      <td><Badge label={r.status || 'draft'} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                      <td className="num mono dim">{r.active_version ?? '—'}</td>
                      <td className="dim">{triggerSummary(r.trigger)}</td>
                      <td className="dim">{r.reenrolment || '—'}</td>
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
