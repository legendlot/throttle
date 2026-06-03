'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Searchable combobox — drop-in replacement for native `<select>` when the option
 * list is large enough that scrolling becomes painful (vendors, products, parts).
 *
 * Controlled component:
 *   value     — the currently-selected option's `value` (string). Pass '' for none.
 *   options   — [{ value: string, label: string, hint?: string }, ...]
 *   onChange  — (value: string, option | null) => void. Fires on selection and on clear.
 *
 * Behaviour:
 *   - Typing filters by case-insensitive substring across label + hint.
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
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef(null);
  const highlightedRef = useRef(null);
  const blurTimerRef = useRef(null);

  // Resolve the label for the currently-selected value.
  const selectedOption = useMemo(
    () => options.find((o) => String(o.value) === String(value)) || null,
    [options, value]
  );

  // Snap query back to the selected label whenever value changes externally.
  // The user's in-progress search is preserved as long as the dropdown is open.
  useEffect(() => {
    if (!open) {
      setQuery(selectedOption ? selectedOption.label : '');
    }
  }, [selectedOption, open]);

  // Filter options against the query. When the query exactly matches the
  // selected label, show all options (user just opened the dropdown).
  // Multi-token: split the query on whitespace and require EVERY token to match
  // the label or hint (substring). So "flare para" matches an option whose label
  // is the code+name and whose hint carries the product/category. A single token
  // behaves exactly as a plain substring match (backward compatible).
  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase();
    if (!q || (selectedOption && q === selectedOption.label.toLowerCase())) {
      return options;
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = `${(o.label || '').toLowerCase()} ${(o.hint || '').toLowerCase()}`;
      return tokens.every((t) => hay.includes(t));
    });
  }, [options, query, selectedOption]);

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

  function handleKeyDown(e) {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((i) => Math.min((i < 0 ? -1 : i) + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && highlight >= 0 && filtered[highlight]) {
        e.preventDefault();
        selectOption(filtered[highlight]);
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
      setQuery(selectedOption ? selectedOption.label : '');
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
      {open && !disabled && !loading && (
        <div
          style={{
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
          {filtered.length === 0 ? (
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
              return (
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
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
