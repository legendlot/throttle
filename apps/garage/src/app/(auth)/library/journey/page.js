'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast, EmptyState, Combobox } from '@throttle/ui';

const EVENT_TYPES = [
  { id: 'GRN',           label: 'GRN',           tone: 'green'  },
  { id: 'ISSUE',         label: 'Issuance',      tone: 'blue'   },
  { id: 'FLUSH',         label: 'Line Flush',    tone: 'yellow' },
  { id: 'DAMAGE',        label: 'Damage Logged', tone: 'red'    },
  { id: 'DAMAGE_ACTION', label: 'Damage Action', tone: 'orange' },
  { id: 'BAG_GEN',       label: 'Bag Generated', tone: 'gray'   },
  { id: 'RUN_PICK',      label: 'Run Pick',      tone: 'purple' },
];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.25)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.25)'  },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.3)'   },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.35)'  },
  orange: { bg: 'rgba(245,158,11,.15)', fg: '#fbbf24', border: 'rgba(245,158,11,.3)'  },
  purple: { bg: 'rgba(168,85,247,.15)', fg: '#c084fc', border: 'rgba(168,85,247,.3)'  },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)'    },
};

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '12px 14px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '8px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, verticalAlign: 'top' };

function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}
function fmtQty(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function TypeBadge({ type }) {
  const cfg = EVENT_TYPES.find(t => t.id === type) || { label: type, tone: 'gray' };
  const s = TONE_STYLES[cfg.tone];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      whiteSpace: 'nowrap',
    }}>{cfg.label}</span>
  );
}

function DirectionArrow({ direction, delta }) {
  if (direction === 'in')  return <span style={{ color: '#4ade80', fontFamily: 'var(--mono)', fontWeight: 700 }}>+{fmtQty(delta)}</span>;
  if (direction === 'out') return <span style={{ color: '#ff7070', fontFamily: 'var(--mono)', fontWeight: 700 }}>-{fmtQty(delta || 0)}</span>;
  return <span style={{ color: 'var(--t3)', fontFamily: 'var(--mono)' }}>—</span>;
}

function StockTile({ label, value, tone = 'gray' }) {
  const s = TONE_STYLES[tone];
  return (
    <div style={{ background: 'var(--surface2)', border: `1px solid ${s.border}`, borderRadius: 4, padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginBottom: 4 }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 18, fontFamily: 'var(--mono)', fontWeight: 700, color: s.fg }}>{fmtQty(value)}</div>
    </div>
  );
}

export default function PartJourneyPage() {
  const { session } = useAuth();
  const { showToast: toast } = useToast();

  const [partsCat, setPartsCat] = useState([]);
  const [partCode, setPartCode] = useState('');
  const [journey,  setJourney]  = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [typeFilter, setTypeFilter] = useState(() => new Set(['GRN','ISSUE','FLUSH','DAMAGE','DAMAGE_ACTION'])); // hide BAG_GEN + RUN_PICK by default
  const [showBalance, setShowBalance] = useState(true);

  // Parts catalogue for combobox (re-uses getProcurementParts — 1120 parts).
  useEffect(() => {
    if (!session) return;
    garageFetch('getProcurementParts', {}, session)
      .then(d => setPartsCat(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [session]);

  async function loadJourney(code) {
    if (!code || !session) return;
    setLoading(true);
    try {
      const r = await workerFetch('getPartJourney', { data: { part_code: code, limit: 500 } }, session);
      if (!r?.ok) { toast(r?.data?.error || 'Load failed', 'error'); setJourney(null); return; }
      setJourney(r.data);
    } finally {
      setLoading(false);
    }
  }

  // Filter + compute running balance ASC forward from opening_stock.
  const filteredEvents = useMemo(() => {
    if (!journey) return [];
    const inScope = journey.events.filter(e => typeFilter.has(e.type));
    if (!showBalance || !journey.stock) return inScope;
    // Build balance ASC, then map back to DESC for display.
    const asc = inScope.slice().sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
    let bal = journey.stock.opening_stock || 0;
    asc.forEach(e => {
      bal += (parseFloat(e.delta) || 0);
      e._balance_after = bal;
    });
    // Sort DESC again for display.
    return asc.slice().sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  }, [journey, typeFilter, showBalance]);

  // Reconciliation gap: balance after newest event vs stored closing_stock.
  const reconGap = useMemo(() => {
    if (!journey?.stock) return null;
    if (!filteredEvents.length) return null;
    if (!showBalance) return null;
    const computed = filteredEvents[0]?._balance_after;
    const stored   = journey.stock.closing_stock;
    if (computed == null || stored == null) return null;
    const diff = Math.round((computed - stored) * 100) / 100;
    return { computed, stored, diff };
  }, [filteredEvents, journey, showBalance]);

  function toggleType(id) {
    setTypeFilter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const comboboxOptions = useMemo(() =>
    partsCat.map(p => ({
      value: p.part_code,
      label: `${p.part_code}${p.part_name ? ' — ' + p.part_name : ''}`,
    })),
  [partsCat]);

  return (
    <div style={{ padding: 16 }}>
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <span>Part Journey</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
            Unified timeline of every transaction touching one part
          </span>
        </div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ minWidth: 320, flex: 1, maxWidth: 480 }}>
              <Combobox
                value={partCode}
                onChange={(v) => { setPartCode(v); loadJourney(v); }}
                options={comboboxOptions}
                placeholder="Type a part code or name…"
              />
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--t2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={showBalance} onChange={e => setShowBalance(e.target.checked)} />
              Running balance
            </label>
          </div>

          {loading ? <Spinner label="Loading journey…" /> : !journey ? (
            <EmptyState title="Pick a part" message="Start typing a part code or name above to see its full transaction history." />
          ) : (
            <>
              {/* Part header + stock tiles */}
              <div style={{ marginBottom: 14, padding: '12px 14px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--yellow)' }}>{journey.part_code}</div>
                    <div style={{ fontSize: 13, color: 'var(--t1)', marginTop: 2 }}>{journey.part_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                      {journey.product ? <>Product: <strong style={{ color: 'var(--t2)' }}>{journey.product}</strong></> : <span>cross-product</span>}
                      {journey.category && <> · {journey.category}</>}
                    </div>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
                    {journey.event_count} event{journey.event_count === 1 ? '' : 's'}
                  </div>
                </div>
                {journey.stock && (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <StockTile label="Opening"  value={journey.stock.opening_stock}  tone="gray"   />
                    <StockTile label="Received" value={journey.stock.total_received} tone="green"  />
                    <StockTile label="Issued"   value={journey.stock.total_issued}   tone="blue"   />
                    <StockTile label="Returned" value={journey.stock.returned}       tone="orange" />
                    <StockTile label="Closing"  value={journey.stock.closing_stock}  tone="yellow" />
                  </div>
                )}
              </div>

              {/* Type filter chips */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', letterSpacing: '.08em', marginRight: 6 }}>FILTER:</span>
                {EVENT_TYPES.map(t => {
                  const active = typeFilter.has(t.id);
                  const s = TONE_STYLES[t.tone];
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleType(t.id)}
                      style={{
                        background: active ? s.bg : 'transparent',
                        border: `1px solid ${active ? s.border : 'var(--border)'}`,
                        color: active ? s.fg : 'var(--t3)',
                        borderRadius: 3, padding: '3px 9px', fontSize: 10,
                        cursor: 'pointer', fontFamily: 'var(--cond)',
                        letterSpacing: '0.05em', textTransform: 'uppercase',
                        fontWeight: active ? 700 : 400,
                      }}
                    >{t.label}</button>
                  );
                })}
              </div>

              {reconGap && Math.abs(reconGap.diff) > 0.001 && (
                <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)', borderRadius: 3, fontSize: 11, color: '#fbbf24' }}>
                  ⚠ Computed running balance ({fmtQty(reconGap.computed)}) differs from stored closing_stock ({fmtQty(reconGap.stored)}) by{' '}
                  <strong>{reconGap.diff > 0 ? '+' : ''}{fmtQty(reconGap.diff)}</strong>.{' '}
                  This usually means some flush dispositions or damage events are showing as &apos;neutral&apos; but were already reflected in the ledger via the underlying issue/receipt.
                </div>
              )}

              {/* Timeline */}
              {filteredEvents.length === 0 ? (
                <EmptyState title="No events" message="No transactions match the current filter." />
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={tableThStyle}>When</th>
                        <th style={tableThStyle}>Type</th>
                        <th style={tableThStyle}>Ref</th>
                        <th style={{ ...tableThStyle, textAlign: 'right' }}>Δ Stock</th>
                        <th style={{ ...tableThStyle, textAlign: 'right' }}>Qty</th>
                        {showBalance && <th style={{ ...tableThStyle, textAlign: 'right' }}>Balance</th>}
                        <th style={tableThStyle}>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvents.map((e, i) => (
                        <tr key={i}>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{fmtTs(e.timestamp)}</td>
                          <td style={tableTdStyle}><TypeBadge type={e.type} /></td>
                          <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>{e.ref_no || '—'}</td>
                          <td style={{ ...tableTdStyle, textAlign: 'right' }}><DirectionArrow direction={e.direction} delta={e.delta} /></td>
                          <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t1)' }}>{fmtQty(e.qty)}</td>
                          {showBalance && (
                            <td style={{ ...tableTdStyle, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--t2)' }}>
                              {e._balance_after != null ? fmtQty(e._balance_after) : '—'}
                            </td>
                          )}
                          <td style={{ ...tableTdStyle, fontSize: 11, color: 'var(--t2)', maxWidth: 360, whiteSpace: 'normal' }}>{e.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
