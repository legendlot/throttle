'use client';
// The React Flow canvas. Controlled: the PAGE owns nodes/edges state; this renders
// them + palette + lint strip and reports changes up. Client-only (page imports it
// via next/dynamic ssr:false — React Flow touches window).
import { useCallback } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position,
  applyNodeChanges, applyEdgeChanges, addEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Zap, Mail, MessageCircle, Clock, Timer, GitBranch, LogOut, Plus, CreditCard, Tag, ShoppingBag } from 'lucide-react';
import { handlesFor, TRIGGER_ID, localLint } from './graph.js';
import { humanOutcome } from './labels.js';

const STEP_META = {
  send:          { label: 'Send',              icon: null,      color: 'var(--accent, #F2CD1A)' },
  wait:          { label: 'Wait',               icon: Clock,     color: '#9aa0a6' },
  wait_response: { label: 'Wait for response',  icon: Timer,     color: '#7aa7ff' },
  condition:     { label: 'Condition',          icon: GitBranch, color: '#e8b93c' },
  exit:          { label: 'Exit',               icon: LogOut,    color: '#57b56b' },
  // J3 action kinds + interactive send — keyed by kind / a synthetic key (palette + node render).
  payment_link:   { label: 'Payment link',      icon: CreditCard, color: '#c07ad6' },
  set_attr:       { label: 'Set attribute',     icon: Tag,        color: '#c07ad6' },
  order_modify:   { label: 'Modify order',      icon: ShoppingBag, color: '#c07ad6' },
  interactive_send: { label: 'WA buttons',      icon: MessageCircle, color: 'var(--accent, #F2CD1A)' },
};

const nodeBox = (selected, color) => ({
  background: 'var(--surface, #fff)', border: `1.5px solid ${selected ? color : 'var(--bd, #d8d8d8)'}`,
  borderRadius: 10, padding: '10px 12px', minWidth: 190, fontSize: 13,
  boxShadow: selected ? `0 0 0 2px ${color}33` : '0 1px 3px rgba(0,0,0,.08)',
});

function TriggerNode({ data, selected }) {
  const t = data.trigger || {};
  return (
    <div style={nodeBox(selected, '#DE2A2A')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: '#DE2A2A' }}>
        <Zap size={13} /> Trigger
      </div>
      <div className="mono" style={{ marginTop: 4, color: 'var(--text-2, #555)' }}>
        {t.type === 'event' ? `event: ${t.name || '?'}`
          : t.type === 'segment_entry' ? `enters: ${t.segment_name || t.segment_id || '?'}`
          : (t.type || 'not set')}
      </div>
      {/* An enrolment filter narrows the audience to a slice — often a single test product
          during a staged rollout. It has to be visible ON the canvas: someone glancing at a
          live money-moving journey must be able to see it is still pinned, without opening
          the trigger form (S241). */}
      {t.type === 'event' && t.filter && Object.keys(t.filter).length > 0 && (
        <div className="mono" style={{ marginTop: 3, fontSize: 10, color: '#B45309' }}>
          {Object.entries(t.filter).map(([k, v]) => `${k}=${v}`).join(' & ')}
        </div>
      )}
      <Handle type="source" position={Position.Right} id="entry" />
    </div>
  );
}

function StepNode({ data, selected }) {
  const c = data.config || {};
  // Node visual keyed by: interactive send → 'interactive_send'; action → its kind; else type.
  const isAction = c.type === 'action';
  const isInteractive = c.type === 'send' && c.interactive;
  const metaKey = isInteractive ? 'interactive_send' : (isAction ? c.kind : c.type);
  const meta = STEP_META[metaKey] || STEP_META.wait;
  const Icon = (c.type === 'send' && !isInteractive) ? (c.channel === 'whatsapp' ? MessageCircle : Mail) : meta.icon;
  const handles = handlesFor(c);
  const sub = isInteractive ? `${(c.buttons || []).length} buttons · ${c.within || 'timeout not set'}`
    : c.type === 'send' ? `${c.channel || 'email'} · ${c.purpose || 'marketing'}`
    : c.type === 'wait' ? (c.duration || 'duration not set')
    : c.type === 'wait_response' ? `awaits ${(c.awaited || []).join(', ') || 'not set'} · ${c.within || 'duration not set'}`
    : c.type === 'condition' ? (
        c.check?.kind === 'event_property'
          ? `${c.check.field || '?'} ${c.check.op || 'eq'} "${c.check.value ?? ''}"`
          : c.check?.kind ? `${c.check.kind}${c.check.event ? `: ${c.check.event}` : ''}` : 'check not set')
    : isAction ? (c.kind === 'payment_link' ? (c.purpose || 'Cashfree pay-link')
        : c.kind === 'order_modify' ? (c.op || 'convert_to_prepaid')
        : `set ${c.attr || 'attr'} = ${c.value ?? ''}`)
    : (c.outcome || 'completed');
  return (
    <div style={nodeBox(selected, meta.color)}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        {Icon && <Icon size={13} style={{ color: meta.color }} />} {meta.label}
      </div>
      <div className="mono" style={{ marginTop: 4, color: 'var(--text-2, #555)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      {/* OUTCOMES render as their own rows under the body, not as absolutely-positioned
          labels floated over it. The old version pinned each label at `top: 16 + i*20`
          INSIDE the node box, so a 3-outcome node (C2P's WA-buttons step) stacked
          "Make Payment / Confirm COD Order / Cancel Order" straight through its own
          title and subtitle — unreadable exactly where the flow is most complex.
          Rows also let the node grow to fit, so N outcomes never overflow, and the
          handle sits on its row rather than at a guessed offset: React Flow reads
          handle geometry from the DOM, so nesting keeps label and dot aligned for free. */}
      {handles.length > 1 ? (
        <div style={{ marginTop: 7, borderTop: '1px solid var(--bd, #e2e2e2)', paddingTop: 5 }}>
          {handles.map((h) => (
            <div key={h} style={{ position: 'relative', display: 'flex', justifyContent: 'flex-end',
              alignItems: 'center', height: 18, paddingRight: 4 }}>
              <span style={{ fontSize: 10.5, color: 'var(--text-3, #888)', whiteSpace: 'nowrap' }}>
                {humanOutcome(h)}
              </span>
              <Handle type="source" position={Position.Right} id={h}
                style={{ position: 'absolute', right: -12, top: '50%', transform: 'translateY(-50%)' }} />
            </div>
          ))}
        </div>
      ) : (
        handles.map((h) => <Handle key={h} type="source" position={Position.Right} id={h} />)
      )}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, step: StepNode };

const NEW_STEP = {
  send:          { type: 'send', channel: 'email', purpose: 'marketing', templateId: '' },
  wait:          { type: 'wait', duration: '24 hours' },
  wait_response: { type: 'wait_response', awaited: ['order_placed'], within: '6 hours' },
  condition:     { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' } },
  exit:          { type: 'exit', outcome: 'completed' },
  // J3 action kinds — each palette button mints an action node of the given kind.
  payment_link:  { type: 'action', kind: 'payment_link', purpose: 'Complete your order payment' },
  set_attr:      { type: 'action', kind: 'set_attr', attr: '', value: '' },
  order_modify:  { type: 'action', kind: 'order_modify', op: 'convert_to_prepaid' },
  interactive_send: { type: 'send', channel: 'whatsapp', purpose: 'utility', interactive: true, within: '6 hours', templateId: '',
    buttons: [{ id: 'make_payment', label: 'Make Payment' }] },
};

let seq = 0;
const newId = (t) => `${t}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export default function JourneyCanvas({ nodes, edges, setNodes, setEdges, onSelect, readOnly }) {
  const onNodesChange = useCallback((ch) => setNodes((ns) => applyNodeChanges(ch, ns)), [setNodes]);
  const onEdgesChange = useCallback((ch) => setEdges((es) => applyEdgeChanges(ch, es)), [setEdges]);
  // one edge per source handle: connecting an already-wired handle rewires it
  const onConnect = useCallback((conn) => setEdges((es) =>
    addEdge(conn, es.filter((e) => !(e.source === conn.source && e.sourceHandle === conn.sourceHandle)))), [setEdges]);

  const addStep = (t) => setNodes((ns) => [...ns, {
    id: newId(t), type: 'step',
    position: { x: 120 + Math.random() * 80, y: 60 + Math.random() * 60 },
    data: { config: {
      ...NEW_STEP[t],
      ...(t === 'condition' ? { check: { ...NEW_STEP.condition.check } } : {}),
      ...(t === 'wait_response' ? { awaited: [...NEW_STEP.wait_response.awaited] } : {}),
      ...(t === 'interactive_send' ? { buttons: NEW_STEP.interactive_send.buttons.map((b) => ({ ...b })) } : {}),
    } },
  }]);

  const lint = localLint(nodes, edges);

  return (
    <div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          {Object.keys(NEW_STEP).map((t) => (
            <button key={t} className="btn" type="button" onClick={() => addStep(t)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Plus size={12} /> {STEP_META[t].label}
            </button>
          ))}
          <span className="dim" style={{ fontSize: 12 }}>Click a node to configure · drag from a right-side dot to connect · ⌫ deletes</span>
        </div>
      )}
      {lint.length > 0 && (
        <div className="info-bar" style={{ background: 'rgba(222,42,42,.06)', borderColor: 'rgba(222,42,42,.3)', marginBottom: 8 }}>
          <span>{lint.join(' · ')}</span>
        </div>
      )}
      {/* Sized against the VIEWPORT, not a fixed 480px. A journey is a wide graph and the
          old box showed roughly two nodes at a time, so reading one meant panning. Clamped
          so it still behaves on a laptop (min) and does not swallow a large screen (max). */}
      <div style={{ height: 'clamp(520px, 68vh, 860px)', border: '1px solid var(--bd, #ddd)', borderRadius: 10 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onNodeClick={(_, n) => onSelect && onSelect(n.id)}
          onPaneClick={() => onSelect && onSelect(null)}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
          deleteKeyCode={readOnly ? null : 'Backspace'}
          fitView
          // `fitView` alone zooms until the graph FILLS the box, so a 2-node journey
          // rendered enormous and a fresh one nearly full-screen. maxZoom 1 means fit
          // never magnifies past actual size — it may only zoom OUT to fit. minZoom
          // lets a long flow shrink far enough to be seen whole.
          fitViewOptions={{ padding: 0.22, maxZoom: 1, minZoom: 0.25 }}
          minZoom={0.25} maxZoom={1.75}
          proOptions={{ hideAttribution: true }}>
          <Background gap={16} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
    </div>
  );
}
