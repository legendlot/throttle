'use client';
/* ════════════════════════════════════════════════════════════
   SCANS — Inbox stream (Pit Wall v2). Scan feed with date
   presets, activity filters, UPC search (server-side ≥3 chars
   via getScansByUpc — global, box-label aware; client-side 1–2), voided toggle, summary
   tiles and cursor load-more. Data actions unchanged:
   useScans (getAllScans) · getScanSummary · getScansByUpc.
   ════════════════════════════════════════════════════════════ */
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Modal } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useScans } from '../../../hooks/useScans.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, Panel, FilterChip, ToneBadge, InboxTabs, fmt, btnGhost, inputStyle,
  lineColor, lineRgb,
} from '../../../components/kit/index.js';

// ── Helpers ───────────────────────────────────────────────────
// Build the LOCAL Y-M-D string directly. Going via .toISOString() renders a local
// wall-clock moment as UTC, which in IST (+5:30) rolls back a day — always for local
// midnight (This Month started on the prev month's last day) and between 00:00–05:30
// IST for a now-timestamped one (This Week started on Sunday). See PATTERN-221.
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMondayISO() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return localISO(d);
}

function getFirstOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${date} ${time}`;
}

const ACT_COLORS = {
  INW:        'var(--blue-bright)',
  QC_PASS:    'var(--ok-fg)',
  QC_FAIL:    'var(--bad-fg)',
  WKS_IN:     '#a78bfa',
  WKS_OUT:    '#a78bfa',
  PKG:        '#8b5cf6',
  RTO_IN:     'var(--orange)',
  RTD_RETURN: '#14b8a6',
  RTE:        'var(--blue-bright)',
  RTR:        'var(--blue-bright)',
  ALLOC:      '#38bdf8',
  PACK:       '#22d3ee',
  DTK:        '#0ea5e9',
  DOUT:       '#3b82f6',
  REP_START:  '#fbbf24',
  REP_PASS:   '#f59e0b',
};

const ACTIVITY_FILTERS = [
  { value: '',           label: 'All' },
  { value: 'INW',        label: 'INW' },
  { value: 'QC_PASS',    label: 'QC Pass' },
  { value: 'QC_FAIL',    label: 'QC Fail' },
  { value: 'WKS_IN',     label: 'WKS In' },
  { value: 'WKS_OUT',    label: 'WKS Out' },
  { value: 'PKG',        label: 'PKG' },
  { value: 'ALLOC',      label: 'Alloc' },
  { value: 'PACK',       label: 'Pack' },
  { value: 'DTK',        label: 'DTK' },
  { value: 'DOUT',       label: 'DOut' },
  { value: 'REP_START',  label: 'Rep Start' },
  { value: 'REP_PASS',   label: 'Rep Pass' },
  { value: 'RTE',        label: 'RTE' },
  { value: 'RTR',        label: 'RTR' },
  { value: 'RTO_IN',     label: 'RTO In' },
  { value: 'RTD_RETURN', label: 'RTD Return' },
];

const SUMMARY_ACTIVITIES = ['INW','QC_PASS','QC_FAIL','WKS_IN','WKS_OUT','PKG','RTO_IN','RTD_RETURN'];

const SUMMARY_LABELS = {
  INW:        'Inwarded',
  QC_PASS:    'QC Pass',
  QC_FAIL:    'QC Fail',
  WKS_IN:     'WKS In',
  WKS_OUT:    'WKS Out',
  PKG:        'PKG',
  RTO_IN:     'RTO In',
  RTD_RETURN: 'RTD Return',
};

// ── shared table cell styles (Pit Wall v2) ────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '9px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

// ── Activity badge ────────────────────────────────────────────
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

// ── Scans Page ────────────────────────────────────────────────
export default function ScansPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [dateFrom,        setDateFrom]        = useState(() => todayStr());
  const [dateTo,          setDateTo]          = useState(() => todayStr());
  const [activityFilter,  setActivityFilter]  = useState('');
  const [showVoided,      setShowVoided]      = useState(false);
  const [upcSearch,       setUpcSearch]       = useState('');
  const [upcMode,         setUpcMode]         = useState(false);
  const [upcScans,        setUpcScans]        = useState([]);
  const [upcLoading,      setUpcLoading]      = useState(false);
  const [summary,         setSummary]         = useState(null);
  const [summaryLoading,  setSummaryLoading]  = useState(false);
  const [historyUpc,      setHistoryUpc]      = useState(null); // unit whose full history modal is open

  const { scans, loading, error: scanError, hasMore, loadMore, reload } =
    useScans({ dateFrom, dateTo, showVoided, activityFilter }, session);

  // ── Scan summary fetch (single date) ──────────────────────
  useEffect(() => {
    if (!session || !dateFrom) return;
    let cancelled = false;
    (async () => {
      setSummaryLoading(true);
      try {
        const data = await garageFetch('getScanSummary', { date: dateFrom }, session);
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
    if (trimmed.length === 0) {
      // Exit UPC mode
      setUpcMode(false);
      setUpcScans([]);
      return;
    }
    if (trimmed.length >= 3) {
      // ≥3 chars → global server lookup via getScansByUpc (all history, not just the
      // loaded page). Handles full UPCs, bare/short numbers, and box labels (LOT-…-E/R).
      debounceRef.current = setTimeout(async () => {
        if (!session) return;
        setUpcLoading(true);
        try {
          const data = await garageFetch('getScansByUpc', { upc: trimmed }, session);
          setUpcScans(Array.isArray(data) ? data : []);
          setUpcMode(true);
        } catch (_) {
          setUpcScans([]);
        } finally {
          setUpcLoading(false);
        }
      }, 500);
    } else {
      // 1–2 chars → client-side quick-filter of the loaded rows (200ms to settle UI)
      debounceRef.current = setTimeout(() => {
        setUpcMode(false);
      }, 200);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [upcSearch, session]);

  // Refresh-bar wiring (manual reload only — no auto-refresh on this tab)
  useEffect(() => {
    setRefreshing(loading || upcLoading || summaryLoading);
  }, [loading, upcLoading, summaryLoading, setRefreshing]);

  useEffect(() => {
    if (!loading && !upcLoading && !summaryLoading) {
      setLastRefreshed(new Date());
    }
  }, [loading, upcLoading, summaryLoading, setLastRefreshed]);

  // ── Preset buttons ────────────────────────────────────────
  function handlePreset(preset) {
    const today = todayStr();
    if (preset === 'today') { setDateFrom(today); setDateTo(today); }
    else if (preset === 'week')  { setDateFrom(getMondayISO()); setDateTo(today); }
    else if (preset === 'month') { setDateFrom(getFirstOfMonthISO()); setDateTo(today); }
  }
  const activePreset =
    dateFrom === todayStr() && dateTo === todayStr() ? 'today'
      : dateFrom === getMondayISO() && dateTo === todayStr() ? 'week'
      : dateFrom === getFirstOfMonthISO() && dateTo === todayStr() ? 'month'
      : null;

  // ── Display rows ──────────────────────────────────────────
  const baseRows = upcMode ? upcScans : scans;
  const trimmed  = upcSearch.trim().toUpperCase();

  const displayRows = useMemo(() => {
    let rows = baseRows || [];
    // In UPC mode, allow toggle to filter voided client-side; in normal mode the hook already excludes
    if (upcMode && !showVoided) rows = rows.filter(r => !r.voided);
    if (upcMode && activityFilter) rows = rows.filter(r => r.activity === activityFilter);
    if (!upcMode && trimmed.length >= 1 && trimmed.length <= 2) {
      rows = rows.filter(r => (r.upc || '').toUpperCase().includes(trimmed));
    }
    return rows;
  }, [baseRows, upcMode, showVoided, activityFilter, trimmed]);

  // ── Style constants ───────────────────────────────────────
  const dateInput = { ...inputStyle, width: 'auto', padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 12.5, colorScheme: 'dark' };
  const searchInput = { ...inputStyle, width: 220, padding: '7px 11px', fontSize: 13 };

  const isRange = dateFrom !== dateTo;

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <InboxTabs counts={{ scans: displayRows.length }} />

      {/* Date bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {isRange && (
          <>
            <span className="eyebrow">From</span>
            <input type="date" className="num" style={dateInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <span className="eyebrow">to</span>
          </>
        )}
        <input
          type="date"
          className="num"
          style={dateInput}
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); if (!isRange) setDateFrom(e.target.value); }}
        />
        <FilterChip active={activePreset === 'today'} onClick={() => handlePreset('today')}>Today</FilterChip>
        <FilterChip active={activePreset === 'week'}  onClick={() => handlePreset('week')}>This Week</FilterChip>
        <FilterChip active={activePreset === 'month'} onClick={() => handlePreset('month')}>This Month</FilterChip>

        <div style={{ flex: 1 }} />

        <input
          data-search-primary
          type="text"
          placeholder="Search UPC / box label…  · /"
          style={searchInput}
          value={upcSearch}
          onChange={e => setUpcSearch(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} />
          Show Voided
        </label>
      </div>

      {/* Activity filter row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
        {ACTIVITY_FILTERS.map(f => (
          <FilterChip
            key={f.value || 'all'}
            active={activityFilter === f.value}
            dot={f.value ? ACT_COLORS[f.value] : undefined}
            onClick={() => setActivityFilter(f.value)}
          >
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
          <SummaryCard
            label="Total"
            value={summary?.total}
            stripe="var(--yellow)"
            active={activityFilter === ''}
            onClick={() => setActivityFilter('')}
          />
          {SUMMARY_ACTIVITIES.map(a => {
            const count = summary?.[a];
            const sub = a === 'INW' && summary?.INW_car != null
              ? `${fmt(summary.INW_car)}C · ${fmt(summary.INW_remote || 0)}R`
              : a === 'QC_PASS' && summary?.QC_PASS_car != null
              ? `${fmt(summary.QC_PASS_car)}C · ${fmt(summary.QC_PASS_remote || 0)}R`
              : null;
            return (
              <SummaryCard
                key={a}
                label={SUMMARY_LABELS[a]}
                value={count}
                stripe={ACT_COLORS[a]}
                sub={sub}
                active={activityFilter === a}
                onClick={() => setActivityFilter(a)}
              />
            );
          })}
          <SummaryCard
            label="Voided"
            value={summary?.voided}
            stripe="var(--t3)"
            active={false}
            onClick={() => setShowVoided(v => !v)}
          />
        </div>
      )}

      {/* Table */}
      <Panel pad={8}>
        {(loading || upcLoading) ? (
          <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : displayRows.length === 0 ? (
          <div style={{ padding: '36px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--t3)' }}>
            <Icon name="scan" size={20} />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>No scans found</span>
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
                        {s.line
                          ? <LineChip id={s.line} />
                          : <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t4)' }}>—</span>}
                      </td>
                      <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--t1)' }}>{s.unit_product || '—'}</td>
                      <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)' }}>{s.operator_name || (s.operator_id ? String(s.operator_id).slice(0, 8) : '—')}</td>
                      <td style={tdBase}><span className="num" style={{ fontSize: 12, color: 'var(--t2)' }}>{s.loop_count != null ? s.loop_count : '—'}</span></td>
                      <td style={tdBase}>
                        {voided
                          ? <ToneBadge tone="bad">Voided</ToneBadge>
                          : <ToneBadge tone="ok">OK</ToneBadge>}
                      </td>
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
            <button
              style={{ ...btnGhost, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
              onClick={loadMore}
              disabled={loading}
            >
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

// ── Line chip (prototype lineChip) ────────────────────────────
function LineChip({ id }) {
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(id),
      background: `rgba(${lineRgb(id)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{id}</span>
  );
}

// ── Summary card (click-through filter tile) ─────────────────
function SummaryCard({ label, value, stripe, sub, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? 'var(--surface-2)' : 'var(--surface)',
        border: active ? '1px solid var(--brand-bd)' : '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        padding: 13,
        cursor: 'pointer',
        position: 'relative',
        overflow: 'hidden',
        transition: 'border-color var(--fast) var(--ease), background var(--fast) var(--ease)',
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: stripe || 'transparent' }} />
      <div className="eyebrow" style={{ marginBottom: 8 }}>{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--t1)', lineHeight: 1 }}>
        {value != null ? fmt(value) : '—'}
      </div>
      {sub && <div className="num" style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}
