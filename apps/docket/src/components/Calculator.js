'use client';
import { useState } from 'react';
import { evalLine, fmtResult } from '../lib/mathEval.js';

// A real calculator docked beside the note. Type into the display (full keyboard) or tap the
// keypad; the result is live. Enter/= collapses the expression to its result so you can keep
// going. Keyboard-reachable: Tab from the note focuses the display (it's the next tab stop;
// keypad buttons are tabIndex=-1), Shift+Tab returns to the note. RULE-DOCKET-005.
export function Calculator() {
  const [expr, setExpr] = useState('');
  const r = expr.trim() ? evalLine(expr) : null;

  const ins = (ch) => setExpr(e => e + ch);
  const back = () => setExpr(e => e.slice(0, -1));
  const clearAll = () => setExpr('');
  const equals = () => { const res = evalLine(expr); if (res.ok) setExpr(fmtResult(res.value)); };

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); }
    // digits, + - * / . % ( ) and Backspace are handled natively by the input.
  }

  // label shown on the button, value inserted into the expression
  const keys = [
    ['7', '7'], ['8', '8'], ['9', '9'], ['÷', '/'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['×', '*'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['−', '-'],
    ['0', '0'], ['.', '.'], ['%', '%'], ['+', '+'],
    ['(', '('], [')', ')'], ['⌫', 'BACK'], ['=', 'EQ'],
  ];

  return (
    <div style={wrap}>
      <div style={label}>Calculator</div>
      <input
        value={expr}
        onChange={e => setExpr(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="type a sum…"
        inputMode="text" spellCheck={false} autoComplete="off"
        style={display} />
      <div style={resultLine}>{r ? (r.ok ? `= ${fmtResult(r.value)}` : '—') : ' '}</div>
      <div style={pad}>
        {keys.map(([lbl, val]) => (
          <button key={lbl} tabIndex={-1}
            onClick={() => val === 'BACK' ? back() : val === 'EQ' ? equals() : ins(val)}
            style={padBtn(val)}>{lbl}</button>
        ))}
        <button tabIndex={-1} onClick={clearAll} style={clearBtn}>C</button>
      </div>
      <div style={hint}>Tab focuses the calculator · Shift+Tab back to the note · Enter = result</div>
    </div>
  );
}

const wrap = { width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 };
const label = { fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)' };
const display = { width: '100%', background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 18, fontFamily: 'var(--font-mono)', outline: 'none', textAlign: 'right' };
const resultLine = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--docket-accent)', minHeight: 22, paddingRight: 2 };
const pad = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 };
function padBtn(val) {
  const op = ['/', '*', '-', '+', 'EQ'].includes(val);
  const accent = val === 'EQ';
  return {
    padding: '12px 0', fontSize: 16, fontFamily: 'var(--font-mono)', cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    background: accent ? 'var(--docket-accent)' : (op ? 'var(--surface-3)' : 'var(--surface-2)'),
    color: accent ? 'var(--accent-fg)' : (op ? 'var(--docket-accent)' : 'var(--text-1)'),
    border: `1px solid ${accent ? 'var(--docket-accent)' : 'var(--border)'}`, fontWeight: op ? 700 : 500,
  };
}
const clearBtn = { gridColumn: 'span 4', padding: '9px 0', fontSize: 13, fontFamily: 'var(--font-cond)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)', color: 'var(--text-3)', border: '1px solid var(--border)' };
const hint = { fontSize: 10, color: 'var(--text-4)', lineHeight: 1.5 };
