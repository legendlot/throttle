'use client';
// Grouped multi-select channel filter — collapses the dashboard's chip-wall into one pill.
// Channels are grouped by family; a family header toggles its whole group. Empty value = all.
import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { FAMILY_ORDER, FAMILIES, familyOf } from '../lib/families.js';

export default function ChannelFilter({ channels, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const sel = value || [];
  const isAll = sel.length === 0;

  const groups = FAMILY_ORDER
    .map(fk => ({ fk, label: FAMILIES[fk].label, color: FAMILIES[fk].color, chans: (channels || []).filter(c => familyOf(c.name) === fk) }))
    .filter(g => g.chans.length);

  const toggle = id => onChange(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const toggleFamily = (chans) => {
    const ids = chans.map(c => c.channel_id);
    const allOn = ids.every(id => sel.includes(id));
    onChange(allOn ? sel.filter(x => !ids.includes(x)) : [...new Set([...sel, ...ids])]);
  };

  // The count is a NUMBER — mono, per the type rule. Everything around it is prose, so it stays
  // in the UI font rather than setting the whole label in mono.
  const label = isAll
    ? 'All channels'
    : <><span style={{ fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>{sel.length}</span>{` channel${sel.length > 1 ? 's' : ''}`}</>;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* .so-btn already carries the UI font, weight and no letter-spacing — only the selection
          state (accent border once a subset is picked) is worth overriding here. */}
      <button className="so-btn ghost" onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, borderColor: isAll ? 'var(--border-strong)' : 'var(--accent-bd)', color: isAll ? 'var(--t2)' : 'var(--t1)' }}>
        {label}
        <ChevronDown size={14} strokeWidth={1.75} style={{ color: 'var(--t3)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </button>
      {open && (
        <div className="so-pop" style={{ top: 'calc(100% + 6px)', right: 0, width: 264, maxHeight: 400, overflowY: 'auto' }}>
          <button className="cf-row" onClick={() => onChange([])} style={{ color: isAll ? 'var(--t1)' : 'var(--t2)' }}>
            All channels {isAll && <span className="cf-check">✓</span>}
          </button>
          {groups.map(g => {
            const ids = g.chans.map(c => c.channel_id);
            const allOn = !isAll && ids.every(id => sel.includes(id));
            return (
              <div key={g.fk}>
                <button className="cf-fam" onClick={() => toggleFamily(g.chans)}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                  <span className="so-dot" style={{ background: g.color }} /> {g.label}
                  {allOn && <span className="cf-check">✓</span>}
                </button>
                {g.chans.map(c => {
                  const on = sel.includes(c.channel_id);
                  return (
                    <button key={c.channel_id} className="cf-row" onClick={() => toggle(c.channel_id)} style={{ color: on ? 'var(--t1)' : 'var(--t2)' }}>
                      <span className="so-dot" style={{ background: g.color, opacity: on ? 1 : 0.4 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {on && <span className="cf-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
