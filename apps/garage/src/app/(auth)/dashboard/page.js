'use client';
import { useState, useMemo } from 'react';
import { useAuth, hasPermission } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
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

const ACT_COLORS = {
  grn:        'var(--green)',
  issue:      'var(--blue)',
  return:     'var(--red)',
  shipment:   'var(--yellow)',
  work_order: 'var(--blue)',
  po:         'var(--yellow)',
  user:       'var(--t2)',
};

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
      workerFetch('getDashboard',  {}, session),
      workerFetch('getGRNSummary', {}, session),
      workerFetch('getIssues',     {}, session),
      workerFetch('getReturns',    {}, session),
      workerFetch('getShipments',  {}, session),
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
        workerFetch('calcKit', { product, variant: '', colour: '', qty: 1 }, session)
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
    const data = await workerFetch('getActivityLog', { limit: 10 }, session);
    setActivity(data || []);
  } catch (e) {
    setActivity([]);
  } finally {
    setActLoading(false);
  }
}

const panelStyle = { backgroundColor: 'var(--surface)', borderRadius: 6, overflow: 'hidden', marginBottom: 16 };
const panelHeaderStyle = {
  padding: '10px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  borderBottom: '1px solid var(--surface2)',
  fontFamily: 'var(--mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1,
  color: 'var(--t1)',
};
const twoColStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 };
const tableTdStyle = { padding: '6px 10px', fontSize: 12, borderBottom: '1px solid var(--surface2)' };
const tableThStyle = { padding: '6px 10px', fontSize: 11, textAlign: 'left', color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1 };

function StatusBadge({ label, color }) {
  return (
    <span style={{
      padding: '2px 6px', borderRadius: 3, fontFamily: 'var(--mono)',
      fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
      background: `${color}22`, color,
    }}>{label}</span>
  );
}

function shipmentStatusColor(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('arriv') && !s.includes('complete')) return 'var(--yellow)';
  if (s.includes('progress')) return 'var(--blue)';
  if (s.includes('complete')) return 'var(--green)';
  if (s.includes('closed'))   return 'var(--t3)';
  return 'var(--t3)';
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

  useAutoRefresh(loadAll, 60000);

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
        <h1 style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 900, textTransform: 'uppercase', margin: 0 }}>
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
          <div style={{ padding: '8px 0' }}>
            {reorderFlags.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: 'var(--green)', fontSize: 12 }}>
                ✅ No reorder flags
              </div>
            ) : (
              <>
                {reorderFlags.slice(0, 10).map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 16px', fontSize: 12 }}>
                    <div>
                      <div style={{ color: 'var(--t1)' }}>{r.part_name}</div>
                      <div style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                        {r.part_code} · {r.product || '—'}
                      </div>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', color: 'var(--red)' }}>
                      {r.closing_stock ?? 0} / {r.reorder_level ?? 0}
                    </div>
                  </div>
                ))}
                {reorderFlags.length > 10 && (
                  <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--t3)', textAlign: 'center' }}>
                    + {reorderFlags.length - 10} more parts need reordering
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>Producible Units by Product</span>
            <span style={{ color: 'var(--t3)' }}>{producible.length} products</span>
          </header>
          <div style={{ padding: '8px 0' }}>
            {prodLoading ? (
              <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
            ) : producible.length === 0 ? (
              <EmptyState message="No producible data" />
            ) : (
              producible.map((row, i) => {
                const constrained = row.maxPossible === 0;
                const color = constrained ? 'var(--red)' : 'var(--green)';
                const isOpen = expandedIndex === i;
                return (
                  <div key={row.product}>
                    <button
                      onClick={() => setExpandedIndex(isOpen ? null : i)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'baseline',
                        padding: '6px 16px', fontSize: 12, background: 'transparent', border: 'none',
                        color: 'var(--t1)', fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <span>{row.product}</span>
                      <span style={{ fontFamily: 'var(--mono)', color, fontWeight: 700 }}>
                        {row.maxPossible}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--t3)', marginLeft: 8 }}>
                        {row.bottleneck?.part_name || '—'}
                      </span>
                    </button>
                    {isOpen && row.shorts.slice(0, 3).map((s, j) => (
                      <div key={j} style={{ padding: '2px 32px', fontSize: 11, color: 'var(--t3)' }}>
                        {s.part_name} — need {Math.max(0, s.bom_qty - (s.available % s.bom_qty || 0))} more → {s.max_units} units possible
                      </div>
                    ))}
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
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{s.shipment_no || s.id || '—'}</td>
                  <td style={tableTdStyle}>{s.supplier || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{s.arrival_date || '—'}</td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>
                    {(s.boxes_received ?? 0)} / {(s.boxes_expected ?? 0)}
                  </td>
                  <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{s.parts_count ?? '—'}</td>
                  <td style={tableTdStyle}>
                    <StatusBadge label={s.status || '—'} color={shipmentStatusColor(s.status)} />
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
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.grn_date || '—'}</td>
                    <td style={tableTdStyle}>{r.supplier || '—'}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{(r.line_count ?? '—')} · {(r.total_qty ?? '—')} pcs</td>
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
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.wo_no || '—'}</td>
                    <td style={tableTdStyle}>{r.product || '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.units ?? '—'}</td>
                    <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{r.issue_date || '—'}</td>
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
          <div style={{ padding: '8px 0' }}>
            {activity.map((a, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 16px', fontSize: 12, borderBottom: '1px solid var(--surface2)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <StatusBadge label={a.entity_type || '—'} color={ACT_COLORS[a.entity_type] || 'var(--t2)'} />
                  <span>{a.summary || a.message || '—'}</span>
                </div>
                <div style={{ color: 'var(--t3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  {a.actor || '—'} · {a.created_at || ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
