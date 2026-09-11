'use client';
// Bot-mode half of the /journeys builder page (S312). Same canvas surface as journeys
// (JourneyCanvas mode="bot"), its own list + save/publish/test wiring against the
// listBots/saveBot/publishBot/testBotTurn worker actions. Deliberately compact: bots
// have no triggers, exit rules, versions UI or funnel — a definition, a status, a test.
import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Play, Pause, Check, Plus, Send } from 'lucide-react';
import { Panel, Badge, Btn, EmptyState } from '@/components/ui.js';
import { fromDefinition, toDefinition, duplicateNode, TRIGGER_ID } from '@/components/journey-canvas/graph.js';
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
  // ⚠️ testBotTurn runs ONE definition. To follow a Shared flow the panel keeps a local
  // frame: while it is set, every turn is sent against the SHARED bot's draft_definition,
  // and a `subflow_return` effect pops it and resumes the parent at `return_step`.
  // Refs, not state, because a single click can chain 3 turns before React re-renders.
  const stateRef = useRef(null);
  const frameRef = useRef(null);   // { definition, name, return_step } | null

  const turn = useCallback(async (input) => {
    setBusy(true);
    try {
      let curInput = input;
      let hops = 0;
      while (curInput && hops++ < 8) {
        const frame = frameRef.current;
        const def = frame ? frame.definition : definition;
        const r = await workerFetch('testBotTurn', { id: botId, definition: def, state: stateRef.current, input: curInput }, session);
        const out = r?.data || r;
        if (!out?.state) return;
        stateRef.current = out.state;
        setState(out.state);
        const lines = [
          ...(curInput.kind === 'open' || curInput.kind === 'resume' ? [] : [{ who: 'you', text: curInput.text || curInput.buttonId }]),
          ...(out.replies || []).map((rp) => ({ who: 'bot', text: rp.text, buttons: rp.buttons, style: rp.style })),
          ...(out.effects || []).filter((e) => e.type === 'handoff').map(() => ({ who: 'sys', text: '→ would hand off to an agent here' })),
          ...(out.effects || []).filter((e) => e.type === 'order_lookup').map((e) => ({ who: 'sys', text: `→ would look up ${e.orderNumber} (verified against ${e.identity?.phone || e.identity?.email || 'nothing — no identity collected!'})` })),
        ];
        const enter = (out.effects || []).find((e) => e.type === 'subflow_enter');
        const back = (out.effects || []).find((e) => e.type === 'subflow_return');
        curInput = null;
        if (enter) {
          const g = await garageFetch('getBot', { id: enter.bot_id }, session);
          const shared = g?.bot;
          if (!shared?.draft_definition) lines.push({ who: 'sys', text: '→ shared flow not found — cannot follow it in the test panel' });
          else {
            // The panel tests the shared bot's DRAFT — the runtime jumps into its ACTIVE
            // (published) version. Said here so a draft-only difference is never mistaken
            // for a bug.
            lines.push({ who: 'sys', text: `→ enters shared flow "${shared.name}" (draft — the live bot runs its published version)` });
            frameRef.current = { definition: shared.draft_definition, name: shared.name, return_step: enter.return_step };
            // The engine's `end` step only emits `subflow_return` when `state.frame` is set
            // (bot-engine.js walk()'s `end` branch) — bot-turn.js installs it before the
            // `open` turn against the shared definition (bot-turn.js:69). Without it the
            // shared flow's `end` just sets `ended` and the panel hangs there.
            stateRef.current = { current_step: null, status: 'active', context: out.state.context || {}, frame: { bot_id: enter.bot_id, version: shared.active_version || null, return_step: enter.return_step } };
            setState(stateRef.current);
            curInput = { kind: 'open' };
          }
        } else if (back && frame) {
          lines.push({ who: 'sys', text: '→ returns' });
          frameRef.current = null;
          // `out.state` is already the engine's returned state with `frame` cleared
          // (bot-engine.js's `end` branch does `state.frame = null` itself) — resume
          // against the PARENT definition using it as-is.
          curInput = { kind: 'resume', from: back.return_step || frame.return_step };
        }
        setTranscript((t) => [...t, ...lines]);
      }
    } finally { setBusy(false); }
  }, [botId, definition, session]);

  // Fire the open turn from start() itself — the old "auto-fire when current_step is null"
  // effect would also fire on the fresh state a sub-flow entry installs.
  const start = () => {
    stateRef.current = { current_step: null, status: 'active', context: {} };
    frameRef.current = null;
    setState(stateRef.current); setTranscript([]);
    turn({ kind: 'open' });
  };

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
                      {/* a WhatsApp LIST renders one row per line, not a row of chips */}
                      {m.buttons.map((b) => (
                        <button key={b.id} className="btn" type="button"
                          style={{ marginRight: 5, marginBottom: 3, fontSize: 12, ...(m.style === 'list' ? { display: 'block', width: '100%', textAlign: 'left' } : null) }}
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
  const [settings, setSettings] = useState(false);

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
    setBot(b); setName(b.name); setPublishErrors(null); setSelected(null); setSettings(false);
    const g = botNodes(b);
    setNodes(g.nodes); setEdges(g.edges);
    setView('form');
  }
  async function openById(id) {
    const r = await garageFetch('getBot', { id }, session);
    if (r?.bot) open(r.bot);
  }
  function startNew() {
    open({ id: null, name: 'New web assistant', status: 'draft', active_version: null, channel: 'web', draft_definition: { entry: null, steps: {} }, config: {} });
  }

  // Serialize the canvas. toDefinition throws without an entry edge — surface as a toast.
  // KEYWORDS are top-level definition state, not a node, so toDefinition() (which builds
  // the definition purely from nodes+edges) cannot know about them — merge them back in
  // or every save would drop them.
  function currentDefinition() {
    try { return { ...toDefinition(nodes, edges), keywords: (bot?.draft_definition?.keywords || []).filter((k) => k.match?.length && k.target) }; }
    catch { showToast('Connect Chat start to a first step before saving', 'error'); return null; }
  }

  async function save() {
    if (!name.trim()) { showToast('Name required', 'error'); return; }
    const definition = currentDefinition();
    if (!definition) return;
    setBusy(true);
    try {
      const r = await workerFetch('saveBot', { id: bot.id || undefined, name: name.trim(), draft_definition: definition, config: bot.config || {}, channel: bot.channel || 'web' }, session);
      const saved = r?.data?.bot || r?.bot;
      if (!saved) { showToast(`Save failed: ${r?.error || 'unknown'}`, 'error'); return; }
      // The wire definition drops incomplete keyword rows (filtered above); a half-typed
      // row must survive locally so Save draft never erases what the author is mid-typing.
      setBot((b) => ({ ...b, ...saved, draft_definition: { ...saved.draft_definition, keywords: b.draft_definition?.keywords || saved.draft_definition?.keywords || [] } }));
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

  // Only a PUBLISHED, ACTIVE shared flow can be jumped into — an unpublished one has no
  // active version for the engine to run, and a paused one is what the worker's publish
  // lint and the runtime loader both require too. Picking anything else would only earn
  // `subflow_target_invalid`.
  const sharedBots = rows.filter((r) => r.channel === 'shared' && r.active_version && r.status === 'active');
  const selectedNode = nodes.find((n) => n.id === selected && n.id !== TRIGGER_ID) || null;
  const updateSelectedConfig = (cfg) => setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: cfg } } : n)));
  const deleteSelected = () => {
    setNodes((ns) => ns.filter((n) => n.id !== selected));
    setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  };
  // Pruthvi, #bugs 2026-09-11: the journey builder had Replicate, bots did not. Same
  // helper, so a copy is unwired and deep-cloned identically in both builders.
  const duplicateSelected = () => {
    const node = duplicateNode(selectedNode);
    if (!node) return;
    setNodes((ns) => [...ns, node]);
    setSelected(node.id);
  };

  // S362 — canvas expand. Above the early return below, so hook order never depends on `loading`.
  const [canvasExpanded, setCanvasExpanded] = useState(false);

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
                    <td className="mono">
                      {r.channel}
                      {r.channel === 'whatsapp' && r.config?.mode && (
                        <> <Badge label={r.config.mode} tone={r.config.mode === 'public' ? 'orange' : 'green'} /></>
                      )}
                    </td>
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

  // S362 — the settings/step/test panel, built ONCE. Passed to the canvas as `aside` so it docks
  // beside the flow when expanded, and rendered in its normal right-hand column otherwise —
  // never both, or two live copies of the same form would fight over ids and focus.
  const sidePanel = (
    <Panel title={settings ? 'Bot settings' : selectedNode ? 'Step' : 'Test'} pad>
      {settings
        ? <BotSettings bot={bot || {}} setBot={setBot} sharedBots={sharedBots}
            canActivate={canActivate} session={session} showToast={showToast} />
        : selectedNode
          ? <BotDrawer nodeId={selectedNode.id} config={selectedNode.data?.config}
              onChange={updateSelectedConfig} onDelete={deleteSelected} onDuplicate={duplicateSelected}
              readOnly={busy || !canBuild}
              sharedBots={sharedBots} />
          : <TestPanel botId={bot?.id} definition={currentDefinitionSafe(nodes, edges, bot)} session={session} />}
    </Panel>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Btn onClick={() => { setView('list'); load(); }}><ArrowLeft size={14} /> Back to bots</Btn>
        <input className="f-inp" style={{ maxWidth: 300 }} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !canBuild} />
        <Badge label={bot?.status || 'draft'} tone={STATUS_TONE[bot?.status] || 'gray'} />
        {bot?.active_version && <span className="dim" style={{ fontSize: 12 }}>live: v{bot.active_version}</span>}
        <span style={{ flex: 1 }} />
        <Btn onClick={() => setSettings((s) => !s)}>Settings</Btn>
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
            onSelect={setSelected} readOnly={busy || !canBuild}
            aside={sidePanel} onExpandedChange={setCanvasExpanded} />
        </div>
        {!canvasExpanded && <div>{sidePanel}</div>}
      </div>
    </div>
  );
}

// Test panel needs a definition even while the graph is mid-edit; a graph with no entry
// edge simply yields null and the panel's first turn reports it — never a throw.
// Carries `keywords` too, so a test run behaves like the saved bot will.
function currentDefinitionSafe(nodes, edges, bot) {
  try { return { ...toDefinition(nodes, edges), keywords: (bot?.draft_definition?.keywords || []).filter((k) => k.match?.length && k.target) }; } catch { return null; }
}

// ── Bot settings — the things that are properties of the BOT, not of any one step:
//    which channel it answers on, the keywords that jump straight to a step from the
//    opening message (or from an invalid answer), and the WhatsApp rollout.
//    Channel is fixed after the first publish: sessions and the inbox key on it.
function BotSettings({ bot, setBot, sharedBots, canActivate, session, showToast }) {
  const def = bot.draft_definition || {};
  const keywords = Array.isArray(def.keywords) ? def.keywords : [];
  const setDef = (patch) => setBot((b) => ({ ...b, draft_definition: { ...(b.draft_definition || {}), ...patch } }));
  const [mode, setMode] = useState(bot.config?.mode || 'pilot');
  const [nums, setNums] = useState((bot.config?.pilot_numbers || []).join(', '));
  // Rollout is a SEPARATE action (activate tier) — saveBot strips mode/pilot_numbers
  // from config on purpose, so a build-only user can never widen the audience.
  async function saveMode() {
    const r = await workerFetch('setBotMode', { id: bot.id, mode, pilot_numbers: nums.split(/[,\s]+/).filter(Boolean) }, session);
    const d = r?.data?.bot || r?.bot;
    if (d) { setBot((b) => ({ ...b, config: d.config })); showToast(mode === 'public' ? 'PUBLIC — every customer on the number will get the bot' : 'Pilot mode saved'); }
    else showToast(`Failed: ${r?.error || 'unknown'}`, 'error');
  }
  return (
    <div>
      <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Channel</div>
        <select className="f-inp" value={bot.channel || 'web'} disabled={!!bot.active_version} onChange={(e) => setBot((b) => ({ ...b, channel: e.target.value }))}>
          <option value="web">Web widget</option><option value="whatsapp">WhatsApp (support number)</option><option value="shared">Shared flow (used by other bots)</option>
        </select>
        {bot.active_version && <div className="dim" style={{ fontSize: 12 }}>Fixed after first publish.</div>}
      </div>
      <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Keywords (opening message, or an invalid answer) → step</div>
        {keywords.map((k, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="f-inp" placeholder="track, where is my order" value={(k.match || []).join(', ')}
              onChange={(e) => setDef({ keywords: keywords.map((x, j) => (j === i ? { ...x, match: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)) })} />
            <input className="f-inp" style={{ maxWidth: 160 }} placeholder="step id" value={k.target || ''}
              onChange={(e) => setDef({ keywords: keywords.map((x, j) => (j === i ? { ...x, target: e.target.value.trim() } : x)) })} />
            <button className="btn" type="button" onClick={() => setDef({ keywords: keywords.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        {keywords.length < 20 && <button className="btn" type="button" onClick={() => setDef({ keywords: [...keywords, { match: [], target: '' }] })}>+ Add keyword</button>}
      </div>
      {bot.channel === 'whatsapp' && (
        <div className="ff" style={{ marginBottom: 10 }}><div className="kv-k">Rollout (activate permission)</div>
          <select className="f-inp" value={mode} disabled={!canActivate || !bot.id} onChange={(e) => setMode(e.target.value)}>
            <option value="pilot">Pilot — only the numbers below</option><option value="public">Public — every customer</option>
          </select>
          <input className="f-inp" style={{ marginTop: 6 }} placeholder="917709991011, 91..." value={nums} disabled={!canActivate || !bot.id} onChange={(e) => setNums(e.target.value)} />
          {canActivate && bot.id && <Btn onClick={saveMode} style={{ marginTop: 6 }}>Save rollout</Btn>}
          <div className="dim" style={{ fontSize: 12 }}>Answers on the support WhatsApp number. Public is Afshaan&rsquo;s call.</div>
        </div>
      )}
      {bot.channel === 'shared' && <div className="dim" style={{ fontSize: 12 }}>A shared flow has no customers of its own; other bots jump into it with a &ldquo;Shared flow&rdquo; step.</div>}
    </div>
  );
}
