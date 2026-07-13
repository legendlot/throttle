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
import { Zap, Mail, MessageCircle, Clock, GitBranch, LogOut, Plus } from 'lucide-react';
import { HANDLES, TRIGGER_ID, localLint } from './graph.js';

const STEP_META = {
  send:      { label: 'Send',      icon: null,      color: 'var(--accent, #F2CD1A)' },
  wait:      { label: 'Wait',      icon: Clock,     color: '#9aa0a6' },
  condition: { label: 'Condition', icon: GitBranch, color: '#e8b93c' },
  exit:      { label: 'Exit',      icon: LogOut,    color: '#57b56b' },
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
        {t.type === 'event' ? `event: ${t.name || '?'}` : (t.type || 'not set')}
      </div>
      <Handle type="source" position={Position.Right} id="entry" />
    </div>
  );
}

function StepNode({ data, selected }) {
  const c = data.config || {};
  const meta = STEP_META[c.type] || STEP_META.wait;
  const Icon = c.type === 'send' ? (c.channel === 'whatsapp' ? MessageCircle : Mail) : meta.icon;
  const handles = HANDLES[c.type] || [];
  const sub = c.type === 'send' ? `${c.channel || 'email'} · ${c.purpose || 'marketing'}`
    : c.type === 'wait' ? (c.duration || 'duration not set')
    : c.type === 'condition' ? (c.check?.kind ? `${c.check.kind}${c.check.event ? `: ${c.check.event}` : ''}` : 'check not set')
    : (c.outcome || 'completed');
  return (
    <div style={nodeBox(selected, meta.color)}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
        {Icon && <Icon size={13} style={{ color: meta.color }} />} {meta.label}
      </div>
      <div className="mono" style={{ marginTop: 4, color: 'var(--text-2, #555)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
      {handles.map((h, i) => (
        <div key={h}>
          <Handle type="source" position={Position.Right} id={h} style={{ top: 24 + i * 20 }} />
          {handles.length > 1 && (
            <span style={{ position: 'absolute', right: 10, top: 16 + i * 20, fontSize: 10, color: 'var(--text-3, #888)' }}>{h}</span>
          )}
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { trigger: TriggerNode, step: StepNode };

const NEW_STEP = {
  send:      { type: 'send', channel: 'email', purpose: 'marketing', templateId: '' },
  wait:      { type: 'wait', duration: '24 hours' },
  condition: { type: 'condition', check: { kind: 'no_event_since_enrol', event: 'order_placed' } },
  exit:      { type: 'exit', outcome: 'completed' },
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
    data: { config: { ...NEW_STEP[t], ...(t === 'condition' ? { check: { ...NEW_STEP.condition.check } } : {}) } },
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
      <div style={{ height: 480, border: '1px solid var(--bd, #ddd)', borderRadius: 10 }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          onNodeClick={(_, n) => onSelect && onSelect(n.id)}
          onPaneClick={() => onSelect && onSelect(null)}
          nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
          deleteKeyCode={readOnly ? null : 'Backspace'} fitView proOptions={{ hideAttribution: true }}>
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
