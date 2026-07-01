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
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Panel } from '../../../../components/kit/index.js';
import { Coins, Boxes, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--t1)', margin: 0 }}><Calendar size={18} style={{ verticalAlign: '-3px' }} /> Monthly Loaded Cost / Unit</h1>
        <MonthPicker value={month} onChange={setMonth} />
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>
              <Cat label="Manpower (prod+store+dispatch+OT)" v={rup(d.categories?.manpower)} />
              <Cat label="Fixed + overhead" v={rup(d.categories?.fixed_overhead)} />
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
              Working days (Mon–Sat): {d.elapsed_working_days} of {d.working_days} elapsed. Fixed + overhead pro-rated to elapsed working days (partial month handled).
            </div>
          </Panel>

          <Panel title="Cars packed per day" icon={Boxes}>
            {(d.daily || []).length === 0 ? (
              <div style={{ color: 'var(--t3)', padding: '30px 0', textAlign: 'center' }}>No cars packed this month.</div>
            ) : (
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.daily} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" stroke="var(--t4)" tick={tick} tickFormatter={x => x.slice(8)} />
                    <YAxis stroke="var(--t4)" tick={tick} width={48} />
                    <Tooltip contentStyle={ttip} cursor={{ fill: 'rgba(255,255,255,0.04)' }} labelStyle={{ color: 'var(--t2)' }} formatter={v => [num(v), 'Cars']} />
                    <Bar dataKey="cars" name="Cars" fill="var(--yellow)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/* Themed month/year picker (replaces the un-themable native <input type=month>) */
function MonthPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [y, m] = value.split('-').map(Number);
  const [viewYear, setViewYear] = useState(y);
  useEffect(() => { setViewYear(y); }, [y, open]);
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(o => !o)} style={{ ...inp, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Calendar size={14} /> {MONTHS[m - 1]} {y}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '112%', left: 0, zIndex: 50, width: 236, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: 12, boxShadow: 'var(--shadow-pop)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <button onClick={() => setViewYear(v => v - 1)} style={navBtn}><ChevronLeft size={16} /></button>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, color: 'var(--t1)' }}>{viewYear}</span>
              <button onClick={() => setViewYear(v => v + 1)} style={navBtn}><ChevronRight size={16} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {MONTHS.map((mm, i) => {
                const sel = viewYear === y && (i + 1) === m;
                return (
                  <button key={mm} onClick={() => { onChange(`${viewYear}-${String(i + 1).padStart(2, '0')}`); setOpen(false); }}
                    style={{ ...monthCell, ...(sel ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' } : {}) }}>
                    {mm}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 10, textAlign: 'right' }}>
              <button onClick={() => { onChange(thisMonth()); setOpen(false); }} style={{ ...navBtn, width: 'auto', padding: '4px 10px', fontSize: 12, color: 'var(--yellow)' }}>This month</button>
            </div>
          </div>
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

const inp = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '7px 12px', fontSize: 13, outline: 'none' };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 28, background: 'var(--surface-2)', color: 'var(--t2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', cursor: 'pointer' };
const monthCell = { padding: '8px 0', background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'var(--font-ui)' };
const tick = { fontSize: 11, fontFamily: 'var(--font-ui)', fill: 'var(--t3)' };
const ttip = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, fontSize: 12 };
