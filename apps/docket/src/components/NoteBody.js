'use client';
import { useState } from 'react';
import { parseMath, fmtResult } from '../lib/mathEval.js';

// A line that STARTS (after optional indent) with [ ] / [x] is a checkbox; brackets
// mid-sentence stay prose. RULE-DOCKET-005.
const CHECK_RE = /^(\s*)\[([ xX])\]\s?(.*)$/;

// Live split editor: a raw textarea (left) you always type into + a live rendered preview
// (right) that updates on every keystroke — clickable checkboxes + inline calc results that
// never disappear (no edit/render mode toggle). Mount keyed by note id so `initialValue`
// seeds a fresh draft per note. onChange(raw) = debounced autosave; onToggleSave(raw) =
// immediate save after a checkbox tick.
export function NoteBody({ initialValue, onChange, onToggleSave }) {
  const [text, setText] = useState(initialValue || '');

  function update(v) { setText(v); onChange(v); }
  function toggleLine(idx) {
    const lines = text.split('\n');
    const m = lines[idx]?.match(CHECK_RE);
    if (!m) return;
    const checked = m[2] !== ' ';
    lines[idx] = `${m[1]}[${checked ? ' ' : 'x'}] ${m[3]}`;
    const nt = lines.join('\n');
    setText(nt); onToggleSave(nt);
  }

  const lines = text.split('\n');
  return (
    <div style={split}>
      <textarea value={text} onChange={e => update(e.target.value)}
        placeholder="Write anything. Use [ ] for a checkbox; a calc line like 'room = 34*3*2' shows its result on the right."
        style={ta} spellCheck={false} />
      <div style={preview} aria-label="Live preview">
        {!text && <span style={{ color: 'var(--text-4)', fontStyle: 'italic' }}>Live preview — checkboxes and calc results appear here as you type.</span>}
        {lines.map((ln, i) => {
          const m = ln.match(CHECK_RE);
          if (m) {
            const checked = m[2] !== ' ';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingLeft: m[1].length * 8 }}>
                <button onClick={() => toggleLine(i)} style={checkbox(checked)} title={checked ? 'Uncheck' : 'Check'}>{checked ? '✓' : ''}</button>
                <span style={{ color: checked ? 'var(--text-4)' : 'var(--text-1)', textDecoration: checked ? 'line-through' : 'none', flex: 1 }}>{m[3] || ' '}</span>
              </div>
            );
          }
          const calc = parseMath(ln);
          if (calc) {
            return <div key={i} style={mathRow}><span style={{ color: 'var(--text-1)' }}>{ln}</span><span style={mathRes}>{calc.trailingEq ? '' : '= '}{fmtResult(calc.value)}</span></div>;
          }
          return <div key={i} style={{ color: ln.trim() ? 'var(--text-1)' : 'transparent', minHeight: '1.5em', whiteSpace: 'pre-wrap' }}>{ln || '·'}</div>;
        })}
      </div>
    </div>
  );
}

const split = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' };
const ta = { width: '100%', minHeight: 440, background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'var(--font-mono)', resize: 'vertical' };
const preview = { minHeight: 440, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, fontFamily: 'var(--font-mono)', display: 'flex', flexDirection: 'column', gap: 2, overflowWrap: 'anywhere' };
const mathRow = { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' };
const mathRes = { color: 'var(--docket-accent)', fontWeight: 700 };
function checkbox(on) {
  return { flexShrink: 0, width: 17, height: 17, marginTop: 2, borderRadius: 4, border: `1.5px solid ${on ? 'var(--docket-accent)' : 'var(--border-2)'}`, background: on ? 'var(--docket-accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, padding: 0 };
}
