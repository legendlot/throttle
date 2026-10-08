'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useTypeahead } from '../../lib/useTypeahead.js';
import { flatItems, highlightParts, moveIndex } from '../../lib/typeahead.js';

// Typeahead ("combo") search box — plan 2026-10-08-ignition-typeahead-search §2.
// Typing (2+ chars, 200 ms debounce) shows matching records in a dropdown; ↑/↓ + Enter or a click
// picks one (onPick). Enter with nothing highlighted calls onSubmit(text) — the list filter on list
// pages. Esc closes the dropdown, a second Esc clears the box. WAI-ARIA combobox pattern.
//
// fetchResults(q, signal) → [{ group, items: [item] }] | [item]  (a group may be { group, error: true })
// item: { id, primary, secondary?, lead? (node), meta? (node), href? }
// Controlled (value + onChange(text)) or uncontrolled. `primary` sets data-search-primary (the `/`
// shortcut target) — at most one per page. `size`: 'md' (40px page box) | 'lg' (46px top bar).
// `persistent`: the list stays shown while there is text, even after blur (the phone search sheet —
// dismissing the soft keyboard blurs the input and must not hide the results).
export function Typeahead({
  value, onChange, fetchResults, onPick, onSubmit,
  minChars = 2, debounceMs = 200, placeholder = 'Search', primary = true,
  autoHighlight = false, clearOnPick = false, size = 'md', width = 300,
  ariaLabel, autoFocus, inputRef: inputRefProp, trailing, refreshKey,
  onFocus, onBlur, onKeyDown, style, dropdownStyle, emptyText, persistent = false,
}) {
  const [inner, setInner] = useState('');
  const text = value !== undefined ? value : inner;
  // Any edit drops the highlight and a pending Enter: rows on screen belong to the previous text.
  const setText = (t) => {
    if (value === undefined) setInner(t);
    setActive(-1);
    pendingEnter.current = false;
    onChange?.(t);
  };
  const pendingEnter = useRef(false);

  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const res = useTypeahead({ query: text, fetchResults, minChars, debounceMs, refreshKey });
  const items = flatItems(res.groups);
  const [active, setActive] = useState(-1);

  // New rows → reset the highlight (first row when autoHighlight, so Enter opens the top match).
  // An Enter pressed while those rows were loading (autoHighlight boxes) lands here: it opens the top
  // match of the query that was typed — never a row left over from the previous query.
  useEffect(() => {
    setActive(autoHighlight && items.length ? 0 : -1);
    if (pendingEnter.current && res.status === 'done') {
      pendingEnter.current = false;
      if (items[0]) pick(items[0]);
    }
  }, [res.groups]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (res.status === 'error' || res.status === 'short' || res.status === 'idle') pendingEnter.current = false;
  }, [res.status]);

  const ownRef = useRef(null);
  const inputRef = inputRefProp || ownRef;
  const listRef = useRef(null);
  const uid = useId().replace(/:/g, '');
  const listId = `ta-list-${uid}`;
  const optId = (i) => `ta-opt-${uid}-${i}`;

  // Keep the highlighted row visible while arrowing through a scrolled list.
  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const showList = (open || persistent) && res.status !== 'idle';

  function pick(it, e) {
    if (!it) return;
    if (it.href && e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      window.open(it.href, '_blank', 'noopener');
      return;
    }
    setOpen(false);
    if (clearOnPick) setText('');
    onPick?.(it);
  }

  function handleKey(e) {
    onKeyDown?.(e);
    // keyCode 229: Safari's IME-confirming Enter arrives with isComposing already false.
    if (e.defaultPrevented || e.nativeEvent?.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!showList) { setOpen(true); return; }
      setActive((i) => moveIndex(i, e.key === 'ArrowDown' ? 1 : -1, items.length));
    } else if (e.key === 'Enter') {
      const loading = res.status === 'loading';
      if (showList && res.status === 'error') {
        e.preventDefault();
        res.retry();
      } else if (showList && loading && autoHighlight && !onSubmit) {
        e.preventDefault();
        pendingEnter.current = true; // picked when this query's rows arrive (effect above)
      } else if (showList && !loading && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active], e);
      } else if (onSubmit) {
        e.preventDefault();
        setOpen(false);
        onSubmit(text);
      } else if (showList) {
        e.preventDefault(); // never submit a surrounding form from an open dropdown
      }
    } else if (e.key === 'Escape') {
      // type=search clears itself on Esc by default; this box owns that (close first, then clear).
      if (showList && !persistent) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      else if (text) { e.preventDefault(); e.stopPropagation(); setText(''); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const lg = size === 'lg';
  const activeId = showList && active >= 0 && items[active] ? optId(active) : undefined;
  let n = -1; // running option index across groups

  return (
    <div style={{ position: 'relative', width, maxWidth: '100%', minWidth: 0, ...style }}>
      <label className="ig-ctl ig-ta-box" style={{
        display: 'flex', alignItems: 'center', gap: lg ? 12 : 8, height: lg ? 46 : 40, width: '100%',
        padding: lg ? '0 16px' : '0 12px', background: 'var(--input)',
        border: `1px solid ${focused ? 'var(--accent)' : 'var(--border-2)'}`,
        borderRadius: lg ? 12 : 'var(--r-ctl)', color: 'var(--text-3)', cursor: 'text', boxSizing: 'border-box',
      }}>
        <Search size={lg ? 17 : 15} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label={ariaLabel || placeholder}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={activeId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          data-search-primary={primary ? '' : undefined}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={(e) => { setFocused(true); if (text) setOpen(true); onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); setOpen(false); onBlur?.(e); }}
          onKeyDown={handleKey}
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-1)',
            font: 'inherit', fontSize: lg ? 15 : 14, height: '100%',
          }}
        />
        {res.status === 'loading' && <span className="ig-ta-spin" aria-hidden="true" />}
        {!focused && !text && trailing}
      </label>

      {showList && (
        <div ref={listRef} className="ig-pop ig-ta-list"
          // mousedown inside the list must not blur the input (blur closes the list before the click lands)
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 400,
            maxHeight: 'min(440px, 62vh)', overflowY: 'auto', padding: 6,
            background: 'var(--menu)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-row)',
            boxShadow: 'var(--shadow-menu)', animationDuration: '160ms', fontFamily: 'var(--font-ui)',
            ...dropdownStyle,
          }}>
          <div id={listId} role="listbox" aria-label={ariaLabel || placeholder}>
            {res.groups.filter((g) => !g.error).map((g, gi) => (
              <div key={`${g.group}-${gi}`} role={g.group ? 'group' : undefined} aria-label={g.group || undefined}>
                {g.group && (
                  <div aria-hidden="true" style={{ padding: '8px 10px 4px', fontFamily: 'var(--font-cond)', fontSize: 11, fontWeight: 600,
                    letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-4)' }}>{g.group}</div>
                )}
                {g.items.map((it) => {
                  n += 1;
                  const i = n;
                  const on = i === active;
                  return (
                    <div key={`${it.id}-${i}`} id={optId(i)} role="option" aria-selected={on}
                      onMouseMove={() => { if (active !== i) setActive(i); }}
                      onClick={(e) => pick(it, e)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-seg)',
                        cursor: 'pointer', background: on ? 'var(--menu-hover)' : 'transparent',
                        opacity: res.status === 'loading' ? 0.6 : 1, minWidth: 0,
                      }}>
                      {it.lead && <span style={{ display: 'flex', flexShrink: 0 }}>{it.lead}</span>}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: 'var(--text-1)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <Marked text={it.primary} q={res.groupsQ} />
                        </span>
                        {it.secondary && (
                          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginTop: 1,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <Marked text={it.secondary} q={res.groupsQ} />
                          </span>
                        )}
                      </span>
                      {it.meta && <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{it.meta}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {res.groups.filter((g) => g.error).map((g, gi) => (
            <div key={`err-${gi}`} role="status" style={{ padding: '8px 10px', fontSize: 13, color: 'var(--state-error-fg)' }}>
              Couldn&apos;t load {g.group ? g.group.toLowerCase() : 'results'}.
            </div>
          ))}
          {res.status === 'short' && <Note>Type {minChars}+ characters</Note>}
          {res.status === 'loading' && !items.length && !res.groups.length && <Note>Searching…</Note>}
          {res.status === 'done' && !res.groups.length && (
            <Note>{emptyText || <>No matches for &ldquo;{res.q}&rdquo;</>}</Note>
          )}
          {res.status === 'error' && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px',
              fontSize: 13, color: 'var(--state-error-fg)' }}>
              <span style={{ flex: 1 }}>Search failed. Press Enter or</span>
              <button type="button" onClick={res.retry} className="ig-ghost-btn"
                style={{ height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-3)',
                  background: 'transparent', color: 'var(--text-1)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Marked({ text, q }) {
  return highlightParts(text, q).map((p, i) => (p.hit
    ? <strong key={i} style={{ fontWeight: 700, color: 'var(--accent-hi)' }}>{p.text}</strong>
    : <span key={i}>{p.text}</span>));
}

function Note({ children }) {
  return <div style={{ padding: '10px 10px', fontSize: 13, color: 'var(--text-3)' }}>{children}</div>;
}

export default Typeahead;
