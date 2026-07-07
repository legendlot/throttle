'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { KpiTile, card, cardLabel } from '../../../components/ui.js';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ComposedChart, Line, CartesianGrid, LabelList,
} from 'recharts';

const YELLOW = '#F2CD1A', BLUE = '#9fb0ff', GREEN = '#4ade80',
      ORANGE = '#fb923c', RED = '#ff8a8a';
const NUM = 'var(--mono, ui-monospace, "SF Mono", monospace)';

const inr = (n) => n == null ? '—'
  : n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L`
  : `₹${Math.round(n).toLocaleString('en-IN')}`;
const mLabel = (m) => {
  const [y, mo] = String(m).split('-');
  return new Date(+y, +mo - 1, 1).toLocaleString('en', { month: 'short' }) + ' ' + y.slice(2);
};
// Direct-label + tooltip formatters (blank string hides a zero label).
const cnt  = (v) => (v ? Number(v).toLocaleString('en-IN') : '');
const inrL = (v) => (v ? inr(v) : '');
const pct  = (v) => (v == null ? '' : `${v}%`);

// ── Chart chrome (shared) ─────────────────────────────────────────────────────
const AXIS  = { stroke: 'var(--t4)', fontSize: 11, tickLine: false };
const GRID  = { stroke: 'var(--t5)', strokeDasharray: '3 3', vertical: false };
const LABEL = { fill: 'var(--t2)', fontSize: 11, fontWeight: 600, fontFamily: NUM };
const BAR_CURSOR  = { fill: 'rgba(159,176,255,0.10)', radius: 4 };       // soft wash, not the gray slab
const LINE_CURSOR = { stroke: 'var(--t4)', strokeWidth: 1, strokeDasharray: '4 4' };
const ACTIVE_BAR  = { stroke: 'rgba(255,255,255,0.35)', strokeWidth: 1 }; // hovered bar lifts via outline
const legendText  = (value) => <span style={{ color: 'var(--t3)', fontSize: 12 }}>{value}</span>;

// Clean tooltip: value leads (bold, numeric font, primary ink); category is a muted
// header; each row keyed by a short stroke of the series color (never color-matched text).
function ChartTip({ active, payload, label, fmt = cnt }) {
  if (!active || !payload) return null;
  const rows = payload.filter((p) => p.value != null && p.value !== 0);
  if (!rows.length) return null;
  const multi = rows.length > 1;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--t5)', borderRadius: 10,
      padding: '8px 11px', boxShadow: '0 8px 24px rgba(0,0,0,.42)', minWidth: 96,
    }}>
      {label != null && label !== '' && (
        <div style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t4)', marginBottom: 6 }}>{label}</div>
      )}
      {rows.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '2px 0' }}>
          <span style={{ width: 11, height: 3, borderRadius: 2, background: p.color || p.stroke || p.fill, flex: '0 0 auto' }} />
          <span style={{ fontFamily: NUM, fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', lineHeight: 1 }}>{fmt(p.value)}</span>
          {multi && <span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 'auto', paddingLeft: 12 }}>{p.name}</span>}
        </div>
      ))}
    </div>
  );
}

// Self-fetching section: own loading / error / retry, so one failure never blanks the page.
// Session lives in a ref and the effect keys on the (gated) user id, so hourly
// TOKEN_REFRESHED session-object churn never refetches; stale data is kept while
// reloading so a refresh never blanks a rendered section.
function useSection(action, params, session) {
  const [state, setState] = useState({ data: null, error: null });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Gate key: null while the passed session is null (e.g. comp gate closed),
  // flips null → user id when the gate opens or the first session arrives.
  const userId = session?.user?.id || null;
  const load = useCallback(() => {
    if (!sessionRef.current) return;
    setState((s) => ({ data: s.data, error: null }));
    podiumopsGet(action, params, sessionRef.current)
      .then((data) => setState({ data, error: null }))
      .catch((e) => setState((s) => ({ data: s.data, error: e.message || 'failed' })));
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps -- action/params are constant per call site
  useEffect(load, [load]);
  return { ...state, retry: load };
}

function Section({ title, state, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600, lineHeight: 1, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 12px' }}>{title}</h2>
      {state.error ? (
        <div style={{ ...card, color: 'var(--bad-fg, ' + RED + ')' }}>
          Failed to load: {state.error}{' '}
          <button onClick={state.retry} style={{ marginLeft: 8, cursor: 'pointer', background: 'none', border: '1px solid var(--t5)', color: 'var(--t2)', borderRadius: 6, padding: '2px 10px' }}>Retry</button>
        </div>
      ) : !state.data ? <Spinner /> : children(state.data)}
    </section>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 };
function ChartCard({ label, children, h = 240 }) {
  return (
    <div style={card}>
      <div style={cardLabel}>{label}</div>
      <div style={{ width: '100%', height: h }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}
const Rail = ({ children }) => <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>{children}</div>;
const Empty = ({ text }) => <div style={{ ...card, color: 'var(--t4)' }}>{text}</div>;

// ── Sections ────────────────────────────────────────────────────────────────

function OrgSection({ d }) {
  const je = (d.joiners_exits || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const att = ((d.attrition || {}).series || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const exits12 = je.reduce((s, r) => s + (r.exits || 0), 0);
  const lastMonth = je[je.length - 1] || {};
  return (
    <>
      <Rail>
        <KpiTile label="Headcount" value={d.headcount?.total ?? '—'} stripe />
        <KpiTile label="Joiners · this month" value={lastMonth.joiners ?? 0} subColor="var(--green-bright)" />
        <KpiTile label="Exits · 12mo" value={exits12} />
        <KpiTile label="Attrition · 12mo" value={d.attrition?.trailing_12mo_pct != null ? `${d.attrition.trailing_12mo_pct}%` : '—'} />
      </Rail>
      <div style={grid}>
        <ChartCard label="Headcount by department" h={Math.max(240, (d.headcount?.by_department?.length || 0) * 26)}>
          <BarChart data={d.headcount?.by_department || []} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 8 }}>
            <XAxis type="number" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
            <Bar dataKey="count" fill={YELLOW} radius={[0, 4, 4, 0]} activeBar={ACTIVE_BAR}>
              <LabelList dataKey="count" position="right" formatter={cnt} {...LABEL} />
            </Bar>
          </BarChart>
        </ChartCard>
        <ChartCard label="Joiners vs exits">
          <ComposedChart data={je} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
            <Legend formatter={legendText} iconType="circle" iconSize={9} />
            <Bar dataKey="joiners" name="Joiners" fill={GREEN} radius={[3, 3, 0, 0]} activeBar={ACTIVE_BAR} />
            <Bar dataKey="exits" name="Exits" fill={RED} radius={[3, 3, 0, 0]} activeBar={ACTIVE_BAR} />
          </ComposedChart>
        </ChartCard>
        <ChartCard label="Tenure distribution">
          <BarChart data={d.tenure_buckets || []} margin={{ top: 18, right: 10, bottom: 4, left: 0 }}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
            <Bar dataKey="count" fill={BLUE} radius={[4, 4, 0, 0]} activeBar={ACTIVE_BAR}>
              <LabelList dataKey="count" position="top" formatter={cnt} {...LABEL} />
            </Bar>
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly attrition rate (%)">
          <ComposedChart data={att} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} />
            <Tooltip content={<ChartTip fmt={pct} />} cursor={LINE_CURSOR} />
            <Line dataKey="rate_pct" name="Attrition %" stroke={ORANGE} strokeWidth={2} dot={false} connectNulls />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

function CompSection({ d }) {
  const t = d.totals || {};
  const trend = (d.monthly_trend || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const latestInc = (d.increments || [])[0];
  return (
    <>
      <Rail>
        <KpiTile label="Annual CTC (plan)" value={inr(t.annual_ctc_total)} stripe />
        <KpiTile label="Monthly plan cost" value={inr(t.monthly_plan_cost)} />
        <KpiTile label="With comp on file" value={`${t.employees_with_comp ?? 0} / ${(t.employees_with_comp ?? 0) + (t.employees_without_comp ?? 0)}`}
          sub={t.employees_without_comp ? `${t.employees_without_comp} missing` : 'complete'}
          subColor={t.employees_without_comp ? 'var(--warn-fg)' : 'var(--green-bright)'} />
        <KpiTile label="Latest increment round" value={latestInc ? (latestInc.avg_increment_pct != null ? `${latestInc.avg_increment_pct}%` : '—') : '—'}
          sub={latestInc ? `${latestInc.count} people · ${latestInc.anchor}` : 'none yet'} />
      </Rail>
      <div style={grid}>
        <ChartCard label="Annual CTC by department" h={Math.max(240, (d.by_department?.length || 0) * 26)}>
          <BarChart data={d.by_department || []} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
            <XAxis type="number" {...AXIS} tickFormatter={inr} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip content={<ChartTip fmt={inr} />} cursor={BAR_CURSOR} />
            <Bar dataKey="annual_ctc_total" name="Annual CTC" fill={YELLOW} radius={[0, 4, 4, 0]} activeBar={ACTIVE_BAR}>
              <LabelList dataKey="annual_ctc_total" position="right" formatter={inrL} {...LABEL} />
            </Bar>
          </BarChart>
        </ChartCard>
        <ChartCard label="CTC distribution">
          <BarChart data={d.distribution || []} margin={{ top: 18, right: 10, bottom: 4, left: 0 }}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
            <Bar dataKey="count" fill={BLUE} radius={[4, 4, 0, 0]} activeBar={ACTIVE_BAR}>
              <LabelList dataKey="count" position="top" formatter={cnt} {...LABEL} />
            </Bar>
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly cost — plan vs actuals (actuals fill in as payouts land)">
          <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} tickFormatter={inr} />
            <Tooltip content={<ChartTip fmt={inr} />} cursor={LINE_CURSOR} />
            <Legend formatter={legendText} iconSize={9} />
            <Bar dataKey="actuals_employee" name="Actuals · payroll" stackId="a" fill={GREEN} activeBar={ACTIVE_BAR} />
            <Bar dataKey="actuals_vendor" name="Actuals · contract labour" stackId="a" fill={ORANGE} activeBar={ACTIVE_BAR} />
            <Line dataKey="plan_cost" name="Plan (CTC ÷ 12)" stroke={YELLOW} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

function PerfSection({ d }) {
  const cycles = d.cycles || [];
  const act = (d.activity || []).map((r) => ({
    ...r, m: mLabel(r.month),
    observations: (r.observations_positive || 0) + (r.observations_neutral || 0) + (r.observations_constructive || 0),
  }));
  const latest = cycles[0];
  const dist = cycles.length
    ? ['1', '2', '3', '4', '5'].map((k) => {
        const row = { rating: `★${k}` };
        cycles.forEach((c) => { row[c.cycle || c.appraisal_date] = c.rating_distribution?.[k] || 0; });
        return row;
      })
    : [];
  const CYCLE_COLS = [YELLOW, BLUE, GREEN, ORANGE];
  return (
    <>
      {latest ? (
        <Rail>
          <KpiTile label={`Avg rating · ${latest.cycle || latest.appraisal_date}`} value={latest.avg_final_rating ?? '—'} stripe />
          <KpiTile label="PIP" value={latest.pip_count ?? 0} subColor={latest.pip_count ? 'var(--bad-fg)' : 'var(--t4)'} />
          <KpiTile label="Finalized" value={`${latest.funnel?.finalized ?? 0} / ${latest.funnel?.enrolled ?? 0}`} />
          <KpiTile label="Acknowledged" value={`${latest.funnel?.acknowledged ?? 0} / ${latest.funnel?.enrolled ?? 0}`} />
        </Rail>
      ) : (
        <Empty text="No appraisal cycles yet — cycle analytics will appear after the first cycle runs. Activity volume below is live." />
      )}
      <div style={grid}>
        {cycles.length > 0 && (
          <ChartCard label="Final-rating distribution by cycle">
            <BarChart data={dist} margin={{ top: 18, right: 10, bottom: 4, left: 0 }}>
              <XAxis dataKey="rating" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
              <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
              <Legend formatter={legendText} iconType="circle" iconSize={9} />
              {cycles.map((c, i) => (
                <Bar key={c.cycle || c.appraisal_date} dataKey={c.cycle || c.appraisal_date} fill={CYCLE_COLS[i % CYCLE_COLS.length]} radius={[4, 4, 0, 0]} activeBar={ACTIVE_BAR}>
                  {cycles.length === 1 && <LabelList dataKey={c.cycle || c.appraisal_date} position="top" formatter={cnt} {...LABEL} />}
                </Bar>
              ))}
            </BarChart>
          </ChartCard>
        )}
        {latest && (
          <ChartCard label={`Participation funnel · ${latest.cycle || latest.appraisal_date}`}>
            <BarChart layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 8 }} data={[
              { stage: 'Enrolled', n: latest.funnel?.enrolled ?? 0 },
              { stage: 'Self done', n: latest.funnel?.self_submitted ?? 0 },
              { stage: 'Manager done', n: latest.funnel?.manager_submitted ?? 0 },
              { stage: 'Finalized', n: latest.funnel?.finalized ?? 0 },
              { stage: 'Acknowledged', n: latest.funnel?.acknowledged ?? 0 },
            ]}>
              <XAxis type="number" {...AXIS} allowDecimals={false} />
              <YAxis type="category" dataKey="stage" width={110} {...AXIS} />
              <Tooltip content={<ChartTip fmt={cnt} />} cursor={BAR_CURSOR} />
              <Bar dataKey="n" fill={BLUE} radius={[0, 4, 4, 0]} activeBar={ACTIVE_BAR}>
                <LabelList dataKey="n" position="right" formatter={cnt} {...LABEL} />
              </Bar>
            </BarChart>
          </ChartCard>
        )}
        <ChartCard label="Performance activity · 12mo">
          <ComposedChart data={act} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip content={<ChartTip fmt={cnt} />} cursor={LINE_CURSOR} />
            <Legend formatter={legendText} iconSize={9} />
            <Line dataKey="observations" name="Observations" stroke={YELLOW} strokeWidth={2} dot={false} />
            <Line dataKey="wins" name="Wins" stroke={GREEN} strokeWidth={2} dot={false} />
            <Line dataKey="one_on_ones" name="1:1s" stroke={BLUE} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  // AuthProvider already loads getMe (pingAction="getMe") — brandUser is that payload;
  // tier = { admin, hr, comp, super_admin } (hr already includes admin server-side).
  const { session, brandUser } = useAuth();
  const isHrTier = !!(brandUser?.tier?.hr || brandUser?.tier?.admin);
  const isComp = !!brandUser?.tier?.comp;

  const org = useSection('getAnalyticsOrg', { months: 12 }, isHrTier ? session : null);
  const perf = useSection('getAnalyticsPerf', { cycles: 4 }, isHrTier ? session : null);
  const comp = useSection('getAnalyticsComp', { months: 12 }, isComp ? session : null);

  // Friendly gate for direct-URL visitors without HR/admin access (nav already hides the entry).
  if (brandUser && !isHrTier) return <Empty text="Analytics needs HR or admin access." />;

  return (
    <div>
      <Section title="Org & Headcount" state={org}>{(d) => <OrgSection d={d} />}</Section>
      {isComp && <Section title="Payroll Cost" state={comp}>{(d) => <CompSection d={d} />}</Section>}
      <Section title="Performance" state={perf}>{(d) => <PerfSection d={d} />}</Section>
    </div>
  );
}
