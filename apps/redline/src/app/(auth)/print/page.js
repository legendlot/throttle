'use client';
/* ════════════════════════════════════════════════════════════
   SETUP · PRINT — Pit Wall v2. On-demand label printer (NOT
   templates). Prototype: redesign-reference/app/setup.jsx (Print
   tab). SINGLE/BULK · search by batch label or car UPC · required
   "Print to" printer selector. Data unchanged (getPkgScanLookup
   lookup, postReprintJob queue).
   ════════════════════════════════════════════════════════════ */
import { useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Icon, Panel, FilterChip, ToneBadge, fmt, btnPrimary, inputStyle } from '../../../components/kit/index.js';

function normalizeLot(raw) {
  let v = (raw || '').trim().toUpperCase();
  if (!v) return '';
  if (!v.startsWith('LOT-')) v = 'LOT-' + v.padStart(8, '0');
  return v;
}
function formatPackedDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
}

const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '11px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

export default function PrintPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const PRINTERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'D1', 'D2'];

  const [mode, setMode] = useState('single');
  const [singleVal, setSingleVal] = useState('');
  const [bulkVal, setBulkVal] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [printStatus, setPrintStatus] = useState({});
  const [selectedPrinter, setSelectedPrinter] = useState('');

  function setMode_(newMode) { setMode(newMode); setResults(null); setPrintStatus({}); }

  async function searchSingle() {
    const val = normalizeLot(singleVal);
    if (!val) return;
    setSearching(true); setResults(null); setPrintStatus({});
    const isCarUpc = !val.endsWith('-E') && !val.endsWith('-R');
    const params = isCarUpc ? { car_upc: val } : { batch_label: val };
    try {
      const data = await garageFetch('getPkgScanLookup', params, session);
      const rows = Array.isArray(data) ? data : (data?.data || []);
      setResults(rows.length ? { rows, notFound: [] } : { rows: [], notFound: [val] });
    } catch (_) {
      setResults({ rows: [], notFound: [val] });
    } finally {
      setSearching(false);
    }
  }

  async function searchBulk() {
    const lines = bulkVal.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const normalized = lines.map(normalizeLot);
    setSearching(true); setResults(null); setPrintStatus({});
    const allRows = [];
    const notFound = [];
    const lookups = await Promise.allSettled(normalized.map(val => {
      const isCarUpc = !val.endsWith('-E') && !val.endsWith('-R');
      const params = isCarUpc ? { car_upc: val } : { batch_label: val };
      return garageFetch('getPkgScanLookup', params, session).then(data => {
        const rows = Array.isArray(data) ? data : (data?.data || []);
        return { val, rows };
      });
    }));
    for (const r of lookups) {
      if (r.status === 'fulfilled') {
        if (r.value.rows.length) allRows.push(...r.value.rows);
        else notFound.push(r.value.val);
      } else {
        notFound.push('(error)');
      }
    }
    setResults({ rows: allRows, notFound });
    setSearching(false);
  }

  async function queueReprint(i, row) {
    if (!selectedPrinter) { showToast('Select a printer before printing', 'warning'); return; }
    setPrintStatus(prev => ({ ...prev, [i]: 'queuing' }));
    try {
      await workerFetch('postReprintJob', {
        batch_label: row.batch_label,
        product:     row.product || '',
        model:       row.model   || '',
        color:       row.color   || '',
        channel:     row.channel || '',
        line:        selectedPrinter,
      }, session);
      setPrintStatus(prev => ({ ...prev, [i]: 'done' }));
    } catch (e) {
      setPrintStatus(prev => ({ ...prev, [i]: 'error' }));
    }
  }

  async function printAll() {
    if (!results?.rows?.length) return;
    if (!selectedPrinter) { showToast('Select a printer before printing', 'warning'); return; }
    for (let i = 0; i < results.rows.length; i++) {
      if (printStatus[i] === 'done') continue;
      // eslint-disable-next-line no-await-in-loop
      await queueReprint(i, results.rows[i]);
    }
  }

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <FilterChip active={mode === 'single'} onClick={() => setMode_('single')}>Single</FilterChip>
        <FilterChip active={mode === 'bulk'} onClick={() => setMode_('bulk')}>Bulk</FilterChip>
      </div>

      {/* Search input */}
      <Panel title={mode === 'single' ? 'Search by batch label or car UPC' : 'Bulk lookup · one label/UPC per line'} icon="search" style={{ marginBottom: 18 }}>
        {mode === 'single' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={{ ...inputStyle, flex: 1 }} placeholder="LOT-12345 or 12345 or LOT-12345-R"
              value={singleVal} onChange={e => setSingleVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') searchSingle(); }} data-search-primary />
            <button onClick={searchSingle} disabled={searching || !singleVal.trim()}
              style={{ ...btnPrimary, opacity: (searching || !singleVal.trim()) ? 0.5 : 1 }}>
              <Icon name="search" size={14} /> {searching ? 'Searching…' : 'Search'}</button>
          </div>
        ) : (
          <>
            <textarea style={{ ...inputStyle, width: '100%', minHeight: 110, resize: 'vertical' }}
              placeholder={"LOT-12345\n12346\nLOT-12347-E"}
              value={bulkVal} onChange={e => setBulkVal(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={searchBulk} disabled={searching || !bulkVal.trim()}
                style={{ ...btnPrimary, opacity: (searching || !bulkVal.trim()) ? 0.5 : 1 }}>
                <Icon name="search" size={14} /> {searching ? 'Looking up…' : 'Look Up All'}</button>
            </div>
          </>
        )}
      </Panel>

      {/* Printer selector */}
      <Panel style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="label" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>Print to</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {PRINTERS.map(p => (
              <FilterChip key={p} active={selectedPrinter === p} onClick={() => setSelectedPrinter(prev => prev === p ? '' : p)}>{p}</FilterChip>
            ))}
          </div>
          {!selectedPrinter && (
            <span style={{ fontSize: 11.5, color: 'var(--warn-fg)', marginLeft: 4 }}>— select before printing</span>
          )}
        </div>
      </Panel>

      {/* Results */}
      {searching ? (
        <Panel><div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div></Panel>
      ) : !results ? (
        <Panel><div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>
          Enter a batch label or car UPC above to search</div></Panel>
      ) : (
        <>
          {results.rows.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <span className="label" style={{ fontSize: 12 }}>Found {results.rows.length} unit{results.rows.length !== 1 ? 's' : ''}</span>
                <div style={{ flex: 1 }} />
                {results.rows.length > 1 && (
                  <button onClick={printAll} style={btnPrimary}><Icon name="printer" size={14} /> Print All</button>
                )}
              </div>
              <Panel pad={0}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>{['Batch Label', 'Product', 'Line', 'Channel', 'Packed', 'Action'].map(h => (
                        <th key={h} className="eyebrow" style={thStyle}>{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {results.rows.map((row, i) => {
                        const status = printStatus[i];
                        return (
                          <tr key={`${row.batch_label}-${i}`}>
                            <td className="num" style={{ ...tdBase, color: 'var(--yellow)' }}>{row.batch_label || '—'}</td>
                            <td style={{ ...tdBase, color: 'var(--t1)' }}>
                              {row.product || '—'}
                              {(row.model || row.color) && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11.5 }}>{[row.model, row.color].filter(Boolean).join(' ')}</span>}
                            </td>
                            <td style={{ ...tdBase, color: 'var(--t1)' }}>{row.line || '—'}</td>
                            <td style={{ ...tdBase, color: 'var(--t2)' }}>{row.channel || '—'}</td>
                            <td className="num" style={{ ...tdBase, color: 'var(--t3)' }}>{formatPackedDate(row.packed_at)}</td>
                            <td style={tdBase}>
                              {status === 'queuing' ? <ToneBadge tone="mute">Queuing…</ToneBadge>
                                : status === 'done' ? <ToneBadge tone="ok">Queued</ToneBadge>
                                : status === 'error' ? <ToneBadge tone="bad">Failed</ToneBadge>
                                : <button onClick={() => queueReprint(i, row)} style={{ ...btnPrimary, padding: '6px 12px' }}><Icon name="printer" size={13} /> Print</button>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}

          {results.notFound.length > 0 && (
            <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)', padding: 14 }}>
              <div className="eyebrow" style={{ color: 'var(--bad-fg)', marginBottom: 8 }}>Not found ({results.notFound.length})</div>
              <div className="num" style={{ fontSize: 12.5, color: 'var(--t2)' }}>{results.notFound.join(', ')}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
