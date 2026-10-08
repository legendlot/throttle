'use client';

// Segmented control (replaces Chip tab rows). options: [{ value, label, count? }] or plain strings.
// Active pill = --text-1 bg with --bg text; inactive transparent --text-3. Count: mono 11px @ 70%.
export function Segmented({ options = [], value, onChange, disabled = false, size = 'md', style, ...rest }) {
  const pad = size === 'sm' ? '6px 12px' : '8px 15px';
  return (
    <div role="tablist" style={{
      display: 'inline-flex', gap: 4, padding: 4, background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 'var(--r-btn)', flexWrap: 'wrap', ...style,
    }} {...rest}>
      {options.map((o) => {
        const opt = typeof o === 'object' ? o : { value: o, label: String(o) };
        const on = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={disabled || opt.disabled}
            className={`ig-seg-pill${on ? ' on' : ''}`}
            onClick={() => { if (!on) onChange?.(opt.value); }}
            style={{
              padding: pad, borderRadius: 'var(--r-seg)', border: 'none', cursor: (disabled || opt.disabled) ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              background: on ? 'var(--text-1)' : 'transparent', color: on ? 'var(--bg)' : 'var(--text-3)',
              opacity: (disabled || opt.disabled) && !on ? 0.5 : 1,
            }}
          >
            {opt.label}
            {opt.count != null && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, opacity: 0.7, marginLeft: 6 }}>{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
