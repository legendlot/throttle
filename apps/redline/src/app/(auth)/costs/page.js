'use client';
/* ════════════════════════════════════════════════════════════
   COSTS — Daily production cost per unit (V2 production-only,
   V3 full). Per-product allocation + category breakdown.
   factory_cost_view only. Aggregate only — no salaries.
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { Panel } from '../../../components/kit/index.js';
import { Coins, Factory, Boxes } from 'lucide-react';

const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const rup = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const num = (n) => n == null ? '—' : Number(n).toLocaleString('en-IN');

export default function DailyCostPage() {
  const { session, perms } = useAuth();
  const [date, setDate] = useState(todayISO());
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    if (!session) return;
    setD(null); setErr(null);
    try { const r = await workerFetch('getFactoryCostDaily', { date }, session); setD(r.data); }
    catch (e) { setErr(e.message || 'Failed'); }
  }, [session, date]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.factory_cost_view) return <div style={{ color: 'var(--t3)', padding: 20 }}>Requires factory_cost_view.</div>;

  const b = d?.breakdown;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--t1)', margin: 0 }}><Coins size={18} style={{ verticalAlign: '-3px' }} /> Daily Cost / Unit</h1>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} />
      </div>

      {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
      {!d && !err && <Spinner />}
      {d && (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Stat label="Cars packed (PKG_OUT)" value={num(d.cars_total)} icon={<Boxes size={15} />} accent="var(--blue)" />
            <Stat label="Production-only / unit (V2)" value={rup(d.v2?.per_unit)} sub={`pool ${rup(d.v2?.pool)}`} icon={<Factory size={15} />} accent="var(--yellow)" />
            <Stat label="Full / unit (V3)" value={rup(d.v3?.per_unit)} sub={`+ store, dispatch, overhead`} icon={<Coins size={15} />} accent="var(--green)" />
          </div>

          <Panel title="Cost breakdown (this day)" icon={Coins}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12 }}>
              <Cat label="Production manpower" v={rup(b?.prod_manpower)} />
              <Cat label="Store manpower" v={rup(b?.store_manpower)} />
              <Cat label="Dispatch manpower" v={rup(b?.dispatch_manpower)} />
              <Cat label="Fixed (rent/elec/other)" v={rup(b?.fixed)} />
              <Cat label="Overhead (admin/security)" v={rup(b?.overhead)} />
              <Cat label="Overtime (incl. above)" v={rup(b?.ot_total)} />
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
              Working days this month (Mon–Sat): {d.working_days} · OT rate ₹{d.ot_rate}/hr (avg). V2 = production manpower + fixed. V3 = V2 + store + dispatch + overhead. Per-unit conversion cost adds on top of each product's COGS.
            </div>
          </Panel>

          <Panel title="Per product (unit-share allocation)" icon={Boxes}>
            <table style={tbl}>
              <thead><tr>{['Product', 'Cars', 'V2 alloc', 'V2 /unit', 'V3 alloc', 'V3 /unit'].map((h,i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {(d.per_product || []).length === 0 && <tr><td style={td} colSpan={6}><span style={{ color: 'var(--t3)' }}>No cars packed out this day.</span></td></tr>}
                {(d.per_product || []).map((p, i) => (
                  <tr key={i}>
                    <td style={td}>{p.product}</td>
                    <td style={tdNum}>{num(p.cars)}</td>
                    <td style={tdNum}>{rup(p.v2_alloc)}</td>
                    <td style={tdNum}>{rup(p.v2_per_unit)}</td>
                    <td style={tdNum}>{rup(p.v3_alloc)}</td>
                    <td style={tdNum}>{rup(p.v3_per_unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' };
const td = { padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--t1)' };
const tdNum = { ...td, fontFamily: 'var(--font-mono)', textAlign: 'right' };
