'use client';
// In-theme confirmation + prompt dialogs, replacing window.confirm / window.prompt.
//
// Why this exists: the app had 31 native dialogs, and the dangerous ones carried real
// decision content — the test-mode gate, the exclusion rules in force, the budget
// shortfall, the quiet-hours cutoff. An OS alert renders all of that as one
// undifferentiated text blob with buttons labelled "OK" and "Cancel", so the operator
// reads a wall and clicks the affirmative. The copy was never the problem; the container
// was. Here the same content gets hierarchy (lede → points → warning) and the action
// button states what it will do, so "Send to 4,228 people" is the thing being clicked.
//
// Deliberately promise-based so a call site converts in one line:
//   if (!window.confirm(msg)) return;   →   if (!await confirm({ ... })) return;
//
// Mounted once by (auth)/layout.js. Pages call useConfirm() / usePrompt().
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { AlertTriangle, OctagonX, Info } from 'lucide-react';

const ConfirmCtx = createContext(null);

// tone → the visual + semantic contract. `danger` is reserved for irreversible outward
// actions (a real send, a stop that drops in-flight recipients); `warn` for reversible but
// consequential; `info` for plain are-you-sure.
const TONE = {
  danger: { icon: OctagonX,      color: 'var(--red, #f87171)',    btn: 'btn-danger-solid' },
  warn:   { icon: AlertTriangle, color: 'var(--accent, #F2CD1A)', btn: 'btn-primary' },
  info:   { icon: Info,          color: 'var(--blue, #7c9bff)',   btn: 'btn-primary' },
};

/* ---- Provider -------------------------------------------------------- */
export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const resolver = useRef(null);

  const settle = useCallback((value) => {
    const r = resolver.current;
    resolver.current = null;
    setReq(null);
    if (r) r(value);
  }, []);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setReq({ kind: 'confirm', ...opts });
  }), []);

  // A decision with two legitimate answers, not a yes/no. Resolves to the chosen
  // action's `value`, or null on cancel. Exists because the journey OFF flow was two
  // stacked OS dialogs using Cancel to mean "let them finish" — an answer nobody reads
  // a Cancel button as giving.
  const choose = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setReq({ kind: 'choose', ...opts });
  }), []);

  const prompt = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setReq({ kind: 'prompt', ...opts });
  }), []);

  return (
    <ConfirmCtx.Provider value={{ confirm, prompt, choose }}>
      {children}
      {req && <Dialog req={req} settle={settle} />}
    </ConfirmCtx.Provider>
  );
}

// A page that renders outside the provider (or during an SSR pass) must not crash on a
// missing context — fall back to the native dialog rather than throwing mid-action.
export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  return ctx?.confirm || (async ({ title, lede }) =>
    typeof window !== 'undefined' && window.confirm([title, lede].filter(Boolean).join('\n\n')));
}
export function usePrompt() {
  const ctx = useContext(ConfirmCtx);
  return ctx?.prompt || (async ({ title, initial = '' }) =>
    typeof window !== 'undefined' ? window.prompt(title, initial) : null);
}
export function useChoose() {
  const ctx = useContext(ConfirmCtx);
  // No context: fall back to the first action only if the operator confirms — never
  // silently pick a branch on their behalf.
  return ctx?.choose || (async ({ title, actions = [] }) =>
    (typeof window !== 'undefined' && window.confirm(title)) ? actions[0]?.value ?? null : null);
}

/* ---- Dialog ---------------------------------------------------------- */
function Dialog({ req, settle }) {
  const {
    kind, tone = 'info', title, lede, points, warning, note,
    confirmLabel = 'Confirm', cancelLabel = 'Cancel',
    requireTyped, initial = '', placeholder, multiline, required,
    actions,
  } = req;

  const t = TONE[tone] || TONE.info;
  const Ico = t.icon;
  const [typed, setTyped] = useState('');
  const [value, setValue] = useState(initial);
  const firstRef = useRef(null);

  // The safe control takes focus, never the destructive one. A dialog that opens with
  // "Send" focused turns a reflexive Enter into a real send.
  useEffect(() => { firstRef.current?.focus(); }, []);

  const typedOk = !requireTyped || typed.trim().toUpperCase() === requireTyped.toUpperCase();
  const valueOk = kind !== 'prompt' || !required || value.trim().length > 0;
  const canGo = typedOk && valueOk;

  const accept = () => { if (canGo) settle(kind === 'prompt' ? value : true); };
  const reject = () => settle(kind === 'prompt' || kind === 'choose' ? null : false);

  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      // Enter commits only when there is nothing to type, no multiline field to break, and
      // exactly one affirmative action. A multi-action dialog has no "the" answer to press.
      if (e.key === 'Enter' && !requireTyped && !multiline && kind !== 'choose' && canGo) {
        e.preventDefault(); accept();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  return (
    <div className="cf-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) reject(); }}>
      <div className="cf-box" role="alertdialog" aria-modal="true" aria-labelledby="cf-title">
        <div className="cf-head">
          <span className="cf-ico" style={{ color: t.color }}><Ico size={16} /></span>
          <h3 className="cf-title" id="cf-title">{title}</h3>
        </div>

        {lede && <div className="cf-lede">{lede}</div>}

        {points?.length > 0 && (
          <ul className="cf-points">
            {points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}

        {warning && (
          <div className="cf-warn">
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{warning}</span>
          </div>
        )}

        {kind === 'prompt' && (
          multiline
            ? <textarea className="f-inp cf-field" rows={3} value={value} placeholder={placeholder}
                        ref={firstRef} onChange={(e) => setValue(e.target.value)} />
            : <input className="f-inp cf-field" value={value} placeholder={placeholder}
                     ref={firstRef} onChange={(e) => setValue(e.target.value)} />
        )}

        {requireTyped && (
          <label className="cf-typed">
            <span>Type <b>{requireTyped}</b> to confirm</span>
            <input className="f-inp" value={typed} autoComplete="off" spellCheck={false}
                   onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}

        {note && <div className="cf-note">{note}</div>}

        {/* A multi-answer decision stacks full-width so neither option reads as the
            default, and each carries its own one-line consequence. */}
        {kind === 'choose' ? (
          <div className="cf-choices">
            {actions.map((a) => (
              <button key={a.value} type="button"
                      className={`cf-choice ${a.tone === 'danger' ? 'is-danger' : ''}`}
                      onClick={() => settle(a.value)}>
                <span className="cf-choice-l">{a.label}</span>
                {a.hint && <span className="cf-choice-h">{a.hint}</span>}
              </button>
            ))}
            <button type="button" className="btn cf-choice-cancel" ref={firstRef} onClick={reject}>
              {cancelLabel}
            </button>
          </div>
        ) : (
          <div className="cf-actions">
            <button type="button" className="btn"
                    ref={kind === 'prompt' || requireTyped ? null : firstRef}
                    onClick={reject}>{cancelLabel}</button>
            <button type="button" className={`btn ${t.btn}`} disabled={!canGo} onClick={accept}>
              {confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
