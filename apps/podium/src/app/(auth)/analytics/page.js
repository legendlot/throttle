'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { KpiTile, card, cardLabel } from '../../../components/ui.js';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ComposedChart, Line, CartesianGrid,
} from 'recharts';

const YELLOW = '#F2CD1A', BLUE = '#9fb0ff', GREEN = '#4ade80',
      ORANGE = '#fb923c', RED = '#ff8a8a';

const inr = (n) => n == null ? '—'
  : n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L`
  : `₹${Math.round(n).toLocaleString('en-IN')}`;
const mLabel = (m) => {
  const [y, mo] = String(m).split('-');
  return new Date(+y, +mo - 1, 1).toLocaleString('en', { month: 'short' }) + ' ' + y.slice(2);
};

const TT = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--t5)', borderRadius: 8, fontSize: 12 } };
const AXIS = { stroke: 'var(--t4)', fontSize: 11 };

// Self-fetching section: own loading / error / retry, so one failure never blanks the page.
function useSection(action, params, session) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => {
    if (!session) return;
    setState({ data: null, error: null });
    podiumopsGet(action, params, session)
      .then((data) => setState({ data, error: null }))
      .catch((e) => setState({ data: null, error: e.message || 'failed' }));
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { ...state, retry: load };
}

function Section({ title, state, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: '600 13px/1 inherit', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 12px' }}>{title}</h2>
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
          <BarChart data={d.headcount?.by_department || []} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis type="number" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={YELLOW} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Joiners vs exits">
          <ComposedChart data={je}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} /><Legend />
            <Bar dataKey="joiners" name="Joiners" fill={GREEN} radius={[3, 3, 0, 0]} />
            <Bar dataKey="exits" name="Exits" fill={RED} radius={[3, 3, 0, 0]} />
          </ComposedChart>
        </ChartCard>
        <ChartCard label="Tenure distribution">
          <BarChart data={d.tenure_buckets || []}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly attrition rate (%)">
          <ComposedChart data={att}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} />
            <Tooltip {...TT} />
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
        <KpiTile label="Latest increment round" value={latestInc ? `${latestInc.avg_increment_pct ?? '—'}%` : '—'}
          sub={latestInc ? `${latestInc.count} people · ${latestInc.anchor}` : 'none yet'} />
      </Rail>
      <div style={grid}>
        <ChartCard label="Annual CTC by department" h={Math.max(240, (d.by_department?.length || 0) * 26)}>
          <BarChart data={d.by_department || []} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis type="number" {...AXIS} tickFormatter={inr} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip {...TT} formatter={(v) => inr(v)} />
            <Bar dataKey="annual_ctc_total" name="Annual CTC" fill={YELLOW} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="CTC distribution">
          <BarChart data={d.distribution || []}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly cost — plan vs actuals (actuals fill in as payouts land)">
          <ComposedChart data={trend}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} tickFormatter={inr} />
            <Tooltip {...TT} formatter={(v) => inr(v)} /><Legend />
            <Bar dataKey="actuals_employee" name="Actuals · payroll" stackId="a" fill={GREEN} />
            <Bar dataKey="actuals_vendor" name="Actuals · contract labour" stackId="a" fill={ORANGE} />
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
            <BarChart data={dist}>
              <XAxis dataKey="rating" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
              <Tooltip {...TT} /><Legend />
              {cycles.map((c, i) => (
                <Bar key={c.cycle || c.appraisal_date} dataKey={c.cycle || c.appraisal_date} fill={CYCLE_COLS[i % CYCLE_COLS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ChartCard>
        )}
        {latest && (
          <ChartCard label={`Participation funnel · ${latest.cycle || latest.appraisal_date}`}>
            <BarChart layout="vertical" margin={{ left: 8, right: 16 }} data={[
              { stage: 'Enrolled', n: latest.funnel?.enrolled ?? 0 },
              { stage: 'Self done', n: latest.funnel?.self_submitted ?? 0 },
              { stage: 'Manager done', n: latest.funnel?.manager_submitted ?? 0 },
              { stage: 'Finalized', n: latest.funnel?.finalized ?? 0 },
              { stage: 'Acknowledged', n: latest.funnel?.acknowledged ?? 0 },
            ]}>
              <XAxis type="number" {...AXIS} allowDecimals={false} />
              <YAxis type="category" dataKey="stage" width={110} {...AXIS} />
              <Tooltip {...TT} />
              <Bar dataKey="n" fill={BLUE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartCard>
        )}
        <ChartCard label="Performance activity · 12mo">
          <ComposedChart data={act}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} /><Legend />
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
  const { session } = useAuth();
  const [me, setMe] = useState(null);
  useEffect(() => {
    if (!session) return;
    podiumopsGet('getMe', {}, session).then(setMe).catch(() => setMe({}));
  }, [session]);

  const org = useSection('getAnalyticsOrg', { months: 12 }, session);
  const perf = useSection('getAnalyticsPerf', { cycles: 4 }, session);
  const isComp = !!me?.tier?.comp;
  const comp = useSection('getAnalyticsComp', { months: 12 }, isComp ? session : null);

  return (
    <div>
      <Section title="Org & Headcount" state={org}>{(d) => <OrgSection d={d} />}</Section>
      {isComp && <Section title="Payroll Cost" state={comp}>{(d) => <CompSection d={d} />}</Section>}
      <Section title="Performance" state={perf}>{(d) => <PerfSection d={d} />}</Section>
    </div>
  );
}
