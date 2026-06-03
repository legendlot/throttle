'use client';
import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, ZoomIn, ZoomOut, Maximize2,
  ChevronsDownUp, ChevronsUpDown, Network, ListTree, Users,
} from 'lucide-react';
import { buildOrgForest, countDescendants } from '../lib/orgTree.js';

// Collect ids of every node that has children (the collapsible set).
function collapsibleIds(forest) {
  const ids = [];
  const walk = (n) => { if (n.children.length) { ids.push(n.id); n.children.forEach(walk); } };
  forest.forEach(walk);
  return ids;
}

// Interactive org chart (zero deps). Collapsible nodes, pan via drag, zoom,
// horizontal (top-down) OR vertical (indented) layout, click-through to profile.
export default function OrgChart({ nodes, onSelect }) {
  const forest = useMemo(() => buildOrgForest(nodes || []), [nodes]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [orientation, setOrientation] = useState('horizontal'); // horizontal | vertical
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(null);

  const total = (nodes || []).length;
  const founders = forest.length;              // top-level (no manager) = founders
  const vertical = orientation === 'vertical';

  function toggle(id) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function collapseAll() { setCollapsed(new Set(collapsibleIds(forest))); }
  function expandAll() { setCollapsed(new Set()); }
  function flip() { setOrientation(o => (o === 'horizontal' ? 'vertical' : 'horizontal')); setPan({ x: 0, y: 0 }); }

  function onDown(e) {
    if (e.target.closest('[data-node]')) return; // don't pan when grabbing a node
    setDrag({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y });
  }
  function onMove(e) {
    if (!drag) return;
    setPan({ x: drag.px + (e.clientX - drag.sx), y: drag.py + (e.clientY - drag.sy) });
  }
  function onUp() { setDrag(null); }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', overflow: 'hidden', height: 'calc(100dvh - 220px)', minHeight: 360 }}>
      <style>{ORG_CSS}</style>

      {/* Toolbar */}
      <div style={toolbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={countPill} title="Total people in this view">
            <Users size={13} /> {total} {total === 1 ? 'person' : 'people'}
            <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {Math.max(total - founders, 0)} excl. founders</span>
          </span>
          <span style={divider} />
          <button style={tbtn} onClick={expandAll} title="Expand every node"><ChevronsUpDown size={14} /> Expand all</button>
          <button style={tbtn} onClick={collapseAll} title="Collapse to founders"><ChevronsDownUp size={14} /> Collapse all</button>
          <span style={divider} />
          <button style={tbtn} onClick={flip} title="Switch layout">
            {vertical ? <Network size={14} /> : <ListTree size={14} />} {vertical ? 'Horizontal' : 'Vertical'} layout
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={zoomBtn} onClick={() => setZoom(z => Math.min(z + 0.1, 2))} title="Zoom in"><ZoomIn size={15} /></button>
          <button style={zoomBtn} onClick={() => setZoom(z => Math.max(z - 0.1, 0.4))} title="Zoom out"><ZoomOut size={15} /></button>
          <button style={zoomBtn} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} title="Reset view"><Maximize2 size={15} /></button>
        </div>
      </div>

      <div
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        style={{ flex: 1, overflow: 'auto', cursor: drag ? 'grabbing' : 'grab' }}
      >
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: vertical ? 'top left' : 'top center', transition: drag ? 'none' : 'transform .12s', padding: '32px 24px', minWidth: 'max-content' }}>
          <div className={`pdorg${vertical ? ' vertical' : ''}`}>
            <ul>
              {forest.map(root => <OrgNode key={root.id} node={root} collapsed={collapsed} toggle={toggle} onSelect={onSelect} />)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function OrgNode({ node, collapsed, toggle, onSelect }) {
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const dept = node.department?.name || node.department || '';
  const initials = (node.full_name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <li>
      <div className="pdorg-card" data-node onClick={() => onSelect && onSelect(node)} title={node.full_name}>
        <div className="pdorg-avatar">
          {node.photo_url ? <img src={node.photo_url} alt="" /> : <span>{initials}</span>}
        </div>
        <div className="pdorg-meta">
          <div className="pdorg-name">{node.full_name}</div>
          <div className="pdorg-title">{node.job_title || '—'}</div>
          {dept && <div className="pdorg-dept">{dept}</div>}
        </div>
        {hasKids && (
          <button
            className="pdorg-toggle"
            onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
            title={isCollapsed ? `Expand (${countDescendants(node)})` : 'Collapse'}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            {isCollapsed && <span className="pdorg-count">{countDescendants(node)}</span>}
          </button>
        )}
      </div>
      {hasKids && !isCollapsed && (
        <ul>
          {node.children.map(c => <OrgNode key={c.id} node={c} collapsed={collapsed} toggle={toggle} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

const toolbar = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)',
};
const tbtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface-3)', color: 'var(--text-1)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '5px 10px',
  fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
  textTransform: 'uppercase', cursor: 'pointer',
};
const countPill = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-1)',
};
const divider = { width: 1, height: 18, background: 'var(--border)', display: 'inline-block' };
const zoomBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, background: 'var(--surface-3)', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
};

// Classic nested-list CSS org chart. Horizontal (top-down) by default; the
// `.vertical` modifier flips it to a compact left-to-right indented tree.
const ORG_CSS = `
.pdorg, .pdorg ul { list-style: none; margin: 0; padding: 0; }
.pdorg ul { display: flex; padding-top: 22px; position: relative; }
.pdorg li { position: relative; padding: 22px 12px 0; text-align: center; }
.pdorg li::before, .pdorg li::after {
  content: ''; position: absolute; top: 0; right: 50%;
  border-top: 1px solid var(--border-2); width: 50%; height: 22px;
}
.pdorg li::after { right: auto; left: 50%; border-left: 1px solid var(--border-2); }
.pdorg li:only-child::after, .pdorg li:only-child::before { display: none; }
.pdorg li:only-child { padding-top: 22px; }
.pdorg li:first-child::before, .pdorg li:last-child::after { border: 0 none; }
.pdorg li:last-child::before { border-right: 1px solid var(--border-2); border-radius: 0 6px 0 0; }
.pdorg li:first-child::after { border-radius: 6px 0 0 0; }
.pdorg ul ul::before {
  content: ''; position: absolute; top: 0; left: 50%;
  border-left: 1px solid var(--border-2); width: 0; height: 22px;
}
.pdorg-card {
  position: relative; display: inline-flex; align-items: center; gap: 9px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 8px 10px; min-width: 170px; max-width: 220px; text-align: left; cursor: pointer;
  transition: border-color .12s, background .12s;
}
.pdorg-card:hover { border-color: var(--podium-accent); background: var(--surface-3); }
.pdorg-avatar {
  flex: 0 0 auto; width: 34px; height: 34px; border-radius: var(--radius-full);
  background: var(--surface-3); color: var(--podium-accent); overflow: hidden;
  display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
}
.pdorg-avatar img { width: 100%; height: 100%; object-fit: cover; }
.pdorg-meta { min-width: 0; }
.pdorg-name { font-size: 13px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pdorg-title { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pdorg-dept { font-size: 10px; color: var(--text-3); letter-spacing: .04em; text-transform: uppercase; }
.pdorg-toggle {
  position: absolute; bottom: -11px; left: 50%; transform: translateX(-50%);
  display: inline-flex; align-items: center; gap: 2px; background: var(--surface-3);
  color: var(--text-2); border: 1px solid var(--border-2); border-radius: var(--radius-full);
  padding: 1px 6px; cursor: pointer; z-index: 2;
}
.pdorg-count { font-size: 10px; font-weight: 700; color: var(--podium-accent); }

/* ── Vertical (left-to-right indented) layout ────────────────────────────── */
.pdorg.vertical ul { display: block; padding-top: 0; }
.pdorg.vertical li { padding: 8px 0 0 0; text-align: left; }
.pdorg.vertical li::before, .pdorg.vertical li::after { display: none; }
.pdorg.vertical ul ul {
  margin-left: 20px; padding-left: 18px; padding-top: 0;
  border-left: 1px solid var(--border-2);
}
.pdorg.vertical .pdorg-toggle {
  position: static; transform: none; bottom: auto; left: auto; margin-left: 8px;
}
`;
