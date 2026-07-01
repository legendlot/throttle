'use client';
/* ════════════════════════════════════════════════════════════
   COSTS — Monthly loaded cost per unit. All factory cost for the
   month ÷ all cars packed. The number added on top of COGS.
   factory_cost_view only. Aggregate only.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { Panel } from '../../../../components/kit/index.js';
import { Coins, Boxes, Calendar } from 'lucide-react';

const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
const rup = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN');

export default function MonthlyCostPage() {
  const { session, perms } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setD(null); setErr(null);
    try { const r = await workerFetch('getFactoryCostMonthly', { month: month + '-01' }, session); setD(r.data); }
    catch (e) { setErr(e.message || 'Failed'); }
  }, [session, month]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.factory_cost_view) return <div style={{ color: 'var(--t3)', padding: 20 }}>Requires factory_cost_view.</div>;

  const maxCars = Math.max(1, ...((d?.daily || []).map(x => x.cars || 0)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--t1)', margin: 0 }}><Calendar size={18} style={{ verticalAlign: '-3px' }} /> Monthly Loaded Cost / Unit</h1>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={inp} />
      </div>

      {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
      {!d && !err && <Spinner />}
      {d && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Stat label="Loaded cost / unit" value={rup(d.per_unit)} sub="add on top of COGS" icon={<Coins size={15} />} accent="var(--green)" />
            <Stat label="Total factory cost" value={rup(d.month_cost)} icon={<Coins size={15} />} accent="var(--yellow)" />
            <Stat label="Cars packed" value={num(d.cars_total)} icon={<Boxes size={15} />} accent="var(--blue)" />
          </div>

          <Panel title="Cost split" icon={Coins}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 12 }}>
              <Cat label="Manpower (prod+store+dispatch+OT)" v={rup(d.categories?.manpower)} />
              <Cat label="Fixed + overhead" v={rup(d.categories?.fixed_overhead)} />
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
              Working days (Mon–Sat): {d.elapsed_working_days} of {d.working_days} elapsed. Fixed + overhead pro-rated to elapsed working days (partial month handled).
            </div>
          </Panel>

          <Panel title="Cars packed per day" icon={Boxes}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, overflowX: 'auto', paddingTop: 6 }}>
              {(d.daily || []).map((x, i) => (
                <div key={i} title={`${x.date}: ${x.cars}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 22 }}>
                  <div style={{ width: 16, height: `${Math.round((x.cars / maxCars) * 100)}%`, minHeight: 2, background: 'var(--yellow)', borderRadius: '2px 2px 0 0' }} />
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>{x.date.slice(8)}</div>
                </div>
              ))}
              {(d.daily || []).length === 0 && <span style={{ color: 'var(--t3)' }}>No cars packed this month.</span>}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, icon, accent }) {
  return (
    <div style={{ flex: '1 1 220px', background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 'var(--r-lg)', padding: '14px 16px' }}>
      <div style={{ fontSize: 11.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6 }}>{icon} {label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--t1)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Cat({ label, v }) {
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--t1)', marginTop: 3 }}>{v}</div>
    </div>
  );
}
const inp = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 10px', fontSize: 13, outline: 'none' };
