'use client';
import { ChevronDown } from 'lucide-react';

// Filter select: 40px, --input bg, --border-2 border (hover --border-input-hover), radius 10.
// A native <select> stays underneath (keyboard + mobile pickers unchanged). Pass `options`
// ([{ value, label }] or strings) or plain <option> children. Extra props go to the <select>.
export function FilterSelect({ value, onChange, options, children, width, style, selectStyle, ...rest }) {
  return (
    <span className="ig-ctl" style={{
      position: 'relative', display: 'inline-flex', alignItems: 'center', height: 40,
      background: 'var(--input)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)',
      color: 'var(--text-2)', width, minWidth: 0, ...style,
    }}>
      <select
        value={value}
        onChange={onChange}
        style={{
          appearance: 'none', WebkitAppearance: 'none', background: 'transparent', border: 'none',
          color: 'inherit', font: 'inherit', fontSize: 14, height: '100%', width: '100%',
          padding: '0 34px 0 12px', cursor: 'pointer', ...selectStyle,
        }}
        {...rest}
      >
        {options ? options.map((o) => {
          const opt = typeof o === 'object' ? o : { value: o, label: String(o) };
          return <option key={String(opt.value)} value={opt.value}>{opt.label}</option>;
        }) : children}
      </select>
      <ChevronDown size={14} strokeWidth={1.75} style={{ position: 'absolute', right: 12, pointerEvents: 'none' }} />
    </span>
  );
}

export default FilterSelect;
