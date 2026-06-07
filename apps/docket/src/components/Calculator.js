'use client';
import { useState } from 'react';
import { evalLine, fmtResult } from '../lib/mathEval.js';

// A real calculator docked beside the note. Type into the display (full keyboard) or tap the
// keypad; the result is live. Enter/= collapses the expression to its result. Keyboard-reachable:
// Tab from the note focuses the display (next tab stop; keypad buttons are tabIndex=-1),
// Shift+Tab returns to the note. RULE-DOCKET-005. Visual refresh only.
export function Calculator() {
  const [expr, setExpr] = useState('');
  const r = expr.trim() ? evalLine(expr) : null;

  const ins = (ch) => setExpr(e => e + ch);
  const back = () => setExpr(e => e.slice(0, -1));
  const clearAll = () => setExpr('');
  const equals = () => { const res = evalLine(expr); if (res.ok) setExpr(fmtResult(res.value)); };

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); }
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
    <div className="calc">
      <div className="calc-label">Calculator</div>
      <input className="calc-display" value={expr} onChange={e => setExpr(e.target.value)} onKeyDown={onKeyDown}
        placeholder="type a sum…" inputMode="text" spellCheck={false} autoComplete="off" />
      <div className="calc-res">{r ? (r.ok ? `= ${fmtResult(r.value)}` : '—') : ' '}</div>
      <div className="calc-pad">
        {keys.map(([lbl, val]) => {
          const op = ['/', '*', '-', '+', 'EQ'].includes(val);
          const cls = 'calc-key' + (val === 'EQ' ? ' eq' : (op ? ' op' : ''));
          return (
            <button key={lbl} tabIndex={-1} className={cls}
              onClick={() => val === 'BACK' ? back() : val === 'EQ' ? equals() : ins(val)}>{lbl}</button>
          );
        })}
        <button tabIndex={-1} className="calc-key clear" onClick={clearAll}>C</button>
      </div>
      <div className="calc-hint">Tab focuses the calculator · Shift+Tab back to the note · Enter = result</div>
    </div>
  );
}

export default Calculator;
