'use client';
import { Search } from 'lucide-react';

// Page search: 40px tall, 300px wide, --input bg, 15px search icon. Renders `data-search-primary`
// (the input `/` and the top-bar search focus — useSearchShortcut) unless primary={false}.
// Extra props (onKeyDown, autoFocus, …) go to the <input>.
export function SearchField({ value, onChange, placeholder = 'Search', primary = true, width = 300, style, inputStyle, ...rest }) {
  return (
    <label className="ig-ctl" style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, width, maxWidth: '100%',
      padding: '0 12px', background: 'var(--input)', border: '1px solid var(--border-2)',
      borderRadius: 'var(--r-ctl)', color: 'var(--text-3)', cursor: 'text', minWidth: 0, ...style,
    }}>
      <Search size={15} strokeWidth={1.75} style={{ flexShrink: 0 }} />
      <input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        data-search-primary={primary ? '' : undefined}
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'var(--text-1)',
          font: 'inherit', fontSize: 14, height: '100%', ...inputStyle,
        }}
        {...rest}
      />
    </label>
  );
}

export default SearchField;
