'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Combobox, Modal } from '@throttle/ui';
import { useProducts } from '../../../../hooks/useProducts.js';

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

function tierTone(t) {
  const v = (t || '').toLowerCase();
  if (v === 'common') return 'green';
  if (v === 'model') return 'blue';
  if (v === 'colour' || v === 'color') return 'yellow';
  return 'gray';
}

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

export default function LibraryPartsPage() {
  const { session } = useAuth();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const [partsDB, setPartsDB] = useState([]);
  const [loadStatus, setLoadStatus] = useState('Loading BOM data…');

  const [search, setSearch] = useState('');
  const [filterProduct, setFilterProduct] = useState('');
  const [filterTier, setFilterTier] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [imgView, setImgView] = useState(null); // { part_code, part_name, image_url } | null

  useEffect(() => {
    if (!session || productsLoading || !PRODUCTS.length) return;
    let cancelled = false;
    setLoadStatus('Loading BOM data…');
    (async () => {
      try {
        const results = await Promise.all(
          PRODUCTS.map((p) => garageFetch('getBOM', { product: p }, session).catch(() => []))
        );
        if (cancelled) return;
        const map = {};
        results.forEach((rows, i) => {
          const product = PRODUCTS[i];
          (Array.isArray(rows) ? rows : []).forEach((r) => {
            if (!map[r.part_code]) {
              map[r.part_code] = {
                part_code:    r.part_code,
                part_name:    r.part_name,
                category:     r.part_category || '—',
                part_type:    r.part_type || '—',
                tier:         r.common_variant || '—',
                products:     [],
                variants:     [],
                qty_per_unit: r.qty_per_unit || 1,
                image_url:    r.image_url || null,
              };
            }
            const entry = map[r.part_code];
            // image_url is keyed per part_code in material_master (identical
            // across products) — backfill if the first-seen row lacked it.
            if (!entry.image_url && r.image_url) entry.image_url = r.image_url;
            if (!entry.products.includes(product)) entry.products.push(product);
            entry.variants.push({
              product,
              variant_model: r.variant_model || 'Common',
              qty_per_unit:  r.qty_per_unit || 1,
            });
          });
        });
        const list = Object.values(map).sort((a, b) => a.part_code.localeCompare(b.part_code));
        setPartsDB(list);
        setLoadStatus('');
      } catch {
        if (!cancelled) setLoadStatus('Failed to load BOM data');
      }
    })();
    return () => { cancelled = true; };
  }, [session, productsLoading, PRODUCTS]);

  const categories = useMemo(() => {
    const set = new Set();
    partsDB.forEach((r) => { if (r.category && r.category !== '—') set.add(r.category); });
    return [...set].sort();
  }, [partsDB]);

  // Multi-token AND-of-OR search across product / part_code / part_name /
  // category / part_type / tier. Mirrors the Stock Ledger pattern so users
  // can type "Flare metal" or "Apex electronic" and get intuitive results.
  const filtered = useMemo(() => {
    const tokens = (search || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return partsDB.filter((r) => {
      if (tokens.length) {
        const fields = [
          r.part_code,
          r.part_name,
          r.category,
          r.part_type,
          r.tier,
          (r.products || []).join(' '),
        ].map((v) => (v || '').toLowerCase());
        for (const t of tokens) {
          if (!fields.some((f) => f.includes(t))) return false;
        }
      }
      if (filterProduct && !r.products.includes(filterProduct)) return false;
      if (filterTier && (r.tier || '').toLowerCase() !== filterTier.toLowerCase()) return false;
      if (filterCat && r.category !== filterCat) return false;
      return true;
    });
  }, [partsDB, search, filterProduct, filterTier, filterCat]);

  function clearFilters() {
    setSearch('');
    setFilterProduct('');
    setFilterTier('');
    setFilterCat('');
  }

  const isFiltered = !!(search || filterProduct || filterTier || filterCat);
  const capped = filtered.slice(0, 300);

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Library — Parts Database
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Cross-product part catalogue derived from all BOMs.
        </p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>Search & Filter</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <span style={labelStyle}>Search</span>
              <input data-search-primary type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search — try “Flare metal” or “Apex electronic”  · /" style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div style={{ flex: '0 0 180px' }}>
              <span style={labelStyle}>Product</span>
              <Combobox
                value={filterProduct}
                options={PRODUCTS.map((p) => ({ value: p, label: p }))}
                onChange={(v) => setFilterProduct(v)}
                placeholder="All products"
                loading={productsLoading}
              />
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <span style={labelStyle}>Tier</span>
              <select value={filterTier} onChange={(e) => setFilterTier(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="">All Tiers</option>
                <option value="Common">Common</option>
                <option value="Model">Model</option>
                <option value="Colour">Colour</option>
              </select>
            </div>
            <div style={{ flex: '0 0 180px' }}>
              <span style={labelStyle}>Category</span>
              <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ ...selectStyle, width: '100%' }}>
                <option value="">All Categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button style={btnSecondary} onClick={clearFilters} disabled={!isFiltered}>✕ Clear</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
        <span>
          {isFiltered
            ? `${filtered.length.toLocaleString()} of ${partsDB.length.toLocaleString()} parts`
            : `${partsDB.length.toLocaleString()} unique parts across ${PRODUCTS.length} products`}
        </span>
        <span>{loadStatus}</span>
      </div>

      <div style={panelStyle}>
        <div style={{ overflowX: 'auto' }}>
          {loadStatus ? (
            <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : capped.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No parts match the filters</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Part Code</th>
                <th style={tableThStyle}>Part Name</th>
                <th style={tableThStyle}>Category</th>
                <th style={tableThStyle}>Type</th>
                <th style={tableThStyle}>Tier</th>
                <th style={tableThStyle}>Products</th>
                <th style={tableThStyle}>Variant / Model</th>
                <th style={tableThStyle}>Qty / Unit</th>
                <th style={tableThStyle}>Image</th>
              </tr></thead>
              <tbody>
                {capped.map((r) => {
                  const variantSet = new Set();
                  r.variants.forEach((v) => {
                    const m = (v.variant_model || '').trim();
                    if (m && m.toLowerCase() !== 'common') variantSet.add(m);
                  });
                  const qtys = [...new Set(r.variants.map((v) => v.qty_per_unit))];
                  qtys.sort((a, b) => a - b);
                  const qtyDisplay = qtys.length === 1 ? qtys[0] : `${qtys[0]}–${qtys[qtys.length - 1]}`;
                  return (
                    <tr key={r.part_code}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{r.part_code}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.3 }}>{r.part_name || '—'}</td>
                      <td style={tableTdStyle}>{r.category}</td>
                      <td style={tableTdStyle}>{r.part_type}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.tier} tone={tierTone(r.tier)} /></td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 240, fontSize: 11 }}>
                        {[...r.products].sort().join(', ')}
                      </td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 220, fontSize: 11, color: 'var(--t2)' }}>
                        {variantSet.size === 0 ? '—' : [...variantSet].join(', ')}
                      </td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{qtyDisplay}</td>
                      <td style={tableTdStyle}>
                        {r.image_url ? (
                          <button
                            onClick={() => setImgView(r)}
                            style={{ ...btnSecondary, padding: '4px 10px', fontSize: 10, color: 'var(--t1)', whiteSpace: 'nowrap' }}
                          >View image</button>
                        ) : (
                          <span style={{ color: 'var(--t3)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length > 300 && (
                  <tr>
                    <td colSpan={9} style={{ ...tableTdStyle, textAlign: 'center', color: 'var(--t3)', fontStyle: 'italic' }}>
                      Showing first 300 of {filtered.length.toLocaleString()} results — narrow your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        open={!!imgView}
        onClose={() => setImgView(null)}
        size="lg"
        title={imgView ? `${imgView.part_code} — ${imgView.part_name || ''}`.trim() : ''}
      >
        {imgView && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <img
              src={imgView.image_url}
              alt={imgView.part_code}
              style={{ maxWidth: '100%', maxHeight: '70dvh', borderRadius: 4, background: '#000' }}
            />
            <a
              href={imgView.image_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}
            >Open original ↗</a>
          </div>
        )}
      </Modal>
    </div>
  );
}
