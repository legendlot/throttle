'use client';
import { useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, EmptyState, useToast } from '@throttle/ui';

// ── Helpers ───────────────────────────────────────────────────
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

// ── Common styles ────────────────────────────────────────────
const btnStyle = { padding: '4px 10px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--t2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--mono)', letterSpacing: '0.04em' };
const inputStyle = { background: 'var(--surface)', color: 'var(--t1)', border: '1px solid var(--border)', padding: '8px 10px', borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 13 };
const sectionLabel = { fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 12 };
const thStyle = { padding: '8px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
const tdStyle = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };

// ── Print Page ────────────────────────────────────────────────
export default function PrintPage() {
  const { session } = useAuth();
  const { showToast } = useToast();

  const PRINTERS = ['L1', 'L2', 'L3', 'DISPATCH'];

  const [mode,            setMode]           = useState('single');
  const [singleVal,       setSingleVal]      = useState('');
  const [bulkVal,         setBulkVal]        = useState('');
  const [results,         setResults]        = useState(null);  // null | { rows: [], notFound: [] }
  const [searching,       setSearching]      = useState(false);
  const [printStatus,     setPrintStatus]    = useState({});    // { [index]: 'queuing'|'done'|'error' }
  const [selectedPrinter, setSelectedPrinter] = useState('');   // '' = unselected, blocks print

  function setMode_(newMode) {
    setMode(newMode);
    setResults(null);
    setPrintStatus({});
  }

  // ── Single search ─────────────────────────────────────────
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

  // ── Bulk search ──────────────────────────────────────────
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

  // ── Reprint queue ─────────────────────────────────────────
  async function queueReprint(i, row) {
    if (!selectedPrinter) {
      showToast('Select a printer before printing', 'warn');
      return;
    }
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
    if (!selectedPrinter) {
      showToast('Select a printer before printing', 'warn');
      return;
    }
    for (let i = 0; i < results.rows.length; i++) {
      // Skip already-done rows
      if (printStatus[i] === 'done') continue;
      // sequential
      // eslint-disable-next-line no-await-in-loop
      await queueReprint(i, results.rows[i]);
    }
  }

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <button
          onClick={() => setMode_('single')}
          style={mode === 'single'
            ? { ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)' }
            : { ...btnStyle, background: 'var(--surface2)' }}
        >Single</button>
        <button
          onClick={() => setMode_('bulk')}
          style={mode === 'bulk'
            ? { ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)' }
            : { ...btnStyle, background: 'var(--surface2)' }}
        >Bulk</button>
      </div>

      {/* Search input */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 16, marginBottom: 18 }}>
        <div style={sectionLabel}>{mode === 'single' ? 'Search by Batch Label or Car UPC' : 'Bulk Lookup — One label/UPC per line'}</div>

        {mode === 'single' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              placeholder="LOT-12345 or 12345 or LOT-12345-R"
              value={singleVal}
              onChange={e => setSingleVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') searchSingle(); }}
            />
            <button
              onClick={searchSingle}
              disabled={searching || !singleVal.trim()}
              style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)', padding: '8px 18px', opacity: (searching || !singleVal.trim()) ? 0.5 : 1 }}
            >{searching ? 'Searching…' : '🔍 Search'}</button>
          </div>
        ) : (
          <>
            <textarea
              style={{ ...inputStyle, width: '100%', minHeight: 110, resize: 'vertical' }}
              placeholder="LOT-12345&#10;12346&#10;LOT-12347-E"
              value={bulkVal}
              onChange={e => setBulkVal(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button
                onClick={searchBulk}
                disabled={searching || !bulkVal.trim()}
                style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)', padding: '8px 18px', opacity: (searching || !bulkVal.trim()) ? 0.5 : 1 }}
              >{searching ? 'Looking up…' : '🔍 Look Up All'}</button>
            </div>
          </>
        )}
      </div>

      {/* Printer selector */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '12px 16px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontFamily: 'var(--cond)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--t3)', whiteSpace: 'nowrap' }}>Print To</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {PRINTERS.map(p => (
            <button
              key={p}
              onClick={() => setSelectedPrinter(prev => prev === p ? '' : p)}
              style={{
                padding: '5px 14px',
                background: selectedPrinter === p ? 'var(--yellow)' : 'var(--surface2)',
                color: selectedPrinter === p ? '#000' : 'var(--t2)',
                border: selectedPrinter === p ? '1px solid var(--yellow)' : '1px solid var(--border)',
                borderRadius: 3,
                fontSize: 11,
                fontFamily: 'var(--mono)',
                fontWeight: 700,
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >{p}</button>
          ))}
        </div>
        {!selectedPrinter && (
          <div style={{ fontSize: 11, color: 'var(--t3)', fontFamily: 'var(--mono)', marginLeft: 4 }}>
            — select before printing
          </div>
        )}
      </div>

      {/* Results */}
      {searching ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 40, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      ) : !results ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '40px 16px', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
          Enter a batch label or car UPC above to search
        </div>
      ) : (
        <>
          {/* Found rows */}
          {results.rows.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <div style={sectionLabel}>Found {results.rows.length} unit{results.rows.length !== 1 ? 's' : ''}</div>
                <div style={{ flex: 1 }} />
                {results.rows.length > 1 && (
                  <button
                    onClick={printAll}
                    style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)' }}
                  >🖨 PRINT ALL</button>
                )}
              </div>

              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Batch Label','Product','Line','Channel','Packed','Action'].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {results.rows.map((row, i) => {
                        const status = printStatus[i];
                        return (
                          <tr key={`${row.batch_label}-${i}`}>
                            <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{row.batch_label || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--t1)' }}>
                              {row.product || '—'}
                              {(row.model || row.color) && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>{[row.model, row.color].filter(Boolean).join(' ')}</span>}
                            </td>
                            <td style={{ ...tdStyle, color: 'var(--t1)' }}>{row.line || '—'}</td>
                            <td style={{ ...tdStyle, color: 'var(--t2)' }}>{row.channel || '—'}</td>
                            <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatPackedDate(row.packed_at)}</td>
                            <td style={tdStyle}>
                              {status === 'queuing'
                                ? <span style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>Queuing…</span>
                                : status === 'done'
                                ? <span style={{ color: 'var(--green)', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700 }}>✅ Queued</span>
                                : status === 'error'
                                ? <span style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700 }}>✗ Failed</span>
                                : <button onClick={() => queueReprint(i, row)} style={{ ...btnStyle, background: 'var(--yellow)', color: '#000', border: '1px solid var(--yellow)' }}>🖨 PRINT</button>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Not found */}
          {results.notFound.length > 0 && (
            <div style={{ background: 'rgba(222,42,42,.08)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--red)', fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                Not found ({results.notFound.length})
              </div>
              <div style={{ fontSize: 12, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                {results.notFound.join(', ')}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
