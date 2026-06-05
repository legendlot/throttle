// Safe per-line arithmetic for the Scratchpad. No eval/Function — tokenizer + shunting-yard + RPN.
// Supports + - * / ( ), unary minus, decimals, and `%`: a trailing `n%` => n/100
// (so 18% -> 0.18, 1200*18% -> 216); a binary `a % b` (digit after %) => modulo.
// Returns {ok:true,value} or {ok:false}. RULE-DOCKET-005.

const MATH_LINE = /^[0-9+\-*/().%\s]+$/;
const HAS_OP = /[+\-*/%]/;

export function isMathLine(line) {
  const t = (line || '').trim();
  if (!t || !MATH_LINE.test(t) || !HAS_OP.test(t)) return false;
  return evalExpr(t).ok;
}

export function evalLine(line) { return evalExpr((line || '').trim()); }

function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1; while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = parseFloat(s.slice(i, j));
      if (!isFinite(num)) return null;
      out.push({ t: 'num', v: num }); i = j; continue;
    }
    if ('+-*/%()'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    return null; // unknown char
  }
  return out;
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3 };

function toRPN(tokens) {
  const out = [], ops = []; let prev = null;
  for (const tok of tokens) {
    if (tok.t === 'num') { out.push(tok); prev = tok; continue; }
    const c = tok.v;
    if (c === '(') { ops.push(c); prev = { t: 'op', v: c }; continue; }
    if (c === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push({ t: 'op', v: ops.pop() });
      if (!ops.length) return null; ops.pop(); prev = { t: 'op', v: ')' }; continue;
    }
    let op = c;
    // unary minus: '-' at start, or after another operator / '('
    if (c === '-' && (prev === null || (prev.t === 'op' && prev.v !== ')'))) op = 'u-';
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top === '(') break;
      if (PREC[top] >= PREC[op]) out.push({ t: 'op', v: ops.pop() }); else break;
    }
    ops.push(op); prev = { t: 'op', v: c };
  }
  while (ops.length) { const o = ops.pop(); if (o === '(') return null; out.push({ t: 'op', v: o }); }
  return out;
}

function runRPN(rpn) {
  const st = [];
  for (const tok of rpn) {
    if (tok.t === 'num') { st.push(tok.v); continue; }
    if (tok.v === 'u-') { if (!st.length) return null; st.push(-st.pop()); continue; }
    if (st.length < 2) return null;
    const b = st.pop(), a = st.pop();
    let r;
    switch (tok.v) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': if (b === 0) return null; r = a / b; break;
      case '%': if (b === 0) return null; r = a % b; break;
      default: return null;
    }
    st.push(r);
  }
  return st.length === 1 ? st[0] : null;
}

function evalExpr(raw) {
  if (!raw) return { ok: false };
  // trailing-percent: turn `<number>%` not followed by a digit into `/100`.
  const s = raw.replace(/(\d(?:\.\d+)?)\s*%(?!\s*\d)/g, '($1/100)');
  const tokens = tokenize(s); if (!tokens || !tokens.length) return { ok: false };
  const rpn = toRPN(tokens); if (!rpn) return { ok: false };
  const v = runRPN(rpn);
  if (v === null || !isFinite(v)) return { ok: false };
  return { ok: true, value: v };
}

export function fmtResult(n) {
  const r = Math.round(n * 1e6) / 1e6; // up to 6 dp, strip trailing zeros via Number→String
  return String(r);
}

// Parse a note line as a (possibly labelled) calculation. Handles three shapes:
//   "25*5*3"                  → pure expression
//   "room volume = 25*5*3"    → label = expression (evaluate the part after the last '=')
//   "25*5*3 ="                → trailing-equals "compute this" gesture
// Returns { value, trailingEq } when the expression is valid arithmetic with an operator,
// else null (line stays plain text). The label/text itself is never parsed.
export function parseMath(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  const trailingEq = /=\s*$/.test(trimmed);
  let work = trailingEq ? trimmed.replace(/=\s*$/, '').trim() : trimmed;
  const eqIdx = work.lastIndexOf('=');
  const exprStr = (eqIdx >= 0 ? work.slice(eqIdx + 1) : work).trim();
  if (!exprStr || !HAS_OP.test(exprStr)) return null;   // require an operator (skip bare numbers/labels)
  const r = evalExpr(exprStr);
  if (!r.ok) return null;
  return { value: r.value, trailingEq };
}
