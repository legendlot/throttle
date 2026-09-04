'use client';
/* ════════════════════════════════════════════════════════════════════
   Support Analytics Dashboard (Pruthvi #bugs 2026-07-14) — live off
   cs_tickets, replacing the manual "Complaints Dashboard" sheet.
   Panels mirror the sheet: KPI band (+ Within/After 3 days), product ×
   issue-category matrix, by issue-category, by LOT product-line, by sale
   channel + support channel, top sub-categories, monthly product +
   category trends. One getSupportAnalytics call (gated cs_reports_view).
   Spec: docs/superpowers/specs/2026-07-16-pitstop-support-analytics-dashboard-design.md
   S339 (Pruthvi #bugs 2026-09-03): dimension filters + sort + CSV export.
   S344 (Pruthvi #bugs 1788512544): every dimension filter is MULTI-select — Pitstop
   is used across departments, and one-value-at-a-time cannot isolate a team's metrics.
   ════════════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, EmptyState } from '@throttle/ui';
import { BarChart3, Download } from 'lucide-react';
import { csopsGet } from '../../../lib/csopsFetch.js';
import { KpiCard, MultiSelect, Panel, selectStyle, inputStyle } from '../../../components/kit/index.js';
import { TrendChart } from '../../../components/kit/Chart.js';

const SERIES_COLORS = ['#7b93ff', '#25D366', '#F59E0B', '#E1306C', '#0084FF', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#f87171', '#c084fc'];

// IST-EXPLICIT range boundaries (S344). These used to call `setHours()`, i.e. the VIEWER's
// midnight, so in a non-IST browser the range sent to the worker was itself shifted: a New York
// viewer asking for 1 Sep sent 2026-09-01T04:00Z, which is 09:30 IST — the first 9.5 hours of the
// business day were silently missing from every figure on the page.
//
// The date the user means is the calendar date on their picker (its LOCAL Y/M/D); the boundary we
// want is IST midnight, because the business day is IST. So read the local calendar parts and
// build the instant with an explicit +05:30, the way the worker's helpers do.
//
// ⚠️ Verified 2026-09-04 under TZ=Asia/Kolkata and TZ=America/New_York: identical output in IST
// (so this is a no-op for the team today) and corrected in New York.
const pad2 = (n) => String(n).padStart(2, '0');
const istBoundary = (d, endOfDay) =>
  new Date(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`).toISOString();
function isoStart(d) { return istBoundary(d, false); }
function isoEnd(d)   { return istBoundary(d, true); }

// Resolve a preset → {from, to} Date objects (local; IST offset handled server-side).
function presetRange(preset) {
  const now = new Date();
  if (preset === 'today')  return { from: now, to: now };
  if (preset === 'mtd')    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  if (preset === 'last')   return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0) };
  if (preset === 'year')   return { from: new Date(now.getFullYear(), 0, 1), to: now };
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
}

// The five dimensions the worker filters on, in filter-bar order. Keys match the
// query params getSupportAnalytics reads and the keys in its `filter_options`.
const DIMS = [
  ['product',         'Product'],
  ['issue_category',  'Issue category'],
  ['product_line',    'Product line'],
  ['sale_channel',    'Sale channel'],
  ['support_channel', 'Support channel'],
  ['agent',           'Agent'],
];

const SORTS = [
  ['count_desc', 'Most first'],
  ['count_asc',  'Fewest first'],
  ['name_asc',   'A–Z'],
];
// One comparator for every ranked panel AND the product matrix, so "A–Z" cannot mean
// something different in two places on the same screen.
function sortBy(sort, nameOf, countOf) {
  if (sort === 'name_asc')  return (a, b) => String(nameOf(a)).localeCompare(String(nameOf(b)));
  if (sort === 'count_asc') return (a, b) => countOf(a) - countOf(b) || String(nameOf(a)).localeCompare(String(nameOf(b)));
  return (a, b) => countOf(b) - countOf(a) || String(nameOf(a)).localeCompare(String(nameOf(b)));
}
const sortRanked = (rows, sort) => [...(rows || [])].sort(sortBy(sort, r => r.name, r => r.count));

// `range.from/to` are ISO instants for IST midnight/end-of-day, so slicing them to 10 chars
// yields the UTC date — a September MTD export labelled itself "2026-08-31 to …", a day early,
// because 1 Sep 00:00 IST is 31 Aug 18:30 UTC. Shift into IST before taking the calendar date.
const istDay = (iso) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const csvEsc = (v) => {
  let s = v == null ? '' : String(v);
  // A product or category beginning = + - @ is executed as a formula by Excel/Sheets.
  // Prefix an apostrophe so it renders as the text it is.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function AnalyticsPage() {
  const { session, perms } = useAuth();
  const canView = !!perms?.cs_reports_view;

  const [preset, setPreset] = useState('mtd');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // dim key → SELECTED VALUES (string[]; [] or absent = All). Multi since S344 — the worker
  // takes a comma-separated list per dimension and a single value still works, so an older
  // cached page keeps functioning against the same endpoint.
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState('count_desc');
  const [grain, setGrain] = useState('month');   // trend bucket: 'month' | 'week'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) return { from: isoStart(customFrom), to: isoEnd(customTo) };
    const r = presetRange(preset);
    return { from: isoStart(r.from), to: isoEnd(r.to) };
  }, [preset, customFrom, customTo]);

  // Serialised so the effect re-runs on a filter change without depending on object identity.
  const filterKey = useMemo(
    () => DIMS.map(([k]) => `${k}=${(filters[k] || []).join(',')}`).join('&'),
    [filters],
  );

  useEffect(() => {
    if (!session || !canView) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const args = { from: range.from, to: range.to, grain };
    // Comma-joined per dimension; an empty selection sends nothing at all, which is "All".
    for (const [k] of DIMS) if (filters[k]?.length) args[k] = filters[k].join(',');
    csopsGet('getSupportAnalytics', args, session)
      .then(d => { if (alive) { setData(d); setError(null); } })
      .catch(e => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, canView, range.from, range.to, filterKey, grain]);

  // Options come from the range BEFORE the dimension filters, so picking a product does
  // not collapse the category list. A value that is selected but absent (the range moved
  // under it) is still listed — otherwise the control silently blanks and reads as "All"
  // while the dashboard is still filtered by it.
  function optionsFor(key) {
    const opts = data?.filter_options?.[key] || [];
    const missing = (filters[key] || []).filter(v => !opts.includes(v));
    return missing.length ? [...missing, ...opts] : opts;
  }

  // Counts DIMENSIONS filtered, not values picked — "Clear 2 filters" must mean two dropdowns,
  // the same thing it meant when each held one value.
  const activeCount = DIMS.filter(([k]) => filters[k]?.length).length;

  function exportCsv() {
    if (!data || loading) return;
    // ⚠️ EVERY line of the header comes from `data`, never from the live controls.
    // `data` holds the PREVIOUS payload until a refetch resolves, so reading `range` and
    // `filters` here stamped the new date range and new filters onto the old numbers —
    // precisely the mislabelling the cohort header exists to prevent. The worker returns
    // `range.from/to` and `applied_filters` for exactly this; use them.
    const fromD = istDay(data.range?.from || range.from), toD = istDay(data.range?.to || range.to);
    const applied = data.applied_filters || {};
    const L = [];
    L.push(`Pitstop Support Analytics,${fromD} to ${toD}`);
    // The active cohort travels WITH the file — same reason the Reports CSV carries its
    // basis and channel: a spreadsheet opened next week must not be ambiguous about which
    // slice it is, or someone reads a filtered export as the whole month.
    // `applied_filters[k]` is an ARRAY since S344 — join it, so a three-product cohort names
    // all three in the header rather than printing "[object Object]" or one of them.
    for (const [k, label] of DIMS) {
      const v = applied[k];
      L.push(`${label},${csvEsc(Array.isArray(v) ? (v.join(' · ') || 'All') : (v || 'All'))}`);
    }
    L.push(`Sorted by,${csvEsc(SORTS.find(s => s[0] === sort)?.[1] || sort)}`);
    L.push(`Complaints in this cohort,${data.range?.total ?? 0}`);
    L.push(`Complaints in date range (before filters),${data.range?.range_total ?? data.range?.total ?? 0}`);
    if (data.range?.truncated) L.push(csvEsc('INCOMPLETE — this range hit the 50,000-row ceiling; narrow the dates'));
    L.push('');
    const k = data.kpis || {};
    L.push('KPI,Value');
    L.push(`Total complaints,${k.total ?? 0}`);
    L.push(`Within 3 days of purchase,${k.within_3d ?? 0}`);
    L.push(`After 3 days of purchase,${k.after_3d ?? 0}`);
    L.push(`Ageing unknown (no purchase date),${k.ageing_unknown ?? 0}`);
    L.push('');

    const m = data.by_product_matrix;
    if (m?.products?.length) {
      const cats = m.categories || [];
      const prods = [...m.products].sort(sortBy(sort, p => p.product, p => p.total));
      L.push(csvEsc('Complaints by Product (rows = product, columns = issue category)'));
      L.push(['Product', 'Total', ...cats].map(csvEsc).join(','));
      for (const p of prods) L.push([p.product, p.total, ...cats.map(c => p.cats[c] || 0)].map(csvEsc).join(','));
      L.push(['TOTAL', prods.reduce((s, p) => s + p.total, 0),
        ...cats.map(c => prods.reduce((s, p) => s + (p.cats[c] || 0), 0))].map(csvEsc).join(','));
      L.push('');
    }

    const ranked = [
      ['By Issue Category', data.by_issue_category, true],
      ['Top Issue Sub-categories (top 20 by volume)', data.top_subcategories, false],
      ['By Product Line (LOT line)', data.by_product_line, true],
      ['By Sale Channel', data.by_sale_channel, true],
      ['By Support Channel', data.by_support_channel, true],
    ];
    for (const [title, rows, showPct] of ranked) {
      if (!rows?.length) continue;
      L.push(csvEsc(title));
      L.push(showPct ? 'Name,Count,% of total' : 'Name,Count');
      for (const r of sortRanked(rows, sort)) {
        L.push(showPct ? [r.name, r.count, r.pct].map(csvEsc).join(',') : [r.name, r.count].map(csvEsc).join(','));
      }
      L.push('');
    }

    // The export must SAY which grain it is — a weekly file headed "Monthly" is the kind of
    // thing that gets quoted in a meeting a month later.
    const grainWord  = data.trend_grain === 'week' ? 'Weekly' : 'Monthly';
    const bucketHead = data.trend_grain === 'week' ? 'Week of' : 'Month';
    for (const [title, series] of [[`${grainWord} Product Trend`, data.monthly_product_trend],
                                  [`${grainWord} Category Trend`, data.monthly_category_trend]]) {
      if (!series?.length) continue;
      const totals = {};
      for (const row of series) for (const kk of Object.keys(row)) {
        if (kk === 'bucket' || kk === 'total') continue;
        totals[kk] = (totals[kk] || 0) + row[kk];
      }
      const dims = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([n]) => n);
      L.push(csvEsc(title));
      L.push([bucketHead, 'Total', ...dims].map(csvEsc).join(','));
      for (const row of series) L.push([row.bucket, row.total, ...dims.map(d => row[d] || 0)].map(csvEsc).join(','));
      L.push('');
    }

    const blob = new Blob([L.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pitstop-support-analytics-${fromD}-to-${toD}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) return <EmptyState icon={<BarChart3 size={28} />} title="No access" message="You need the reports permission to view analytics." />;

  const PRESETS = [['today', 'Today'], ['mtd', 'MTD'], ['last', 'Last month'], ['year', 'This year'], ['custom', 'Custom']];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          {PRESETS.map(([id, label]) => (
            <button key={id} onClick={() => setPreset(id)} style={{
              fontFamily: 'var(--f-ui)', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 5,
              border: 'none', cursor: 'pointer',
              background: preset === id ? 'var(--surface-3)' : 'transparent',
              color: preset === id ? 'var(--t1)' : 'var(--t3)' }}>{label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--t3)' }}>→</span>
            <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} style={inputStyle} />
          </>
        )}

        <div style={{ flex: 1 }} />

        <select value={sort} onChange={e => setSort(e.target.value)} style={selectStyle} title="Sort every ranked panel and the product table">
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <button onClick={exportCsv} disabled={!data || loading} style={exportBtn}>
          <Download size={13} strokeWidth={1.75} /> Export CSV
        </button>
      </div>

      {/* Dimension filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {DIMS.map(([key, label]) => (
          <MultiSelect key={key} label={label} value={filters[key] || []} options={optionsFor(key)}
            onChange={vals => setFilters(f => ({ ...f, [key]: vals }))} />
        ))}
        {/* Trend grain. Sits with the filters because it changes what the trend panels mean,
            not merely how they look — the tables and the CSV re-head themselves from it. */}
        <select value={grain} style={selectStyle} onChange={e => setGrain(e.target.value)}>
          <option value="month">Trend: monthly</option>
          <option value="week">Trend: weekly</option>
        </select>
        {activeCount > 0 && (
          <>
            <button onClick={() => setFilters({})} style={clearBtn}>Clear {activeCount} filter{activeCount > 1 ? 's' : ''}</button>
            {data?.range && (
              <span style={{ fontSize: 12, color: 'var(--t3)' }}>
                <strong style={{ color: 'var(--t1)' }}>{data.range.total}</strong> of {data.range.range_total ?? data.range.total} complaints in range
              </span>
            )}
          </>
        )}
      </div>

      {data?.range?.truncated && (
        <div style={{ padding: 12, background: 'var(--warn-bg)', color: 'var(--warn-fg)', borderRadius: 8, fontSize: 13 }}>
          This range hit the 50,000-row ceiling, so the figures below and any export are incomplete. Narrow the dates.
        </div>
      )}
      {error && <div style={{ padding: 12, background: 'var(--bad-bg)', color: 'var(--bad-fg)', borderRadius: 8, fontSize: 13 }}>{error}</div>}
      {loading ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>
        : !data ? <EmptyState icon={<BarChart3 size={28} />} title="No data" message="No complaints in this range." />
        : (data.range?.total ?? 0) === 0 && activeCount > 0
          ? <EmptyState icon={<BarChart3 size={28} />} title="No complaints match these filters"
              message="Nothing in this date range matches every filter you picked. Clear one and try again." />
        : <Dashboard data={data} sort={sort} />}
    </div>
  );
}

function Dashboard({ data, sort }) {
  const k = data.kpis || {};
  return (
    <>
      {/* KPI band */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KpiCard label="Total Complaints" value={k.total ?? 0} icon="list" />
        <KpiCard label="Within 3 Days" value={k.within_3d ?? 0} tone="var(--ok-fg)" sub="of purchase" icon="check" />
        <KpiCard label="After 3 Days" value={k.after_3d ?? 0} tone="var(--warn-fg)" sub="of purchase" icon="clock" />
        <KpiCard label="Ageing Unknown" value={k.ageing_unknown ?? 0} tone="var(--t3)" sub={k.ageing_unknown ? 'no purchase date on file' : ''} icon="alert" />
      </div>

      {/* Product × issue-category matrix */}
      <Panel title="Complaints by Product" sub="rows = product · columns = issue category">
        <ProductMatrix matrix={data.by_product_matrix} sort={sort} />
      </Panel>

      {/* By issue category + top sub-categories */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <Panel title="Complaints by Issue Category"><RankedList rows={data.by_issue_category} sort={sort} showPct /></Panel>
        <Panel title="Top Issue Sub-categories" sub="top 20 by volume"><RankedList rows={data.top_subcategories} sort={sort} /></Panel>
      </div>

      {/* Product line + channels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Panel title="By Product Line (LOT line)"><RankedList rows={data.by_product_line} sort={sort} showPct /></Panel>
        <Panel title="By Sale Channel"><RankedList rows={data.by_sale_channel} sort={sort} showPct /></Panel>
        <Panel title="By Support Channel"><RankedList rows={data.by_support_channel} sort={sort} showPct /></Panel>
      </div>

      {/* Trend panels. The HEADING follows the grain too — a weekly table under a panel
          headed "Monthly" is the same error as a weekly CSV headed "Monthly", and the
          heading is the part someone screenshots. */}
      <Panel title={`${data.trend_grain === 'week' ? 'Weekly' : 'Monthly'} Product Issue Trend`}>
        <TrendBlock series={data.monthly_product_trend} dimLabel="Product" grain={data.trend_grain} />
      </Panel>
      <Panel title={`${data.trend_grain === 'week' ? 'Weekly' : 'Monthly'} Category Trend`}>
        <TrendBlock series={data.monthly_category_trend} dimLabel="Issue category" grain={data.trend_grain} />
      </Panel>
    </>
  );
}

function ProductMatrix({ matrix, sort }) {
  if (!matrix || !matrix.products?.length) return <Empty />;
  const cats = matrix.categories || [];
  // Sorting only reorders rows — the column set, the totals row and the heat scale are
  // all computed over the same products either way, so no number moves with the sort.
  const products = [...matrix.products].sort(sortBy(sort, p => p.product, p => p.total));
  const max = Math.max(1, ...products.flatMap(p => cats.map(c => p.cats[c] || 0)));
  const totals = cats.map(c => products.reduce((s, p) => s + (p.cats[c] || 0), 0));
  const grand = products.reduce((s, p) => s + p.total, 0);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={thL}>Product</th>
            <th style={thR}>Total</th>
            {cats.map(c => <th key={c} style={thR} title={c}>{abbr(c)}</th>)}
          </tr>
        </thead>
        <tbody>
          {products.map(p => (
            <tr key={p.product}>
              <td style={tdL}>{p.product}</td>
              <td style={{ ...tdR, fontWeight: 700 }}>{p.total}</td>
              {cats.map(c => {
                const v = p.cats[c] || 0;
                return <td key={c} style={{ ...tdR, background: heat(v, max) }}>{v || ''}</td>;
              })}
            </tr>
          ))}
          <tr>
            <td style={{ ...tdL, fontWeight: 700, borderTop: '2px solid var(--border)' }}>TOTAL</td>
            <td style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)' }}>{grand}</td>
            {totals.map((t, i) => <td key={i} style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)' }}>{t}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RankedList({ rows, showPct, sort }) {
  if (!rows || !rows.length) return <Empty />;
  // Bar width stays relative to the largest value in the panel, not the first row, so
  // "Fewest first" does not make the smallest item render as a full-width bar.
  const max = Math.max(1, ...rows.map(r => r.count));
  const ordered = sortRanked(rows, sort);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {ordered.map(r => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: '0 0 42%', fontSize: 12.5, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</span>
          <div style={{ flex: 1, height: 8, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(r.count / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
          </div>
          <span className="num" style={{ flex: '0 0 auto', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)', minWidth: 34, textAlign: 'right' }}>{r.count}</span>
          {showPct && <span className="num" style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--t3)', minWidth: 42, textAlign: 'right' }}>{r.pct}%</span>}
        </div>
      ))}
    </div>
  );
}

// Trend: total-cases chart + the full bucket × dimension table (sheet-faithful).
// `bucket` is a month (YYYY-MM) or a week-commencing Monday (YYYY-MM-DD) — the worker says
// which via trend_grain, and the column header follows it so the table can never be read
// as months when it is weeks.
function TrendBlock({ series, dimLabel, grain }) {
  if (!series || series.length === 0) return <Empty />;
  const bucketLabel = grain === 'week' ? 'Week of' : 'Month';
  // union of dimension keys across buckets, ordered by total desc; top 8 as chart series.
  const totalsByDim = {};
  for (const row of series) for (const kk of Object.keys(row)) {
    if (kk === 'bucket' || kk === 'total') continue;
    totalsByDim[kk] = (totalsByDim[kk] || 0) + row[kk];
  }
  const dims = Object.entries(totalsByDim).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const chartDims = dims.slice(0, 8);
  const chartSeries = chartDims.map((d, i) => ({ key: d, name: d, color: SERIES_COLORS[i % SERIES_COLORS.length], kind: 'area', stackId: 'a' }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <TrendChart data={series} xKey="bucket" series={chartSeries} height={240} xLabel={bucketLabel} showLegend />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={thL}>{bucketLabel}</th>
              <th style={thR}>Total</th>
              {dims.map(d => <th key={d} style={thR} title={d}>{abbr(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {series.map(row => (
              <tr key={row.bucket}>
                <td style={tdL}>{row.bucket}</td>
                <td style={{ ...tdR, fontWeight: 700 }}>{row.total}</td>
                {dims.map(d => <td key={d} style={tdR}>{row[d] || ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty() { return <div style={{ color: 'var(--t3)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>No data in this range.</div>; }
function abbr(s) { return String(s).length > 16 ? String(s).slice(0, 15) + '…' : s; }
function heat(v, max) {
  if (!v) return 'transparent';
  const a = 0.08 + (v / max) * 0.4;
  return `rgba(123, 147, 255, ${a.toFixed(3)})`;
}

const exportBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--f-ui)', fontSize: 12,
  fontWeight: 600, padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--t2)',
};
const clearBtn = {
  fontFamily: 'var(--f-ui)', fontSize: 11.5, fontWeight: 600, padding: '5px 10px',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'transparent',
  border: '1px solid var(--border)', color: 'var(--t3)',
};

const thL = { textAlign: 'left', padding: '7px 10px', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t3)', borderBottom: '1px solid var(--border)', position: 'sticky', left: 0, background: 'var(--surface)' };
const thR = { textAlign: 'right', padding: '7px 10px', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const tdL = { textAlign: 'left', padding: '6px 10px', color: 'var(--t1)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)' };
const tdR = { textAlign: 'right', padding: '6px 10px', color: 'var(--t2)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--f-mono)' };
