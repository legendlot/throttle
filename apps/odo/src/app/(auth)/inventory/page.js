'use client';
// Odo — Inventory (S223). Two jobs only: availability watch + history audit.
// Spec: docs/superpowers/specs/2026-07-20-odo-inventory-design.md
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Combobox } from '@throttle/ui';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea } from 'recharts';
import { salesGet, fmtInt, istToday, istDaysAgo, downloadCsv } from '../../../lib/api.js';
import { Kpi, SegmentedToggle, RangePicker, useTableSort, SortHeader } from '../../../components/kit.js';

const STATUS_META = {
  oos:   { label: 'Out of stock', color: '#F2545B' },
  low:   { label: 'Low',          color: '#F59E0B' },
  ok:    { label: 'In stock',     color: '#34D27B' },
  gone:  { label: 'Delisted',     color: '#8A8C95' },
};

// IST display of a UTC timestamp. The DB stores true UTC; conversion happens here only.
const istTime = (ts) => ts ? new Date(ts).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

// Duration in human terms. `atFloor` = the run reaches the earliest reading we hold, so the
// true duration is at least this — render "≥" rather than implying precision we don't have.
function durationLabel(since, now, atFloor) {
  if (!since) return '—';
  const mins = Math.max(0, (now - new Date(since).getTime()) / 60000);
  const s = mins < 90 ? `${Math.round(mins)}m`
    : mins < 60 * 36 ? `${Math.round(mins / 60)}h`
    : `${Math.round(mins / 1440)}d`;
  return (atFloor ? '≥ ' : '') + s;
}

function StatusChip({ status }) {
  const m = STATUS_META[status] || STATUS_META.ok;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t1)' }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: m.color, flex: '0 0 auto' }} />
      {m.label}
    </span>
  );
}

export default function InventoryPage() {
  const { session } = useAuth();
  const [tab, setTab] = useState('watch');
  return (
    <div className="so-page">
      <SegmentedToggle
        options={[{ key: 'watch', label: 'Watch' }, { key: 'history', label: 'History' }]}
        value={tab} onChange={setTab}
      />
      {tab === 'watch' ? <Watch session={session} /> : <History session={session} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Watch */

function Watch({ session }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('attention');
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [variants, setVariants] = useState([]);
  const now = Date.now();

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      salesGet('getInventoryStatus', { include_unmapped: showUnmapped ? '1' : '0' }, session),
      salesGet('getVariants', {}, session),
    ]).then(([s, v]) => {
      setRows(Array.isArray(s?.rows) ? s.rows : []);
      setMeta({ history_start: s?.history_start || null, low_threshold: Number(s?.low_threshold) || 10 });
      setVariants(Array.isArray(v?.rows) ? v.rows : []);
    }).finally(() => setLoading(false));
  }, [session, showUnmapped]);

  const famOf = useMemo(() => Object.fromEntries(
    variants.map(v => [v.product_code, v.product || '—'])), [variants]);

  const enriched = useMemo(() => rows.map(r => ({
    ...r,
    available_qty: Number(r.available_qty) || 0,
    family: r.product_code ? (famOf[r.product_code] || r.product_code) : 'Unmapped',
    // A `since` sitting on the earliest reading we hold is a floor, not an exact age.
    at_floor: !!(meta.history_start && r.since && new Date(r.since).getTime() <= new Date(meta.history_start).getTime()),
  })), [rows, famOf, meta.history_start]);

  const counts = useMemo(() => {
    const c = { oos: 0, low: 0, ok: 0, gone: 0, unbuyable: 0, units: 0 };
    for (const r of enriched) {
      c[r.status] = (c[r.status] || 0) + 1;
      if (!r.purchasable && r.status !== 'gone') c.unbuyable++;
      if (r.status !== 'gone') c.units += r.available_qty;
    }
    return c;
  }, [enriched]);

  const filtered = useMemo(() => {
    if (filter === 'all') return enriched;
    if (filter === 'attention') return enriched.filter(r => r.status === 'oos' || r.status === 'low');
    if (filter === 'unbuyable') return enriched.filter(r => !r.purchasable && r.status !== 'gone');
    return enriched.filter(r => r.status === filter);
  }, [enriched, filter]);

  // Default sort = longest in its current state first, which is the order that matters on a
  // watch list. `since` must sort by epoch, not by ISO string.
  const sort = useTableSort(filtered, {
    initialKey: 'since', initialDir: 'asc',
    valueOf: (row, key) => key === 'since'
      ? (row.since ? new Date(row.since).getTime() : Number.MAX_SAFE_INTEGER)
      : row[key],
  });
  const sorted = sort.sorted;

  if (loading) return <Spinner />;

  const FILTERS = [
    ['attention', `Needs attention (${counts.oos + counts.low})`],
    ['oos', `Out of stock (${counts.oos})`],
    ['low', `Low (${counts.low})`],
    ['unbuyable', `Unbuyable (${counts.unbuyable})`],
    ['gone', `Delisted (${counts.gone})`],
    ['all', `All (${enriched.length})`],
  ];

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
        <Kpi lbl="Out of stock" val={fmtInt(counts.oos)} sub="live on the website" />
        <Kpi lbl={`Low (< ${meta.low_threshold})`} val={fmtInt(counts.low)} sub="approaching zero" />
        <Kpi lbl="Unbuyable" val={fmtInt(counts.unbuyable)} sub="listing not purchasable" />
        <Kpi lbl="Units on hand" val={fmtInt(counts.units)} sub="across tracked SKUs" />
        <Kpi lbl="Delisted" val={fmtInt(counts.gone)} sub="gone from the feed" />
      </div>

      <div className="so-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
          {FILTERS.map(([k, lbl]) => (
            <button key={k} className={`so-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{lbl}</button>
          ))}
          <div style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--t3)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showUnmapped} onChange={e => setShowUnmapped(e.target.checked)} />
            Show unmapped SKUs
          </label>
          <button className="so-chip" onClick={() => downloadCsv(sorted.map(r => ({
            sku: r.sku, product_code: r.product_code || '', product: r.family, qty: r.available_qty,
            status: r.status, purchasable: r.purchasable, since: r.since || '',
          })), 'inventory-watch.csv')}>Export CSV</button>
        </div>

        {!showUnmapped && (
          <p style={{ fontSize: 12, color: 'var(--t3)', margin: '0 0 12px' }}>
            Showing SKUs mapped to a product. Most of the raw Shopify feed is retired or
            non-catalogue variants — turn on <em>Show unmapped</em> to see them, and map the real
            ones in <a href="/mapping" style={{ color: 'var(--accent)' }}>Mapping</a>.
          </p>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead>
              <tr>
                <SortHeader k="family" label="Product" sort={sort} />
                <SortHeader k="sku" label="SKU" sort={sort} />
                <SortHeader k="available_qty" label="Qty" sort={sort} numeric />
                <SortHeader k="status" label="Status" sort={sort} />
                <SortHeader k="since" label="In this state" sort={sort} />
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={`${r.channel_id}:${r.sku}`}>
                  <td style={{ color: 'var(--t1)' }}>
                    {r.family}
                    {!r.purchasable && r.status !== 'gone' && (
                      <span style={{ marginLeft: 8, fontSize: 10, letterSpacing: '.08em', color: '#F59E0B' }}>UNBUYABLE</span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.sku}</td>
                  <td className="so-num">{fmtInt(r.available_qty)}</td>
                  <td><StatusChip status={r.status} /></td>
                  <td className="so-num">{durationLabel(r.since, now, r.at_floor)}</td>
                  <td style={{ fontSize: 12, color: 'var(--t3)' }}>{istTime(r.last_seen_at)}</td>
                </tr>
              ))}
              {!sorted.length && (
                <tr><td colSpan={6} style={{ color: 'var(--t3)', padding: 22, textAlign: 'center' }}>
                  Nothing in this filter.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: 11, color: 'var(--t3)', margin: '14px 0 0' }}>
          Website (Shopify) only — Amazon is not wired yet. Durations shown with ≥ reach the start
          of the history we hold ({meta.history_start ? istTime(meta.history_start) : '—'}) and are
          therefore a floor, not an exact age.
        </p>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- History */

function History({ session }) {
  const [variants, setVariants] = useState([]);
  const [statusRows, setStatusRows] = useState([]);
  const [sku, setSku] = useState('');
  const [from, setFrom] = useState(istDaysAgo(30));
  const [to, setTo] = useState(istToday());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      salesGet('getVariants', {}, session),
      salesGet('getInventoryStatus', {}, session),
    ]).then(([v, s]) => {
      setVariants(Array.isArray(v?.rows) ? v.rows : []);
      const sr = Array.isArray(s?.rows) ? s.rows : [];
      setStatusRows(sr);
      if (!sku && sr.length) setSku(sr[0].sku);
    });
  }, [session]);

  useEffect(() => {
    if (!session || !sku) return;
    setLoading(true);
    salesGet('getInventoryHistory', { sku, from, to }, session)
      .then(r => setRows(Array.isArray(r?.rows) ? r.rows : []))
      .finally(() => setLoading(false));
  }, [session, sku, from, to]);

  const famOf = useMemo(() => Object.fromEntries(
    variants.map(v => [v.product_code, [v.product, v.model, v.color].filter(Boolean).join(' ')])), [variants]);

  const options = useMemo(() => statusRows.map(r => ({
    value: r.sku,
    label: r.product_code ? (famOf[r.product_code] || r.product_code) : r.sku,
    hint: r.sku,
  })), [statusRows, famOf]);

  const chart = useMemo(() => rows.map(r => ({
    t: new Date(r.captured_at).getTime(),
    label: istTime(r.captured_at),
    qty: Number(r.available_qty) || 0,
    status: r.status,
  })), [rows]);

  // Contiguous out-of-stock spans, for shading behind the line.
  const oosBands = useMemo(() => {
    const bands = []; let start = null;
    for (const p of chart) {
      if (p.status === 'oos' && start === null) start = p.t;
      if (p.status !== 'oos' && start !== null) { bands.push([start, p.t]); start = null; }
    }
    if (start !== null && chart.length) bands.push([start, chart[chart.length - 1].t]);
    return bands;
  }, [chart]);

  const flips = useMemo(() => rows.filter(r => r.is_flip), [rows]);

  return (
    <>
      <div className="so-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{ minWidth: 300 }}>
            <Combobox
              options={options} value={sku} onChange={setSku}
              placeholder="Pick a SKU…" portal
            />
          </div>
          <RangePicker from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        </div>
      </div>

      {loading ? <Spinner /> : (
        <>
          <div className="so-card">
            <h3 style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--t2)' }}>Stock level</h3>
            {chart.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--t3)' }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--t3)' }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }}
                    formatter={(v) => [fmtInt(v), 'Units']}
                  />
                  {oosBands.map(([a, b], i) => (
                    <ReferenceArea key={i} x1={chart.find(p => p.t === a)?.label}
                      x2={chart.find(p => p.t === b)?.label}
                      fill="#F2545B" fillOpacity={0.12} strokeOpacity={0} />
                  ))}
                  <Area type="stepAfter" dataKey="qty" stroke="var(--accent)"
                    fill="var(--accent)" fillOpacity={0.14} strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p style={{ color: 'var(--t3)', fontSize: 13, padding: '18px 0' }}>
                No readings for this SKU in the selected range.
              </p>
            )}
            <p style={{ fontSize: 11, color: 'var(--t3)', margin: '12px 0 0' }}>
              Shaded bands are out-of-stock periods. Shopify exposes no historical inventory API,
              so this record begins when capture started — there is no earlier data to backfill.
            </p>
          </div>

          <div className="so-card">
            <h3 style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--t2)' }}>Changes ({flips.length})</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
                <thead>
                  <tr><th>When (IST)</th><th>From</th><th>To</th><th className="so-num">Units</th></tr>
                </thead>
                <tbody>
                  {flips.map((f, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 12 }}>{istTime(f.captured_at)}</td>
                      <td><StatusChip status={f.prev_status} /></td>
                      <td><StatusChip status={f.status} /></td>
                      <td className="so-num">{fmtInt(Number(f.available_qty) || 0)}</td>
                    </tr>
                  ))}
                  {!flips.length && (
                    <tr><td colSpan={4} style={{ color: 'var(--t3)', padding: 22, textAlign: 'center' }}>
                      No stock changes in this range.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
