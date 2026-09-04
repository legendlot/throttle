'use client';
/* ════════════════════════════════════════════════════════════
   MultiSelect (S344, Pruthvi #bugs 1788512544) — a checkbox popover
   for the Reports/Analytics dimension filters.

   ⚠️ WHY NOT `Combobox` from @throttle/ui: it is single-value by contract
   (`value` is a string, `onChange(value, option)` fires one selection and
   the input snaps to that option's label). Multi-select cannot be expressed
   through it without changing the component itself — and packages/ui is a
   dependency of all twelve apps, so that is a twelve-app change for two
   pages in one app. Kept local until a second app needs it.

   ⚠️ WHY NOT a native `<select multiple>`: it needs ctrl/cmd-click to pick a
   second value and shows no "All" state, which is the whole point here —
   Pitstop is used across departments and the common action is "these three
   teams", not "one".

   value    — string[] ('[]' = All, i.e. no filter on this dimension)
   options  — [{ v, l }] or plain strings
   The popover is position:absolute inside a relative wrapper; the filter rows
   on both pages are plain flex bands with no overflow clipping, so no portal
   is needed (unlike Combobox inside a scrollable table).
   ════════════════════════════════════════════════════════════ */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export function MultiSelect({ label, value = [], options = [], onChange, style, minWidth = 130, title }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  // Close on any click outside. Registered on the document in the capture-free
  // phase and gated on `open`, so a closed control costs nothing.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const opts = options.map(o => (typeof o === 'string' ? { v: o, l: o } : o));
  const sel = new Set(value);
  const query = q.trim().toLowerCase();
  const shown = query ? opts.filter(o => String(o.l).toLowerCase().includes(query)) : opts;

  function toggle(v) {
    onChange(sel.has(v) ? value.filter(x => x !== v) : [...value, v]);
  }

  // The button says the COHORT, not just "filtered": one pick shows its name so the
  // screen still reads as a sentence, several show the count (names would overflow).
  const summary = value.length === 0 ? 'All'
    : value.length === 1 ? (opts.find(o => o.v === value[0])?.l ?? value[0])
    : `${value.length} selected`;

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0, ...style }}>
      <button type="button" onClick={() => setOpen(o => !o)} title={title || `Filter by ${label.toLowerCase()}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, minWidth, maxWidth: 240,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderColor: value.length ? 'var(--accent-bd)' : 'var(--border)',
          borderRadius: 'var(--radius-sm)', padding: '7px 10px', cursor: 'pointer',
          fontFamily: 'var(--f-ui)', fontSize: 13, color: value.length ? 'var(--t1)' : 'var(--t2)',
        }}>
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}: {summary}
        </span>
        <ChevronDown size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 40, minWidth: 220,
          maxHeight: 300, overflowY: 'auto', background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-2, 0 8px 24px rgba(0,0,0,0.35))', padding: 6,
        }}>
          {/* Search appears only when the list is long enough to be worth it — a
              five-channel list does not need a box above it. */}
          {opts.length > 8 && (
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
              style={{ width: '100%', marginBottom: 4, background: 'var(--surface-2)', color: 'var(--t1)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                padding: '5px 8px', fontSize: 12, outline: 'none' }} />
          )}
          <button type="button" onMouseDown={() => onChange([])}
            style={{ ...rowStyle, color: value.length ? 'var(--t3)' : 'var(--t1)' }}>
            <span style={{ width: 14, display: 'inline-flex' }}>{value.length === 0 && <Check size={12} />}</span>
            All {label.toLowerCase()}
          </button>
          {shown.map(o => (
            <button key={o.v} type="button" onMouseDown={() => toggle(o.v)}
              style={{ ...rowStyle, color: sel.has(o.v) ? 'var(--t1)' : 'var(--t2)' }}>
              <span style={{ width: 14, display: 'inline-flex' }}>{sel.has(o.v) && <Check size={12} style={{ color: 'var(--accent)' }} />}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.l}</span>
            </button>
          ))}
          {!shown.length && <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--t4)' }}>No matches</div>}
        </div>
      )}
    </div>
  );
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
  padding: '5px 8px', fontFamily: 'var(--f-ui)', fontSize: 12.5, cursor: 'pointer',
};
