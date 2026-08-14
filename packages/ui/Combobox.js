'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Searchable combobox — drop-in replacement for native `<select>` when the option
 * list is large enough that scrolling becomes painful (vendors, products, parts).
 *
 * Controlled component:
 *   value     — the currently-selected option's `value` (string). Pass '' for none.
 *   options   — [{ value: string, label: string, hint?: string, search?: string,
 *                  group?: string }, ...]
 *               `hint` is shown to the right of the label AND matched against.
 *               `search` is matched against but NEVER rendered — hidden alias text.
 *               `group` is OPTIONAL: when set, a sticky section header is rendered each
 *               time it changes between adjacent options, so a long list reads as
 *               segmented sections (Relay's event pickers). Options WITHOUT `group`
 *               render exactly as before — this is purely additive.
 *               NB the caller must keep same-group options CONTIGUOUS (headers are emitted
 *               on change, not by bucketing) — a group that appears twice renders twice.
 *               Headers are not selectable and are NOT part of the keyboard-highlight
 *               index, so Arrow/Enter navigation is unaffected by grouping.
 *   onChange  — (value: string, option | null) => void. Fires on selection and on clear.
 *
 * Behaviour:
 *   - Typing filters by case-insensitive substring across label + hint + search.
 *   - ArrowUp/ArrowDown move the highlight; Enter selects; Escape closes.
 *   - mousedown (not click) selects, so the option fires before the input's blur.
 *   - Blur close is delayed 150 ms so mousedown lands first.
 *   - Pasting / typing an exact label is auto-resolved on Enter or blur.
 *   - When `value` changes externally, the input snaps back to the matched label.
 *   - Disabled state: input is read-only, no dropdown opens.
 *
 * Style: matches the existing app's input chrome via CSS variables. Override via
 * the `style` prop (applied to the input). Outer wrapper uses 100% width.
 */
export function Combobox({
  value = '',
  options = [],
  onChange,
  placeholder = 'Search…',
  disabled = false,
  required = false,
  allowClear = true,
  style,
  inputStyle: inputStyleOverride,
  onKeyDown: onKeyDownExternal,
  emptyLabel = 'No matches',
  loadingLabel = 'Loading…',
  loading = false,
  autoFocus = false,
  maxDropdownHeight = 240,
  id,
  name,
  onBlur: onBlurExternal,
  commitOnTab = false,
  renderOption,
  // Async/server-search mode. When provided, fires (query) on every keystroke so
  // the parent can fetch options (e.g. a debounced API search). In this mode the
  // component does NOT client-filter `options` — the parent owns matching. Selection
  // still flows through onChange(value, option) with the option's extra fields intact.
  onQueryChange,
  // Creatable mode. When provided, a trailing "+ Create …" row appears whenever the
  // typed query is non-empty and does NOT exactly match an existing option's label.
  // Fires (query: string) — the parent creates the record and sets `value`; the input
  // snaps to the new label once `options` updates. Replaces the parent-side onKeyDown
  // create hack, which was non-deterministic (Enter could select a highlighted option
  // OR create, depending on highlight state the parent couldn't see).
  //
  // NB deliberately NOT wired into blur: clicking away must never create a record.
  // NB when the query partially matches exactly one option, Enter still SELECTS that
  // option (the pre-existing contract) — arrow down to the create row to create instead.
  onCreateOption,
  createLabel,
  // Free-text mode (2026-08-14). Declares that `value` may legitimately be text the user
  // typed rather than an option's `value`. Two effects, both scoped to this flag:
  //   · a `value` matching no option DISPLAYS ITSELF instead of rendering blank
  //   · blurring with unmatched typed text COMMITS it via onCreateOption
  //
  // ⚠️ Opt-in precisely because "create" means different things to different callers. For
  // Docket's program picker, create PERSISTS a record and `value` is then a UUID — showing
  // the raw value would print a UUID in the box, and committing on blur would create a
  // program because someone clicked away. That is what the note above guards. Ignition's
  // product field is the opposite: the field is free text by design (S214), `value` IS the
  // label, and "create" only means "keep what I typed". Only such fields may set this.
  //
  // Without it a creatable field is quietly lossy, which is how it was found: typing a
  // product and tabbing to the next field erased it, and even clicking "Use …" stored the
  // value while leaving the box LOOKING empty — doCreate closed the dropdown, and the
  // reset-on-close effect could not resolve a value that is absent from `options`.
  // (Nandeswari, #bugs 1786606775.600109.)
  freeTextValue = false,
  // When true, the dropdown renders position:fixed (anchored to the input's
  // viewport rect) instead of position:absolute. Use inside scroll/overflow
  // containers (e.g. a horizontally-scrollable table) where an absolute
  // dropdown would be clipped by the ancestor's overflow. Default off.
  portal = false,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [rect, setRect] = useState(null); // input viewport rect, portal mode only
  const inputRef = useRef(null);
  const highlightedRef = useRef(null);
  const blurTimerRef = useRef(null);

  // Portal mode: keep the fixed-position dropdown anchored to the input as the
  // page/container scrolls or resizes. getBoundingClientRect is cheap; we
  // reposition rather than close so the dropdown tracks the input.
  useEffect(() => {
    if (!portal || !open) return;
    const update = () => {
      if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [portal, open]);

  // Resolve the label for the currently-selected value.
  const selectedOption = useMemo(
    () => options.find((o) => String(o.value) === String(value)) || null,
    [options, value]
  );

  // The text to show when the dropdown is closed: the selected option's label, or — in
  // free-text mode — the raw value, which IS the label for such a field. Anything else
  // shows an empty box for a field that holds a value, which reads as data loss.
  const closedLabel = selectedOption ? selectedOption.label
    : (freeTextValue && value != null && value !== '' ? String(value) : '');

  // Snap query back to the selected label whenever value changes externally.
  // The user's in-progress search is preserved as long as the dropdown is open.
  useEffect(() => {
    if (!open) {
      setQuery(closedLabel);
    }
  }, [closedLabel, open]);

  // Filter options against the query. When the query exactly matches the
  // selected label, show all options (user just opened the dropdown).
  // Multi-token: split the query on whitespace and require EVERY token to match
  // the label or hint (substring). So "flare para" matches an option whose label
  // is the code+name and whose hint carries the product/category. A single token
  // behaves exactly as a plain substring match (backward compatible).
  const filtered = useMemo(() => {
    // Async/server-search mode: the parent feeds already-filtered options via
    // onQueryChange, so trust them verbatim — don't re-filter client-side (a
    // server fuzzy/stock match might not substring-match the raw query).
    if (onQueryChange) return options;
    const q = (query || '').trim().toLowerCase();
    if (!q || (selectedOption && q === selectedOption.label.toLowerCase())) {
      return options;
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      // `search` is HIDDEN match-only text — never rendered. Use it for terms a
      // user will plausibly type but that don't belong on screen: sub-variants,
      // colours, trade/partner aliases. (Snorkel's sales-order product picker
      // needs "Harry Potter" to find `HP Desk warmer standee`, whose character
      // names live in the Model field, not the product name.) Putting those in
      // `hint` would work for matching but dumps them into the dropdown.
      const hay = `${(o.label || '').toLowerCase()} ${(o.hint || '').toLowerCase()} ${(o.search || '').toLowerCase()}`;
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, query, selectedOption, onQueryChange]);

  // Creatable mode: offer a "+ Create …" row unless the typed text already names an
  // existing option. Matched against ALL options, not the filtered set — a query that
  // exactly names an option the current filter happens to exclude is still not new.
  const trimmedQuery = (query || '').trim();
  const canCreate = useMemo(() => {
    if (!onCreateOption || !trimmedQuery) return false;
    const q = trimmedQuery.toLowerCase();
    return !options.some((o) => (o.label || '').trim().toLowerCase() === q);
  }, [onCreateOption, trimmedQuery, options]);

  // The create row is the last keyboard-navigable row, one past the real options.
  const createIndex = canCreate ? filtered.length : -1;
  const rowCount = filtered.length + (canCreate ? 1 : 0);

  // Scroll the highlighted option into view during keyboard navigation.
  useEffect(() => {
    if (open && highlight >= 0 && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [open, highlight]);

  function selectOption(opt) {
    if (!opt) {
      onChange?.('', null);
    } else {
      onChange?.(opt.value, opt);
    }
    setOpen(false);
    setHighlight(-1);
    setQuery(opt ? opt.label : '');
    if (inputRef.current) inputRef.current.blur();
  }

  function doCreate() {
    if (!canCreate) return;
    onCreateOption?.(trimmedQuery);
    setOpen(false);
    setHighlight(-1);
    // Hold the created text in the box. Without this the close triggers the reset effect,
    // which for a value absent from `options` resolved to '' — so "Use …" appeared to do
    // nothing even though the parent had stored the value.
    setQuery(trimmedQuery);
    if (inputRef.current) inputRef.current.blur();
  }

  function handleKeyDown(e) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((i) => Math.min((i < 0 ? -1 : i) + 1, rowCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      // Order matters, and it is what makes this deterministic: an explicitly
      // highlighted create row wins; then a highlighted option; then create when
      // nothing matched at all (typed a genuinely new name); then the sole match.
      if (open && canCreate && highlight === createIndex) {
        e.preventDefault();
        doCreate();
      } else if (open && highlight >= 0 && filtered[highlight]) {
        e.preventDefault();
        selectOption(filtered[highlight]);
      } else if (open && canCreate && filtered.length === 0) {
        e.preventDefault();
        doCreate();
      } else if (open && filtered.length === 1) {
        e.preventDefault();
        selectOption(filtered[0]);
      }
    } else if (e.key === 'Tab' && commitOnTab && open) {
      // Opt-in grid-style commit: as the user Tabs to the next field, commit the
      // highlighted option (or the sole match). Crucially we do NOT preventDefault
      // and do NOT blur — so the same Tab keystroke also advances focus to the next
      // cell. Lets keyboard users type → arrow → Tab in one motion (no extra Enter).
      const opt = (highlight >= 0 && filtered[highlight]) ? filtered[highlight]
        : (filtered.length === 1 ? filtered[0] : null);
      if (opt && String(opt.value) !== String(value)) {
        onChange?.(opt.value, opt);
        setOpen(false);
        setHighlight(-1);
        setQuery(opt.label);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHighlight(-1);
      setQuery(closedLabel);
    } else if (e.key === 'Backspace' && allowClear && value && query === '') {
      // Backspace on an empty input after clearing the label clears selection.
      onChange?.('', null);
    }
    // Passthrough for keys the combobox doesn't own (e.g. Tab for grid-style cell
    // navigation). Runs after internal handling; the parent decides whether to act.
    onKeyDownExternal?.(e);
  }

  function handleChange(e) {
    if (disabled) return;
    const next = e.target.value;
    setQuery(next);
    setOpen(true);
    setHighlight(-1);
    onQueryChange?.(next);
    // If the user is editing the label of the currently-selected option, clear
    // the underlying value so the form doesn't pretend it's still selected.
    if (selectedOption && next !== selectedOption.label) {
      onChange?.('', null);
    }
  }

  function handleFocus() {
    if (disabled) return;
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setOpen(true);
  }

  function handleBlur() {
    if (disabled) return;
    // Delay close so an mousedown inside the dropdown lands before close.
    blurTimerRef.current = setTimeout(() => {
      setOpen(false);
      setHighlight(-1);
      // On blur, if the query doesn't match anything but there's a selection,
      // restore the selected label so the input doesn't look like a free-text box.
      if (selectedOption && query !== selectedOption.label) {
        setQuery(selectedOption.label);
      } else if (!selectedOption && query) {
        // Exact-match auto-resolve on blur (helps when user pastes a label).
        const exact = options.find(
          (o) => (o.label || '').toLowerCase() === query.trim().toLowerCase()
        );
        if (exact) selectOption(exact);
        // Free-text mode only: keep what was typed. For these fields the text IS the
        // value, so discarding it on blur is data loss, not caution — and tabbing to the
        // next field is the normal way to leave an input, not an unusual one. Still never
        // fires for a plain creatable picker, where blur must not create a record.
        else if (freeTextValue && onCreateOption && trimmedQuery && trimmedQuery !== String(value ?? '')) {
          onCreateOption(trimmedQuery);
        }
      }
      onBlurExternal?.();
    }, 150);
  }

  const baseInputStyle = {
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: open ? '3px 3px 0 0' : 3,
    padding: '6px 10px',
    fontSize: 12,
    color: 'var(--t1)',
    outline: 'none',
    fontFamily: 'inherit',
    width: '100%',
    cursor: disabled ? 'not-allowed' : 'text',
    opacity: disabled ? 0.6 : 1,
  };

  return (
    <div style={{ position: 'relative', width: '100%', ...style }}>
      <input
        id={id}
        name={name}
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={loading ? loadingLabel : placeholder}
        value={query}
        disabled={disabled || loading}
        required={required}
        autoFocus={autoFocus}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{ ...baseInputStyle, ...inputStyleOverride }}
      />
      {allowClear && value && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); selectOption(null); }}
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            color: 'var(--t3)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
            lineHeight: 1,
          }}
          title="Clear selection"
        >
          ×
        </button>
      )}
      {open && !disabled && !loading && (!portal || rect) && (() => {
        // In portal mode the dropdown is rendered into document.body via a real
        // portal, NOT just position:fixed. A bare fixed element is still trapped
        // (positioned + clipped) by any ancestor with transform/filter/will-change
        // — which our hover-animated panels/cards have — so fixed alone wasn't
        // enough. Portaling to body escapes every overflow + stacking + transform
        // context. Non-portal mode keeps the in-flow absolute dropdown.
        const node = (
        <div
          style={portal ? {
            position: 'fixed',
            top: rect.bottom,
            left: rect.left,
            width: Math.max(rect.width, 280),
            zIndex: 9999,
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            maxHeight: maxDropdownHeight,
            overflowY: 'auto',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          } : {
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 60,
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            maxHeight: maxDropdownHeight,
            overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {filtered.length === 0 && !canCreate ? (
            <div style={{
              padding: '8px 10px',
              color: 'var(--t3)',
              fontSize: 12,
              fontFamily: 'var(--mono)',
              fontStyle: 'italic',
            }}>
              {emptyLabel}
            </div>
          ) : (
            filtered.map((o, idx) => {
              const highlighted = idx === highlight;
              const isSelected = String(o.value) === String(value);
              // Section header on each group change. Driven off the FILTERED list, so a
              // group whose options all filter out takes its header with it. `idx` still
              // indexes options only — keyboard highlight is untouched by grouping.
              const prevGroup = idx > 0 ? filtered[idx - 1].group : null;
              const showGroupHeader = o.group && o.group !== prevGroup;
              const optionRow = (
                <div
                  key={`${o.value}__${idx}`}
                  ref={highlighted ? highlightedRef : null}
                  onMouseDown={(e) => { e.preventDefault(); selectOption(o); }}
                  onMouseEnter={() => setHighlight(idx)}
                  style={{
                    padding: '7px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--t1)',
                    background: highlighted
                      ? 'var(--surface)'
                      : (isSelected ? 'rgba(242,205,26,.07)' : 'transparent'),
                    borderBottom: '1px solid rgba(42,42,42,.5)',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  {renderOption ? (
                    renderOption(o, { highlighted, selected: isSelected })
                  ) : (
                    <>
                      <span style={{ flex: 1 }}>{o.label}</span>
                      {o.hint && (
                        <span style={{
                          color: 'var(--t3)',
                          fontSize: 10,
                          fontFamily: 'var(--mono)',
                        }}>{o.hint}</span>
                      )}
                      {isSelected && (
                        <span style={{ color: '#f2cd1a', fontSize: 10 }}>✓</span>
                      )}
                    </>
                  )}
                </div>
              );
              if (!showGroupHeader) return optionRow;
              return (
                <Fragment key={`grp__${o.group}__${idx}`}>
                  <div style={{
                    padding: '6px 10px 4px',
                    fontSize: 9,
                    letterSpacing: '.09em',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--mono)',
                    color: 'var(--t3)',
                    background: 'var(--surface)',
                    borderBottom: '1px solid rgba(42,42,42,.5)',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                  }}>{o.group}</div>
                  {optionRow}
                </Fragment>
              );
            })
          )}
          {canCreate && (
            <div
              ref={highlight === createIndex ? highlightedRef : null}
              onMouseDown={(e) => { e.preventDefault(); doCreate(); }}
              onMouseEnter={() => setHighlight(createIndex)}
              style={{
                padding: '7px 10px',
                cursor: 'pointer',
                fontSize: 12,
                color: '#f2cd1a',
                background: highlight === createIndex ? 'var(--surface)' : 'transparent',
                borderTop: filtered.length ? '1px solid rgba(42,42,42,.9)' : 'none',
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <span style={{ flex: 1 }}>
                {/* `createLabel` may be a RENDER FUNCTION or a plain STRING. It was
                    function-only, and a caller passing the string "Use" crashed the whole
                    page with `createLabel is not a function` the moment this row rendered —
                    i.e. on the first keystroke (Ignition product field, S273→S274). The prop
                    name reads like a string, so accept both rather than wait for the next
                    caller to make the same reasonable assumption. */}
                {typeof createLabel === 'function'
                  ? createLabel(trimmedQuery)
                  : createLabel
                    ? <>{createLabel} “{trimmedQuery}”</>
                    : <>+ Create “{trimmedQuery}”</>}
              </span>
              <span style={{ color: 'var(--t3)', fontSize: 10, fontFamily: 'var(--mono)' }}>new</span>
            </div>
          )}
        </div>
        );
        return portal && typeof document !== 'undefined'
          ? createPortal(node, document.body)
          : node;
      })()}
    </div>
  );
}
