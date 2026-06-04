'use client';
import { useCallback, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, Panel, StatusBadge } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

// ── Line Cards ────────────────────────────────────────────────
function LineCards({ lines, crMap }) {
  crMap = crMap || {};
  const filtered = (lines || []).filter(l => l.line !== 'SHARED' && !(l.line || '').startsWith('D'));

  if (!filtered.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>🏭 No line data for today</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
      {filtered.map(l => {
        const pct      = l.completion_pct || 0;
        const passRate = l.pass_rate_pct  || 0;
        const pctColor = pct >= 90 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : pct >= 30 ? 'var(--orange)' : 'var(--red)';
        const fillBg   = pct >= 90 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)'  : pct >= 30 ? 'var(--orange)' : 'var(--red)';
        const badgeVariant = pct >= 90 ? 'success' : pct >= 60 ? 'brand' : pct >= 30 ? 'warning' : 'error';

        const inwCar  = crMap[`${l.line}:INW:car`];
        const inwRem  = crMap[`${l.line}:INW:remote`];
        const passCar = crMap[`${l.line}:QC_PASS:car`];
        const passRem = crMap[`${l.line}:QC_PASS:remote`];
        const failCar = crMap[`${l.line}:QC_FAIL:car`];
        const failRem = crMap[`${l.line}:QC_FAIL:remote`];

        const firstScan = l.first_scan_at
          ? new Date(l.first_scan_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
          : null;

        const statStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 };
        const valStyle  = (color) => ({ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: color || 'var(--t1)' });
        const lblStyle  = { fontSize: 9, color: 'var(--t3)', letterSpacing: '0.12em', textTransform: 'uppercase' };
        const subStyle  = { fontSize: 8, color: 'var(--t3)', marginTop: 1 };

        return (
          <Panel key={l.line} style={{ borderRadius: 6 }} padding={14}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{l.line || '—'}</div>
                <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 2 }}>{l.product || (l.run_no ? 'Repair run' : 'No run assigned')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, color: pctColor }}>{pct}%</div>
                <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 1 }}>{l.run_no || ''}</div>
              </div>
            </div>

            {/* Progress bar */}
            <div style={{ background: 'var(--border)', borderRadius: 3, height: 5, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: fillBg, borderRadius: 3, transition: 'width .5s' }} />
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4, marginBottom: 10 }}>
              <div style={statStyle}>
                <div style={valStyle('var(--t1)')}>{fmt(inwCar != null ? inwCar : l.inw_count)}</div>
                <div style={lblStyle}>INW</div>
                <div style={subStyle}>{fmt(l.inw_remote_count || 0)}R</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--green)')}>{fmt(l.qc_pass_count)}</div>
                <div style={lblStyle}>QC Pass</div>
                {passCar != null && <div style={subStyle}>{passCar}C · {passRem || 0}R</div>}
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--red)')}>{fmt(l.qc_fail_count)}</div>
                <div style={lblStyle}>QC Fail</div>
                {failCar != null && <div style={subStyle}>{failCar}C · {failRem || 0}R</div>}
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--yellow)')}>{fmt(l.pkg_count)}</div>
                <div style={lblStyle}>PKG</div>
              </div>
              <div style={statStyle}>
                <div style={valStyle('var(--green)')}>{fmt((l.rtr_count || 0) + (l.rte_count || 0))}</div>
                <div style={lblStyle}>Dispatched</div>
                <div style={subStyle}>{fmt(l.rtr_count)}R · {fmt(l.rte_count)}E</div>
              </div>
            </div>

            {/* Footer rows */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--t3)', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <span>{fmt(l.active_operators)} operators · {fmt(l.downtime_mins)}m downtime</span>
              <StatusBadge variant={badgeVariant}>{pct}% done</StatusBadge>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>
              <span>Target: {fmt(l.target_qty)} · FPY: {passRate}%</span>
              {firstScan && <span style={{ color: 'var(--t3)', marginLeft: 'auto' }}>⏱ {firstScan}</span>}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

// ── Operator Table ────────────────────────────────────────────
function OperatorTable({ ops }) {
  if (!ops.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No operator data</div>;
  }

  const sorted = [...ops].sort((a, b) => (a.operator_name || '').localeCompare(b.operator_name || ''));
  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: 600, textAlign: 'left' };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', whiteSpace: 'nowrap', color: 'var(--t1)' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Operator', 'Line', 'INW Cars', 'INW Remotes', 'QC Pass Cars', 'QC Pass Remotes', 'QC Fail', 'Pass Rate'].map(h => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, idx) => {
            const pr = o.pass_rate_pct || 0;
            const prColor = pr >= 95 ? 'var(--green)' : pr >= 85 ? 'var(--yellow)' : 'var(--red)';
            return (
              <tr key={idx}>
                <td style={{ ...tdStyle, color: 'var(--t1)' }}>{o.operator_name || '—'}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{o.line || '—'}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)' }}>{fmt(o.inw_car_count)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{fmt(o.inw_remote_count)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--green)' }}>{fmt(o.qc_pass_car_count)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>{fmt(o.qc_pass_remote_count)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: 'var(--red)' }}>{fmt(o.qc_fail_count)}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--mono)', color: prColor }}>
                  {o.pass_rate_pct != null ? o.pass_rate_pct + '%' : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Takt Table ────────────────────────────────────────────────
function TaktTable({ taktRows }) {
  if (!taktRows.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No takt data for today</div>;
  }

  const stations   = ['INW', 'QC', 'PKG'];
  const lines      = [...new Set(taktRows.filter(r => r.line !== 'SHARED').map(r => r.line))].sort();
  const lookup     = {};
  taktRows.forEach(r => { lookup[r.station + '|' + r.line] = r; });
  const pkgout     = lookup['PKG_OUT|SHARED'];

  const tCol = v => {
    if (!v) return 'var(--t3)';
    const n = Number(v);
    return n <= 5 ? 'var(--green)' : n <= 10 ? 'var(--yellow)' : 'var(--red)';
  };
  const fmtT = v => v ? Number(v).toFixed(1) + ' min' : '—';
  const fmtR = v => v ? Number(v).toFixed(1) + '/hr' : '—';

  const thStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', fontWeight: 600 };
  const tdStyle = { padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 13, borderBottom: '1px solid rgba(64,64,64,.5)', color: 'var(--t1)', textAlign: 'center' };
  const stStyle = { ...tdStyle, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--t2)', textAlign: 'left' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>Station</th>
            {lines.map(l => (
              <th key={l} style={{ ...thStyle, textAlign: 'center', color: 'var(--yellow)' }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stations.map(st => (
            <tr key={st}>
              <td style={stStyle}>{st}</td>
              {lines.map(l => {
                const r = lookup[st + '|' + l];
                if (!r) return <td key={l} style={{ ...tdStyle, color: 'var(--t3)' }}>—</td>;
                return (
                  <td key={l} style={tdStyle}>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: tCol(r.avg_takt_mins) }}>
                      {fmtT(r.avg_takt_mins)}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--t3)' }}>
                      {fmtR(r.units_per_hour)} · {r.units_measured} units
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
          {pkgout && (
            <tr>
              <td style={stStyle}>PKG_OUT</td>
              <td colSpan={lines.length} style={tdStyle}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: tCol(pkgout.avg_takt_mins) }}>
                  {fmtT(pkgout.avg_takt_mins)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 8 }}>
                  {fmtR(pkgout.units_per_hour)} · {pkgout.units_measured} units · SHARED
                </span>
              </td>
            </tr>
          )}
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

// ── Lines Page ────────────────────────────────────────────────
export default function LinesPage() {
  const { session }                         = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [lines,     setLines]     = useState([]);
  const [crMap,     setCrMap]     = useState({});
  const [operators, setOperators] = useState([]);
  const [takt,      setTakt]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  // isFirstLoadRef: first call includes getTaktTime; subsequent auto-refresh calls skip it.
  // Matches legacy: loadLines(skipTakt=false) on first/manual, loadLines(skipTakt=true) on auto.
  const isFirstLoadRef = useRef(true);

  const loadAll = useCallback(async () => {
    if (!session) return;
    const skipTakt = !isFirstLoadRef.current;
    if (isFirstLoadRef.current) isFirstLoadRef.current = false;

    setRefreshing(true);
    try {
      const today = todayStr();
      const fetches = [garageFetch('getLineView', { date: today }, session)];
      if (!skipTakt) fetches.push(garageFetch('getTaktTime', { from: today, to: today }, session));

      const [lineData, taktData] = await Promise.all(fetches);

      // Build car/remote split map: "L1:INW:car" → count
      const map = {};
      (lineData.car_remote || []).forEach(r => {
        map[`${r.line}:${r.activity}:${r.component_type}`] = Number(r.cnt) || 0;
      });

      setLines(lineData.lines || []);
      setCrMap(map);
      setOperators(lineData.operator_stats || []);

      if (!skipTakt && taktData) {
        setTakt(taktData.takt || []);
      }

      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load data');
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

      <Section label="Line Performance">
        <LineCards lines={lines} crMap={crMap} />
      </Section>

      <Section label="Operator Output">
        <Panel padding={0}>
          <OperatorTable ops={operators} />
        </Panel>
      </Section>

      <Section label="Station Pace — Today">
        <Panel padding={0}>
          <TaktTable taktRows={takt} />
        </Panel>
      </Section>
    </div>
  );
}
