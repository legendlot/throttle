'use client';
import { useState, useMemo } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { KpiCard, EmptyState, Spinner } from '@throttle/ui';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

// TD-020: replace with dynamic getMaterials call once shared useProducts() lands in G-W2.
const PRODUCT_VARIANTS = {
  'Flare':    ['Track','Race','Underground','Street','Burnout'],
  'Flare LE': ['Race'],
  'Ghost':    ['Burnout','Street','Underground'],
  'Knox':     ['Adventure','Explorer'],
  'Shadow':   ['Asphalt','Tarmac'],
  'Nitro':    ['Race Grey','Race Blue','Tarmac Black','Tarmac Green','Tarmac Grey','Burnout Red'],
  'Dash':     ['Street White','Green','Black','Blue','Silver','Urban Red','Urban White','Sports Yellow','Sports Blue'],
  'Fang':     [],
  'Atlas':    [],
};
const PRODUCTS = Object.keys(PRODUCT_VARIANTS);

// Tone keys match legacy .badge-* classes — used by StatusBadge
const ACT_TONES = {
  GRN:      'green',
  WO:       'blue',
  Issue:    'yellow',
  Return:   'red',
  Shipment: 'blue',
  Flush:    'yellow',
  PO:       'gray',
  Run:      'gray',
};

const ACT_ICONS = {
  GRN_CREATED:       '📥', GRN_FROM_RECEIVING: '📦',
  WO_CREATED:        '🏭', STOCK_ISSUED:       '📤',
  RETURN_LOGGED:     '🔄', SHIPMENT_CREATED:   '🚢',
  FLUSH_CREATED:     '🔁', FLUSH_VERIFIED:     '✅',
  PO_CREATED:        '📋', PO_APPROVED:        '✔',
  PO_STATUS_UPDATED: '🔀', PO_CANCELLED:       '✖',
};

function formatActivityTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function loadMain(session, setKpis, setSections, setMainLoading, setMainError, setRefreshing) {
  setMainLoading(true);
  setRefreshing(true);
  setMainError(null);
  try {
    const [kpisRes, grnsRes, issuesRes, returnsRes, shipmentsRes] = await Promise.all([
      garageFetch('getDashboard',  {}, session),
      garageFetch('getGRNSummary', {}, session),
      garageFetch('getIssues',     {}, session),
      garageFetch('getReturns',    {}, session),
      garageFetch('getShipments',  {}, session),
    ]);
    setKpis(kpisRes);
    setSections({ grns: grnsRes, issues: issuesRes, returns: returnsRes, shipments: shipmentsRes });
  } catch (e) {
    setMainError(e.message);
  } finally {
    setMainLoading(false);
    setRefreshing(false);
  }
}

async function loadProducible(session, setProducible, setProdLoading) {
  setProdLoading(true);
  try {
    const results = await Promise.all(
      PRODUCTS.map(product =>
        garageFetch('calcKit', { product, variant: '', colour: '', qty: 1 }, session)
          .then(data => ({ product, ok: true, kit: data.kit || [] }))
          .catch(() => ({ product, ok: false, kit: [] }))
      )
    );
    const rows = results
      .filter(r => r.ok && r.kit.length > 0)
      .map(({ product, kit }) => {
        const producible = kit.map(r => ({
          part_code: r.part_code,
          part_name: r.part_name,
          bom_qty:   r.bom_qty || 1,
          available: r.available || 0,
          max_units: r.bom_qty > 0 ? Math.floor((r.available || 0) / r.bom_qty) : 0,
        }));
        const maxPossible = Math.max(0, ...producible.map(r => r.max_units));
        const bottleneck  = producible.reduce((min, r) => r.max_units < min.max_units ? r : min, producible[0]);
        const shorts      = producible.filter(r => r.max_units < maxPossible);
        return { product, bottleneck, maxPossible, shorts };
      });
    setProducible(rows);
  } catch (e) {
    setProducible([]);
  } finally {
    setProdLoading(false);
  }
}

async function loadActivity(session, setActivity, setActLoading) {
  setActLoading(true);
  try {
    const data = await garageFetch('getActivityLog', { limit: 10 }, session);
    setActivity(data || []);
  } catch (e) {
    setActivity([]);
  } finally {
    setActLoading(false);
  }
}

const panelStyle = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden', marginBottom: 16 };
const panelHeaderStyle = {
  padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--t2)',
};
const twoColStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 };
const tableTdStyle = { padding: '9px 10px', fontSize: 12, borderBottom: '1px solid rgba(42,42,42,.6)', whiteSpace: 'nowrap' };
const tableThStyle = { padding: '8px 10px', fontSize: 10, textAlign: 'left', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };

// Matches legacy .badge + .badge-* rgba values exactly
const BADGE_STYLES = {
  yellow: { background: 'rgba(242,205,26,.12)', color: '#f2cd1a', border: '1px solid rgba(242,205,26,.2)' },
  green:  { background: 'rgba(34,197,94,.12)',  color: '#4ade80', border: '1px solid rgba(34,197,94,.2)'  },
  red:    { background: 'rgba(222,42,42,.15)',  color: '#ff7070', border: '1px solid rgba(222,42,42,.25)' },
  blue:   { background: 'rgba(33,60,226,.2)',   color: '#7b93ff', border: '1px solid rgba(33,60,226,.3)'  },
  orange: { background: 'rgba(255,140,0,.15)',  color: '#ffaa33', border: '1px solid rgba(255,140,0,.25)' },
  gray:   { background: 'rgba(80,80,80,.2)',    color: '#888',    border: '1px solid rgba(80,80,80,.3)'   },
};
function StatusBadge({ label, tone = 'gray' }) {
  const s = BADGE_STYLES[tone] || BADGE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase', ...s,
    }}>{label}</span>
  );
}

function shipmentStatusTone(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('arriv') && !s.includes('complete')) return 'yellow';
  if (s.includes('progress')) return 'blue';
  if (s.includes('complete')) return 'green';
  return 'gray';
}

function formatDisplayDate(raw) {
  if (!raw) return '—';
  const str = String(raw);
  if (/^\d{2}-[A-Za-z]{3}-\d{4}/.test(str)) return str.slice(0, 11);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return String(d.getDate()).padStart(2, '0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
    }
  }
  return str.slice(0, 10);
}

export default function DashboardPage() {
  const { session, perms } = useAuth();
  const { setRefreshing } = useRefreshState();
  const [kpis, setKpis] = useState(null);
  const [sections, setSections] = useState({ grns: [], issues: [], returns: [], shipments: [] });
  const [mainLoading, setMainLoading] = useState(true);
  const [mainError, setMainError] = useState(null);
  const [producible, setProducible] = useState([]);
  const [prodLoading, setProdLoading] = useState(true);
  const [activity, setActivity] = useState([]);
  const [actLoading, setActLoading] = useState(true);
  const [expandedIndex, setExpandedIndex] = useState(null);

  function loadAll() {
    if (!session) return;
    loadMain(session, setKpis, setSections, setMainLoading, setMainError, setRefreshing);
    loadProducible(session, setProducible, setProdLoading);
    loadActivity(session, setActivity, setActLoading);
  }

  useAutoRefresh(loadAll, 60000, !session);

  const cutoff7  = useMemo(() => daysAgo(7),  []);
  const cutoff3  = useMemo(() => daysAgo(3),  []);
  const cutoff30 = useMemo(() => daysAgo(30), []);

  const recentShipments = useMemo(() => {
    return (sections.shipments || []).filter(s => {
      const d = new Date(s.arrival_date || s.created_at || '');
      return !isNaN(d) && d >= cutoff7;
    });
  }, [sections.shipments, cutoff7]);

  const recentGRNs = useMemo(() => {
    return (sections.grns || []).filter(r => {
      const d = new Date(r.grn_date || '');
      return !isNaN(d) && d >= cutoff7;
    });
  }, [sections.grns, cutoff7]);

  const { plannedIssues, adhocIssues } = useMemo(() => {
    const all = sections.issues || [];
    const seen = new Set();
    const planned = all.filter(r => {
      const d = new Date(r.issue_date || '');
      const isPlanned = (r.issue_type || '').toLowerCase() !== 'ad hoc';
      if (isPlanned && !isNaN(d) && d >= cutoff7 && !seen.has(r.issue_no)) {
        seen.add(r.issue_no);
        return true;
      }
      return false;
    });
    const adhoc = all.filter(r => {
      const d = new Date(r.issue_date || '');
      return (r.issue_type || '').toLowerCase() === 'ad hoc' && !isNaN(d) && d >= cutoff3;
    });
    return { plannedIssues: planned, adhocIssues: adhoc };
  }, [sections.issues, cutoff7, cutoff3]);

  const returnsByChannel = useMemo(() => {
    const all = (sections.returns || []).filter(r => {
      const d = new Date(r.return_date || r.created_at || '');
      return !isNaN(d) && d >= cutoff30;
    });
    const map = {};
    all.forEach(r => {
      const ch = r.channel || 'Other';
      map[ch] = (map[ch] || 0) + (r.qty || 1);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [sections.returns, cutoff30]);

  const reorderFlags = Array.isArray(kpis?.reorder_flags) ? kpis.reorder_flags : [];
  const reorderCount = kpis?.reorder_count ?? reorderFlags.length;
  const returnsTotal = returnsByChannel.reduce((acc, [, qty]) => acc + qty, 0);
  const returnsMax = returnsByChannel.length ? Math.max(...returnsByChannel.map(([, q]) => q)) : 0;

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Dashboard
        </h1>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          {kpis?.as_of || '—'}
        </span>
      </div>

      {mainError && (
        <div style={panelStyle}>
          <EmptyState message={mainError} />
          <div style={{ textAlign: 'center', paddingBottom: 16 }}>
            <button
              onClick={loadAll}
              style={{ background: 'var(--surface2)', color: 'var(--t1)', border: '1px solid var(--surface2)',
                padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12 }}
            >Retry</button>
          </div>
        </div>
      )}

      {mainLoading && !kpis && !mainError ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spinner /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
          <KpiCard label="Open Work Orders" value={kpis?.open_work_orders ?? '—'} color="yellow" />
          <KpiCard label="Today's GRNs"     value={kpis?.today_grn_count   ?? '—'} color="green"  />
          <KpiCard label="WOs Issued Today" value={kpis?.today_wo_count    ?? '—'} color="blue"   />
          <KpiCard
            label="Reorder Flags"
            value={reorderCount ?? '—'}
            color={reorderCount > 0 ? 'red' : 'green'}
          />
          {hasPermission(perms, 'reports_finance') && (
            <KpiCard
              label="Stock Value (₹)"
              value={kpis?.total_stock_value !== undefined
                ? '₹' + Number(kpis.total_stock_value).toLocaleString('en-IN')
                : '—'}
              color="yellow"
            />
          )}
          <KpiCard label="Pending Returns" value={kpis?.pending_returns ?? '—'} color="green" />
        </div>
      )}

      <div style={twoColStyle}>
        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>🔴 Reorder Flags</span>
            <span style={{ color: reorderCount > 0 ? 'var(--red)' : 'var(--green)' }}>{reorderCount || 0}</span>
          </header>
          <div style={{ padding: '12px 16px' }}>
            {reorderFlags.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--green)', fontSize: 12 }}>
                ✅ No reorder flags
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {reorderFlags.slice(0, 10).map((r, i) => (
                  <div key={i} style={{
                    padding: '10px 12px',
                    background: 'rgba(222,42,42,.06)',
                    border: '1px solid rgba(222,42,42,.15)',
                    borderRadius: 3,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: 12, color: 'var(--t1)' }}>{r.part_name}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                        {r.part_code} · {r.product || '—'}
                      </div>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--red)' }}>
                      {r.closing_stock ?? 0} / {r.reorder_level ?? 0}
                    </div>
                  </div>
                ))}
                {reorderFlags.length > 10 && (
                  <div style={{ fontSize: 11, color: 'var(--t3)', textAlign: 'center', paddingTop: 4 }}>
                    + {reorderFlags.length - 10} more parts need reordering
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Producible Units by Product</span>
            <span style={{ color: 'var(--t3)' }}>{producible.length} products</span>
          </header>
          <div>
            {prodLoading ? (
              <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
            ) : producible.length === 0 ? (
              <EmptyState message="No producible data" />
            ) : (
              producible.map((row, i) => {
                const constrained = row.shorts.length > 0;
                const color = row.maxPossible === 0 ? 'var(--red)' : 'var(--green)';
                const pct = row.maxPossible > 0 && row.bottleneck
                  ? Math.round((row.bottleneck.max_units / row.maxPossible) * 100)
                  : 0;
                const isOpen = expandedIndex === i;
                const isLast = i === producible.length - 1;
                return (
                  <div key={row.product} style={{
                    padding: '9px 16px',
                    borderBottom: isLast ? 'none' : '1px solid var(--border)',
                  }}>
                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                      onClick={() => setExpandedIndex(isOpen ? null : i)}
                    >
                      <div>
                        <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14 }}>{row.product}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                          Bottleneck: {row.bottleneck?.part_name || '—'}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 20, color }}>
                          {row.maxPossible.toLocaleString()}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>units producible</div>
                      </div>
                    </div>
                    {constrained && (
                      <div style={{ marginTop: 5 }}>
                        <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: 4, background: color, borderRadius: 2 }} />
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                          {pct}% of max potential ({row.maxPossible.toLocaleString()} units)
                        </div>
                      </div>
                    )}
                    {isOpen && constrained && row.shorts.length > 0 && (
                      <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, fontSize: 11 }}>
                        <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                          WHAT'S NEEDED TO REACH {row.maxPossible.toLocaleString()} UNITS
                        </div>
                        {row.shorts.slice(0, 3).map((s, j) => {
                          const needed = (row.maxPossible - s.max_units) * s.bom_qty;
                          return (
                            <div key={j} style={{
                              display: 'flex', justifyContent: 'space-between', padding: '3px 0',
                              borderBottom: j < Math.min(row.shorts.length, 3) - 1 ? '1px solid rgba(42,42,42,.4)' : 'none',
                            }}>
                              <span style={{ color: 'var(--t2)' }}>
                                {s.part_name} <span style={{ color: 'var(--t3)', fontSize: 10 }}>({s.part_code})</span>
                              </span>
                              <span style={{ color: 'var(--yellow)', fontFamily: 'var(--mono)' }}>
                                need {needed} more → {row.maxPossible} units
                              </span>
                            </div>
                          );
                        })}
                        {row.shorts.length > 3 && (
                          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
                            + {row.shorts.length - 3} more parts short
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      <section style={panelStyle}>
        <header style={panelHeaderStyle}>
          <span>Recent Shipments — Last 7 Days</span>
          <span style={{ color: 'var(--t3)' }}>{recentShipments.length}</span>
        </header>
        {recentShipments.length === 0 ? (
          <EmptyState message="No shipments in the last 7 days" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={tableThStyle}>Shipment</th>
              <th style={tableThStyle}>Supplier</th>
              <th style={tableThStyle}>Arrival</th>
              <th style={tableThStyle}>Boxes</th>
              <th style={tableThStyle}>Parts</th>
              <th style={tableThStyle}>Status</th>
            </tr></thead>
            <tbody>
              {recentShipments.map((s, i) => (
                <tr key={i}>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{s.shipment_id || '—'}</td>
                  <td style={tableTdStyle}>{s.supplier || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDisplayDate(s.arrival_date)}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                    {(s.total_boxes_received ?? 0)} / {(s.total_boxes_expected ?? 0)}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                    {(s.parts_counted ?? 0)} / {(s.total_parts ?? 0)}
                  </td>
                  <td style={tableTdStyle}>
                    <StatusBadge label={s.status || '—'} tone={shipmentStatusTone(s.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div style={twoColStyle}>
        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Recent GRNs — Last 7 Days</span>
            <span style={{ color: 'var(--t3)' }}>{recentGRNs.length}</span>
          </header>
          {recentGRNs.length === 0 ? (
            <EmptyState message="No GRNs in the last 7 days" />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>GRN No</th>
                <th style={tableThStyle}>Date</th>
                <th style={tableThStyle}>Supplier</th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Lines · Qty</th>
              </tr></thead>
              <tbody>
                {recentGRNs.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{r.grn_no || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDisplayDate(r.grn_date)}</td>
                    <td style={tableTdStyle}>{r.supplier || '—'}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{(r.lines ?? '—')} · {(r.total_qty ?? 0).toLocaleString()} pcs</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Planned Issues — Last 7 Days</span>
            <span style={{ color: 'var(--t3)' }}>{plannedIssues.length}</span>
          </header>
          {plannedIssues.length === 0 ? (
            <EmptyState message="No planned issues in 7 days" />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Issue No</th>
                <th style={tableThStyle}>WO</th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Units</th>
                <th style={tableThStyle}>Date</th>
              </tr></thead>
              <tbody>
                {plannedIssues.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.issue_no || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.wo_no || r.work_order_no || '—'}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.units_planned ?? '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{formatDisplayDate(r.issue_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div style={twoColStyle}>
        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Ad Hoc Issues — Last 3 Days</span>
            <span style={{ color: 'var(--t3)' }}>{adhocIssues.length}</span>
          </header>
          {adhocIssues.length === 0 ? (
            <EmptyState message="No ad hoc issues in 3 days" />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={tableThStyle}>Issue No</th>
                <th style={tableThStyle}>Product</th>
                <th style={tableThStyle}>Part</th>
                <th style={tableThStyle}>Qty</th>
                <th style={tableThStyle}>Date</th>
              </tr></thead>
              <tbody>
                {adhocIssues.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.issue_no || '—'}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={tableTdStyle}>{r.part_name || r.part_code || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.qty ?? '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.issue_date || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Returns by Channel — Last 30 Days</span>
            <span style={{ color: 'var(--t3)' }}>{returnsTotal} total</span>
          </header>
          {returnsByChannel.length === 0 ? (
            <EmptyState message="No returns in the last 30 days" />
          ) : (
            <div style={{ padding: '8px 16px' }}>
              {returnsByChannel.map(([channel, qty]) => {
                const pct = returnsMax > 0 ? (qty / returnsMax) * 100 : 0;
                return (
                  <div key={channel} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 60px', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
                    <span>{channel}</span>
                    <div style={{ background: 'var(--surface2)', borderRadius: 3, height: 10, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, background: 'var(--red)', height: '100%' }} />
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', textAlign: 'right' }}>{qty}</span>
                  </div>
                );
              })}
              <div style={{ fontSize: 11, color: 'var(--t3)', paddingTop: 8 }}>
                {returnsTotal} total · last 30 days
              </div>
            </div>
          )}
        </section>
      </div>

      <section style={panelStyle}>
        <header style={panelHeaderStyle}>
          <span>Recent Activity</span>
          <a href="/activity" style={{ color: 'var(--t3)', fontSize: 11, textDecoration: 'none' }}>View all →</a>
        </header>
        {actLoading ? (
          <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
        ) : activity.length === 0 ? (
          <EmptyState message="No activity yet" />
        ) : (
          <div>
            {activity.map((a, i) => {
              const tone  = ACT_TONES[a.entity_type] || 'gray';
              const icon  = ACT_ICONS[a.action] || '·';
              return (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 16px', borderBottom: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <StatusBadge label={a.entity_type || '—'} tone={tone} />
                    <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {icon} {a.summary || a.message || '—'}
                    </span>
                  </div>
                  <div style={{ flexShrink: 0, marginLeft: 12, textAlign: 'right' }}>
                    <div style={{ fontSize: 10, fontWeight: 600 }}>{a.actor || '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--t3)' }}>{formatActivityTime(a.logged_at || a.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
