'use client';
import { useCallback, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Panel, EmptyState, StatusBadge } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

function fmtMins(mins) {
  if (mins == null) return '—';
  const m = Number(mins);
  if (m < 60) return m.toFixed(1) + ' min';
  const h   = Math.floor(m / 60);
  const rem = (m % 60).toFixed(0);
  return `${h}h ${rem}m`;
}

const LINE_COLORS = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)' };

// ── Cycle Time section ────────────────────────────────────────
function CycleTimeSection({ ct, ctByLine }) {
  ctByLine = ctByLine || {};

  if (!ct || !ct.units_measured) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>Avg QC Cycle Time</div>
          <div style={{ fontSize: 20, color: 'var(--t1)', fontWeight: 600 }}>—</div>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>No data for period</div>
        </div>
      </div>
    );
  }

  const avgColor = ct.avg_mins_all <= 30 ? 'var(--green)' : ct.avg_mins_all <= 60 ? 'var(--yellow)' : 'var(--red)';

  const cardStyle = {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4,
    padding: 16, fontFamily: 'var(--mono)',
  };
  const cardLbl = { fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 };
  const cardVal = (color) => ({ fontSize: 22, color: color || 'var(--t1)', lineHeight: 1, fontWeight: 600 });
  const cardSub = { fontSize: 11, color: 'var(--t3)', marginTop: 4 };

  const activeLines = ['L1', 'L2', 'L3'].filter(l => ctByLine[l] && ctByLine[l].units_measured);

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        <div style={cardStyle}>
          <div style={cardLbl}>Avg Cycle Time</div>
          <div style={cardVal(avgColor)}>{fmtMins(ct.avg_mins_all)}</div>
          <div style={cardSub}>All lines · {fmt(ct.units_measured)} units</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLbl}>Median</div>
          <div style={cardVal()}>{fmtMins(ct.median_mins)}</div>
          <div style={cardSub}>50th percentile</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLbl}>Avg — QC Pass</div>
          <div style={cardVal('var(--green)')}>{fmtMins(ct.avg_mins_pass)}</div>
          <div style={cardSub}>Units that passed</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLbl}>Avg — QC Fail</div>
          <div style={cardVal('var(--red)')}>{fmtMins(ct.avg_mins_fail)}</div>
          <div style={cardSub}>Units that failed</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLbl}>Fastest</div>
          <div style={cardVal()}>{fmtMins(ct.fastest_mins)}</div>
          <div style={cardSub}>Quickest through QC</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLbl}>Slowest (Normal)</div>
          <div style={cardVal()}>{fmtMins(ct.slowest_normal_mins)}</div>
          <div style={cardSub}>Max within fence</div>
        </div>
      </div>

      {/* Outlier strip */}
      {Number(ct.outlier_count) > 0 && (
        <div style={{ background: 'rgba(222,42,42,.08)', border: '1px solid rgba(222,42,42,.2)', borderRadius: 3, padding: '8px 12px', fontSize: 11, color: 'var(--t2)', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span>⚠</span>
          <span><strong>{ct.outlier_count}</strong> outlier unit{Number(ct.outlier_count) > 1 ? 's' : ''} excluded from all averages above</span>
          <span style={{ color: 'var(--t3)' }}>— longest was <strong style={{ color: 'var(--t2)' }}>{fmtMins(ct.outlier_max_mins)}</strong> · IQR fence at {fmtMins(ct.outlier_threshold_mins)}</span>
        </div>
      )}

      {/* Per-line breakdown */}
      {activeLines.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activeLines.map(line => {
            const l = ctByLine[line];
            const ac = l.avg_mins_all <= 30 ? 'var(--green)' : l.avg_mins_all <= 60 ? 'var(--yellow)' : 'var(--red)';
            return (
              <div key={line} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 12, color: LINE_COLORS[line], letterSpacing: '0.08em' }}>{line}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                  {[
                    { lbl: 'Avg',        val: fmtMins(l.avg_mins_all),      color: ac,             sub: `${fmt(l.units_measured)} units` },
                    { lbl: 'Pass Avg',   val: fmtMins(l.avg_mins_pass),     color: 'var(--green)' },
                    { lbl: 'Fail Avg',   val: fmtMins(l.avg_mins_fail),     color: 'var(--red)'   },
                    { lbl: 'Median',     val: fmtMins(l.median_mins)                               },
                    { lbl: 'Fastest',    val: fmtMins(l.fastest_mins)                              },
                    { lbl: 'Slowest',    val: fmtMins(l.slowest_normal_mins),                      sub: 'within fence' },
                  ].map(({ lbl, val, color, sub }) => (
                    <div key={lbl}>
                      <div style={{ fontSize: 9, color: 'var(--t3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 3 }}>{lbl}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: color || 'var(--t1)' }}>{val}</div>
                      {sub && <div style={{ fontSize: 9, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── FPY Table ─────────────────────────────────────────────────
function FpyTable({ rows }) {
  if (!rows.length) {
    return <EmptyState icon="🎯" message="No QC data for selected period" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, idx) => {
        const pct = r.fpy_pct || 0;
        const color = pct >= 95 ? 'var(--green)' : pct >= 85 ? 'var(--yellow)' : 'var(--red)';
        return (
          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 200px 56px', alignItems: 'center', gap: 12, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3 }}>
            <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 12, color: LINE_COLORS[r.line] || 'var(--t2)' }}>{r.line || '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--t2)' }}>{r.product || '—'} <span style={{ color: 'var(--t3)' }}>· {r.scan_date}</span></div>
            <div style={{ background: 'var(--surface3)', borderRadius: 3, height: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width .5s' }} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color, textAlign: 'right' }}>{pct}%</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Top Defects grid ──────────────────────────────────────────
function DefectGrid({ rows }) {
  if (!rows.length) {
    return <EmptyState icon="✓" message="No defects logged" />;
  }

  // Group: line → functional|visual → defect_code → aggregated entry
  const byLine = {};
  rows.forEach(r => {
    const line = r.line || 'Unknown';
    if (!byLine[line]) byLine[line] = { functional: {}, visual: {} };
    const grp = (r.category || '').includes('Functional') ? 'functional' : 'visual';
    if (!byLine[line][grp][r.defect_code]) {
      byLine[line][grp][r.defect_code] = { code: r.defect_code, issue: r.issue, category: r.category, severity: r.severity, count: 0, training: false };
    }
    byLine[line][grp][r.defect_code].count    += Number(r.defect_count) || 0;
    if (r.training_flag) byLine[line][grp][r.defect_code].training = true;
  });

  const SEV_ORDER = { Critical: 0, Major: 1, Minor: 2 };
  function sortedCards(map) {
    return Object.values(map)
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || b.count - a.count)
      .slice(0, 12);
  }

  function DefectCard({ d }) {
    const sevColor = d.severity === 'Critical' ? 'var(--red)' : d.severity === 'Major' ? 'var(--orange)' : 'var(--t2)';
    return (
      <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--t1)', display: 'flex', alignItems: 'center', gap: 5 }}>
            {d.code}
            {d.training && <StatusBadge variant="info">Flag</StatusBadge>}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: 'var(--t1)' }}>{d.count}</div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 4 }}>{d.issue || '—'}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--t3)' }}>
          <span>{d.category || '—'}</span>
          <span style={{ color: sevColor }}>{d.severity || '—'}</span>
        </div>
      </div>
    );
  }

  const lineNames = Object.keys(byLine).sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {lineNames.map(line => {
        const fCards = sortedCards(byLine[line].functional);
        const vCards = sortedCards(byLine[line].visual);
        const fTotal = Object.values(byLine[line].functional).reduce((s, d) => s + d.count, 0);
        const vTotal = Object.values(byLine[line].visual).reduce((s, d) => s + d.count, 0);

        return (
          <div key={line}>
            <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 11, color: 'var(--yellow)', letterSpacing: '0.08em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, textTransform: 'uppercase' }}>
              {line}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', fontWeight: 400, textTransform: 'none' }}>{fTotal + vTotal} total occurrences</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Functional <span style={{ color: 'var(--red)', fontWeight: 700 }}>{fTotal}</span>
                </div>
                {fCards.length
                  ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8 }}>{fCards.map((d, i) => <DefectCard key={i} d={d} />)}</div>
                  : <div style={{ fontSize: 11, color: 'var(--t3)', padding: '4px 0' }}>None</div>}
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Visual <span style={{ color: 'var(--orange)', fontWeight: 700 }}>{vTotal}</span>
                </div>
                {vCards.length
                  ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8 }}>{vCards.map((d, i) => <DefectCard key={i} d={d} />)}</div>
                  : <div style={{ fontSize: 11, color: 'var(--t3)', padding: '4px 0' }}>None</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Defect Breakdown ──────────────────────────────────────────
function DefectBreakdown({ rows }) {
  const [openSet, setOpenSet] = useState(new Set());

  function toggle(pi) {
    setOpenSet(prev => {
      const next = new Set(prev);
      next.has(pi) ? next.delete(pi) : next.add(pi);
      return next;
    });
  }

  if (!rows.length) {
    return <EmptyState icon="📊" message="No defect data for selected period" />;
  }

  const SEV_ORDER = { Critical: 0, Major: 1, Minor: 2 };

  // Build: product → component_type → severity → defects
  const byProduct = {};
  rows.forEach(r => {
    const p = r.product || 'Unknown';
    const c = r.component_type || 'car';
    const s = r.severity || 'Minor';
    if (!byProduct[p]) byProduct[p] = { total: 0, components: {} };
    if (!byProduct[p].components[c]) byProduct[p].components[c] = { total: 0, bySev: {} };
    if (!byProduct[p].components[c].bySev[s]) byProduct[p].components[c].bySev[s] = { total: 0, defects: [] };
    const n = Number(r.defect_count) || 0;
    byProduct[p].total                         += n;
    byProduct[p].components[c].total           += n;
    byProduct[p].components[c].bySev[s].total  += n;
    byProduct[p].components[c].bySev[s].defects.push({ code: r.defect_code, issue: r.issue, count: n, training: r.training_flag });
  });

  const products = Object.keys(byProduct).sort();

  const SEV_COLORS = {
    Critical: { bg: 'rgba(222,42,42,.15)', color: '#ff7070', border: '1px solid rgba(222,42,42,.25)' },
    Major:    { bg: 'rgba(249,115,22,.15)', color: '#fb923c', border: '1px solid rgba(249,115,22,.25)' },
    Minor:    { bg: 'rgba(80,80,80,.2)',    color: '#888',    border: '1px solid rgba(80,80,80,.3)'   },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {products.map((prod, pi) => {
        const pd      = byProduct[prod];
        const isOpen  = openSet.has(pi);
        const comps   = Object.keys(pd.components).sort();

        return (
          <div key={prod}>
            {/* Product row — clickable */}
            <div
              onClick={() => toggle(pi)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: isOpen ? '4px 4px 0 0' : 4, cursor: 'pointer', userSelect: 'none' }}
            >
              <span style={{ fontSize: 10, color: 'var(--t3)', transition: 'transform 0.15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
              <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13, color: 'var(--t1)' }}>{prod}</span>
              <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)' }}>
                <strong style={{ color: 'var(--t2)' }}>{pd.total}</strong> defect occurrences
              </div>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 4px 4px', padding: 14 }}>
                {comps.map(comp => {
                  const cd         = pd.components[comp];
                  const compLabel  = comp === 'car' ? 'Car' : 'Remote';
                  const compColor  = comp === 'car' ? 'var(--yellow)' : 'var(--blue)';
                  const sevs       = Object.keys(cd.bySev).sort((a, b) => (SEV_ORDER[a] ?? 9) - (SEV_ORDER[b] ?? 9));

                  return (
                    <div key={comp} style={{ marginBottom: 14 }}>
                      <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 11, color: compColor, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {compLabel} <span style={{ color: 'var(--t3)', fontSize: 9, fontWeight: 400, textTransform: 'none' }}>{cd.total} occurrences</span>
                      </div>
                      {sevs.map(sev => {
                        const sd = cd.bySev[sev];
                        const defects = sd.defects.sort((a, b) => b.count - a.count);
                        const tone = SEV_COLORS[sev] || SEV_COLORS.Minor;
                        return (
                          <div key={sev} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 2, marginBottom: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', ...{ background: tone.bg, color: tone.color, border: tone.border } }}>
                              {sev} <span style={{ fontWeight: 400, opacity: 0.7 }}>{sd.total} occurrences</span>
                            </div>
                            {defects.map((d, di) => (
                              <div key={di} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', fontSize: 11, borderBottom: '1px solid rgba(42,42,42,.4)' }}>
                                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)', minWidth: 80 }}>{d.code}</span>
                                <span style={{ color: 'var(--t2)', flex: 1 }}>{d.issue || '—'}</span>
                                {d.training && <StatusBadge variant="info">Training</StatusBadge>}
                                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, color: 'var(--t1)', minWidth: 24, textAlign: 'right' }}>{d.count}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Repeat Defects Table ──────────────────────────────────────
function RepeatDefectsTable({ rows }) {
  if (!rows.length) {
    return <EmptyState icon="↻" message="No repeat failures" />;
  }

  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['UPC', 'Product', 'Total Defects', 'Unique Codes', 'Codes'].map(h => <th key={h} style={thStyle}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r, idx) => (
            <tr key={idx}>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)' }}>{r.upc}</td>
              <td style={tdStyle}>{r.product || '—'}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--red)' }}>{r.total_defects}</td>
              <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{r.unique_defect_codes}</td>
              <td style={{ ...tdStyle, fontSize: 10, color: 'var(--t3)' }}>{(r.defect_codes || []).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ margin: '0 0 14px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t2)' }}>
        {label}
      </h2>
      {children}
    </div>
  );
}

// ── QC Page ───────────────────────────────────────────────────
export default function QcPage() {
  const { session }                         = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [cycleTime,   setCycleTime]   = useState(null);
  const [ctByLine,    setCtByLine]    = useState({});
  const [fpy,         setFpy]         = useState([]);
  const [heatmap,     setHeatmap]     = useState([]);
  const [breakdown,   setBreakdown]   = useState([]);
  const [repeats,     setRepeats]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);

  const loadAll = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const today = todayStr();
      const data  = await garageFetch('getQCView', { from: today, to: today }, session);

      setCycleTime(data.cycle_time       || null);
      setCtByLine(data.cycle_time_lines  || {});
      setFpy(data.fpy                    || []);
      setHeatmap(data.heatmap            || []);
      setBreakdown(data.defect_breakdown || []);
      setRepeats(data.repeat_defects     || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load QC data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadAll, 30000, !session);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 20 }}>
          {error}
        </div>
      )}

      <Section label="QC Cycle Time — INW to Outcome">
        <CycleTimeSection ct={cycleTime} ctByLine={ctByLine} />
      </Section>

      <Section label="First Pass Yield by Line">
        <FpyTable rows={fpy} />
      </Section>

      <Section label="Top Defects">
        <DefectGrid rows={heatmap} />
      </Section>

      <Section label="Defect Breakdown by Product">
        <DefectBreakdown rows={breakdown} />
      </Section>

      <Section label="Repeat Failures">
        <Panel padding={0}>
          <RepeatDefectsTable rows={repeats} />
        </Panel>
      </Section>
    </div>
  );
}
