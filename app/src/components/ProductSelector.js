'use client';
import { useState, useEffect } from 'react';
import { workerFetch } from '@/lib/worker';
import { useAuth } from '@/lib/auth';

export default function ProductSelector({ selected, onChange, multi = true }) {
  const { session } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [customEntry, setCustomEntry] = useState('');

  useEffect(() => {
    workerFetch('getProducts', {}, session?.access_token)
      .then(data => { setProducts(data.products || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = products.filter(p =>
    p.product.toLowerCase().includes(search.toLowerCase()) ||
    p.product_code.toLowerCase().includes(search.toLowerCase())
  );

  const isSelected = (code) => (selected || []).some(s => s.product_code === code);

  const toggle = (product) => {
    if (isSelected(product.product_code)) {
      onChange((selected || []).filter(s => s.product_code !== product.product_code));
    } else {
      onChange([...(selected || []), { product_code: product.product_code, product_name: product.product, notes: '' }]);
    }
  };

  const handleAddCustom = () => {
    if (!customEntry.trim()) return;
    const customProduct = {
      product_code: `custom_${Date.now()}`,
      product_name: customEntry.trim(),
      notes: '',
      is_custom: true,
    };
    onChange([...(selected || []), customProduct]);
    setCustomEntry('');
  };

  if (loading) return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>Loading products...</div>
  );

  return (
    <div>
      <input
        type="text"
        placeholder="Search products..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 6,
          padding: '8px 12px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
          outline: 'none', width: '100%', marginBottom: 8,
        }}
        onFocus={e => e.target.style.borderColor = '#F2CD1A'}
        onBlur={e => e.target.style.borderColor = 'var(--b2)'}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', padding: '8px 0' }}>No products found.</div>
        )}
        {filtered.map(p => (
          <div
            key={p.product_code}
            onClick={() => toggle(p)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 10px', borderRadius: 4, cursor: 'pointer',
              background: isSelected(p.product_code) ? 'rgba(242,205,26,0.08)' : 'transparent',
              border: `1px solid ${isSelected(p.product_code) ? 'rgba(242,205,26,0.25)' : 'transparent'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 14, height: 14, borderRadius: multi ? 3 : 7,
                border: `1px solid ${isSelected(p.product_code) ? '#F2CD1A' : 'var(--b3)'}`,
                background: isSelected(p.product_code) ? '#F2CD1A' : 'transparent',
                flexShrink: 0,
              }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>{p.product}</span>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>{p.product_code}</span>
          </div>
        ))}
      </div>
      {multi && (selected || []).length > 0 && (
        <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>
          {selected.length} selected
        </div>
      )}

      {/* Custom product entry */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--b1)', paddingTop: 12 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 6 }}>
          Can&apos;t find your product?
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="Enter product name manually"
            value={customEntry}
            onChange={e => setCustomEntry(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddCustom(); }}
            style={{
              flex: 1, background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4,
              padding: '6px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, outline: 'none',
            }}
            onFocus={e => e.target.style.borderColor = '#F2CD1A'}
            onBlur={e => e.target.style.borderColor = 'var(--b2)'}
          />
          <button
            onClick={handleAddCustom}
            disabled={!customEntry.trim()}
            style={{
              background: customEntry.trim() ? '#F2CD1A' : 'var(--s3)',
              color: customEntry.trim() ? '#080808' : 'var(--t3)',
              border: 'none', borderRadius: 4, padding: '6px 12px',
              fontFamily: 'var(--head)', fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase',
              cursor: customEntry.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Add
          </button>
        </div>
        {(selected || []).filter(s => s.is_custom).map(s => (
          <div key={s.product_code} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--b1)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>
              ✦ {s.product_name}
            </span>
            <button
              onClick={() => onChange((selected || []).filter(x => x.product_code !== s.product_code))}
              style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 12 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
