'use client';
// Odo — Inventory (S223). Two jobs only: availability watch + history audit.
// Spec: docs/superpowers/specs/2026-07-20-odo-inventory-design.md
import { Fragment, useEffect, useMemo, useState } from 'react';
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

// Product-row availability: one small tick per variant, plus a plain-language summary.
//
// The first cut was a full-width proportional bar in saturated red/amber. Two problems: it
// stretched across half the table so the page read as an alarm even when most stock was fine,
// and a proportional bar can't tell you 4-of-5 from 8-of-10. One tick per variant fixes both —
// variant counts here are 1–11, so the marks stay legible AND the range size becomes visible.
//
// Only the exceptional states carry colour. "In stock" is drawn in a muted neutral rather than
// green, because it isn't news — letting it compete for attention is what made the original
// jarring. Muted red/amber still read clearly against it without shouting.
const TICK = {
  oos:  '#C4565B',
  low:  '#B8862F',
  ok:   'color-mix(in srgb, var(--t3) 38%, transparent)',
  gone: 'color-mix(in srgb, var(--t3) 18%, transparent)',
};

function Availability({ counts, total }) {
  const seq = [
    ...Array(counts.oos).fill('oos'), ...Array(counts.low).fill('low'),
    ...Array(counts.ok).fill('ok'), ...Array(counts.gone).fill('gone'),
  ];
  const parts = [];
  if (counts.oos) parts.push(`${counts.oos} of ${total} out`);
  if (counts.low) parts.push(`${counts.low} low`);
  if (counts.gone) parts.push(`${counts.gone} delisted`);
  if (!parts.length) parts.push(`All ${total} in stock`);

  return (
    <div style={{ minWidth: 150 }}>
      <div style={{ display: 'flex', gap: 3, marginBottom: 6, flexWrap: 'wrap', maxWidth: 220 }}>
        {seq.slice(0, 24).map((k, i) => (
          <span key={i} title={STATUS_META[k].label}
            style={{ width: 9, height: 5, borderRadius: 2, background: TICK[k], flex: '0 0 auto' }} />
        ))}
        {seq.length > 24 && (
          <span style={{ fontSize: 10, color: 'var(--t3)', lineHeight: '5px' }}>+{seq.length - 24}</span>
        )}
      </div>
      <span style={{ fontSize: 11, color: counts.oos ? 'var(--t2)' : 'var(--t3)' }}>{parts.join(' · ')}</span>
    </div>
  );
}

// Child-row label: the part of the variant that ISN'T the product name — "Tarmac Purple", not
// "Shadow Tarmac Purple" — since the product is already the row above. Falls back to the full
// name when it isn't a clean prefix (unmapped SKUs, odd titles).
function variantLabel(r) {
  const full = r.variant_name || r.family;
  if (r.family && full !== r.family && full.startsWith(r.family + ' ')) return full.slice(r.family.length + 1);
  return full === r.family ? (r.sku || full) : full;
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
  const [touched, setTouched] = useState({});   // family → explicit open/closed, overrides auto
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

  const nameOf = useMemo(() => Object.fromEntries(variants.map(v => [v.product_code, {
    family: v.product || '—',
    full: [v.product, v.model, v.color].filter(Boolean).join(' '),
  }])), [variants]);

  const enriched = useMemo(() => rows.map(r => ({
    ...r,
    available_qty: Number(r.available_qty) || 0,
    family: r.product_code ? (nameOf[r.product_code]?.family || r.product_code) : 'Unmapped',
    variant_name: r.product_code ? (nameOf[r.product_code]?.full || r.product_code) : (r.product_title || r.sku),
    // A `since` sitting on the earliest reading we hold is a floor, not an exact age.
    at_floor: !!(meta.history_start && r.since && new Date(r.since).getTime() <= new Date(meta.history_start).getTime()),
  })), [rows, nameOf, meta.history_start]);

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

  // Group the filtered variants under their product. A flat list of ~67 rows buries the thing
  // you actually want — WHICH products are partly out — so the product is the row and its
  // models/colours are children. Same shape as /products/drr.
  const groups = useMemo(() => {
    // Children come from the FILTERED set, but the rollup is computed over ALL of the product's
    // variants. Aggregating the filtered subset made the summary lie under any active filter —
    // with "Needs attention" on, Flare read "5 variants / 2 units" when it really has 11 and 107.
    // A rollup that only describes the rows that survived a filter is worse than no rollup.
    const all = new Map();
    for (const r of enriched) {
      if (!all.has(r.family)) all.set(r.family, []);
      all.get(r.family).push(r);
    }
    const shown = new Map();
    for (const r of filtered) {
      if (!shown.has(r.family)) shown.set(r.family, []);
      shown.get(r.family).push(r);
    }
    return [...shown.entries()].map(([family, rows]) => {
      const every = all.get(family) || rows;
      const c = { oos: 0, low: 0, ok: 0, gone: 0, unbuyable: 0 };
      let units = 0, oldest = null;
      for (const r of every) {
        c[r.status] = (c[r.status] || 0) + 1;
        if (!r.purchasable && r.status !== 'gone') c.unbuyable++;
        if (r.status !== 'gone') units += r.available_qty;
        const t = (r.status === 'oos' || r.status === 'low') && r.since ? new Date(r.since).getTime() : null;
        if (t && (oldest === null || t < oldest)) oldest = t;
      }
      // A product's headline status is its WORST variant — one colour out of stock is a fact
      // about the product, and averaging it away is what makes a rollup useless.
      const worst = c.oos ? 'oos' : c.low ? 'low' : c.gone === every.length ? 'gone' : 'ok';
      return { family, rows, counts: c, units, worst, oldest, total: every.length, shownCount: rows.length };
    });
  }, [filtered, enriched]);

  // Products needing attention first, then most variants out, then name.
  const sort = useTableSort(groups, {
    initialKey: 'attention', initialDir: 'desc',
    valueOf: (g, key) => key === 'attention' ? (g.counts.oos * 1000 + g.counts.low)
      : key === 'family' ? g.family
      : key === 'units' ? g.units
      : key === 'total' ? g.total
      : g[key],
  });
  const sortedGroups = sort.sorted;

  // With a filter on, every visible child already matches — collapsed rows would hide exactly
  // what was asked for, so open them. Manual toggles still win via `touched`.
  const autoExpand = filter !== 'all';
  const isOpen = (fam) => touched[fam] !== undefined ? touched[fam] : autoExpand;

  if (loading) return <Spinner />;

  const FILTERS = [
    ['attention', `Needs attention (${counts.oos + counts.low})`],
    ['all', `All (${enriched.length})`],
    ['oos', `Out of stock (${counts.oos})`],
    ['low', `Low (${counts.low})`],
    ['unbuyable', `Unbuyable (${counts.unbuyable})`],
    ['gone', `Delisted (${counts.gone})`],
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
          <button className="so-chip" onClick={() => downloadCsv(
            sortedGroups.flatMap(g => g.rows).map(r => ({
              product: r.family, variant: r.variant_name, sku: r.sku,
              product_code: r.product_code || '', qty: r.available_qty,
              status: r.status, purchasable: r.purchasable, since: r.since || '',
            })), 'inventory-watch.csv')}>Export CSV</button>
          <button className="so-chip" onClick={() => setTouched(
            Object.fromEntries(sortedGroups.map(g => [g.family, !sortedGroups.every(x => isOpen(x.family))])))}>
            {sortedGroups.every(g => isOpen(g.family)) ? 'Collapse all' : 'Expand all'}
          </button>
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
                <SortHeader k="attention" label="Availability" sort={sort} />
                <SortHeader k="total" label="Variants" sort={sort} numeric />
                <SortHeader k="units" label="Units" sort={sort} numeric />
                <th>Longest out</th>
                <th style={{ width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map(g => {
                const open = isOpen(g.family);
                return (
                  <Fragment key={g.family}>
                    <tr onClick={() => setTouched(t => ({ ...t, [g.family]: !open }))}
                      style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--t1)', fontWeight: 600 }}>
                        <span style={{ display: 'inline-block', width: 14, color: 'var(--t3)' }}>
                          {open ? '▾' : '▸'}
                        </span>
                        {g.family}
                      </td>
                      <td><Availability counts={g.counts} total={g.total} /></td>
                      <td className="so-num">
                        {g.total}
                        {g.shownCount < g.total && (
                          <span style={{ color: 'var(--t3)', fontSize: 11 }}> · {g.shownCount} shown</span>
                        )}
                      </td>
                      <td className="so-num">{fmtInt(g.units)}</td>
                      <td className="so-num" style={{ color: g.oldest ? 'var(--t2)' : 'var(--t3)' }}>
                        {g.oldest ? durationLabel(new Date(g.oldest).toISOString(), now,
                          meta.history_start && g.oldest <= new Date(meta.history_start).getTime()) : '—'}
                      </td>
                      <td />
                    </tr>
                    {open && g.rows.map(r => (
                      <tr key={`${r.channel_id}:${r.sku}`} style={{ background: 'var(--surface2)' }}>
                        <td style={{ paddingLeft: 34, color: 'var(--t2)' }}>
                          {variantLabel(r)}
                          {!r.purchasable && r.status !== 'gone' && (
                            <span style={{ marginLeft: 8, fontSize: 10, letterSpacing: '.08em', color: '#F59E0B' }}>UNBUYABLE</span>
                          )}
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>{r.sku}</div>
                        </td>
                        <td><StatusChip status={r.status} /></td>
                        <td />
                        <td className="so-num">{r.status === 'gone' ? '—' : fmtInt(r.available_qty)}</td>
                        <td className="so-num" style={{ color: 'var(--t2)' }}>
                          {r.status === 'gone'
                            ? <span style={{ fontSize: 11, color: 'var(--t3)' }}>last seen {istTime(r.last_seen_at)}</span>
                            : durationLabel(r.since, now, r.at_floor)}
                        </td>
                        <td />
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {!sortedGroups.length && (
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
      {/* RangePicker is a STICKY PAGE HEADER — it paints an opaque var(--bg) with a bottom
          border so content scrolls under it. Nesting it in a .so-card (var(--surface)) painted
          the page background as a black strip inside a lighter card. It belongs at page level,
          as on every other Odo page, with extra controls in its `right` slot. */}
      <RangePicker from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }}
        right={
          <div style={{ minWidth: 260 }}>
            <Combobox options={options} value={sku} onChange={setSku}
              placeholder="Pick a variant…" portal />
          </div>
        } />

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
