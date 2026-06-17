'use client';
// Org chart (Pit Wall v2) — restyled to the prototype layout:
//   root (CEO / founder) card(s) → vertical connector → responsive grid of
//   manager cards, each listing its direct reports as mini avatar rows.
// Lossless for deep orgs: every non-root node that has reports gets its own
// card, so reporting lines at any depth are represented (a manager who also
// reports to someone appears both as a mini-row under their manager and as
// their own card). Individual contributors appear only as mini-rows.
import { useMemo } from 'react';
import { buildOrgForest } from '../lib/orgTree.js';
import { Avatar } from './ui.js';

function deptName(n) { return n.department?.name || n.department || ''; }

export default function OrgChart({ nodes, onSelect }) {
  const { roots, managers } = useMemo(() => {
    const forest = buildOrgForest(nodes || []);
    const mgrs = [];
    const walk = (n, isRoot) => {
      if (!isRoot && n.children.length) mgrs.push(n);
      n.children.forEach(c => walk(c, false));
    };
    forest.forEach(r => walk(r, true));
    return { roots: forest, managers: mgrs };
  }, [nodes]);

  const click = (n) => () => onSelect && onSelect(n);

  return (
    <div style={{ maxWidth: 1180 }}>
      {/* Root(s) */}
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 14 }}>
        {roots.map(r => (
          <div key={r.id} data-node onClick={click(r)} title={r.full_name}
            style={{ display: 'flex', alignItems: 'center', gap: 13, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 12, padding: '15px 22px', boxShadow: 'var(--shadow-card)', cursor: 'pointer' }}>
            <Avatar name={r.full_name} photoUrl={r.photo_url} tintKey={r.id} size={42} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{r.full_name}</div>
              <div style={{ fontSize: 12, color: 'var(--t2)' }}>{r.job_title || deptName(r) || '—'}</div>
            </div>
          </div>
        ))}
      </div>

      {managers.length > 0 && <div style={{ height: 24, width: 1, background: 'var(--border)', margin: '0 auto' }} />}

      {/* Manager cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'start' }}>
        {managers.map(m => (
          <div key={m.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
            <div data-node onClick={click(m)} title={m.full_name}
              style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 11, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <Avatar name={m.full_name} photoUrl={m.photo_url} tintKey={m.id} size={34} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{m.full_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--t2)' }}>{m.job_title || deptName(m) || '—'}</div>
              </div>
            </div>
            <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {m.children.map(r => (
                <div key={r.id} data-node onClick={click(r)} title={r.full_name} className="pd-org-report"
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 8px', borderRadius: 7, background: 'var(--bg)', cursor: 'pointer' }}>
                  <Avatar name={r.full_name} photoUrl={r.photo_url} tintKey={r.id} size={26} />
                  <span style={{ fontSize: 12.5, color: 'var(--t-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.full_name}</span>
                  {r.children.length > 0 && <span className="num" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--t4)' }}>+{r.children.length}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
