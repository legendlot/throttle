'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch, supabase } from '@throttle/db';
import { Spinner, Combobox, Modal, useToast } from '@throttle/ui';
import { useProducts } from '../../../../hooks/useProducts.js';

const PART_IMAGES_BUCKET = 'part-images';

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
  const { showToast } = useToast();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const [partsDB, setPartsDB] = useState([]);
  const [loadStatus, setLoadStatus] = useState('Loading parts…');

  const [search, setSearch] = useState('');
  const [filterProduct, setFilterProduct] = useState('');
  const [filterTier, setFilterTier] = useState('');
  const [filterCat, setFilterCat] = useState('');

  // Photo manager
  const [photoPart, setPhotoPart] = useState(null); // the part row being managed
  const [photos, setPhotos] = useState([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [enlarge, setEnlarge] = useState(null);     // a single photo for the lightbox
  const [delId, setDelId] = useState(null);         // inline 2-step delete confirm

  useEffect(() => {
    if (!session || productsLoading || !PRODUCTS.length) return;
    let cancelled = false;
    setLoadStatus('Loading parts…');
    (async () => {
      try {
        // Catalogue is the spine (ALL active parts incl. those not in any BOM, with
        // photo counts). BOMs only enrich product / variant / qty usage.
        const [bomResults, catalog] = await Promise.all([
          Promise.all(PRODUCTS.map((p) => garageFetch('getBOM', { product: p }, session).catch(() => []))),
          garageFetch('getPartsCatalog', {}, session).catch(() => []),
        ]);
        if (cancelled) return;

        const bomMap = {};
        bomResults.forEach((rows, i) => {
          const product = PRODUCTS[i];
          (Array.isArray(rows) ? rows : []).forEach((r) => {
            if (!bomMap[r.part_code]) {
              bomMap[r.part_code] = {
                part_name: r.part_name, category: r.part_category || '', part_type: r.part_type || '',
                tier: r.common_variant || '', products: [], variants: [],
              };
            }
            const e = bomMap[r.part_code];
            if (!e.products.includes(product)) e.products.push(product);
            e.variants.push({ product, variant_model: r.variant_model || 'Common', qty_per_unit: r.qty_per_unit || 1 });
          });
        });

        const map = {};
        // 1) every catalogue part
        (Array.isArray(catalog) ? catalog : []).forEach((c) => {
          const b = bomMap[c.part_code];
          map[c.part_code] = {
            part_code:   c.part_code,
            part_name:   c.part_name || b?.part_name || '—',
            category:    c.part_category || b?.category || '—',
            part_type:   c.part_type || b?.part_type || '—',
            tier:        c.tier || b?.tier || '—',
            products:    b?.products || [],
            variants:    b?.variants || [],
            image_url:   c.image_url || null,
            photo_count: c.photo_count || 0,
          };
        });
        // 2) any BOM part missing from the catalogue (name mismatch / not yet in material_master)
        Object.entries(bomMap).forEach(([code, b]) => {
          if (map[code]) return;
          map[code] = {
            part_code: code, part_name: b.part_name || '—', category: b.category || '—',
            part_type: b.part_type || '—', tier: b.tier || '—',
            products: b.products, variants: b.variants, image_url: null, photo_count: 0,
          };
        });

        const list = Object.values(map).sort((a, b) => a.part_code.localeCompare(b.part_code, undefined, { numeric: true }));
        setPartsDB(list);
        setLoadStatus('');
      } catch {
        if (!cancelled) setLoadStatus('Failed to load parts');
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
  // category / part_type / tier. Mirrors the Stock Ledger pattern.
  const filtered = useMemo(() => {
    const tokens = (search || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return partsDB.filter((r) => {
      if (tokens.length) {
        const fields = [
          r.part_code, r.part_name, r.category, r.part_type, r.tier, (r.products || []).join(' '),
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
    setSearch(''); setFilterProduct(''); setFilterTier(''); setFilterCat('');
  }

  const isFiltered = !!(search || filterProduct || filterTier || filterCat);
  const capped = filtered.slice(0, 300);

  // ── Photo manager ──────────────────────────────────────────
  function syncRow(part_code, list) {
    const primary = list.find((p) => p.is_primary) || list[0] || null;
    setPartsDB((prev) => prev.map((r) =>
      r.part_code === part_code ? { ...r, photo_count: list.length, image_url: primary?.url || null } : r));
  }

  async function loadPhotos(part_code) {
    setPhotosLoading(true);
    try {
      const data = await garageFetch('getPartPhotos', { part_code }, session);
      const list = Array.isArray(data?.photos) ? data.photos : [];
      setPhotos(list);
      syncRow(part_code, list);
      return list;
    } catch { setPhotos([]); return []; }
    finally { setPhotosLoading(false); }
  }

  async function openPhotos(row) {
    setPhotoPart(row); setPhotos([]); setEnlarge(null); setDelId(null);
    await loadPhotos(row.part_code);
  }
  function closePhotos() { setPhotoPart(null); setPhotos([]); setEnlarge(null); setDelId(null); }

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || !photoPart) return;
    setUploading(true);
    let added = 0;
    for (const file of files) {
      try {
        if (!file.type.startsWith('image/')) { showToast(`"${file.name}" is not an image`, 'error'); continue; }
        const r1 = await workerFetch('createPartPhotoUploadUrl', { data: { part_code: photoPart.part_code, file_name: file.name } }, session);
        if (!r1.ok || !r1.data?.token) throw new Error(r1.error || 'No upload token');
        const { storage_path, token } = r1.data;
        const up = await supabase.storage.from(PART_IMAGES_BUCKET).uploadToSignedUrl(storage_path, token, file);
        if (up.error) throw up.error;
        const r2 = await workerFetch('recordPartPhoto', { data: { part_code: photoPart.part_code, storage_path, file_name: file.name, mime_type: file.type || null } }, session);
        if (!r2.ok) throw new Error(r2.error || 'Record failed');
        added++;
      } catch (err) { showToast(`"${file.name}" failed: ${err.message || err}`, 'error'); }
    }
    if (added) { showToast(`${added} photo${added > 1 ? 's' : ''} added`, 'success'); await loadPhotos(photoPart.part_code); }
    setUploading(false);
  }

  async function setCover(photo) {
    const r = await workerFetch('setPrimaryPartPhoto', { data: { id: photo.id } }, session);
    if (!r.ok) { showToast(r.error || 'Failed to set cover', 'error'); return; }
    await loadPhotos(photoPart.part_code);
    showToast('Cover photo updated', 'success');
  }

  async function doDelete(photo) {
    const r = await workerFetch('deletePartPhoto', { data: { id: photo.id } }, session);
    setDelId(null);
    if (!r.ok) { showToast(r.error || 'Delete failed', 'error'); return; }
    await loadPhotos(photoPart.part_code);
    showToast('Photo deleted', 'success');
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Library — Parts Database
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Full parts catalogue. Add or manage photos on any part — click its Photos button.
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
            : `${partsDB.length.toLocaleString()} parts in catalogue`}
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
                <th style={tableThStyle}>Photos</th>
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
                  const qtyDisplay = qtys.length === 0 ? '—' : qtys.length === 1 ? qtys[0] : `${qtys[0]}–${qtys[qtys.length - 1]}`;
                  return (
                    <tr key={r.part_code}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--yellow)' }}>{r.part_code}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 260, lineHeight: 1.3 }}>{r.part_name || '—'}</td>
                      <td style={tableTdStyle}>{r.category}</td>
                      <td style={tableTdStyle}>{r.part_type}</td>
                      <td style={tableTdStyle}><StatusBadge label={r.tier} tone={tierTone(r.tier)} /></td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 240, fontSize: 11 }}>
                        {r.products.length ? [...r.products].sort().join(', ') : <span style={{ color: 'var(--t3)' }}>— not in any BOM</span>}
                      </td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal', maxWidth: 220, fontSize: 11, color: 'var(--t2)' }}>
                        {variantSet.size === 0 ? '—' : [...variantSet].join(', ')}
                      </td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{qtyDisplay}</td>
                      <td style={tableTdStyle}>
                        <button
                          onClick={() => openPhotos(r)}
                          style={{
                            ...btnSecondary, padding: '4px 10px', fontSize: 10, whiteSpace: 'nowrap',
                            color: r.photo_count > 0 ? 'var(--t1)' : 'var(--t2)',
                            borderColor: r.photo_count > 0 ? 'var(--border)' : 'rgba(80,80,80,.4)',
                          }}
                        >{r.photo_count > 0 ? `Photos (${r.photo_count})` : '+ Add photos'}</button>
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

      {/* Photo manager */}
      <Modal
        open={!!photoPart}
        onClose={closePhotos}
        size="lg"
        title={photoPart ? `${photoPart.part_code} — ${photoPart.part_name || ''}`.trim() : ''}
      >
        {photoPart && (
          <div>
            {/* Upload control */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <label style={{
                ...btnSecondary, display: 'inline-flex', alignItems: 'center', gap: 6,
                color: 'var(--t1)', borderColor: 'var(--yellow)', cursor: uploading ? 'wait' : 'pointer',
                opacity: uploading ? 0.6 : 1,
              }}>
                {uploading ? 'Uploading…' : '⬆ Upload photos'}
                <input type="file" accept="image/*" multiple disabled={uploading} onChange={onFiles} style={{ display: 'none' }} />
              </label>
              <span style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)' }}>
                JPG / PNG · multiple at once · first photo becomes the cover
              </span>
            </div>

            {photosLoading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : photos.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
                No photos yet — upload the first one.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                {photos.map((p) => (
                  <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', background: 'var(--surface2)' }}>
                    <div
                      onClick={() => setEnlarge(p)}
                      style={{ height: 120, background: '#000', cursor: 'zoom-in', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <img src={p.url} alt={p.file_name || p.part_code} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                    </div>
                    <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        {p.is_primary
                          ? <StatusBadge label="Cover" tone="green" />
                          : <button onClick={() => setCover(p)} style={{ ...btnSecondary, padding: '2px 8px', fontSize: 9 }}>Set cover</button>}
                        {delId === p.id ? (
                          <span style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => doDelete(p)} style={{ ...btnSecondary, padding: '2px 8px', fontSize: 9, color: '#ff7070', borderColor: 'rgba(222,42,42,.4)' }}>Confirm</button>
                            <button onClick={() => setDelId(null)} style={{ ...btnSecondary, padding: '2px 8px', fontSize: 9 }}>✕</button>
                          </span>
                        ) : (
                          <button onClick={() => setDelId(p.id)} style={{ ...btnSecondary, padding: '2px 8px', fontSize: 9, color: 'var(--t3)' }}>Delete</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Lightbox */}
      <Modal open={!!enlarge} onClose={() => setEnlarge(null)} size="lg" title={enlarge ? (enlarge.file_name || photoPart?.part_code || '') : ''}>
        {enlarge && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <img src={enlarge.url} alt={enlarge.part_code} style={{ maxWidth: '100%', maxHeight: '70dvh', borderRadius: 4, background: '#000' }} />
            <a href={enlarge.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>Open original ↗</a>
          </div>
        )}
      </Modal>
    </div>
  );
}
