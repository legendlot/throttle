'use client';
/* ════════════════════════════════════════════════════════════
   DEPOT — Scan Feed. The dispatch-side equivalent of Redline's
   Scans inbox: the same scan stream + summary tiles + date
   presets + UPC search, scoped to DISPATCH scan activities
   (RTE/RTR/DTK/ALLOC/PACK/DOUT/RTO_IN/RTD_RETURN/REPACK_*).
   Stream: useScans (getAllScans, activities[] allow-list) +
   getScansByUpc. Tiles: getDispatchScanSummary.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Modal } from '@throttle/ui';
import {
  Icon, Panel, FilterChip, ToneBadge, fmt, btnGhost, inputStyle, lineColor, lineRgb, istToday,
} from '../../../components/kit/index.js';
import { useScans } from '../../../hooks/useScans.js';
import { useRefreshState } from '../layout.js';

// ── Date helpers (IST-anchored, derived from istToday()) ──────
function dFromISO(iso) { return new Date(iso + 'T00:00:00'); }
function isoOf(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0]; }
function getMondayISO() {
  const d = dFromISO(istToday()); const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return isoOf(d);
}
function getFirstOfMonthISO() {
  const d = dFromISO(istToday());
  return isoOf(new Date(d.getFullYear(), d.getMonth(), 1));
}
function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

// ── Dispatch scan activities ──────────────────────────────────
const ACT_COLORS = {
  RTE:        'var(--blue-bright, #60a5fa)',
  RTR:        '#818cf8',
  DTK:        '#0ea5e9',
  ALLOC:      '#38bdf8',
  PACK:       '#22d3ee',
  DOUT:       '#3b82f6',
  RTO_IN:     'var(--orange, #f97316)',
  RTD_RETURN: '#14b8a6',
  REPACK_IN:  '#a78bfa',
  REPACK_OUT: '#c084fc',
};
const DISPATCH_ACTS = ['RTE','RTR','DTK','ALLOC','PACK','DOUT','RTO_IN','RTD_RETURN','REPACK_IN','REPACK_OUT'];

const ACT_LABELS = {
  RTE: 'RTE', RTR: 'RTR', DTK: 'DTK', ALLOC: 'Alloc', PACK: 'Pack', DOUT: 'DOut',
  RTO_IN: 'RTO In', RTD_RETURN: 'RTD Return', REPACK_IN: 'Repack In', REPACK_OUT: 'Repack Out',
};
const ACTIVITY_FILTERS = [{ value: '', label: 'All' }, ...DISPATCH_ACTS.map(a => ({ value: a, label: ACT_LABELS[a] }))];
// Headline tiles (REPACK_* stay in the stream/filter but off the tile strip).
const SUMMARY_ACTIVITIES = ['RTE','RTR','DTK','ALLOC','PACK','DOUT','RTO_IN','RTD_RETURN'];
const SUMMARY_LABELS = {
  RTE: 'RTE (ecom)', RTR: 'RTR (retail)', DTK: 'DTK', ALLOC: 'Allocated', PACK: 'Packed',
  DOUT: 'Dispatched', RTO_IN: 'Returns In', RTD_RETURN: 'RTD Return',
};

// ── shared table cell styles ──────────────────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '9px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

function ActivityBadge({ activity }) {
  const color = ACT_COLORS[activity] || 'var(--t2)';
  return (
    <span className="num" style={{
      display: 'inline-block', padding: '2px 7px', fontSize: 10.5, fontWeight: 600,
      letterSpacing: '0.04em', textTransform: 'uppercase', color,
      background: 'var(--surface-2)', border: '1px solid var(--border-2)',
      borderRadius: 3, whiteSpace: 'nowrap', lineHeight: 1.3,
    }}>
      {activity || '—'}
    </span>
  );
}

export default function ScanFeedPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [dateFrom,        setDateFrom]        = useState(() => istToday());
  const [dateTo,          setDateTo]          = useState(() => istToday());
  const [activityFilter,  setActivityFilter]  = useState('');
  const [showVoided,      setShowVoided]      = useState(false);
  const [upcSearch,       setUpcSearch]       = useState('');
  const [upcMode,         setUpcMode]         = useState(false);
  const [upcScans,        setUpcScans]        = useState([]);
  const [upcLoading,      setUpcLoading]      = useState(false);
  const [summary,         setSummary]         = useState(null);
  const [summaryLoading,  setSummaryLoading]  = useState(false);
  const [historyUpc,      setHistoryUpc]      = useState(null); // unit whose full history modal is open

  const { scans, loading, error: scanError, hasMore, loadMore } =
    useScans({ dateFrom, dateTo, showVoided, activityFilter, activities: DISPATCH_ACTS }, session);

  // ── Summary fetch (single date) ───────────────────────────
  useEffect(() => {
    if (!session || !dateFrom) return;
    let cancelled = false;
    (async () => {
      setSummaryLoading(true);
      try {
        const data = await garageFetch('getDispatchScanSummary', { date: dateFrom }, session);
        if (!cancelled) setSummary(data || null);
      } catch (_) {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dateFrom, session]);

  // ── UPC search debounce ───────────────────────────────────
  const debounceRef = useRef(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = upcSearch.trim();
    if (trimmed.length === 0) { setUpcMode(false); setUpcScans([]); return; }
    if (trimmed.length >= 3) {
      // ≥3 chars → global server lookup via getScansByUpc (all history, not just the
      // loaded page). Handles full UPCs, box labels (LOT-…-E/R), and partial fragments.
      debounceRef.current = setTimeout(async () => {
        if (!session) return;
        setUpcLoading(true);
        try {
          const data = await garageFetch('getScansByUpc', { upc: trimmed }, session);
          setUpcScans(Array.isArray(data) ? data : []);
          setUpcMode(true);
        } catch (_) { setUpcScans([]); }
        finally { setUpcLoading(false); }
      }, 500);
    } else {
      debounceRef.current = setTimeout(() => { setUpcMode(false); }, 200);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [upcSearch, session]);

  // Refresh-bar wiring (manual reload only)
  useEffect(() => { setRefreshing(loading || upcLoading || summaryLoading); }, [loading, upcLoading, summaryLoading, setRefreshing]);
  useEffect(() => {
    if (!loading && !upcLoading && !summaryLoading) setLastRefreshed(new Date());
  }, [loading, upcLoading, summaryLoading, setLastRefreshed]);

  // ── Presets ───────────────────────────────────────────────
  function handlePreset(preset) {
    const today = istToday();
    if (preset === 'today') { setDateFrom(today); setDateTo(today); }
    else if (preset === 'week')  { setDateFrom(getMondayISO()); setDateTo(today); }
    else if (preset === 'month') { setDateFrom(getFirstOfMonthISO()); setDateTo(today); }
  }
  const activePreset =
    dateFrom === istToday() && dateTo === istToday() ? 'today'
      : dateFrom === getMondayISO() && dateTo === istToday() ? 'week'
      : dateFrom === getFirstOfMonthISO() && dateTo === istToday() ? 'month'
      : null;

  // ── Display rows ──────────────────────────────────────────
  const baseRows = upcMode ? upcScans : scans;
  const trimmed  = upcSearch.trim().toUpperCase();

  const displayRows = useMemo(() => {
    let rows = baseRows || [];
    // In UPC mode the server returns the unit's full history — scope to dispatch
    // activities so the feed stays dispatch-only, and honour the voided/activity chips.
    if (upcMode) {
      rows = rows.filter(r => DISPATCH_ACTS.includes(r.activity));
      if (!showVoided) rows = rows.filter(r => !r.voided);
      if (activityFilter) rows = rows.filter(r => r.activity === activityFilter);
    }
    return rows;
  }, [baseRows, upcMode, showVoided, activityFilter]);

  const dateInput = { ...inputStyle, width: 'auto', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 12.5, colorScheme: 'dark' };
  const searchInput = { ...inputStyle, width: 220, padding: '7px 11px', fontSize: 13 };
  const isRange = dateFrom !== dateTo;

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <h1 className="font-display" style={{ fontSize: 18, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--t1)', margin: 0 }}>Dispatch Scan Feed</h1>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t3)' }}>{fmt(displayRows.length)} shown</span>
      </div>

      {/* Date bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {isRange && (
          <>
            <span className="eyebrow">From</span>
            <input type="date" className="num" style={dateInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <span className="eyebrow">to</span>
          </>
        )}
        <input type="date" className="num" style={dateInput} value={dateTo}
          onChange={e => { setDateTo(e.target.value); if (!isRange) setDateFrom(e.target.value); }} />
        <FilterChip active={activePreset === 'today'} onClick={() => handlePreset('today')}>Today</FilterChip>
        <FilterChip active={activePreset === 'week'}  onClick={() => handlePreset('week')}>This Week</FilterChip>
        <FilterChip active={activePreset === 'month'} onClick={() => handlePreset('month')}>This Month</FilterChip>

        <div style={{ flex: 1 }} />

        <input data-search-primary type="text" placeholder="Search UPC / box label…  · /" style={searchInput}
          value={upcSearch} onChange={e => setUpcSearch(e.target.value)} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
          Show Voided
        </label>
      </div>

      {/* Activity filter row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {ACTIVITY_FILTERS.map(f => (
          <FilterChip key={f.value || 'all'} active={activityFilter === f.value}
            dot={f.value ? ACT_COLORS[f.value] : undefined} onClick={() => setActivityFilter(f.value)}>
            {f.label}
          </FilterChip>
        ))}
      </div>

      {scanError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)',
          borderRadius: 'var(--r-md)', padding: '12px 16px', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 16 }}>
          <Icon name="alert" size={16} /> {scanError}
        </div>
      )}

      {/* Summary cards (hidden in UPC mode) */}
      {!upcMode && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 16 }}>
          <SummaryCard label="Total" value={summary?.total} stripe="var(--yellow)" active={activityFilter === ''} onClick={() => setActivityFilter('')} />
          {SUMMARY_ACTIVITIES.map(a => (
            <SummaryCard key={a} label={SUMMARY_LABELS[a]} value={summary?.[a]} stripe={ACT_COLORS[a]}
              active={activityFilter === a} onClick={() => setActivityFilter(a)} />
          ))}
          <SummaryCard label="Voided" value={summary?.voided} stripe="var(--t3)" active={false} onClick={() => setShowVoided(v => !v)} />
        </div>
      )}

      {/* Table */}
      <Panel pad={8}>
        {(loading || upcLoading) ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : displayRows.length === 0 ? (
          <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--t3)' }}>
            <Icon name="scan" size={20} />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>No dispatch scans found</span>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time','UPC','Activity','Line','Product','Operator','Loop','Status'].map(h => (
                    <th key={h} style={thStyle}><span className="eyebrow">{h}</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(s => {
                  const voided = !!s.voided;
                  return (
                    <tr key={s.id} className="scan-row" style={{ opacity: voided ? 0.5 : 1, cursor: s.upc ? 'pointer' : 'default' }}
                      title={s.upc ? 'Click for full unit history' : undefined}
                      onClick={() => { if (s.upc) setHistoryUpc(s.upc); }}>
                      <td style={tdBase}>
                        <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>
                          {upcMode ? formatDateTime(s.timestamp) : formatTime(s.timestamp)}
                        </span>
                      </td>
                      <td style={tdBase}><span className="num" style={{ fontSize: 11.5, color: 'var(--yellow)' }}>{s.upc || '—'}</span></td>
                      <td style={tdBase}><ActivityBadge activity={s.activity} /></td>
                      <td style={tdBase}>
                        {s.line ? <LineChip id={s.line} /> : <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>}
                      </td>
                      <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' }}>{s.unit_product || '—'}</td>
                      <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—')}</td>
                      <td style={tdBase}><span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{s.loop_count != null ? s.loop_count : '—'}</span></td>
                      <td style={tdBase}>{voided ? <ToneBadge tone="bad">Voided</ToneBadge> : <ToneBadge tone="ok">OK</ToneBadge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && !upcMode && (
          <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)' }}>
              Showing <span className="num">{fmt(scans.length)}</span> scans — more available
            </span>
            <button style={{ ...btnGhost, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }} onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load More'}
            </button>
          </div>
        )}
        {!hasMore && scans.length > 0 && !upcMode && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', textAlign: 'right' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)' }}>
              <span className="num">{fmt(scans.length)}</span> scans loaded
            </span>
          </div>
        )}
      </Panel>

      <UnitHistoryModal upc={historyUpc} session={session} onClose={() => setHistoryUpc(null)} />
      <style>{`.scan-row:hover td { background: var(--surface-2); }`}</style>
    </div>
  );
}

/* ── Unit history modal ─────────────────────────────────────────
   Click any feed row → the unit's WHOLE scan history (production +
   dispatch), with the dispatch channel attached to ALLOC/PACK/DOUT
   rows (served by getScansByUpc's allocation enrichment). */
function UnitHistoryModal({ upc, session, onClose }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!upc || !session) { setRows([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await garageFetch('getScansByUpc', { upc }, session);
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (_) { if (!cancelled) setRows([]); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [upc, session]);

  const product   = rows.find(r => r.unit_product)?.unit_product || null;
  const status    = rows.find(r => r.unit_status)?.unit_status || null;
  // Headline channel = the most recent dispatch row that resolved one (rows are desc).
  const channel   = rows.find(r => r.channel_name && (r.activity === 'DOUT' || r.activity === 'ALLOC'))?.channel_name || null;

  return (
    <Modal open={!!upc} onClose={onClose} size="lg" title={`Unit history — ${upc || ''}`}>
      {loading ? (
        <div style={{ padding: '32px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t3)' }}>
          No scans found for this unit
        </div>
      ) : (
        <>
          {/* Header strip: product · status · channel */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 14 }}>
            <HeaderStat label="Product" value={product || '—'} />
            <HeaderStat label="Status" value={status ? status.replace(/_/g, ' ').toUpperCase() : '—'} />
            <HeaderStat label="Channel" value={channel || '—'} accent={!!channel} />
            <HeaderStat label="Scans" value={String(rows.length)} />
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time','Activity','Station','Line','Channel','Operator','Status'].map(h => (
                    <th key={h} style={thStyle}><span className="eyebrow">{h}</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ opacity: r.voided ? 0.5 : 1 }}>
                    <td style={tdBase}>
                      <span className="num" style={{ fontSize: 11, color: 'var(--t3)' }}>{formatDateTime(r.timestamp)}</span>
                    </td>
                    <td style={tdBase}><ActivityBadge activity={r.activity} /></td>
                    <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t2)' }}>{r.station || '—'}</td>
                    <td style={tdBase}>
                      {r.line ? <LineChip id={r.line} /> : <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>}
                    </td>
                    <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: r.channel_name ? 'var(--t1)' : 'var(--t4)', fontWeight: r.channel_name ? 600 : 400 }}>
                      {r.channel_name || '—'}
                    </td>
                    <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>
                      {r.operator_name || (r.operator_id ? String(r.operator_id).slice(0, 8) : '—')}
                    </td>
                    <td style={tdBase}>{r.voided ? <ToneBadge tone="bad">Voided</ToneBadge> : <ToneBadge tone="ok">OK</ToneBadge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function HeaderStat({ label, value, accent }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: accent ? 'var(--yellow)' : 'var(--t1)' }}>{value}</div>
    </div>
  );
}

function LineChip({ id }) {
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(id),
      background: `rgba(${lineRgb(id)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{id}</span>
  );
}

function SummaryCard({ label, value, stripe, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: active ? 'var(--surface-2)' : 'var(--surface)',
      border: active ? '1px solid var(--brand-bd)' : '1px solid var(--border)',
      borderRadius: 'var(--r-md)', padding: 13, cursor: 'pointer', position: 'relative', overflow: 'hidden',
      transition: 'border-color var(--fast) var(--ease), background var(--fast) var(--ease)',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: stripe || 'transparent' }} />
      <div className="eyebrow" style={{ marginBottom: 8 }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)', lineHeight: 1 }}>
        {value != null ? fmt(value) : '—'}
      </div>
    </div>
  );
}
