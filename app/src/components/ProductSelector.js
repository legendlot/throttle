'use client';
import { useState } from 'react';

const PRODUCTS = [
  'Alex','Apex','Bracey','Brutus','Bumble','Dash','Diesel','Doughty',
  'Ellie','Fang','Flare','Flare LE','Gazer','Ghost','Iris','Knox',
  'McCloud','NightWolf','Nitro','Otto','Shadow','Shuttle','Thunder','Titan','Vera'
];

export default function ProductSelector({ selected, onChange }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = PRODUCTS.filter(p =>
    p.toLowerCase().includes(search.toLowerCase())
  );

  function toggle(product) {
    if (selected.includes(product)) {
      onChange(selected.filter(p => p !== product));
    } else {
      onChange([...selected, product]);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Selected tags */}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map(p => (
            <span
              key={p}
              style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--s3)', color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 8px', borderRadius: 4 }}
            >
              {p}
              <button
                type="button"
                onClick={() => toggle(p)}
                style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 4, fontSize: 11 }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <input
        type="text"
        placeholder="Search products..."
        value={search}
        onChange={e => { setSearch(e.target.value); setOpen(true); }}
        onFocus={e => { setOpen(true); e.target.style.borderColor = '#F2CD1A'; }}
        onBlur={e => { e.target.style.borderColor = 'var(--b2)'; }}
        style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6, padding: '10px 14px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13, outline: 'none' }}
      />

      {/* Dropdown */}
      {open && (
        <div style={{ position: 'absolute', zIndex: 10, width: '100%', marginTop: 4, background: 'var(--s1)', border: '1px solid var(--b2)', borderRadius: 6, maxHeight: 192, overflowY: 'auto', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
          {filtered.length === 0 && (
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', padding: '8px 12px' }}>No products found</p>
          )}
          {filtered.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => { toggle(p); setSearch(''); }}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12,
                border: 'none', cursor: 'pointer', transition: 'background .1s',
                background: selected.includes(p) ? 'var(--s3)' : 'transparent',
                color: selected.includes(p) ? 'var(--text)' : 'var(--t2)',
              }}
              onMouseEnter={e => { if (!selected.includes(p)) e.currentTarget.style.background = 'var(--s2)'; }}
              onMouseLeave={e => { if (!selected.includes(p)) e.currentTarget.style.background = 'transparent'; }}
            >
              {selected.includes(p) && <span style={{ color: 'var(--green)', marginRight: 8 }}>✓</span>}
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Close on outside click */}
      {open && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 0 }}
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}
