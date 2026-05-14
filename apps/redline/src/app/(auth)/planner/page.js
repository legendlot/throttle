'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const LEAD_COLORS = {
  impossible: '#DE2A2A',
  critical:   '#DE2A2A',
  warning:    '#F2CD1A',
  ok:         '#22c55e',
};
const LEAD_LABELS = {
  impossible: 'IMPOSSIBLE',
  critical:   'URGENT — TODAY ONLY',
  warning:    'CAUTION',
  ok:         'ON TRACK',
};
const STATUS_RANK = { impossible: 0, critical: 1, warning: 2, ok: 3 };

function parseCSVRows(text) {
  return text.split(/\r?\n/).map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  });
}

const MONTHS = ['january','february','march','april','may','june',
                'july','august','september','october','november','december'];

function formatLocalISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00');
    return isNaN(d) ? null : d;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) {
    const [m, day, yr] = s.split('/').map(Number);
    const year = yr < 100 ? 2000 + yr : yr;
    const d = new Date(year, m - 1, day);
    return isNaN(d) ? null : d;
  }

  const mdy = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (mdy) {
    const monthIdx = MONTHS.indexOf(mdy[1].toLowerCase());
    if (monthIdx !== -1) {
      const year = mdy[3] ? parseInt(mdy[3]) : new Date().getFullYear();
      return new Date(year, monthIdx, parseInt(mdy[2]));
    }
  }

  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dmy) {
    const monthIdx = MONTHS.indexOf(dmy[2].toLowerCase());
    if (monthIdx !== -1) return new Date(parseInt(dmy[3]), monthIdx, parseInt(dmy[1]));
  }

  return null;
}

function parseDispatchCsv(csvText) {
  const rows = parseCSVRows(csvText);

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(cell => cell.trim().toLowerCase() === 'sku')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error(
    "Cannot find a header row. Make sure you exported the 'Projection V2' tab " +
    'from the Dispatch Plan Google Sheet (File → Download → Comma Separated Values).'
  );

  const header = rows[headerIdx].map(h => h.trim().toLowerCase());
  const colIdx = {
    channel: header.indexOf('channel'),
    product: header.indexOf('product'),
    variant: header.indexOf('variant'),
    color:   header.indexOf('color'),
    sku:     header.indexOf('sku'),
    mapping: header.indexOf('mapping'),
    total:   header.indexOf('total'),
  };

  if (colIdx.sku === -1) {
    throw new Error(
      'Cannot find a SKU column. Make sure you exported the correct tab — ' +
      "open the Dispatch Plan Google Sheet, go to the 'Projection V2' tab, " +
      'then File → Download → CSV.'
    );
  }
  if (colIdx.channel === -1 || colIdx.mapping === -1) {
    const missing = [colIdx.channel === -1 && 'Channel', colIdx.mapping === -1 && 'Mapping']
      .filter(Boolean).join(' and ');
    throw new Error(
      `Missing columns: ${missing}. This looks like the wrong tab was exported. ` +
      "Please export the 'Projection V2' tab from the Dispatch Plan spreadsheet " +
      '(File → Download → Comma Separated Values). Do NOT export Sheet39 or any ' +
      'other tab — only Projection V2 has the channel and ecom/retail mapping data.'
    );
  }
  if (colIdx.product === -1) {
    throw new Error('Required column missing: Product. Check that the exported tab is Projection V2.');
  }

  const dateCols = [];
  const startCol = colIdx.total >= 0 ? colIdx.total + 1 : Math.max(colIdx.mapping, colIdx.sku) + 1;
  for (let i = startCol; i < rows[headerIdx].length; i++) {
    const parsed = parseDateStr(rows[headerIdx][i]);
    if (parsed) dateCols.push({ col: i, date: parsed });
  }
  if (dateCols.length === 0) throw new Error(
    'No date columns found after the Total column. The Projection V2 tab should have ' +
    'one column per dispatch date (e.g. "5/15/2026" or "May 15, 2026") to the right of Total.'
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const seenMappings = new Set();
  const lines = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const sku     = row[colIdx.sku]?.trim();
    const product = row[colIdx.product]?.trim();
    const channel = row[colIdx.channel]?.trim();
    if (!sku || !product || !channel) continue;

    const rawMapping = (row[colIdx.mapping] ?? '').trim().toLowerCase();
    if (!seenMappings.has(rawMapping)) {
      seenMappings.add(rawMapping);
      console.log('[planner] mapping value seen:', JSON.stringify(rawMapping));
    }

    let mapping;
    if (rawMapping === '') {
      continue;
    } else if (rawMapping.includes('ecom') || rawMapping.includes('e-com') ||
               rawMapping === 'amazon' || rawMapping === 'online') {
      mapping = 'Ecom';
    } else if (rawMapping.includes('retail') || rawMapping.includes('gt') ||
               rawMapping.includes('mt') || rawMapping === 'offline') {
      mapping = 'Retail';
    } else {
      mapping = rawMapping.charAt(0).toUpperCase() + rawMapping.slice(1);
    }

    for (const { col, date } of dateCols) {
      if (date < today) continue;
      const qty = parseInt(row[col], 10);
      if (!qty || qty <= 0) continue;
      lines.push({
        sku,
        product,
        variant: row[colIdx.variant]?.trim() || null,
        color:   row[colIdx.color]?.trim()   || null,
        channel,
        mapping,
        dispatch_date: formatLocalISO(date),
        qty,
      });
    }
  }
  if (seenMappings.size > 0) {
    console.log('[planner] all mapping values:', Array.from(seenMappings));
    console.log('[planner] parsed', lines.length, 'demand rows from', rows.length - headerIdx - 1, 'data rows');
  }
  return lines;
}

const variantKey = (variant, colour) => `${variant ?? ''}·${colour ?? ''}`;

function resolveStatus(gap, leadStatus) {
  if (!gap || gap <= 0) return { label: 'Covered', color: '#22c55e' };
  switch (leadStatus) {
    case 'ok':         return { label: 'Plan Run',  color: '#eab308' };
    case 'warning':    return { label: 'Urgent',    color: '#f97316' };
    case 'critical':   return { label: 'Critical',  color: '#ef4444' };
    case 'impossible': return { label: 'Too Late',  color: '#991b1b' };
    default:           return { label: 'Plan Run',  color: '#eab308' };
  }
}

function StatusBadge({ gap, leadStatus }) {
  const { label, color } = resolveStatus(gap, leadStatus);
  const fg = (color === '#eab308' || color === '#22c55e') ? '#080808' : '#fff';
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      color: fg, background: color,
    }}>{label}</span>
  );
}

export default function PlannerPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [planData, setPlanData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState('timeline');
  const [viewMode, setViewMode] = useState('cascaded');
  const [expandedProducts, setExpandedProducts] = useState({});
  const [expandedRecs, setExpandedRecs] = useState({});
  const [runDraft, setRunDraft] = useState({});
  const [creating, setCreating] = useState({});
  const [batchConfig, setBatchConfig] = useState([]);
  const [editingBatch, setEditingBatch] = useState({});
  const fileRef = useRef();

  const loadPlan = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getDispatchPlan', {}, session);
      setPlanData(data);
    } catch (e) {
      showToast('Failed to load planner data: ' + e.message, 'error');
    }
    setLoading(false);
  }, [session, showToast]);

  const loadBatchConfig = useCallback(async () => {
    if (!session) return;
    try {
      const data = await garageFetch('getBatchConfig', {}, session);
      setBatchConfig(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast('Failed to load batch config: ' + e.message, 'error');
    }
  }, [session, showToast]);

  useEffect(() => { loadPlan(); }, [loadPlan]);
  useEffect(() => { if (view === 'config') loadBatchConfig(); }, [view, loadBatchConfig]);

  // Pre-populate runDraft and expand recommendations from worker data
  useEffect(() => {
    const recs = planData?.recommendations || [];
    const todayISO = new Date().toISOString().slice(0, 10);
    const draft = {};
    const recExpand = {};
    for (const rec of recs) {
      if (rec.all_covered) continue;
      const variants = {};
      for (const v of rec.variants) {
        if ((v.gap_ecomm || 0) + (v.gap_retail || 0) === 0) continue;
        variants[variantKey(v.variant, v.colour)] = {
          qty_ecomm:  v.suggested_qty_ecomm  ?? v.gap_ecomm  ?? 0,
          qty_retail: v.suggested_qty_retail ?? v.gap_retail ?? 0,
        };
      }
      if (Object.keys(variants).length === 0) continue;
      draft[rec.product] = {
        line_no: '',
        run_date: todayISO,
        variants,
      };
      recExpand[rec.product] = true;
    }
    setRunDraft(draft);
    setExpandedRecs(recExpand);
  }, [planData]);

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const text = await file.text();
      let rows;
      try { rows = parseDispatchCsv(text); }
      catch (parseErr) {
        showToast(`Parse error: ${parseErr.message}`, 'error');
        setUploading(false);
        e.target.value = '';
        return;
      }
      if (rows.length === 0) {
        showToast(
          'No demand rows found after parsing. Possible causes: ' +
          '(1) all quantities are zero, ' +
          '(2) all dispatch dates are in the past, or ' +
          '(3) the Mapping column values were not recognised — expected "Ecom" or "Retail". ' +
          'Open the browser console to see which mapping values were detected.',
          'error'
        );
        setUploading(false);
        e.target.value = '';
        return;
      }
      const monthLabel = rows[0]?.dispatch_date?.slice(0, 7) || null;
      const res = await workerFetch('uploadDispatchPlan',
        { month_label: monthLabel, rows }, session);
      if (res.ok) {
        showToast(`Plan uploaded — ${res.data.row_count} demand rows`, 'success');
        await loadPlan();
      } else {
        showToast('Upload failed: ' + (res.error || 'unknown'), 'error');
      }
    } catch (err) {
      showToast('Upload error: ' + err.message, 'error');
    }
    setUploading(false);
    e.target.value = '';
  }

  function setVariantQty(product, key, field, value) {
    setRunDraft(prev => {
      const cur = prev[product] || { line_no: '', run_date: new Date().toISOString().slice(0,10), variants: {} };
      const variants = { ...cur.variants };
      const v = { ...(variants[key] || { qty_ecomm: 0, qty_retail: 0 }) };
      const n = Math.max(0, parseInt(value, 10) || 0);
      v[field] = n;
      variants[key] = v;
      return { ...prev, [product]: { ...cur, variants } };
    });
  }

  function setDraftField(product, field, value) {
    setRunDraft(prev => {
      const cur = prev[product] || { line_no: '', run_date: new Date().toISOString().slice(0,10), variants: {} };
      return { ...prev, [product]: { ...cur, [field]: value } };
    });
  }

  async function handleCreateRun(product) {
    const draft = runDraft[product];
    if (!draft?.line_no) {
      showToast('Pick a production line first', 'error');
      return;
    }
    const variants = Object.entries(draft.variants || {})
      .map(([key, q]) => {
        const idx = key.indexOf('·');
        const variant = key.slice(0, idx);
        const colour  = key.slice(idx + 1);
        return {
          variant: variant || 'Common',
          colour:  colour === '' ? null : colour,
          qty_ecomm:  parseInt(q.qty_ecomm,  10) || 0,
          qty_retail: parseInt(q.qty_retail, 10) || 0,
        };
      })
      .filter(v => v.qty_ecomm + v.qty_retail > 0);

    if (variants.length === 0) {
      showToast('No variants have qty > 0', 'error');
      return;
    }

    setCreating(c => ({ ...c, [product]: true }));
    try {
      const res = await workerFetch('createPlannerRun', {
        product,
        run_date: draft.run_date,
        line_no:  draft.line_no,
        shift:    'Morning',
        upload_id: planData?.upload?.id || null,
        variants,
      }, session);

      if (res.ok) {
        showToast(`Run ${res.data.run_no} created — ${res.data.wo_count} work orders · ${res.data.total_qty} units`, 'success');
        await loadPlan();
      } else {
        showToast('Failed: ' + (res.error || 'unknown'), 'error');
      }
    } catch (err) {
      showToast('Create-run error: ' + err.message, 'error');
    }
    setCreating(c => ({ ...c, [product]: false }));
  }

  async function handleSaveBatch(product) {
    const size = parseInt(editingBatch[product], 10);
    if (!size || size < 1) { showToast('Invalid batch size', 'error'); return; }
    const res = await workerFetch('updateBatchConfig',
      { product, default_batch_size: size }, session);
    if (res.ok) {
      showToast(`Batch size updated for ${product}`, 'success');
      setEditingBatch(prev => { const n = { ...prev }; delete n[product]; return n; });
      await loadBatchConfig();
    } else {
      showToast('Update failed: ' + (res.error || 'unknown'), 'error');
    }
  }

  const activeDates = useMemo(() => {
    if (!planData) return [];
    return viewMode === 'cascaded' ? (planData.dates_cascaded || []) : (planData.dates_normal || []);
  }, [planData, viewMode]);

  const recommendations = planData?.recommendations || [];
  const recsWithGaps = recommendations.filter(r => !r.all_covered);

  if (loading) return <div style={{ padding: 32 }}><Spinner /></div>;

  const { upload } = planData || {};

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1180 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'Tomorrow, sans-serif', fontSize: 22, margin: 0, color: 'var(--text)' }}>
            Production Planner
          </h1>
          {upload ? (
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--t2)' }}>
              Plan: {upload.month_label || 'Uploaded'} &nbsp;·&nbsp;
              {upload.row_count} demand rows &nbsp;·&nbsp;
              Last updated {new Date(upload.uploaded_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          ) : (
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--t2)' }}>
              No plan uploaded yet
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
            onChange={handleFileChange} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{ padding: '8px 16px', background: 'var(--b1)', border: '1px solid var(--b2)',
              color: 'var(--text)', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            {uploading ? 'Uploading…' : '↑ Upload Plan CSV'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--b1)' }}>
        {[
          { key: 'timeline',        label: 'Dispatch Timeline' },
          { key: 'recommendations', label: `Recommended Runs (${recsWithGaps.length})` },
          { key: 'config',          label: 'Batch Sizes' },
        ].map(tab => (
          <button key={tab.key} onClick={() => setView(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer',
              background: view === tab.key ? '#F2CD1A' : 'transparent',
              color:      view === tab.key ? '#080808' : 'var(--t2)',
              borderRadius: '6px 6px 0 0', fontWeight: view === tab.key ? 600 : 400,
              fontSize: 13,
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {view === 'timeline' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--t2)' }}>View:</span>
            {[
              { key: 'cascaded', label: 'Cascaded Waterfall' },
              { key: 'normal',   label: 'Normal' },
            ].map(opt => (
              <button key={opt.key}
                onClick={() => setViewMode(opt.key)}
                style={{
                  padding: '6px 12px', fontSize: 12,
                  background: viewMode === opt.key ? '#F2CD1A' : 'var(--s1)',
                  color:      viewMode === opt.key ? '#080808' : 'var(--t2)',
                  border: '1px solid ' + (viewMode === opt.key ? '#F2CD1A' : 'var(--b2)'),
                  borderRadius: 4, cursor: 'pointer',
                  fontWeight: viewMode === opt.key ? 600 : 400,
                }}>
                {opt.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--t3)', marginLeft: 8 }}>
              {viewMode === 'cascaded'
                ? '— stock balance carries forward across dates per SKU'
                : '— each date compared against current static stock'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {activeDates.length === 0 && (
              <p style={{ color: 'var(--t2)', fontSize: 14 }}>No upcoming dispatch dates in plan.</p>
            )}
            {activeDates.map(dateEntry => {
              const dateLabel = dateEntry.days_away === 0 ? 'TODAY'
                              : dateEntry.days_away === 1 ? 'TOMORROW'
                              : `In ${dateEntry.days_away} days`;
              const hasGaps = dateEntry.total_gap > 0;
              return (
                <div key={dateEntry.date} style={{
                  border: `1px solid ${hasGaps ? '#DE2A2A44' : 'var(--b1)'}`,
                  borderRadius: 8, overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '12px 16px', background: 'var(--s1)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <span style={{ fontFamily: 'Tomorrow, sans-serif', fontSize: 15, color: 'var(--text)', fontWeight: 600 }}>
                        {new Date(dateEntry.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                      </span>
                      <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--t2)' }}>{dateLabel}</span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--t2)' }}>
                      {dateEntry.total_demand.toLocaleString()} units · {dateEntry.products.length} product{dateEntry.products.length === 1 ? '' : 's'}
                      {hasGaps && <span style={{ color: '#DE2A2A', fontWeight: 600, marginLeft: 8 }}>⚠ {dateEntry.total_gap} gap</span>}
                    </span>
                  </div>
                  <div>
                    {dateEntry.products.map(prod => {
                      const expandKey = `${prod.product}·${dateEntry.date}`;
                      const isOpen = !!expandedProducts[expandKey];
                      return (
                        <div key={prod.product} style={{ borderTop: '1px solid var(--b1)' }}>
                          <button
                            onClick={() => setExpandedProducts(prev => ({ ...prev, [expandKey]: !prev[expandKey] }))}
                            style={{
                              width: '100%', textAlign: 'left',
                              padding: '10px 16px', background: 'transparent', border: 'none',
                              cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              color: 'var(--text)', fontSize: 13,
                            }}>
                            <span>
                              <span style={{ display: 'inline-block', width: 14, color: 'var(--t2)' }}>
                                {isOpen ? '▼' : '▶'}
                              </span>
                              <strong>{prod.product}</strong>
                              <span style={{ marginLeft: 12, color: 'var(--t2)' }}>
                                Need <strong style={{ color: 'var(--text)' }}>{prod.total_need}</strong> ·
                                Gap <strong style={{ color: prod.total_gap > 0 ? '#DE2A2A' : 'var(--text)' }}>{prod.total_gap}</strong> ·
                                {prod.variants.length} variant{prod.variants.length === 1 ? '' : 's'}
                              </span>
                            </span>
                            <StatusBadge
                              gap={prod.total_gap}
                              leadStatus={prod.lead_status}
                            />
                          </button>
                          {isOpen && (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                                  {[
                                    'Variant', 'Mapping', 'Need', 'RTD', 'Allocated',
                                    viewMode === 'cascaded' ? 'Balance' : 'Available',
                                    'Gap', 'Status'
                                  ].map(h => (
                                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {prod.variants.map((v, vi) => (
                                  <tr key={vi} style={{
                                    borderTop: '1px solid var(--b1)',
                                    background: v.gap > 0 ? '#DE2A2A0A' : 'transparent',
                                  }}>
                                    <td style={{ padding: '6px 10px', color: 'var(--text)' }}>
                                      {v.variant} {v.colour}
                                    </td>
                                    <td style={{ padding: '6px 10px', color: 'var(--t2)' }}>{v.mapping}</td>
                                    <td style={{ padding: '6px 10px' }}>{v.need}</td>
                                    <td style={{ padding: '6px 10px' }}>{v.rtd}</td>
                                    <td style={{ padding: '6px 10px' }}>{v.allocated}</td>
                                    <td style={{ padding: '6px 10px' }}>
                                      {viewMode === 'cascaded'
                                        ? (v.balance_before ?? 0)
                                        : (v.rtd + v.allocated)}
                                    </td>
                                    <td style={{ padding: '6px 10px',
                                      color: v.gap > 0 ? '#DE2A2A' : 'inherit',
                                      fontWeight: v.gap > 0 ? 600 : 400 }}>
                                      {v.gap > 0 ? v.gap : '—'}
                                    </td>
                                    <td style={{ padding: '6px 10px' }}>
                                      <StatusBadge gap={v.gap} leadStatus={v.lead_status} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'recommendations' && (
        <div>
          {recsWithGaps.length === 0 && (
            <p style={{ color: '#22c55e', fontSize: 14 }}>
              ✓ All upcoming dispatch dates are covered. No production runs needed.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {recsWithGaps.map(rec => {
              const isOpen = !!expandedRecs[rec.product];
              const draft = runDraft[rec.product] || { line_no: '', run_date: '', variants: {} };
              const totalQty = Object.values(draft.variants || {}).reduce(
                (s, v) => s + (parseInt(v.qty_ecomm,10) || 0) + (parseInt(v.qty_retail,10) || 0), 0);
              const batchSize = rec.batch_size || 400;
              const histLabel = rec.history_suggested_qty && rec.history_suggested_qty !== batchSize
                ? ` · Historical avg: ${rec.history_suggested_qty} u/run` : '';
              const counterColor = totalQty === 0          ? 'var(--t2)'
                                  : totalQty < batchSize    ? 'var(--t2)'
                                  : totalQty === batchSize  ? '#22c55e'
                                  : '#F2CD1A';
              const variantsWithGaps = rec.variants.filter(v => (v.gap_ecomm || 0) + (v.gap_retail || 0) > 0);
              const lineSelected = draft.line_no === 'L1' || draft.line_no === 'L2' || draft.line_no === 'L3';
              const createDisabled = !lineSelected || totalQty === 0 || !!creating[rec.product];

              return (
                <div key={rec.product} style={{
                  border: '1px solid var(--b1)', borderRadius: 8, overflow: 'hidden',
                }}>
                  <button
                    onClick={() => setExpandedRecs(prev => ({ ...prev, [rec.product]: !prev[rec.product] }))}
                    style={{
                      width: '100%', textAlign: 'left',
                      padding: '12px 18px', background: 'var(--s1)', border: 'none',
                      cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      color: 'var(--text)',
                    }}>
                    <span>
                      <span style={{ display: 'inline-block', width: 16, color: 'var(--t2)' }}>
                        {isOpen ? '▼' : '▶'}
                      </span>
                      <strong style={{ fontFamily: 'Tomorrow, sans-serif', fontSize: 15 }}>{rec.product}</strong>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--t2)' }}>
                      Total gap: <strong style={{ color: '#DE2A2A' }}>{rec.total_gap}u</strong> ·
                      Batch: <strong style={{ color: 'var(--text)' }}>{batchSize}u</strong> ·
                      {variantsWithGaps.length} variant{variantsWithGaps.length === 1 ? '' : 's'}
                    </span>
                  </button>

                  {isOpen && (
                    <div style={{ padding: 18 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                            {['Variant', 'Colour', 'Gap Ecom', 'Gap Retail', 'Qty Ecom', 'Qty Retail'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {variantsWithGaps.map((v, vi) => {
                            const k = variantKey(v.variant, v.colour);
                            const cur = draft.variants?.[k] || { qty_ecomm: 0, qty_retail: 0 };
                            return (
                              <tr key={vi} style={{ borderTop: '1px solid var(--b1)' }}>
                                <td style={{ padding: '6px 10px', color: 'var(--text)' }}>{v.variant}</td>
                                <td style={{ padding: '6px 10px', color: 'var(--t2)' }}>{v.colour}</td>
                                <td style={{ padding: '6px 10px', color: v.gap_ecomm > 0 ? '#DE2A2A' : 'var(--t3)' }}>
                                  {v.gap_ecomm || 0}
                                </td>
                                <td style={{ padding: '6px 10px', color: v.gap_retail > 0 ? '#DE2A2A' : 'var(--t3)' }}>
                                  {v.gap_retail || 0}
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  <input type="number" min={0}
                                    value={cur.qty_ecomm}
                                    onChange={e => setVariantQty(rec.product, k, 'qty_ecomm', e.target.value)}
                                    style={{ width: 70, padding: '4px 6px', background: 'var(--s1)',
                                      border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 3, fontSize: 12 }} />
                                </td>
                                <td style={{ padding: '6px 10px' }}>
                                  <input type="number" min={0}
                                    value={cur.qty_retail}
                                    onChange={e => setVariantQty(rec.product, k, 'qty_retail', e.target.value)}
                                    style={{ width: 70, padding: '4px 6px', background: 'var(--s1)',
                                      border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 3, fontSize: 12 }} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>

                      <div style={{ marginTop: 12, fontSize: 12 }}>
                        <span style={{ color: counterColor, fontWeight: 600 }}>
                          Total qty: {totalQty} / {batchSize} batch size
                        </span>
                        <span style={{ color: 'var(--t2)' }}>{histLabel}</span>
                      </div>

                      <div style={{ marginTop: 14, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: 'var(--t2)', marginRight: 6 }}>Line:</span>
                          {['L1', 'L2', 'L3'].map(L => (
                            <button key={L}
                              onClick={() => setDraftField(rec.product, 'line_no', L)}
                              style={{
                                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                                background: draft.line_no === L ? '#F2CD1A' : 'var(--s1)',
                                color:      draft.line_no === L ? '#080808' : 'var(--t2)',
                                border: '1px solid ' + (draft.line_no === L ? '#F2CD1A' : 'var(--b2)'),
                                borderRadius: 4, cursor: 'pointer',
                              }}>
                              {L}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12, color: 'var(--t2)' }}>Date:</span>
                          <input type="date"
                            value={draft.run_date}
                            min={new Date().toISOString().slice(0,10)}
                            onChange={e => setDraftField(rec.product, 'run_date', e.target.value)}
                            style={{ padding: '5px 8px', background: 'var(--s1)', border: '1px solid var(--b2)',
                              color: 'var(--text)', borderRadius: 4, fontSize: 12 }} />
                        </div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <button
                          onClick={() => handleCreateRun(rec.product)}
                          disabled={createDisabled}
                          style={{
                            padding: '8px 18px', fontSize: 13, fontWeight: 600,
                            background: createDisabled ? 'var(--s1)' : '#F2CD1A',
                            color:      createDisabled ? 'var(--t3)' : '#080808',
                            border: 'none', borderRadius: 6,
                            cursor: createDisabled ? 'not-allowed' : 'pointer',
                          }}>
                          {creating[rec.product] ? 'Creating…' : 'Create Run'}
                        </button>
                        {!lineSelected && (
                          <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--t3)' }}>
                            Pick a line first
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'config' && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16 }}>
            Set the default production run size per product. Used to calculate
            how many runs are needed to cover a dispatch gap.
            &quot;History&quot; shows the most common run size from past production runs.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                {['Product', 'Default Batch Size', 'From History', ''].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batchConfig.map(row => (
                <tr key={row.product} style={{ borderTop: '1px solid var(--b1)' }}>
                  <td style={{ padding: '10px 14px', color: 'var(--text)' }}>{row.product}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {editingBatch[row.product] !== undefined ? (
                      <input type="number" min={1} max={10000}
                        value={editingBatch[row.product]}
                        onChange={e => setEditingBatch(prev => ({ ...prev, [row.product]: e.target.value }))}
                        style={{ width: 80, padding: '4px 8px', background: 'var(--s1)',
                          border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 4 }} />
                    ) : (
                      <strong>{row.default_batch_size}</strong>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--t2)' }}>
                    {row.history_suggested_qty || '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {editingBatch[row.product] !== undefined ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => handleSaveBatch(row.product)}
                          style={{ padding: '4px 12px', background: '#F2CD1A', color: '#080808',
                            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                          Save
                        </button>
                        <button onClick={() => setEditingBatch(prev => { const n = { ...prev }; delete n[row.product]; return n; })}
                          style={{ padding: '4px 12px', background: 'transparent', color: 'var(--t2)',
                            border: '1px solid var(--b2)', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingBatch(prev => ({ ...prev, [row.product]: row.default_batch_size }))}
                        style={{ padding: '4px 12px', background: 'transparent', color: 'var(--t2)',
                          border: '1px solid var(--b2)', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
