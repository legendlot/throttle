'use client';
/* ════════════════════════════════════════════════════════════
   COSTS — Per-operator productivity (per-capita by dept).
   Cars packed that day ÷ operators present that day, by dept.
   factory_cost_view only.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { Panel } from '../../../../components/kit/index.js';
import { Users } from 'lucide-react';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const num = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const DEPTS = ['assembly', 'qc', 'packaging', 'store', 'dispatch'];
const DEPT_LABEL = { assembly: 'Assembly', qc: 'QC', packaging: 'Packaging', store: 'Store', dispatch: 'Dispatch' };

export default function ProductivityPage() {
  const { session, perms } = useAuth();
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(daysAgo(0));
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setRows(null); setErr(null);
    try { const r = await workerFetch('getFactoryProductivity', { from, to }, session); setRows(r.data?.rows || []); }
    catch (e) { setErr(e.message || 'Failed'); }
  }, [session, from, to]);
  useEffect(() => { load(); }, [load]);

  // pivot: date -> {dept -> {present, per_capita}}, cars per date
  const { dates, byDate } = useMemo(() => {
    const map = {}; const carsByDate = {};
    for (const r of (rows || [])) {
      (map[r.date] ||= {})[r.dept] = r;
      carsByDate[r.date] = r.cars;
    }
    return { dates: Object.keys(map).sort((a, b) => b.localeCompare(a)), byDate: map, carsByDate };
  }, [rows]);

  if (perms && !perms.factory_cost_view) return <div style={{ color: 'var(--t3)', padding: 20 }}>Requires factory_cost_view.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--t1)', margin: 0 }}><Users size={18} style={{ verticalAlign: '-3px' }} /> Operator Productivity</h1>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ color: 'var(--t3)' }}>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Per-capita = cars packed that day ÷ operators present that day, by department. Line work — no single person makes a whole unit.</div>

      {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
      {!rows && !err && <Spinner />}
      {rows && (
        <Panel title="Units per operator / day" icon={Users}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>Date</th><th style={thNum}>Cars</th>
                {DEPTS.map(dp => <th key={dp} style={thNum}>{DEPT_LABEL[dp]}</th>)}
              </tr></thead>
              <tbody>
                {dates.length === 0 && <tr><td style={td} colSpan={2 + DEPTS.length}><span style={{ color: 'var(--t3)' }}>No attendance in range.</span></td></tr>}
                {dates.map(dt => (
                  <tr key={dt}>
                    <td style={td}>{dt}</td>
                    <td style={tdNum}>{num(byDate[dt][DEPTS.find(x => byDate[dt][x])]?.cars)}</td>
                    {DEPTS.map(dp => {
                      const c = byDate[dt][dp];
                      return <td key={dp} style={tdNum}>{c ? <span><strong>{num(c.per_capita)}</strong> <span style={{ color: 'var(--t3)', fontSize: 11 }}>({c.present})</span></span> : '—'}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--t3)' }}>Bold = units/operator · (n) = operators present.</div>
        </Panel>
      )}
    </div>
  );
}

const inp = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 13, outline: 'none' };
const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' };
const thNum = { ...th, textAlign: 'right' };
const td = { padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--t1)' };
const tdNum = { ...td, fontFamily: 'var(--font-mono)', textAlign: 'right' };
