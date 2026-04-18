'use client';

export function DateBar({ from, to, onChange, showRange = true }) {
  function handleFrom(e) {
    onChange && onChange({ from: e.target.value, to });
  }
  function handleTo(e) {
    onChange && onChange({ from, to: e.target.value });
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono, ui-monospace, Menlo, monospace)', fontSize: 12, color: '#aaa' }}>
      <label>From
        <input type="date" value={from || ''} onChange={handleFrom} style={{ marginLeft: 6, background: '#111', color: '#eee', border: '1px solid #333', padding: '3px 6px', borderRadius: 3 }} />
      </label>
      {showRange && (
        <label>To
          <input type="date" value={to || ''} onChange={handleTo} style={{ marginLeft: 6, background: '#111', color: '#eee', border: '1px solid #333', padding: '3px 6px', borderRadius: 3 }} />
        </label>
      )}
    </div>
  );
}
