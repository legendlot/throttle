'use client';
// Rich text for review boxes (S396): bold, italic, bulleted + numbered lists. The editor is an
// uncontrolled contentEditable seeded once on mount; it reports sanitized HTML via onChange.
// RichTextView renders stored HTML (or legacy plain text) and clamps long text behind a
// "Read full" modal that scrolls.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '@throttle/ui';
import { Bold, Italic, List, ListOrdered, Maximize2 } from 'lucide-react';
import { sanitizeRich, isRich, toEditorHtml } from '../lib/richText.js';

const RICH_CSS = `
.podium-rich p, .podium-rich div { margin: 0 0 6px; }
.podium-rich p:last-child, .podium-rich div:last-child { margin-bottom: 0; }
.podium-rich ul, .podium-rich ol { margin: 4px 0 6px; padding-left: 22px; }
.podium-rich ul { list-style: disc; }
.podium-rich ol { list-style: decimal; }
.podium-rich li { margin: 2px 0; }
.podium-rich strong, .podium-rich b { font-weight: 700; }
.podium-rich em, .podium-rich i { font-style: italic; }
`;
function RichCss() { return <style>{RICH_CSS}</style>; }

export function RichTextEditor({ value, onChange, minHeight = 96, placeholder }) {
  const ref = useRef(null);
  const [empty, setEmpty] = useState(!value);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // Start inside a <p> so the first line is a paragraph, not a bare text node.
    el.innerHTML = toEditorHtml(value) || '<p><br></p>';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function emit() {
    const el = ref.current; if (!el) return;
    const blank = !el.textContent.trim();   // an empty bullet counts as empty
    setEmpty(blank);
    let html = el.innerHTML;
    if (blank) html = '';
    else if (!isRich(html)) html = `<p>${html}</p>`;
    onChange(sanitizeRich(html));
  }
  function cmd(c) {
    ref.current?.focus();
    document.execCommand(c, false, null);
    emit();
  }
  function onPaste(e) {   // paste as plain text — pasted HTML brings styles the sanitizer would strip anyway
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2)' }}>
      <RichCss />
      <div style={{ display: 'flex', gap: 2, padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>
        {[[Bold, 'bold', 'Bold'], [Italic, 'italic', 'Italic'], [List, 'insertUnorderedList', 'Bulleted list'], [ListOrdered, 'insertOrderedList', 'Numbered list']].map(([Ic, c, t]) => (
          <button key={c} type="button" title={t} aria-label={t} onMouseDown={e => e.preventDefault()} onClick={() => cmd(c)}
            style={{ background: 'none', border: 'none', color: 'var(--text-2)', cursor: 'pointer', padding: '4px 6px', borderRadius: 4, display: 'inline-flex' }}>
            <Ic size={14} />
          </button>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        {empty && placeholder && <div style={{ position: 'absolute', top: 8, left: 10, fontSize: 13, color: 'var(--text-3)', pointerEvents: 'none' }}>{placeholder}</div>}
        <div ref={ref} className="podium-rich" contentEditable suppressContentEditableWarning
          onInput={emit} onBlur={emit} onPaste={onPaste}
          onFocus={() => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browsers */ } }}
          style={{ minHeight, maxHeight: 420, overflowY: 'auto', padding: '8px 10px', fontSize: 13, color: 'var(--text-1)', outline: 'none', lineHeight: 1.5 }} />
      </div>
    </div>
  );
}

function RichBody({ value }) {
  if (isRich(value)) return <div className="podium-rich" dangerouslySetInnerHTML={{ __html: sanitizeRich(value) }} />;
  return <div style={{ whiteSpace: 'pre-wrap' }}>{value}</div>;
}

// Clamped view; "Read full" opens the whole text in a scrollable modal.
export function RichTextView({ value, title, clamp = 180 }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOver(el.scrollHeight > clamp + 4);
  }, [value, clamp]);
  if (!value) return null;
  return (
    <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>
      <RichCss />
      <div ref={ref} style={{ maxHeight: clamp, overflow: 'hidden', position: 'relative' }}>
        <RichBody value={value} />
        {over && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 36, background: 'linear-gradient(transparent, var(--surface))' }} />}
      </div>
      {over && (
        <button type="button" onClick={() => setOpen(true)}
          style={{ marginTop: 4, background: 'none', border: 'none', color: 'var(--podium-accent)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Maximize2 size={12} /> Read full
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={title} size="lg">
        <div style={{ fontSize: 13.5, lineHeight: 1.6, fontFamily: 'var(--font-body, inherit)', maxHeight: '70dvh', overflowY: 'auto' }}>
          <RichBody value={value} />
        </div>
      </Modal>
    </div>
  );
}
