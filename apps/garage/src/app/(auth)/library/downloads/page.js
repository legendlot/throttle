'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useProducts } from '../../../../hooks/useProducts.js';

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '8px 18px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };

function bomToCSV(rows, includeProductCol) {
  const headers = includeProductCol
    ? ['Product', 'Part Code', 'Part Name', 'Category', 'Tier', 'Variant Model', 'Qty Per Unit']
    : ['Part Code', 'Part Name', 'Category', 'Tier', 'Variant Model', 'Qty Per Unit'];
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    const vals = includeProductCol
      ? [r.product, r.part_code, r.part_name, r.part_category || '', r.common_variant || '', r.variant_model || '', r.qty_per_unit || 1]
      : [r.part_code, r.part_name, r.part_category || '', r.common_variant || '', r.variant_model || '', r.qty_per_unit || 1];
    lines.push(vals.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  });
  return lines.join('\n');
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function triggerCSVDownload(csv, filename) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function LibraryDownloadsPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { PRODUCTS, loading: productsLoading } = useProducts();

  const [selectedProduct, setSelectedProduct] = useState('');
  const [bomCache, setBomCache] = useState({});
  const [singleLoading, setSingleLoading] = useState(false);

  const [fullStats, setFullStats] = useState({ products: '—', lines: '—', parts: '—' });
  const [fullLoading, setFullLoading] = useState(true);
  const [fullDownloading, setFullDownloading] = useState(false);

  // Load all BOMs in parallel for full-extract stats
  useEffect(() => {
    if (!session || productsLoading || !PRODUCTS.length) return;
    let cancelled = false;
    setFullLoading(true);
    (async () => {
      try {
        const results = await Promise.all(
          PRODUCTS.map((p) => garageFetch('getBOM', { product: p }, session).catch(() => []))
        );
        if (cancelled) return;
        const cache = {};
        const allParts = new Set();
        let totalLines = 0;
        let productsCovered = 0;
        results.forEach((rows, i) => {
          const product = PRODUCTS[i];
          const arr = Array.isArray(rows) ? rows : [];
          cache[product] = arr;
          if (arr.length > 0) productsCovered += 1;
          totalLines += arr.length;
          arr.forEach((r) => allParts.add(r.part_code));
        });
        setBomCache(cache);
        setFullStats({
          products: productsCovered,
          lines:    totalLines.toLocaleString('en-IN'),
          parts:    allParts.size.toLocaleString('en-IN'),
        });
      } catch {
        if (!cancelled) setFullStats({ products: '—', lines: '—', parts: '—' });
      } finally {
        if (!cancelled) setFullLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session, productsLoading, PRODUCTS]);

  const previewStats = useMemo(() => {
    if (!selectedProduct) return null;
    const rows = bomCache[selectedProduct];
    if (!rows) return null;
    let common = 0, model = 0, colour = 0;
    rows.forEach((r) => {
      const tier = (r.common_variant || '').toLowerCase();
      if (tier === 'common') common += 1;
      else if (tier === 'model') model += 1;
      else if (tier === 'colour' || tier === 'color') colour += 1;
    });
    return { lines: rows.length, common, model, colour };
  }, [selectedProduct, bomCache]);

  async function downloadSingle() {
    if (!selectedProduct) return;
    setSingleLoading(true);
    try {
      const rows = await garageFetch('getBOM', { product: selectedProduct }, session);
      const arr = Array.isArray(rows) ? rows : [];
      if (!arr.length) {
        showToast('No BOM lines for this product', 'error');
        return;
      }
      const csv = bomToCSV(arr, false);
      triggerCSVDownload(csv, `LOT-BOM-${selectedProduct}-${nowStamp()}.csv`);
      showToast(`Downloaded BOM for ${selectedProduct} — ${arr.length} lines`, 'success');
      setBomCache((c) => ({ ...c, [selectedProduct]: arr }));
    } catch (e) {
      showToast(e.message || 'Download failed', 'error');
    } finally {
      setSingleLoading(false);
    }
  }

  async function downloadFull() {
    setFullDownloading(true);
    try {
      // Use cache if loaded, otherwise fetch
      let cache = bomCache;
      const missing = PRODUCTS.filter((p) => !cache[p]);
      if (missing.length) {
        const results = await Promise.all(
          missing.map((p) => garageFetch('getBOM', { product: p }, session).catch(() => []))
        );
        const next = { ...cache };
        missing.forEach((p, i) => { next[p] = Array.isArray(results[i]) ? results[i] : []; });
        cache = next;
        setBomCache(next);
      }
      const allRows = [];
      PRODUCTS.forEach((product) => {
        (cache[product] || []).forEach((r) => allRows.push({ ...r, product }));
      });
      if (!allRows.length) { showToast('No BOM data available', 'error'); return; }
      const csv = bomToCSV(allRows, true);
      triggerCSVDownload(csv, `LOT-BOM-FULL-${nowStamp()}.csv`);
      showToast(`Downloaded full BOM — ${allRows.length} lines across ${PRODUCTS.length} products`, 'success');
    } catch (e) {
      showToast(e.message || 'Download failed', 'error');
    } finally {
      setFullDownloading(false);
    }
  }

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Library — Downloads
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Download per-product BOMs or the full master extract.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Single Product BOM</span></div>
          <div style={panelBodyStyle}>
            <p style={{ color: 'var(--t2)', fontSize: 12, lineHeight: 1.6, margin: 0, marginBottom: 12 }}>
              Pick a product to preview its BOM line counts and download the CSV. Includes Common, Model, and Colour-tier rows.
            </p>
            <div style={{ maxWidth: 300, marginBottom: 12 }}>
              <span style={labelStyle}>Product</span>
              <select
                value={selectedProduct}
                onChange={(e) => setSelectedProduct(e.target.value)}
                style={{ ...selectStyle, width: '100%' }}
                disabled={productsLoading}
              >
                <option value="">{productsLoading ? 'Loading…' : 'Select…'}</option>
                {PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            {previewStats && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...labelStyle, marginBottom: 4 }}>Preview</div>
                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '10px 12px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--t1)' }}>
                  {previewStats.lines} BOM lines · {previewStats.common} Common · {previewStats.model} Model · {previewStats.colour} Colour/Variant
                </div>
              </div>
            )}

            <button
              style={{ ...btnPrimary, opacity: !selectedProduct || singleLoading ? 0.5 : 1, cursor: !selectedProduct || singleLoading ? 'not-allowed' : 'pointer' }}
              onClick={downloadSingle}
              disabled={!selectedProduct || singleLoading}
            >
              {singleLoading ? 'Preparing…' : '↓ Download BOM'}
            </button>
          </div>
        </div>

        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Full BOM Extract</span></div>
          <div style={panelBodyStyle}>
            <p style={{ color: 'var(--t2)', fontSize: 12, lineHeight: 1.6, margin: 0, marginBottom: 12 }}>
              All products in a single CSV — useful for offline searching, spreadsheet pivots, and bulk audits.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12, fontSize: 12, fontFamily: 'var(--mono)' }}>
              <Stat label="Products covered" value={fullLoading ? '—' : fullStats.products} />
              <Stat label="Total BOM lines" value={fullLoading ? '—' : fullStats.lines} />
              <Stat label="Unique part codes" value={fullLoading ? '—' : fullStats.parts} />
            </div>
            {fullLoading && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><Spinner /></div>}
            <button
              style={{ ...btnPrimary, opacity: fullLoading || fullDownloading ? 0.5 : 1, cursor: fullLoading || fullDownloading ? 'not-allowed' : 'pointer' }}
              onClick={downloadFull}
              disabled={fullLoading || fullDownloading}
            >
              {fullDownloading ? 'Preparing…' : '↓ Download Full Extract'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ background: 'rgba(242,205,26,.06)', border: '1px solid rgba(242,205,26,.3)', borderRadius: 4, padding: '12px 14px', marginTop: 8, fontSize: 12, color: 'var(--t2)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--yellow)', fontFamily: 'var(--cond)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>How to use</strong>
        <div style={{ marginTop: 4 }}>
          The downloaded file is a CSV — open it in Google Sheets or Excel to search, filter, and print. UTF-8 BOM included so accented characters render correctly.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '8px 10px' }}>
      <div style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2, color: 'var(--yellow)' }}>{value}</div>
    </div>
  );
}
