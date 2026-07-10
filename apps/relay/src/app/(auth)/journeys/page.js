'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Play, Pause, AlertTriangle, GitBranch } from 'lucide-react';
import { PageHead, Panel, Badge, Btn, EmptyState, Pipeline } from '@/components/ui.js';
import { fmtDate } from '@/components/format.js';

const STEP_TONE = { wait: 'gray', condition: 'yellow', send: 'blue', exit: 'green' };

const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow', archived: 'gray' };
const REENROL = [
  { id: 'once_while_active', label: 'Once while active' },
  { id: 'once_ever', label: 'Once ever' },
  { id: 'cooldown', label: 'Cooldown (hours)' },
];
const COND_KINDS = [
  { id: 'no_event_since_enrol', label: "Hasn't done event since enrol" },
  { id: 'event_since_enrol', label: 'Has done event since enrol' },
];
const EVENT_SUGGEST = ['checkout_started', 'order_placed', 'order_fulfilled', 'order_delivered',
  'add_to_cart', 'checkout_abandoned', 'return_created'];

// The linear abandoned-cart shape the structured form round-trips:
//   entry=wait1 → cond1 → {send1 | exit1};  send1 → exit1;  exit1 exit
function emptyJourney() {
  return {
    id: null, name: '', status: 'draft', active_version: null,
    triggerEvent: 'checkout_started',
    reenrolment: 'once_while_active', reenrolCooldown: 24,
    waitDuration: '24 hours',
    condKind: 'no_event_since_enrol', condEvent: 'order_placed',
    templateId: '',
    rawOnly: false, rawDefinition: null, versions: [],
  };
}

// Decide whether an existing definition fits the linear form. If it doesn't,
// we fall back to a read-only raw JSON view (judgment call per task spec).
function isLinearShape(def) {
  if (!def || def.entry !== 'wait1') return false;
  const s = def.steps || {};
  const ids = Object.keys(s).sort().join(',');
  if (ids !== 'cond1,exit1,send1,wait1') return false;
  return s.wait1?.type === 'wait' && s.cond1?.type === 'condition'
    && s.send1?.type === 'send' && s.exit1?.type === 'exit';
}

function fromDefinition(def) {
  const s = def.steps;
  const check = s.cond1.check || {};
  return {
    waitDuration: s.wait1.duration || '24 hours',
    condKind: check.kind || 'no_event_since_enrol',
    condEvent: check.event || 'order_placed',
    templateId: s.send1.templateId || '',
  };
}

function buildDefinition(j) {
  return {
    entry: 'wait1',
    steps: {
      wait1: { type: 'wait', duration: j.waitDuration.trim(), next: 'cond1' },
      cond1: { type: 'condition', check: { kind: j.condKind, event: j.condEvent.trim() }, if_true: 'send1', if_false: 'exit1' },
      send1: { type: 'send', channel: 'email', purpose: 'marketing', templateId: j.templateId, next: 'exit1' },
      exit1: { type: 'exit', outcome: 'completed' },
    },
  };
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

  const canBuild = !perms || perms.campaign_build;

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

  function startNew() { setJ(emptyJourney()); setCompileErrors(null); setFunnel(null); setView('form'); }

  async function open(r) {
    setCompileErrors(null); setFunnel(null);
    // seed from the list row first, then refresh with versions
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
    const base = {
      id: r.id, name: r.name || '', status: r.status || 'draft', active_version: r.active_version ?? null,
      triggerEvent: t.name || 'checkout_started',
      reenrolment: r.reenrolment || 'once_while_active',
      reenrolCooldown: r.reenrol_cooldown_hours || 24,
      versions: r.versions || [],
      rawOnly: false, rawDefinition: null,
      ...emptyDefaults(),
    };
    if (def && isLinearShape(def)) {
      Object.assign(base, fromDefinition(def));
    } else if (def) {
      base.rawOnly = true;
      base.rawDefinition = def;
    }
    setJ(base);
  }
  function emptyDefaults() {
    const e = emptyJourney();
    return { waitDuration: e.waitDuration, condKind: e.condKind, condEvent: e.condEvent, templateId: e.templateId };
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

  const emailTemplates = templates.filter((t) => t.channel === 'email');

  async function save() {
    if (!j.name.trim()) { showToast('Name required', 'error'); return; }
    if (!j.triggerEvent.trim()) { showToast('Trigger event name required', 'error'); return; }
    if (!j.templateId) { showToast('Pick a send template', 'error'); return; }
    setBusy(true);
    setCompileErrors(null);
    try {
      const definition = buildDefinition(j);
      // Pre-validate so we can surface per-step compile errors (saveJourney's
      // error response drops the details array).
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
      if (String(e.message) === 'invalid_definition') {
        showToast('Journey has validation errors — check the steps', 'error');
      } else {
        showToast(e.message || 'Save failed', 'error');
      }
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
    const editable = canBuild && !j.rawOnly;
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

        {j.rawOnly && (
          <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)' }}>
            <AlertTriangle size={16} style={{ color: 'var(--accent)' }} />
            <span>This journey has a custom step graph the simple builder can't edit. Showing the definition read-only.</span>
          </div>
        )}

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
          <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
            Trigger type is <strong>event</strong> (v1). A matching event enrols the profile; the flow below runs once per enrolment.
          </div>
        </Panel>

        {j.rawOnly ? (
          <Panel title="Definition (read-only)" pad>
            <pre className="mono" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, overflowX: 'auto', color: 'var(--text-2)' }}>
              {JSON.stringify(j.rawDefinition, null, 2)}
            </pre>
          </Panel>
        ) : (
          <Panel title="Steps" pad>
            <div className="tw-note" style={{ marginTop: 0 }}>
              A linear flow: <strong>wait</strong> → <strong>condition</strong> → on true <strong>send</strong>, on false exit → exit.
            </div>
            <div className="form-grid">
              <div className="ff"><div className="kv-k">1 · Wait — duration</div>
                <input className="f-inp mono" value={j.waitDuration} onChange={(e) => set('waitDuration', e.target.value)} placeholder="24 hours" disabled={busy || !editable} />
              </div>
              <div className="ff"><div className="kv-k">2 · Condition — check</div>
                <select className="f-inp" value={j.condKind} onChange={(e) => set('condKind', e.target.value)} disabled={busy || !editable}>
                  {COND_KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </div>
              <div className="ff"><div className="kv-k">2 · Condition — event</div>
                <input className="f-inp mono" list="journey-event-suggest" value={j.condEvent} onChange={(e) => set('condEvent', e.target.value)} placeholder="order_placed" disabled={busy || !editable} />
              </div>
              <div className="ff"><div className="kv-k">3 · Send (if condition true) — template</div>
                <select className="f-inp" value={j.templateId} onChange={(e) => set('templateId', e.target.value)} disabled={busy || !editable}>
                  <option value="">— pick a template —</option>
                  {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} · v{t.version} ({t.status})</option>)}
                </select>
              </div>
            </div>
            <div className="tw-note" style={{ marginBottom: 0, marginTop: 12 }}>
              The send step requires an <strong>active</strong> template (the engine validates this on save). If the condition is false, the journey exits without sending.
            </div>
          </Panel>
        )}

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
          ? <Panel><EmptyState icon="arrow-right" title="No journeys yet" hint="Create a journey — pick a trigger event, set a wait, branch on a follow-up event, then send." /></Panel>
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
