'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
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

export default function PlannerPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const [planData, setPlanData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState('timeline');
  const [schedDates, setSchedDates] = useState({});
  const [creatingRun, setCreatingRun] = useState(null);
  const [batchConfig, setBatchConfig] = useState([]);
  const [editingBatch, setEditingBatch] = useState({});
  const fileRef = useRef();

  const loadPlan = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getDispatchPlan', {}, session);
      setPlanData(data);
      const defaults = {};
      (data?.recommendations || []).forEach((rec, i) => {
        defaults[i] = rec.deadline_date;
      });
      setSchedDates(defaults);
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

  async function handleCreateRun(rec, schedDate) {
    const key = rec.sku + rec.mapping;
    setCreatingRun(key);
    const res = await workerFetch('createRunFromPlan', {
      product: rec.product,
      variant: rec.variant,
      color:   rec.color,
      mapping: rec.mapping,
      qty:     rec.batch_size * rec.runs_needed,
      scheduled_date: schedDate,
      sku:     rec.sku,
    }, session);
    if (res.ok) {
      showToast(`Run ${res.data.run_no} created — ${rec.product} ${rec.variant || ''} · ${res.data.qty} units`, 'success');
    } else {
      showToast('Failed to create run: ' + (res.error || 'unknown'), 'error');
    }
    setCreatingRun(null);
    return res.ok;
  }

  async function handleCreateAll() {
    const recs = planData?.recommendations || [];
    let successCount = 0;
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const date = schedDates[i] || rec.deadline_date;
      const okFlag = await handleCreateRun(rec, date);
      if (okFlag) successCount++;
    }
    showToast(`Created ${successCount} of ${recs.length} runs`, successCount === recs.length ? 'success' : 'info');
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

  if (loading) return <div style={{ padding: 32 }}><Spinner /></div>;

  const { upload, dates = [], recommendations = [] } = planData || {};

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>

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
          { key: 'recommendations', label: `Recommended Runs (${recommendations.length})` },
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {dates.length === 0 && (
            <p style={{ color: 'var(--t2)', fontSize: 14 }}>No upcoming dispatch dates in plan.</p>
          )}
          {dates.map(dateEntry => {
            const hasGaps = dateEntry.skus.some(s => s.gap > 0);
            const label = dateEntry.days_away === 0 ? 'TODAY'
                        : dateEntry.days_away === 1 ? 'TOMORROW'
                        : `In ${dateEntry.days_away} days`;
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
                    <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--t2)' }}>{label}</span>
                  </div>
                  <span style={{ fontSize: 13, color: 'var(--t2)' }}>
                    {dateEntry.total_demand.toLocaleString()} units · {dateEntry.skus.length} SKUs
                    {hasGaps && <span style={{ color: '#DE2A2A', fontWeight: 600, marginLeft: 8 }}>⚠ Gaps</span>}
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--s2)', color: 'var(--t2)' }}>
                      {['SKU', 'Mapping', 'Need', 'RTD', 'Allocated', 'Gap', 'Runs', 'Status'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dateEntry.skus.map((s, si) => (
                      <tr key={si} style={{ borderTop: '1px solid var(--b1)',
                        background: s.gap > 0 ? '#DE2A2A0A' : 'transparent' }}>
                        <td style={{ padding: '8px 12px', color: 'var(--text)' }}>
                          {s.product} {s.variant} {s.color}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--t2)' }}>{s.mapping}</td>
                        <td style={{ padding: '8px 12px' }}>{s.demand}</td>
                        <td style={{ padding: '8px 12px' }}>{s.rtd_available}</td>
                        <td style={{ padding: '8px 12px' }}>{s.allocated}</td>
                        <td style={{ padding: '8px 12px', color: s.gap > 0 ? '#DE2A2A' : 'inherit', fontWeight: s.gap > 0 ? 600 : 400 }}>
                          {s.gap > 0 ? s.gap : '—'}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {s.runs_needed > 0 ? `${s.runs_needed} run${s.runs_needed > 1 ? 's' : ''}` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {s.status === 'covered'
                            ? <span style={{ color: '#22c55e', fontWeight: 600 }}>✓ Covered</span>
                            : s.status === 'impossible'
                              ? <span style={{ color: '#DE2A2A', fontWeight: 600 }}>✗ Too late</span>
                              : <span style={{ color: LEAD_COLORS[s.lead_status], fontWeight: 600 }}>
                                  {LEAD_LABELS[s.lead_status]}
                                </span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      {view === 'recommendations' && (
        <div>
          {recommendations.length === 0 && (
            <p style={{ color: '#22c55e', fontSize: 14 }}>
              ✓ All upcoming dispatch dates are covered. No production runs needed.
            </p>
          )}
          {recommendations.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <button onClick={handleCreateAll}
                style={{ padding: '10px 20px', background: '#213CE2', color: '#fff',
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Create All {recommendations.length} Runs
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {recommendations.map((rec, i) => {
              const schedDate = schedDates[i] || rec.deadline_date;
              const isCreating = creatingRun === rec.sku + rec.mapping;
              return (
                <div key={i} style={{
                  border: '1px solid var(--b1)', borderRadius: 8, padding: '16px 20px',
                  borderLeft: `4px solid ${LEAD_COLORS[rec.lead_status]}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontFamily: 'Tomorrow, sans-serif', fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                        {rec.product} {rec.variant} {rec.color} — {rec.mapping}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 }}>
                        Need <strong style={{ color: 'var(--text)' }}>{rec.gap} more units</strong> for&nbsp;
                        {new Date(rec.urgency_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} dispatch
                        &nbsp;·&nbsp;
                        Run size: <strong style={{ color: 'var(--text)' }}>{rec.batch_size} units</strong>
                        {rec.surplus > 0 && <span style={{ color: 'var(--t2)' }}> ({rec.surplus} surplus)</span>}
                        {rec.runs_needed > 1 && <span> · <strong>{rec.runs_needed} runs</strong> needed</span>}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: LEAD_COLORS[rec.lead_status] }}>
                        {LEAD_LABELS[rec.lead_status]}
                        {rec.days_to_deadline > 0
                          ? ` — ${rec.days_to_deadline} day${rec.days_to_deadline > 1 ? 's' : ''} to complete run by ${rec.deadline_date}`
                          : rec.days_to_deadline === 0
                            ? ' — Run must complete today'
                            : ' — Dispatch date already passed'
                        }
                      </div>
                      {rec.history_suggested_qty && rec.history_suggested_qty !== rec.batch_size && (
                        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t2)' }}>
                          Historical avg: {rec.history_suggested_qty} units/run
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', minWidth: 280 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ fontSize: 12, color: 'var(--t2)' }}>Schedule:</label>
                        <input type="date" value={schedDate}
                          min={new Date().toISOString().split('T')[0]}
                          max={rec.deadline_date}
                          onChange={e => setSchedDates(prev => ({ ...prev, [i]: e.target.value }))}
                          style={{ padding: '6px 8px', background: 'var(--s1)', border: '1px solid var(--b2)',
                            color: 'var(--text)', borderRadius: 4, fontSize: 13 }} />
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => handleCreateRun(rec, schedDate)}
                          disabled={isCreating}
                          style={{ padding: '8px 16px', background: '#F2CD1A', color: '#080808',
                            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                          {isCreating ? 'Creating…' : 'Create Run'}
                        </button>
                        <a href="/lines"
                          style={{ padding: '8px 16px', background: 'transparent', color: 'var(--t2)',
                            border: '1px solid var(--b2)', borderRadius: 6, fontSize: 13,
                            textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
                          Go to Lines →
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'config' && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16 }}>
            Set the default production run size per product. This is used to calculate
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
