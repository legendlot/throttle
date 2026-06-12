'use client';
/* ════════════════════════════════════════════════════════════
   LINES (Production · Runs) — Pit Wall v2. Per-line run cards
   with a completion ShiftBattery + INW→QC→PKG→OUT funnel +
   crew/downtime/FPY; operator-output table; station-takt matrix
   exposing the bottleneck. Prototype: redesign-reference/app/lines.jsx.
   Data unchanged (getLineView + getTaktTime, first-load-only takt).
   Prototype pause/reassign/open actions omitted — no backing API.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';
import {
  Icon, ShiftBattery, Panel, SectionHead, ToneBadge,
  lineColor, lineRgb, fmt,
} from '../../../components/kit/index.js';

const FUNNEL = [
  { key: 'inw',  label: 'INW',  color: 'var(--blue-bright)' },
  { key: 'qc',   label: 'QC Pass', color: 'var(--ok-fg)' },
  { key: 'pkg',  label: 'PKG',  color: 'var(--yellow)' },
  { key: 'out',  label: 'Out',  color: 'var(--green-bright)' },
];

function fpyTone(p) { return p >= 95 ? 'ok' : p >= 85 ? 'warn' : 'bad'; }

// ── Per-line run card ─────────────────────────────────────────
function LineCard({ l, crMap }) {
  const pct = Number(l.completion_pct) || 0;
  const target = Number(l.target_qty) || 0;
  const dispatched = (Number(l.rtr_count) || 0) + (Number(l.rte_count) || 0);
  // battery 'done' tracks the official completion % against target
  const done = target ? Math.round((pct / 100) * target) : dispatched;

  const counts = {
    inw: crMap[`${l.line}:INW:car`] != null ? crMap[`${l.line}:INW:car`] : (Number(l.inw_count) || 0),
    qc: Number(l.qc_pass_count) || 0,
    pkg: Number(l.pkg_count) || 0,
    out: dispatched,
  };
  const maxFunnel = Math.max(...FUNNEL.map(f => counts[f.key]), 1);
  const passRate = Number(l.pass_rate_pct) || 0;
  const firstScan = l.first_scan_at
    ? new Date(l.first_scan_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
    : null;
  const lc = lineColor(l.line);

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-card)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: lc, flexShrink: 0 }} />
        <span className="font-display" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--t1)' }}>{l.line || '—'}</span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {l.product || (l.run_no ? 'Repair run' : 'No run assigned')}
        </span>
        <span className="num" style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 'auto' }}>{l.run_no || ''}</span>
      </div>

      <div style={{ padding: 16 }}>
        {/* completion battery */}
        <div style={{ marginBottom: 14 }}>
          <ShiftBattery lineId={l.line} done={done} target={target} segments={16} height={24} />
        </div>

        {/* funnel */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
          {FUNNEL.map(f => {
            const v = counts[f.key];
            return (
              <div key={f.key} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: '9px 10px', borderTop: `2px solid ${f.color}` }}>
                <div className="eyebrow">{f.label}</div>
                <div className="num" style={{ fontSize: 17, fontWeight: 700, color: 'var(--t1)', marginTop: 4 }}>{fmt(v)}</div>
                <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-2)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(v / maxFunnel) * 100}%`, background: f.color, borderRadius: 2 }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* footer metrics */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 10, borderTop: '1px solid var(--border)',
          fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--t3)', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="users" size={13} /> <span className="num" style={{ color: 'var(--t2)' }}>{fmt(l.active_operators)}</span> crew
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="clock" size={13} /> <span className="num" style={{ color: 'var(--t2)' }}>{fmt(l.downtime_mins)}</span>m down
          </span>
          {l.pass_rate_pct != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              FPY <ToneBadge tone={fpyTone(passRate)}>{passRate}%</ToneBadge>
            </span>
          )}
          {firstScan && <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--t4)' }}><Icon name="clock" size={12} /><span className="num">{firstScan}</span></span>}
        </div>
      </div>
    </div>
  );
}

// ── Operator output table ─────────────────────────────────────
const thStyle = { padding: '0 14px 9px', textAlign: 'left', whiteSpace: 'nowrap' };
const tdBase = { padding: '10px 14px', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap', verticalAlign: 'middle' };

function OperatorTable({ ops }) {
  if (!ops.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>No operator data</div>;
  }
  const sorted = [...ops].sort((a, b) => (a.operator_name || '').localeCompare(b.operator_name || ''));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Operator', 'Line', 'INW Cars', 'INW Rmt', 'QC Pass Cars', 'QC Pass Rmt', 'QC Fail', 'Pass Rate'].map((h, i) => (
              <th key={h} className="eyebrow" style={{ ...thStyle, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, idx) => {
            const pr = Number(o.pass_rate_pct) || 0;
            const prColor = pr >= 95 ? 'var(--ok-fg)' : pr >= 85 ? 'var(--warn-fg)' : 'var(--bad-fg)';
            return (
              <tr key={idx}>
                <td style={{ ...tdBase, fontFamily: 'var(--font-ui)', color: 'var(--t1)' }}>{o.operator_name || '—'}</td>
                <td style={tdBase}>
                  {o.line ? <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(o.line), background: `rgba(${lineRgb(o.line)},0.12)`, borderRadius: 3, padding: '1px 5px' }}>{o.line}</span> : <span style={{ color: 'var(--t4)' }}>—</span>}
                </td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t1)' }}>{fmt(o.inw_car_count)}</td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t3)' }}>{fmt(o.inw_remote_count)}</td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--ok-fg)' }}>{fmt(o.qc_pass_car_count)}</td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--t3)' }}>{fmt(o.qc_pass_remote_count)}</td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: 'var(--bad-fg)' }}>{fmt(o.qc_fail_count)}</td>
                <td className="num" style={{ ...tdBase, textAlign: 'right', color: prColor, fontWeight: 600 }}>{o.pass_rate_pct != null ? o.pass_rate_pct + '%' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Station takt matrix ───────────────────────────────────────
function TaktTable({ taktRows }) {
  if (!taktRows.length) {
    return <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>No takt data for today</div>;
  }
  const stations = ['INW', 'QC', 'PKG'];
  const lines = [...new Set(taktRows.filter(r => r.line !== 'SHARED').map(r => r.line))].sort();
  const lookup = {};
  taktRows.forEach(r => { lookup[r.station + '|' + r.line] = r; });
  const pkgout = lookup['PKG_OUT|SHARED'];

  // flag the slowest (bottleneck) cell
  let bottleneck = null;
  taktRows.forEach(r => { if (r.line !== 'SHARED' && r.avg_takt_mins != null && (!bottleneck || Number(r.avg_takt_mins) > Number(bottleneck.avg_takt_mins))) bottleneck = r; });

  const tCol = v => { if (!v) return 'var(--t3)'; const n = Number(v); return n <= 5 ? 'var(--ok-fg)' : n <= 10 ? 'var(--warn-fg)' : 'var(--bad-fg)'; };
  const fmtT = v => v ? Number(v).toFixed(1) + ' min' : '—';
  const fmtR = v => v ? Number(v).toFixed(1) + '/hr' : '—';

  return (
    <div style={{ overflowX: 'auto' }}>
      {bottleneck && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)',
          borderRadius: 'var(--r-sm)', padding: '6px 11px', marginBottom: 12, fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--bad-fg)' }}>
          <Icon name="activity" size={13} /> Bottleneck: <span className="num" style={{ fontWeight: 700 }}>{bottleneck.station} · {bottleneck.line}</span> at {fmtT(bottleneck.avg_takt_mins)}/unit
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...thStyle, textAlign: 'left' }}>Station</th>
            {lines.map(l => (
              <th key={l} style={{ ...thStyle, textAlign: 'center' }}>
                <span className="num" style={{ fontSize: 11, fontWeight: 700, color: lineColor(l) }}>{l}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stations.map(st => (
            <tr key={st}>
              <td style={{ ...tdBase, color: 'var(--t2)' }}><span className="label" style={{ fontSize: 11 }}>{st}</span></td>
              {lines.map(l => {
                const r = lookup[st + '|' + l];
                if (!r) return <td key={l} style={{ ...tdBase, textAlign: 'center', color: 'var(--t4)' }}>—</td>;
                const isBn = bottleneck && r.station === bottleneck.station && r.line === bottleneck.line;
                return (
                  <td key={l} style={{ ...tdBase, textAlign: 'center', background: isBn ? 'var(--bad-bg)' : 'transparent' }}>
                    <div className="num" style={{ fontWeight: 700, color: tCol(r.avg_takt_mins) }}>{fmtT(r.avg_takt_mins)}</div>
                    <div className="num" style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{fmtR(r.units_per_hour)} · {r.units_measured}u</div>
                  </td>
                );
              })}
            </tr>
          ))}
          {pkgout && (
            <tr>
              <td style={{ ...tdBase, color: 'var(--t2)' }}><span className="label" style={{ fontSize: 11 }}>PKG_OUT</span></td>
              <td colSpan={lines.length} style={{ ...tdBase, textAlign: 'center' }}>
                <span className="num" style={{ fontWeight: 700, color: tCol(pkgout.avg_takt_mins) }}>{fmtT(pkgout.avg_takt_mins)}</span>
                <span className="num" style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 8 }}>{fmtR(pkgout.units_per_hour)} · {pkgout.units_measured}u · SHARED</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function LinesPage() {
  const { session } = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [lines, setLines] = useState([]);
  const [crMap, setCrMap] = useState({});
  const [operators, setOperators] = useState([]);
  const [takt, setTakt] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // first call includes getTaktTime; auto-refresh calls skip it (legacy behavior).
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

      const map = {};
      (lineData.car_remote || []).forEach(r => {
        map[`${r.line}:${r.activity}:${r.component_type}`] = Number(r.cnt) || 0;
      });

      setLines(lineData.lines || []);
      setCrMap(map);
      setOperators(lineData.operator_stats || []);
      if (!skipTakt && taktData) setTakt(taktData.takt || []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(new Date());
    }
  }, [session, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadAll, 30000, !session);

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;
  }

  const cards = (lines || []).filter(l => l.line !== 'SHARED' && !(l.line || '').startsWith('D'));

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)',
          padding: '10px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 20 }}>{error}</div>
      )}

      <div style={{ marginBottom: 28 }}>
        <SectionHead>Line performance</SectionHead>
        {cards.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
            {cards.map(l => <LineCard key={l.line} l={l} crMap={crMap} />)}
          </div>
        ) : (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <div style={{ display: 'inline-grid', placeItems: 'center', width: 46, height: 46, borderRadius: '50%',
              background: 'var(--surface-2)', color: 'var(--t3)', border: '1px solid var(--border-2)', marginBottom: 12 }}>
              <Icon name="factory" size={22} /></div>
            <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>No line data for today</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>No runs are active on the floor.</div>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 28 }}>
        <SectionHead>Operator output</SectionHead>
        <Panel pad={0}><OperatorTable ops={operators} /></Panel>
      </div>

      <div style={{ marginBottom: 28 }}>
        <SectionHead>Station pace · today</SectionHead>
        <Panel pad={16}><TaktTable taktRows={takt} /></Panel>
      </div>
    </div>
  );
}
