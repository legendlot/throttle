'use client';
// Bot-mode half of the /journeys builder page (S312). Same canvas surface as journeys
// (JourneyCanvas mode="bot"), its own list + save/publish/test wiring against the
// listBots/saveBot/publishBot/testBotTurn worker actions. Deliberately compact: bots
// have no triggers, exit rules, versions UI or funnel — a definition, a status, a test.
import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Play, Pause, Check, Plus, Send } from 'lucide-react';
import { Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fromDefinition, toDefinition, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
import BotDrawer from '@/components/journey-canvas/BotDrawer.js';

const JourneyCanvas = dynamic(() => import('@/components/journey-canvas/JourneyCanvas.js'),
  { ssr: false, loading: () => <div style={{ padding: 24 }}><Spinner /></div> });

const STATUS_TONE = { draft: 'gray', active: 'green', paused: 'yellow' };

// The graph helpers were written for journeys, where the entry-anchor node carries the
// trigger. For bots the SAME node renders as "Chat start" — we just stamp botMode on it.
function botNodes(bot) {
  const { nodes, edges } = fromDefinition({ trigger: {} }, bot?.draft_definition || null);
  return { nodes: nodes.map((n) => (n.id === TRIGGER_ID ? { ...n, data: { ...n.data, botMode: true } } : n)), edges };
}

// ── Test panel — runs the CURRENT DRAFT through testBotTurn (worker-side engine, zero
//    side effects, no rows written). This is how a flow is validated without the widget.
function TestPanel({ botId, definition, session }) {
  const [state, setState] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const turn = useCallback(async (input) => {
    setBusy(true);
    try {
      const r = await workerFetch('testBotTurn', { id: botId, definition, state, input }, session);
      const out = r?.data || r;
      if (!out?.state) return;
      setState(out.state);
      setTranscript((t) => [
        ...t,
        ...(input.kind === 'open' ? [] : [{ who: 'you', text: input.text || input.buttonId }]),
        ...(out.replies || []).map((rp) => ({ who: 'bot', text: rp.text, buttons: rp.buttons })),
        ...(out.effects || []).filter((e) => e.type === 'handoff').map(() => ({ who: 'sys', text: '→ would hand off to an agent here' })),
        ...(out.effects || []).filter((e) => e.type === 'order_lookup').map((e) => ({ who: 'sys', text: `→ would look up ${e.orderNumber} (verified against ${e.identity?.phone || e.identity?.email || 'nothing — no identity collected!'})` })),
      ]);
    } finally { setBusy(false); }
  }, [botId, definition, state, session]);

  const start = () => { setState({ current_step: null, status: 'active', context: {} }); setTranscript([]); };
  // Auto-fire the open turn once a fresh state is set.
  useEffect(() => { if (state && state.current_step === null && !transcript.length) turn({ kind: 'open' }); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Btn onClick={start} disabled={busy}><Play size={13} /> {state ? 'Restart test' : 'Test this draft'}</Btn>
        {state && <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>state: {state.status} · step: {state.current_step || '—'}</span>}
      </div>
      {state && (
        <>
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--bd, #ddd)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            {transcript.map((m, i) => (
              <div key={i} style={{ marginBottom: 6, textAlign: m.who === 'you' ? 'right' : 'left' }}>
                <span style={{ display: 'inline-block', padding: '5px 9px', borderRadius: 8, fontSize: 13, maxWidth: '85%',
                  background: m.who === 'you' ? 'var(--accent, #F2CD1A)' : m.who === 'sys' ? 'transparent' : 'var(--surface-2, #f2f2f2)',
                  color: m.who === 'sys' ? 'var(--text-3, #888)' : 'inherit',
                  fontStyle: m.who === 'sys' ? 'italic' : 'normal' }}>
                  {m.text}
                  {m.buttons && (
                    <span style={{ display: 'block', marginTop: 5 }}>
                      {m.buttons.map((b) => (
                        <button key={b.id} className="btn" type="button" style={{ marginRight: 5, marginBottom: 3, fontSize: 12 }}
                          disabled={busy || state.status !== 'active'} onClick={() => turn({ kind: 'button', buttonId: b.id, text: b.label })}>
                          {b.label}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { turn({ kind: 'text', text: text.trim() }); setText(''); } }}>
            <input className="f-inp" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={state.status === 'active' ? 'Type as the customer…' : 'Session over — restart to test again'}
              disabled={busy || state.status !== 'active'} />
            <Btn type="submit" disabled={busy || state.status !== 'active' || !text.trim()}><Send size={13} /></Btn>
          </form>
        </>
      )}
    </div>
  );
}

export default function BotBuilder() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canBuild = !perms || perms.campaign_build;
  const canActivate = !perms || perms.send_activate;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [bot, setBot] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [publishErrors, setPublishErrors] = useState(null);

  const [stats, setStats] = useState({});   // bot_id -> {sessions,handled,handoffs,conversions} (7d)
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await garageFetch('listBots', {}, session);
      const bots = r?.bots || [];
      setRows(bots);
      // few bots by construction — one parallel stats read each, not an N+1 concern
      const pairs = await Promise.all(bots.map((b) =>
        garageFetch('botStats', { id: b.id }, session).then((x) => [b.id, x?.stats || null]).catch(() => [b.id, null])));
      setStats(Object.fromEntries(pairs));
    } finally { setLoading(false); }
  }, [session]);
  useEffect(() => { if (session) load(); }, [session, load]);

  function open(b) {
    setBot(b); setName(b.name); setPublishErrors(null); setSelected(null);
    const g = botNodes(b);
    setNodes(g.nodes); setEdges(g.edges);
    setView('form');
  }
  async function openById(id) {
    const r = await garageFetch('getBot', { id }, session);
    if (r?.bot) open(r.bot);
  }
  function startNew() {
    open({ id: null, name: 'New web assistant', status: 'draft', active_version: null, draft_definition: { entry: null, steps: {} }, config: {} });
  }

  // Serialize the canvas. toDefinition throws without an entry edge — surface as a toast.
  function currentDefinition() {
    try { return toDefinition(nodes, edges); }
    catch { showToast('Connect Chat start to a first step before saving', 'error'); return null; }
  }

  async function save() {
    if (!name.trim()) { showToast('Name required', 'error'); return; }
    const definition = currentDefinition();
    if (!definition) return;
    setBusy(true);
    try {
      const r = await workerFetch('saveBot', { id: bot.id || undefined, name: name.trim(), draft_definition: definition, config: bot.config || {} }, session);
      const saved = r?.data?.bot || r?.bot;
      if (!saved) { showToast(`Save failed: ${r?.error || 'unknown'}`, 'error'); return; }
      setBot((b) => ({ ...b, ...saved }));
      showToast('Draft saved');
      load();
    } finally { setBusy(false); }
  }

  async function publish() {
    if (!bot?.id) { showToast('Save the draft first', 'error'); return; }
    setBusy(true); setPublishErrors(null);
    try {
      const r = await workerFetch('publishBot', { id: bot.id }, session);
      const d = r?.data || r;
      if (d?.bot) { setBot((b) => ({ ...b, ...d.bot })); showToast(`Published v${d.version} — live`); load(); }
      else if (d?.errors || r?.errors) setPublishErrors(d?.errors || r?.errors);
      else showToast(`Publish failed: ${r?.error || d?.error || 'unknown'}`, 'error');
    } finally { setBusy(false); }
  }

  async function setStatus(next) {
    setBusy(true);
    try {
      const r = await workerFetch(next === 'paused' ? 'pauseBot' : 'resumeBot', { id: bot.id }, session);
      const d = r?.data?.bot || r?.bot;
      if (d) { setBot((b) => ({ ...b, ...d })); showToast(next === 'paused' ? 'Paused — the widget shows the away message' : 'Active'); load(); }
    } finally { setBusy(false); }
  }

  const selectedNode = nodes.find((n) => n.id === selected && n.id !== TRIGGER_ID) || null;
  const updateSelectedConfig = (cfg) => setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: cfg } } : n)));
  const deleteSelected = () => {
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  };

  if (loading) return <div style={{ padding: 24 }}><Spinner /></div>;

  if (view === 'list') {
    return (
      <Panel title="Bots" pad
        action={canBuild ? <Btn kind="primary" onClick={startNew}><Plus size={14} /> New bot</Btn> : null}>
        {rows.length === 0 ? (
          <EmptyState title="No bots yet" hint="A bot is a scripted conversation — menus, order status, agent handoff — that runs on the website chat widget." />
        ) : (
          <table className="tbl"><thead><tr><th>Name</th><th>Status</th><th>Channel</th><th>Version</th><th>Last 7 days</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const st = stats[r.id];
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                    <td className="mono">{r.channel}</td>
                    <td className="mono">{r.active_version ? `v${r.active_version}` : '—'}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {st ? `${st.sessions} chats · ${st.handled} handled · ${st.handoffs} to agents · ${st.conversions} converted` : '—'}
                    </td>
                    <td><Btn onClick={() => openById(r.id)}>Open</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Btn onClick={() => { setView('list'); load(); }}><ArrowLeft size={14} /> Back to bots</Btn>
        <input className="f-inp" style={{ maxWidth: 300 }} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !canBuild} />
        <Badge label={bot?.status || 'draft'} tone={STATUS_TONE[bot?.status] || 'gray'} />
        {bot?.active_version && <span className="dim" style={{ fontSize: 12 }}>live: v{bot.active_version}</span>}
        <span style={{ flex: 1 }} />
        {canBuild && <Btn onClick={save} disabled={busy}>Save draft</Btn>}
        {canActivate && bot?.id && <Btn kind="primary" onClick={publish} disabled={busy}><Check size={14} /> Publish</Btn>}
        {canActivate && bot?.status === 'active' && <Btn onClick={() => setStatus('paused')} disabled={busy}><Pause size={14} /> Pause</Btn>}
        {canActivate && bot?.status === 'paused' && <Btn onClick={() => setStatus('active')} disabled={busy}><Play size={14} /> Resume</Btn>}
      </div>

      {publishErrors && (
        <div className="info-bar" style={{ background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.3)', marginBottom: 10 }}>
          <span>Cannot publish: {publishErrors.map((e) => `${e.stepId || '?'} — ${e.code}${e.handle ? ` (${e.handle})` : ''}`).join(' · ')}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14, alignItems: 'start' }}>
        <div>
          <JourneyCanvas mode="bot" nodes={nodes} edges={edges} setNodes={setNodes} setEdges={setEdges}
            onSelect={setSelected} readOnly={busy || !canBuild} />
        </div>
        <div>
          <Panel title={selectedNode ? 'Step' : 'Test'} pad>
            {selectedNode
              ? <BotDrawer nodeId={selectedNode.id} config={selectedNode.data?.config}
                  onChange={updateSelectedConfig} onDelete={deleteSelected} readOnly={busy || !canBuild} />
              : <TestPanel botId={bot?.id} definition={currentDefinitionSafe(nodes, edges)} session={session} />}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// Test panel needs a definition even while the graph is mid-edit; a graph with no entry
// edge simply yields null and the panel's first turn reports it — never a throw.
function currentDefinitionSafe(nodes, edges) {
  try { return toDefinition(nodes, edges); } catch { return null; }
}
