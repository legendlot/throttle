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
  // V3 Recommended Runs state
  const [expandedDates, setExpandedDates] = useState({});            // { '<dispatch_date>': true }
  const [expandedDateProducts, setExpandedDateProducts] = useState({}); // { '<dispatch_date>·<product>': true }
  const [scheduling, setScheduling] = useState(null);                // open scheduling panel state
  const [scheduleTarget, setScheduleTarget] = useState({ cartId: 'new', line_no: 'L1', production_date: '' });
  const [carts, setCarts] = useState([]);                            // [{ id, production_date, lines: [...] }]
  const [createStatus, setCreateStatus] = useState({});              // { [cartId]: { [lineId]: 'creating'|'done'|'error' } }
  const [creatingCart, setCreatingCart] = useState({});              // { [cartId]: true } while loop running
  const [batchConfig, setBatchConfig] = useState([]);
  const [editingBatch, setEditingBatch] = useState({});
  const fileRef = useRef();

  const todayLocalISO = formatLocalISO(new Date());
  const makeId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

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

  // Auto-expand all gap dates when plan loads
  useEffect(() => {
    const recs = planData?.recommendations || [];
    const expand = {};
    for (const r of recs) expand[r.dispatch_date] = true;
    setExpandedDates(expand);
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

  function openScheduler(dispatchDate, product) {
    const entry = (planData?.recommendations || []).find(r => r.dispatch_date === dispatchDate);
    if (!entry) return;
    const prodEntry = entry.products.find(p => p.product === product);
    if (!prodEntry) return;
    const suggested = entry.suggested_run_date || todayLocalISO;
    setScheduling({
      dispatchDate,
      product,
      suggestedRunDate: suggested,
      variants: prodEntry.variants.map(v => ({
        variant:    v.variant,
        colour:     v.colour,
        gap_ecomm:  v.gap_ecomm  || 0,
        gap_retail: v.gap_retail || 0,
        qty_ecomm:  v.gap_ecomm  || 0,
        qty_retail: v.gap_retail || 0,
      })),
    });
    setScheduleTarget({ cartId: 'new', line_no: 'L1', production_date: suggested });
  }

  function setSchedulingVariantQty(idx, field, value) {
    setScheduling(prev => {
      if (!prev) return prev;
      const variants = prev.variants.slice();
      variants[idx] = { ...variants[idx], [field]: Math.max(0, parseInt(value, 10) || 0) };
      return { ...prev, variants };
    });
  }

  function addToSchedule() {
    if (!scheduling) return;
    const activeVariants = scheduling.variants.filter(v => v.qty_ecomm + v.qty_retail > 0);
    if (activeVariants.length === 0) {
      showToast('No variants with qty > 0', 'error');
      return;
    }
    if (!['L1','L2','L3'].includes(scheduleTarget.line_no)) {
      showToast('Pick a line first', 'error');
      return;
    }
    const newLine = {
      id:      makeId(),
      line_no: scheduleTarget.line_no,
      product: scheduling.product,
      variants: activeVariants.map(v => ({
        variant:    v.variant,
        colour:     v.colour,
        qty_ecomm:  v.qty_ecomm,
        qty_retail: v.qty_retail,
      })),
    };
    if (scheduleTarget.cartId === 'new') {
      const productionDate = scheduleTarget.production_date || scheduling.suggestedRunDate || todayLocalISO;
      const newCart = { id: makeId(), production_date: productionDate, lines: [newLine] };
      setCarts(prev => [...prev, newCart]);
    } else {
      const targetCart = carts.find(c => c.id === scheduleTarget.cartId);
      const lineConflict = targetCart && targetCart.lines.some(l => l.line_no === scheduleTarget.line_no);
      if (lineConflict) {
        if (!window.confirm(`${scheduleTarget.line_no} already has a line in that cart. Add this one anyway?`)) return;
      }
      setCarts(prev => prev.map(c =>
        c.id === scheduleTarget.cartId ? { ...c, lines: [...c.lines, newLine] } : c
      ));
    }
    setScheduling(null);
  }

  function deleteLine(cartId, lineId) {
    const cart = carts.find(c => c.id === cartId);
    const line = cart?.lines.find(l => l.id === lineId);
    const status = createStatus[cartId]?.[lineId];
    if (status === 'done') {
      if (!window.confirm(`Line ${line?.line_no} (${line?.product}) was already created as a run. Remove from cart anyway?`)) return;
    }
    setCarts(prev => prev.map(c =>
      c.id === cartId ? { ...c, lines: c.lines.filter(l => l.id !== lineId) } : c
    ));
    setCreateStatus(prev => {
      const cs = { ...prev };
      if (cs[cartId]) {
        cs[cartId] = { ...cs[cartId] };
        delete cs[cartId][lineId];
      }
      return cs;
    });
  }

  function deleteCart(cartId) {
    const cart = carts.find(c => c.id === cartId);
    if (cart?.lines.length > 0 && !window.confirm(`Delete this cart with ${cart.lines.length} line(s)?`)) return;
    setCarts(prev => prev.filter(c => c.id !== cartId));
    setCreateStatus(prev => { const n = { ...prev }; delete n[cartId]; return n; });
    setCreatingCart(prev => { const n = { ...prev }; delete n[cartId]; return n; });
  }

  function setCartDate(cartId, date) {
    setCarts(prev => prev.map(c => c.id === cartId ? { ...c, production_date: date } : c));
  }

  function createEmptyCart() {
    const newCart = { id: makeId(), production_date: '', lines: [] };
    setCarts(prev => [...prev, newCart]);
  }

  async function handleCreateAll(cart) {
    if (!cart.production_date) { showToast('Set a production date for this cart first', 'error'); return; }
    const linesToCreate = cart.lines.filter(line =>
      line.variants.some(v => (v.qty_ecomm || 0) + (v.qty_retail || 0) > 0)
      && (createStatus[cart.id]?.[line.id] !== 'done')
    );
    if (linesToCreate.length === 0) { showToast('Nothing to create in this cart', 'info'); return; }

    setCreatingCart(prev => ({ ...prev, [cart.id]: true }));

    let successCount = 0;
    let failCount = 0;
    for (const line of linesToCreate) {
      setCreateStatus(prev => ({
        ...prev,
        [cart.id]: { ...(prev[cart.id] || {}), [line.id]: 'creating' },
      }));

      const payload = {
        product:   line.product,
        run_date:  cart.production_date,
        line_no:   line.line_no,
        shift:     'Morning',
        upload_id: planData?.upload?.id || null,
        variants:  line.variants.filter(v => (v.qty_ecomm || 0) + (v.qty_retail || 0) > 0),
      };

      let res;
      let collision = false;
      try {
        res = await workerFetch('createPlannerRun', payload, session);
      } catch (err) {
        const msg = err?.message || '';
        if (msg.startsWith('Open run ')) collision = true;
        res = { ok: false, error: msg };
      }

      if (collision) {
        const wantForce = window.confirm(
          `${line.product}: ${res.error}\n\nClick OK to create another run anyway, Cancel to skip.`
        );
        if (wantForce) {
          try {
            res = await workerFetch('createPlannerRun', { ...payload, force: true }, session);
          } catch (err) {
            res = { ok: false, error: err?.message || 'unknown' };
          }
        } else {
          setCreateStatus(prev => ({
            ...prev,
            [cart.id]: { ...(prev[cart.id] || {}), [line.id]: 'skipped' },
          }));
          continue;
        }
      }

      if (res?.ok) {
        successCount++;
        setCreateStatus(prev => ({
          ...prev,
          [cart.id]: { ...(prev[cart.id] || {}), [line.id]: 'done', run_no_by_line: { ...(prev[cart.id]?.run_no_by_line || {}), [line.id]: res.data.run_no } },
        }));
      } else {
        failCount++;
        setCreateStatus(prev => ({
          ...prev,
          [cart.id]: { ...(prev[cart.id] || {}), [line.id]: 'error', error_by_line: { ...(prev[cart.id]?.error_by_line || {}), [line.id]: res?.error || 'unknown' } },
        }));
        showToast(`Failed: ${line.product} on ${line.line_no} — ${res?.error || 'unknown'}`, 'error');
      }
    }

    setCreatingCart(prev => { const n = { ...prev }; delete n[cart.id]; return n; });
    if (successCount > 0) {
      showToast(`Created ${successCount} run${successCount === 1 ? '' : 's'}${failCount > 0 ? ` (${failCount} failed)` : ''}`,
        failCount === 0 ? 'success' : 'info');
      await loadPlan();
    }
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
  const recDateCount = recommendations.length;
  const sortedCarts = [...carts].sort((a, b) => {
    if (!a.production_date && !b.production_date) return 0;
    if (!a.production_date) return 1;
    if (!b.production_date) return -1;
    return a.production_date.localeCompare(b.production_date);
  });

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
          { key: 'recommendations', label: `Recommended Runs (${recDateCount} date${recDateCount === 1 ? '' : 's'})` },
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
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 18 }}>
          {/* LEFT: Dispatch Needs */}
          <div style={{ minWidth: 0 }}>
            {recommendations.length === 0 ? (
              <p style={{ color: '#22c55e', fontSize: 14 }}>
                ✓ All upcoming dispatch dates are covered. No production runs needed.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {recommendations.map(rec => {
                  const dateExpanded = expandedDates[rec.dispatch_date] !== false;
                  const dateLabel = new Date(rec.dispatch_date + 'T00:00:00').toLocaleDateString('en-IN',
                    { weekday: 'short', day: 'numeric', month: 'short' });
                  const daysLabel = rec.days_until === 0 ? 'TODAY'
                                  : rec.days_until === 1 ? 'TOMORROW'
                                  : `${rec.days_until} days away`;
                  const suggestedLabel = rec.too_late
                    ? null
                    : new Date(rec.suggested_run_date + 'T00:00:00').toLocaleDateString('en-IN',
                        { weekday: 'short', day: 'numeric', month: 'short' });

                  return (
                    <div key={rec.dispatch_date} style={{
                      border: '1px solid var(--b1)', borderRadius: 8, overflow: 'hidden',
                    }}>
                      <button
                        onClick={() => setExpandedDates(prev => ({ ...prev, [rec.dispatch_date]: !dateExpanded }))}
                        style={{
                          width: '100%', textAlign: 'left',
                          padding: '12px 16px', background: 'var(--s1)', border: 'none',
                          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          color: 'var(--text)',
                        }}>
                        <span>
                          <span style={{ display: 'inline-block', width: 16, color: 'var(--t2)' }}>
                            {dateExpanded ? '▼' : '▶'}
                          </span>
                          <strong style={{ fontFamily: 'Tomorrow, sans-serif', fontSize: 15 }}>{dateLabel}</strong>
                          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--t2)' }}>{daysLabel}</span>
                        </span>
                        <StatusBadge gap={1} leadStatus={rec.lead_status} />
                      </button>

                      {dateExpanded && (
                        <div style={{ padding: '12px 16px 16px' }}>
                          <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
                            {rec.too_late
                              ? <span style={{ color: '#DE2A2A', fontWeight: 600 }}>⚠ Too late to produce in time</span>
                              : <span>Suggested production date: <strong style={{ color: 'var(--text)' }}>{suggestedLabel}</strong></span>}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {rec.products.map(prod => {
                              const prodKey = `${rec.dispatch_date}·${prod.product}`;
                              const isProdOpen = !!expandedDateProducts[prodKey];
                              const isPanelOpen = scheduling
                                && scheduling.dispatchDate === rec.dispatch_date
                                && scheduling.product === prod.product;
                              return (
                                <div key={prod.product} style={{ borderTop: '1px solid var(--b1)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 4px' }}>
                                    <button
                                      onClick={() => setExpandedDateProducts(prev => ({ ...prev, [prodKey]: !isProdOpen }))}
                                      style={{
                                        background: 'transparent', border: 'none', cursor: 'pointer',
                                        color: 'var(--text)', fontSize: 13, padding: 0, textAlign: 'left',
                                      }}>
                                      <span style={{ color: 'var(--t2)', marginRight: 4 }}>{isProdOpen ? '▼' : '▶'}</span>
                                      <strong>{prod.product}</strong>
                                      <span style={{ marginLeft: 10, color: 'var(--t2)', fontSize: 12 }}>
                                        {prod.gap_ecomm > 0 && <span>{prod.gap_ecomm} ecomm</span>}
                                        {prod.gap_ecomm > 0 && prod.gap_retail > 0 && <span> · </span>}
                                        {prod.gap_retail > 0 && <span>{prod.gap_retail} retail</span>}
                                      </span>
                                    </button>
                                    <button
                                      onClick={() => isPanelOpen ? setScheduling(null) : openScheduler(rec.dispatch_date, prod.product)}
                                      disabled={rec.too_late}
                                      title={rec.too_late ? 'Too late to produce in time' : ''}
                                      style={{
                                        padding: '4px 10px', fontSize: 11, fontWeight: 600,
                                        background: rec.too_late ? 'var(--s1)' : (isPanelOpen ? 'var(--s2)' : '#F2CD1A'),
                                        color:      rec.too_late ? 'var(--t3)' : (isPanelOpen ? 'var(--t2)' : '#080808'),
                                        border: '1px solid ' + (isPanelOpen ? 'var(--b2)' : 'transparent'),
                                        borderRadius: 4,
                                        cursor: rec.too_late ? 'not-allowed' : 'pointer',
                                      }}>
                                      {rec.too_late ? '(Too late)' : isPanelOpen ? '× Cancel' : '+ Schedule'}
                                    </button>
                                  </div>

                                  {isProdOpen && (
                                    <div style={{ fontSize: 12, color: 'var(--t2)', paddingLeft: 22, paddingBottom: 6 }}>
                                      {prod.variants.map((v, vi) => (
                                        <div key={vi} style={{ display: 'flex', gap: 12, padding: '2px 0' }}>
                                          <span style={{ minWidth: 140, color: 'var(--text)' }}>
                                            {v.variant} {v.colour && <span style={{ color: 'var(--t2)' }}>{v.colour}</span>}
                                          </span>
                                          {v.gap_ecomm  > 0 && <span>{v.gap_ecomm} ecomm</span>}
                                          {v.gap_retail > 0 && <span>{v.gap_retail} retail</span>}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {isPanelOpen && (
                                    <div style={{
                                      margin: '6px 4px 10px',
                                      padding: 14,
                                      background: 'var(--s1)',
                                      border: '1px solid var(--b2)',
                                      borderRadius: 6,
                                    }}>
                                      <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 10 }}>
                                        Schedule <strong style={{ color: 'var(--text)' }}>{scheduling.product}</strong>
                                        &nbsp;→&nbsp;{dateLabel} dispatch
                                      </div>
                                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 10 }}>
                                        <thead>
                                          <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                                            {['Variant', 'Colour', 'Qty Ecomm', 'Qty Retail'].map(h => (
                                              <th key={h} style={{ padding: '5px 8px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {scheduling.variants.map((v, vi) => (
                                            <tr key={vi} style={{ borderTop: '1px solid var(--b1)' }}>
                                              <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{v.variant}</td>
                                              <td style={{ padding: '5px 8px', color: 'var(--t2)' }}>{v.colour}</td>
                                              <td style={{ padding: '5px 8px' }}>
                                                <input type="number" min={0} value={v.qty_ecomm}
                                                  onChange={e => setSchedulingVariantQty(vi, 'qty_ecomm', e.target.value)}
                                                  style={{ width: 70, padding: '3px 6px', background: 'var(--s2)',
                                                    border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 3, fontSize: 12 }} />
                                                <span style={{ marginLeft: 6, color: 'var(--t3)', fontSize: 11 }}>
                                                  /{v.gap_ecomm}
                                                </span>
                                              </td>
                                              <td style={{ padding: '5px 8px' }}>
                                                <input type="number" min={0} value={v.qty_retail}
                                                  onChange={e => setSchedulingVariantQty(vi, 'qty_retail', e.target.value)}
                                                  style={{ width: 70, padding: '3px 6px', background: 'var(--s2)',
                                                    border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 3, fontSize: 12 }} />
                                                <span style={{ marginLeft: 6, color: 'var(--t3)', fontSize: 11 }}>
                                                  /{v.gap_retail}
                                                </span>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>

                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                          <span style={{ color: 'var(--t2)' }}>Add to:</span>
                                          <label style={{ cursor: 'pointer', color: 'var(--text)' }}>
                                            <input type="radio" name="cartTarget"
                                              checked={scheduleTarget.cartId === 'new'}
                                              onChange={() => setScheduleTarget(prev => ({
                                                ...prev, cartId: 'new',
                                                production_date: prev.production_date || scheduling.suggestedRunDate || todayLocalISO,
                                              }))} />
                                            &nbsp;New day
                                          </label>
                                          {sortedCarts.map(c => (
                                            <label key={c.id} style={{ cursor: 'pointer', color: 'var(--text)' }}>
                                              <input type="radio" name="cartTarget"
                                                checked={scheduleTarget.cartId === c.id}
                                                onChange={() => setScheduleTarget(prev => ({ ...prev, cartId: c.id }))} />
                                              &nbsp;{c.production_date
                                                ? new Date(c.production_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                                                : 'Unscheduled'}
                                              <span style={{ color: 'var(--t3)' }}> ({c.lines.length})</span>
                                            </label>
                                          ))}
                                        </div>

                                        {scheduleTarget.cartId === 'new' && (
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ color: 'var(--t2)' }}>Production date:</span>
                                            <input type="date"
                                              value={scheduleTarget.production_date}
                                              min={todayLocalISO}
                                              onChange={e => setScheduleTarget(prev => ({ ...prev, production_date: e.target.value }))}
                                              style={{ padding: '4px 8px', background: 'var(--s2)', border: '1px solid var(--b2)',
                                                color: 'var(--text)', borderRadius: 3, fontSize: 12 }} />
                                          </div>
                                        )}

                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ color: 'var(--t2)', marginRight: 4 }}>Line:</span>
                                          {['L1','L2','L3'].map(L => (
                                            <button key={L}
                                              onClick={() => setScheduleTarget(prev => ({ ...prev, line_no: L }))}
                                              style={{
                                                padding: '5px 12px', fontSize: 11, fontWeight: 600,
                                                background: scheduleTarget.line_no === L ? '#F2CD1A' : 'var(--s2)',
                                                color:      scheduleTarget.line_no === L ? '#080808' : 'var(--t2)',
                                                border: '1px solid ' + (scheduleTarget.line_no === L ? '#F2CD1A' : 'var(--b2)'),
                                                borderRadius: 3, cursor: 'pointer',
                                              }}>{L}</button>
                                          ))}
                                        </div>
                                      </div>

                                      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                                        <button onClick={() => setScheduling(null)}
                                          style={{ padding: '6px 12px', fontSize: 12, background: 'transparent',
                                            color: 'var(--t2)', border: '1px solid var(--b2)', borderRadius: 4, cursor: 'pointer' }}>
                                          Cancel
                                        </button>
                                        <button onClick={addToSchedule}
                                          style={{ padding: '6px 14px', fontSize: 12, fontWeight: 600,
                                            background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                                          Add to Schedule
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* RIGHT: Production Schedule */}
          <div style={{ position: 'sticky', top: 16, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--t2)' }}>
                PRODUCTION SCHEDULE
              </span>
              <button onClick={createEmptyCart}
                style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: 'var(--s1)',
                  border: '1px solid var(--b2)', color: 'var(--text)', borderRadius: 3, cursor: 'pointer' }}>
                + New Day
              </button>
            </div>

            {sortedCarts.length === 0 && (
              <p style={{ color: 'var(--t3)', fontSize: 12 }}>
                No production days scheduled yet. Click &quot;+ Schedule&quot; on a product
                under Dispatch Needs to start a cart.
              </p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sortedCarts.map(cart => {
                const cartStatus = createStatus[cart.id] || {};
                const cartCreating = !!creatingCart[cart.id];
                const allDone = cart.lines.length > 0 && cart.lines.every(l => cartStatus[l.id] === 'done');

                return (
                  <div key={cart.id} style={{
                    border: '1px solid var(--b1)', borderRadius: 6, padding: 10,
                    background: 'var(--s1)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--t2)' }}>📅</span>
                        <input type="date"
                          value={cart.production_date}
                          min={todayLocalISO}
                          onChange={e => setCartDate(cart.id, e.target.value)}
                          style={{ padding: '3px 6px', background: 'var(--s2)', border: '1px solid var(--b2)',
                            color: 'var(--text)', borderRadius: 3, fontSize: 12, width: 130 }} />
                      </div>
                      <button onClick={() => deleteCart(cart.id)}
                        title="Delete cart"
                        style={{ padding: '2px 8px', fontSize: 11, background: 'transparent',
                          color: 'var(--t3)', border: '1px solid var(--b2)', borderRadius: 3, cursor: 'pointer' }}>
                        ✕
                      </button>
                    </div>

                    {['L1','L2','L3'].map(L => {
                      const line = cart.lines.find(l => l.line_no === L);
                      if (!line) {
                        return (
                          <div key={L} style={{
                            padding: '6px 4px', fontSize: 11, color: 'var(--t3)',
                            borderTop: '1px dashed var(--b1)',
                          }}>
                            <strong style={{ marginRight: 6 }}>{L}</strong>
                            <span style={{ fontStyle: 'italic' }}>(empty)</span>
                          </div>
                        );
                      }
                      const status = cartStatus[line.id];
                      const runNo = cartStatus.run_no_by_line?.[line.id];
                      return (
                        <div key={line.id} style={{
                          padding: '6px 4px', borderTop: '1px solid var(--b1)',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: 'var(--text)' }}>
                              <strong style={{ marginRight: 6 }}>{L}</strong>
                              {line.product}
                              {status === 'creating' && <span style={{ marginLeft: 6, color: 'var(--t3)' }}>…</span>}
                              {status === 'done' && <span style={{ marginLeft: 6, color: '#22c55e' }}>✓ {runNo || ''}</span>}
                              {status === 'error' && <span style={{ marginLeft: 6, color: '#DE2A2A' }}>✗</span>}
                              {status === 'skipped' && <span style={{ marginLeft: 6, color: 'var(--t3)' }}>(skipped)</span>}
                            </span>
                            <button onClick={() => deleteLine(cart.id, line.id)}
                              title="Remove line"
                              style={{ padding: '1px 6px', fontSize: 10, background: 'transparent',
                                color: 'var(--t3)', border: '1px solid var(--b2)', borderRadius: 3, cursor: 'pointer' }}>
                              ✕
                            </button>
                          </div>
                          <div style={{ marginTop: 3, paddingLeft: 16, fontSize: 11, color: 'var(--t2)' }}>
                            {line.variants.map((v, vi) => {
                              const total = (v.qty_ecomm || 0) + (v.qty_retail || 0);
                              return (
                                <div key={vi}>
                                  {v.variant} {v.colour}: {total}
                                  {v.qty_ecomm > 0 && <span> ({v.qty_ecomm}e</span>}
                                  {v.qty_ecomm > 0 && v.qty_retail > 0 && <span>+</span>}
                                  {v.qty_retail > 0 && <span>{v.qty_retail}r</span>}
                                  {(v.qty_ecomm > 0 || v.qty_retail > 0) && <span>)</span>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    <div style={{ marginTop: 10 }}>
                      {allDone ? (
                        <button disabled
                          style={{ width: '100%', padding: '6px 10px', fontSize: 12, fontWeight: 600,
                            background: 'var(--s2)', color: '#22c55e',
                            border: '1px solid #22c55e44', borderRadius: 4, cursor: 'default' }}>
                          ✓ All Created
                        </button>
                      ) : (
                        <button
                          onClick={() => handleCreateAll(cart)}
                          disabled={!cart.production_date || cart.lines.length === 0 || cartCreating}
                          style={{
                            width: '100%', padding: '6px 10px', fontSize: 12, fontWeight: 600,
                            background: (!cart.production_date || cart.lines.length === 0 || cartCreating)
                              ? 'var(--s2)' : '#F2CD1A',
                            color: (!cart.production_date || cart.lines.length === 0 || cartCreating)
                              ? 'var(--t3)' : '#080808',
                            border: 'none', borderRadius: 4,
                            cursor: (!cart.production_date || cart.lines.length === 0 || cartCreating)
                              ? 'not-allowed' : 'pointer',
                          }}>
                          {cartCreating
                            ? 'Creating…'
                            : cart.production_date
                              ? `Create All for ${new Date(cart.production_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
                              : 'Set date to create'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
