'use client';
import { useState, useRef, useEffect } from 'react';
import { parseMath, fmtResult } from '../lib/mathEval.js';

// A line that STARTS (after optional indent) with [ ] / [x] is a checkbox; brackets
// mid-sentence stay prose. RULE-DOCKET-005.
const CHECK_RE = /^(\s*)\[([ xX])\]\s?(.*)$/;

// Click-to-edit note body: rendered by default (clickable checkboxes + live math), click the
// text to edit raw, blur to render. value = raw text. onChange(raw) = debounced autosave while
// typing. onToggleSave(raw) = immediate save after a checkbox tick (no edit-mode entry).
export function NoteBody({ value, onChange, onToggleSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const taRef = useRef(null);
  useEffect(() => { if (!editing) setDraft(value || ''); }, [value, editing]);
  useEffect(() => {
    if (editing && taRef.current) { taRef.current.focus(); const n = taRef.current.value.length; taRef.current.setSelectionRange(n, n); }
  }, [editing]);

  function toggleLine(idx) {
    const lines = (value || '').split('\n');
    const m = lines[idx]?.match(CHECK_RE);
    if (!m) return;
    const checked = m[2] !== ' ';
    lines[idx] = `${m[1]}[${checked ? ' ' : 'x'}] ${m[3]}`;
    onToggleSave(lines.join('\n'));
  }

  if (editing) {
    return (
      <textarea ref={taRef} value={draft}
        onChange={e => { setDraft(e.target.value); onChange(e.target.value); }}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Escape') e.currentTarget.blur(); }}
        placeholder="Write anything. Use [ ] for a checkbox; a math line like 1200*18% shows its result."
        style={ta} />
    );
  }

  const lines = (value || '').split('\n');
  return (
    <div onClick={() => setEditing(true)} style={rendered}>
      {!value && <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>Click to write…</span>}
      {lines.map((ln, i) => {
        const m = ln.match(CHECK_RE);
        if (m) {
          const checked = m[2] !== ' ';
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingLeft: m[1].length * 8 }}>
              <button onClick={e => { e.stopPropagation(); toggleLine(i); }} style={checkbox(checked)} title={checked ? 'Uncheck' : 'Check'}>{checked ? '✓' : ''}</button>
              <span style={{ color: checked ? 'var(--text-4)' : 'var(--text-1)', textDecoration: checked ? 'line-through' : 'none', flex: 1 }}>{m[3] || ' '}</span>
            </div>
          );
        }
        const calc = parseMath(ln);
        if (calc) {
          // trailing-equals line ("25*5 =") already shows the '='; otherwise prefix one.
          return <div key={i} style={mathRow}><span style={{ color: 'var(--text-1)' }}>{ln}</span><span style={mathRes}>{calc.trailingEq ? '' : '= '}{fmtResult(calc.value)}</span></div>;
        }
        return <div key={i} style={{ color: 'var(--text-1)', minHeight: '1.5em', whiteSpace: 'pre-wrap' }}>{ln || ' '}</div>;
      })}
    </div>
  );
}

const ta = { width: '100%', minHeight: 420, background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'var(--font-mono)', resize: 'vertical' };
const rendered = { width: '100%', minHeight: 420, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, cursor: 'text', fontFamily: 'var(--font-mono)', display: 'flex', flexDirection: 'column', gap: 2 };
const mathRow = { display: 'flex', alignItems: 'baseline', gap: 10 };
const mathRes = { color: 'var(--docket-accent)', fontWeight: 700 };
function checkbox(on) {
  return { flexShrink: 0, width: 17, height: 17, marginTop: 2, borderRadius: 4, border: `1.5px solid ${on ? 'var(--docket-accent)' : 'var(--border-2)'}`, background: on ? 'var(--docket-accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 };
}
