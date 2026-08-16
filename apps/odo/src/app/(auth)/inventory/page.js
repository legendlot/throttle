'use client';
// Odo — Inventory (S223; PRISM reskin 2026-07). Two jobs only: availability watch + history audit.
// Spec: docs/superpowers/specs/2026-07-20-odo-inventory-design.md
//
// The reskin is markup + tokens ONLY. Every RPC (`getInventoryStatus`, `getVariants`,
// `getInventoryHistory`), every argument, and every derived number below is unchanged —
// including the rollup-over-ALL-variants rule, the worst-variant headline, the `≥` floor
// durations and `variantLabel` prefix-stripping. (The old `autoExpand` rule was retired
// 2026-07-25 — groups now default to COLLAPSED on every filter; see `isOpen` below.)
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, Combobox } from '@throttle/ui';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea } from 'recharts';
import { salesGet, salesPost, fmtInt, istToday, istDaysAgo, downloadCsv } from '../../../lib/api.js';
import { downloadXlsx } from '../../../lib/xlsx.js';
import { Kpi, SegmentedToggle, RangePicker, useTableSort, SortHeader } from '../../../components/kit.js';
import { PageHead, PanelHead, Pill, Nil } from '../../../components/prism.js';
import { HUE } from '../../../lib/hues.js';

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

// Headline tallies over a set of status rows. Extracted so the hero KPI row can render on BOTH
// tabs from the `getInventoryStatus` payload each one already loads — no extra call, no new arg.
function statusCounts(rows) {
  const c = { oos: 0, low: 0, ok: 0, gone: 0, unbuyable: 0, units: 0 };
  for (const r of rows) {
    c[r.status] = (c[r.status] || 0) + 1;
    if (!r.purchasable && r.status !== 'gone') c.unbuyable++;
    if (r.status !== 'gone') c.units += Number(r.available_qty) || 0;
  }
  return c;
}

// Hero KPI 5-up. This is a STATUS row, so its hues are the STATUS_META colours rather than the
// generic metric hues — the tile colour has to agree with the dot next to the same word in the
// table below it.
function InventoryKpis({ counts, lowThreshold }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14 }}>
      <Kpi hue={STATUS_META.oos.color} lbl="Out of stock" val={fmtInt(counts.oos)} sub="website + Amazon FBA" />
      <Kpi hue={STATUS_META.low.color} lbl={`Low (< ${lowThreshold})`} val={fmtInt(counts.low)} sub="approaching zero" />
      <Kpi hue={HUE.returns} lbl="Unbuyable" val={fmtInt(counts.unbuyable)} sub="listing not purchasable" />
      <Kpi hue={HUE.units} lbl="Units on hand" val={fmtInt(counts.units)} sub="across tracked SKUs" />
      <Kpi hue={HUE.neutral} lbl="Delisted" val={fmtInt(counts.gone)} sub="gone from the feed" />
    </div>
  );
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
//
// PRISM note: the ticks are deliberately NOT restyled. The reskin touched the summary's type
// role (prose → --ui) and the overflow counter's (number → --mono) and nothing else.
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
      <div style={{ display: 'flex', gap: 3, marginBottom: 6, flexWrap: 'wrap', maxWidth: 220, alignItems: 'center' }}>
        {seq.slice(0, 24).map((k, i) => (
          <span key={i} title={STATUS_META[k].label}
            style={{ width: 9, height: 5, borderRadius: 2, background: TICK[k], flex: '0 0 auto' }} />
        ))}
        {seq.length > 24 && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t4)', lineHeight: '5px' }}>+{seq.length - 24}</span>
        )}
      </div>
      {/* The summary is a sentence, not a datum — it stays in the UI font (§3.1). */}
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: counts.oos ? 'var(--t2)' : 'var(--t3)' }}>
        {parts.join(' · ')}
      </span>
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t1)' }}>
      <span className="so-dot" style={{ background: m.color, flex: '0 0 auto' }} />
      {m.label}
    </span>
  );
}

export default function InventoryPage() {
  const { session, perms } = useAuth();
  const isAdmin = !!(perms && perms.salesops_admin);
  const [tab, setTab] = useState('watch');
  return (
    <div className="so-page" style={{ gap: 12 }}>
      <PageHead
        title="Inventory"
        sub="Availability watch and history audit · Website (Shopify) + Amazon (FBA fulfillable)"
        right={
          <SegmentedToggle
            options={[{ key: 'watch', label: 'Watch' }, { key: 'history', label: 'History' }]}
            value={tab} onChange={setTab}
          />
        }
      />
      {tab === 'watch' ? <Watch session={session} isAdmin={isAdmin} /> : <History session={session} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Watch */

function Watch({ session, isAdmin }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('attention');
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [touched, setTouched] = useState({});   // family → explicit open/closed, overrides auto
  const [variants, setVariants] = useState([]);
  const [thresholds, setThresholds] = useState({});   // product_code → per-variant low-stock override
  const [alerts, setAlerts] = useState([]);
  const [err, setErr] = useState('');
  const now = Date.now();

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    Promise.all([
      salesGet('getInventoryStatus', { include_unmapped: showUnmapped ? '1' : '0' }, session),
      salesGet('getVariants', {}, session),
      salesGet('getInvThresholds', {}, session),
      salesGet('getStockAlerts', { limit: '60' }, session),
    ]).then(([s, v, t, al]) => {
      setRows(Array.isArray(s?.rows) ? s.rows : []);
      setMeta({ history_start: s?.history_start || null, low_threshold: Number(s?.low_threshold) || 10 });
      setVariants(Array.isArray(v?.rows) ? v.rows : []);
      setThresholds(Object.fromEntries((Array.isArray(t?.rows) ? t.rows : []).map(x => [x.product_code, Number(x.low_stock_qty)])));
      setAlerts(Array.isArray(al?.rows) ? al.rows : []);
    }).finally(() => setLoading(false));
  }, [session, showUnmapped]);

  // null = no override, inheriting the global. Kept distinct from 0, which is a legitimate
  // "never warn" setting — conflating the two would silently switch alerting off.
  const thresholdOf = code => (code && Object.prototype.hasOwnProperty.call(thresholds, code) ? thresholds[code] : null);
  const saveThreshold = async (code, raw) => {
    if (!code) return;
    const v = String(raw ?? '').trim();
    const next = v === '' ? null : Number(v);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return;
    if (next === thresholdOf(code)) return;                    // no-op edit — don't write
    // Optimistic, then reload so `status`/`low_threshold` come back from the RPC rather than
    // being recomputed client-side — the threshold decides the row's status and only one place
    // should own that rule.
    setThresholds(prev => { const n = { ...prev }; if (next === null) delete n[code]; else n[code] = next; return n; });
    try {
      await salesPost('setInvThreshold', { product_code: code, low_stock_qty: next }, session);
      const s = await salesGet('getInventoryStatus', { include_unmapped: showUnmapped ? '1' : '0' }, session);
      setRows(Array.isArray(s?.rows) ? s.rows : []);
    } catch (e) { setErr(e.message || String(e)); }
  };

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

  const counts = useMemo(() => statusCounts(enriched), [enriched]);

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

  // COLLAPSED IS THE DEFAULT, on every filter (Afshaan, 2026-07-25).
  // This replaces the old `autoExpand = filter !== 'all'` rule, whose reasoning was that a filter
  // implies you want to see the matching variants. In practice the product list is long enough
  // that auto-expanding buries the product-level rollup — which is the row you actually scan —
  // under its own children. Open what you need from the master toggle in the Product header, or
  // per product. Manual toggles still win via `touched`.
  const isOpen = (fam) => touched[fam] === true;

  if (loading) return <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>;

  // Each filter carries its own colour so the chip row reads as the same vocabulary as the
  // status dots below it. "Needs attention" is oos+low, so it gets both.
  const FILTERS = [
    ['attention', 'Needs attention', counts.oos + counts.low, `linear-gradient(135deg,${STATUS_META.oos.color},${STATUS_META.low.color})`],
    ['all', 'All', enriched.length, 'var(--t3)'],
    ['oos', 'Out of stock', counts.oos, STATUS_META.oos.color],
    ['low', 'Low', counts.low, STATUS_META.low.color],
    ['unbuyable', 'Unbuyable', counts.unbuyable, HUE.returns],
    ['gone', 'Delisted', counts.gone, STATUS_META.gone.color],
  ];

  // `every` on an empty array is true, which would label the master toggle "Collapse all" over an
  // empty table — require at least one group.
  // Shared by both export buttons so the two formats can never drift apart.
  const exportRows = () => sortedGroups.flatMap(g => g.rows).map(r => ({
    product: r.family, variant: r.variant_name, sku: r.sku,
    product_code: r.product_code || '', qty: r.available_qty,
    status: r.status, purchasable: r.purchasable, since: r.since || '',
  }));

  const allOpen = sortedGroups.length > 0 && sortedGroups.every(g => isOpen(g.family));
  const toggleAll = () => setTouched(Object.fromEntries(sortedGroups.map(g => [g.family, !allOpen])));

  return (
    <>
      {err && <div className="so-card" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}
      <InventoryKpis counts={counts} lowThreshold={meta.low_threshold} />

      <div className="so-card flush" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '0 18px 14px' }}>
          {FILTERS.map(([k, lbl, n, color]) => (
            <button key={k} className={`so-chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
              <span className="so-swatch" style={{ background: color }} />
              {lbl}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: filter === k ? 'inherit' : 'var(--t4)' }}>
                {fmtInt(n)}
              </span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t3)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showUnmapped} onChange={e => setShowUnmapped(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }} />
            Show unmapped SKUs
          </label>
          <button className="so-btn ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => downloadXlsx(exportRows(), 'inventory-watch.xlsx', 'Inventory')}>
            <Download size={14} strokeWidth={1.75} />Export Excel
          </button>
          <button className="so-btn ghost"
            onClick={() => downloadCsv(exportRows(), 'inventory-watch.csv')}>CSV</button>
          {/* Expand/collapse-all lives in the Product column header, not out here — see the table
              head below. It belongs beside the column it acts on, at the start of the reading line. */}
        </div>

        {!showUnmapped && (
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--t3)', padding: '0 18px 12px', margin: 0, maxWidth: 780, lineHeight: 1.6 }}>
            Showing SKUs mapped to a product. Most of the raw Shopify feed is retired or
            non-catalogue variants — turn on <em>Show unmapped</em> to see them, and map the real
            ones in <a href="/mapping" style={{ color: 'var(--accent)' }}>Mapping</a>.
          </p>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead>
              <tr>
                {/* Master expand/collapse sits IN the Product header, aligned with the per-row
                    chevrons directly beneath it, so the whole column reads as one control. The
                    chevron mirrors the row convention (down = open) rather than naming the action.
                    stopPropagation keeps the header's own click free for sorting. */}
                <SortHeader k="family" sort={sort} label={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                    <span role="button" tabIndex={0}
                      title={allOpen ? 'Collapse all products' : 'Expand all products'}
                      aria-label={allOpen ? 'Collapse all products' : 'Expand all products'}
                      onClick={(e) => { e.stopPropagation(); toggleAll(); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleAll(); } }}
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 19, height: 19, borderRadius: 5, cursor: 'pointer',
                        background: 'var(--control)', border: '1px solid var(--border-ctl)',
                        color: allOpen ? 'var(--accent)' : 'var(--t2)' }}>
                      {allOpen ? <ChevronDown size={13} strokeWidth={2} /> : <ChevronRight size={13} strokeWidth={2} />}
                    </span>
                    Product
                  </span>
                } />
                <SortHeader k="attention" label="Availability" sort={sort} />
                <SortHeader k="total" label="Variants" sort={sort} numeric />
                <SortHeader k="units" label="Units" sort={sort} numeric />
                <th className="so-num" title="Low-stock threshold. Blank = the global default; set a per-variant number where the default over- or under-warns.">Low &lt;</th>
                <th className="so-num">Longest out</th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map(g => {
                const open = isOpen(g.family);
                return (
                  <Fragment key={g.family}>
                    <tr onClick={() => setTouched(t => ({ ...t, [g.family]: !open }))}
                      style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--t1)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {open
                            ? <ChevronDown size={15} strokeWidth={1.75} color="var(--t3)" style={{ flex: 'none' }} />
                            : <ChevronRight size={15} strokeWidth={1.75} color="var(--t3)" style={{ flex: 'none' }} />}
                          {g.family}
                        </span>
                      </td>
                      <td><Availability counts={g.counts} total={g.total} /></td>
                      <td className="so-num">
                        {g.total}
                        {g.shownCount < g.total && (
                          <span style={{ color: 'var(--t4)', fontSize: 10.5 }}> · {g.shownCount} shown</span>
                        )}
                      </td>
                      <td className="so-num bright">{fmtInt(g.units)}</td>
                      {/* threshold is per-variant, so the product row stays blank rather than
                          showing an average that belongs to nothing */}
                      <td />
                      <td className="so-num" style={{ color: g.oldest ? 'var(--t2-cell)' : undefined }}>
                        {g.oldest ? durationLabel(new Date(g.oldest).toISOString(), now,
                          meta.history_start && g.oldest <= new Date(meta.history_start).getTime()) : <Nil />}
                      </td>
                    </tr>
                    {open && g.rows.map(r => (
                      <tr key={`${r.channel_id}:${r.sku}`} style={{ background: 'var(--surface2)' }}>
                        <td style={{ paddingLeft: 42, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
                          {variantLabel(r)}
                          {!r.purchasable && r.status !== 'gone' && (
                            <Pill color={STATUS_META.low.color} style={{ marginLeft: 8 }}>Unbuyable</Pill>
                          )}
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t4)', marginTop: 2 }}>{r.sku}</div>
                        </td>
                        <td><StatusChip status={r.status} /></td>
                        <td />
                        <td className="so-num">{r.status === 'gone' ? <Nil /> : fmtInt(r.available_qty)}</td>
                        {/* Per-variant low-stock override. Blank input = inheriting the global, which
                            is why the placeholder shows the global value rather than 0 — an empty box
                            that behaves like "10" must say so. Admins only; everyone else sees the
                            effective number, since the threshold explains the row's own status. */}
                        <td className="so-num">
                          {r.status === 'gone' ? <Nil /> : isAdmin ? (
                            <input
                              type="number" min="0"
                              defaultValue={thresholdOf(r.product_code) ?? ''}
                              placeholder={String(meta.low_threshold)}
                              title={thresholdOf(r.product_code) == null ? `Inheriting the global default (${meta.low_threshold}). Type a number to override.` : 'Per-variant override. Clear the box to fall back to the global.'}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                              onBlur={e => saveThreshold(r.product_code, e.currentTarget.value)}
                              style={{ width: 56, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11,
                                       background: 'var(--control)', border: '1px solid var(--border-ctl)',
                                       borderRadius: 6, padding: '2px 6px', color: 'var(--t1)' }} />
                          ) : (
                            <span style={{ color: thresholdOf(r.product_code) == null ? 'var(--t4)' : 'var(--t2)' }}>
                              {r.low_threshold}
                            </span>
                          )}
                        </td>
                        <td className="so-num" style={{ color: 'var(--t2)' }}>
                          {r.status === 'gone'
                            ? <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>last seen {istTime(r.last_seen_at)}</span>
                            : durationLabel(r.since, now, r.at_floor)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
              {!sortedGroups.length && (
                <tr><td colSpan={5} style={{ color: 'var(--t3)', padding: 22, textAlign: 'center' }}>
                  Nothing in this filter.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--t3)', padding: '14px 18px 16px', margin: 0, lineHeight: 1.6 }}>
          Two channels, and the counts above are the BLENDED total. <b style={{ color: 'var(--t2)' }}>Website</b> is
          Shopify availability; <b style={{ color: 'var(--t2)' }}>Amazon</b> is FBA <b style={{ color: 'var(--t2)' }}>fulfillable</b> quantity
          — units in a fulfilment centre, sellable now. Amazon stock that is reserved, inbound-working or
          inbound-shipped is deliberately excluded, so an Amazon row reading 0 can still have units in transit.
          Amazon history starts 2026-08-16; Website reaches further back. Durations shown with ≥ reach the start
          of the history we hold (<span style={{ fontFamily: 'var(--mono)', color: 'var(--t4)' }}>{meta.history_start ? istTime(meta.history_start) : '—'}</span>) and are
          therefore a floor, not an exact age.
        </p>
      </div>

      <StockAlertLog alerts={alerts} />
    </>
  );
}

/* Stock-alert history. The outbox has been posting to #stock-alerts since 2026-07-20 but had no
   in-app surface at all, so the only record of what was announced lived in Slack scrollback.
   Read-only — this reports what the sender did, it never re-sends. */
function StockAlertLog({ alerts }) {
  const [open, setOpen] = useState(false);
  if (!alerts.length) return null;
  const sent = alerts.filter(a => a.status === 'sent').length;
  return (
    <div className="so-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
           onClick={() => setOpen(o => !o)}>
        <div className="so-eyebrow" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {open ? <ChevronDown size={13} strokeWidth={2} color="var(--t3)" /> : <ChevronRight size={13} strokeWidth={2} color="var(--t3)" />}
          Recent stock alerts
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)' }}>
          {sent} sent{alerts.length > sent ? ` · ${alerts.length - sent} not sent` : ''}
        </span>
      </div>
      {open && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="so-table">
            <thead><tr>
              <th>Flipped (IST)</th><th>What</th><th>Direction</th><th className="so-num">Units</th><th>Status</th>
            </tr></thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }}>{istTime(a.flipped_at)}</td>
                  <td>
                    {a.scope === 'product' ? (a.product_family || a.product_title || a.sku) : (a.product_title || a.sku)}
                    {a.scope === 'product' && <Pill color={HUE.neutral} style={{ marginLeft: 8 }}>whole product</Pill>}
                  </td>
                  <td>
                    <StatusChip status={a.direction === 'oos' ? 'oos' : 'ok'} />
                    <span style={{ marginLeft: 6, color: 'var(--t2)', fontSize: 11 }}>{a.direction === 'oos' ? 'went out' : 'restocked'}</span>
                  </td>
                  <td className="so-num" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)' }}>
                    {a.qty_before ?? '—'} → {a.qty_after ?? '—'}
                  </td>
                  <td>
                    {a.status === 'sent'
                      ? <span style={{ color: 'var(--t2)', fontSize: 11 }}>sent {a.sent_at ? istTime(a.sent_at) : ''}</span>
                      /* `skipped` is not a failure: it is the deliberate staleness guard + the
                         day-one baseline, both of which exist so the channel is never blasted
                         with history. Say that rather than showing a bare red word. */
                      : <span style={{ color: 'var(--t4)', fontSize: 11 }}
                              title="Retired unsent — either the day-one baseline or older than the staleness window when the sender ran.">
                          not sent · {a.status}
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- History */

function History({ session }) {
  const [variants, setVariants] = useState([]);
  const [statusRows, setStatusRows] = useState([]);
  const [lowThreshold, setLowThreshold] = useState(10);
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
      setLowThreshold(Number(s?.low_threshold) || 10);
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

  // Same headline row as Watch, off the getInventoryStatus payload this tab already loads.
  const counts = useMemo(() => statusCounts(statusRows), [statusRows]);

  const picked = useMemo(() => options.find(o => o.value === sku), [options, sku]);

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

      {statusRows.length > 0 && <InventoryKpis counts={counts} lowThreshold={lowThreshold} />}

      {loading ? <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div> : (
        <>
          <div className="so-card">
            <PanelHead title="Stock level" qual={picked ? `· ${picked.label}` : undefined} />
            {/* The chart sits in a plain wrapper so .so-card's backdrop-filter is never its
                DIRECT parent (§7) — and the stepAfter line + red oosBands are unchanged. */}
            <div>
              {chart.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={chart}>
                    <CartesianGrid strokeDasharray="4 4" stroke="var(--row-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--t3)', fontFamily: 'var(--mono)' }}
                      minTickGap={40} axisLine={{ stroke: 'var(--border-table)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--t3)', fontFamily: 'var(--mono)' }}
                      allowDecimals={false} axisLine={false} tickLine={false} width={44} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface-solid)', border: '1px solid var(--border-ctl)',
                        borderRadius: 10, fontFamily: 'var(--mono)', fontSize: 11.5 }}
                      labelStyle={{ color: 'var(--t3)' }} itemStyle={{ color: 'var(--t1)' }}
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
                <p style={{ fontFamily: 'var(--ui)', color: 'var(--t3)', fontSize: 13, padding: '18px 0' }}>
                  No readings for this SKU in the selected range.
                </p>
              )}
            </div>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--t3)', margin: '12px 0 0', lineHeight: 1.6 }}>
              Shaded bands are out-of-stock periods. Shopify exposes no historical inventory API,
              so this record begins when capture started — there is no earlier data to backfill.
            </p>
          </div>

          <div className="so-card flush" style={{ overflow: 'hidden' }}>
            <PanelHead title="Changes" qual={`(${flips.length})`} style={{ marginBottom: 0 }} />
            <div style={{ overflowX: 'auto' }}>
              <table className="so-table">
                <thead>
                  <tr><th>When (IST)</th><th>From</th><th>To</th><th className="so-num">Units</th></tr>
                </thead>
                <tbody>
                  {flips.map((f, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>
                        {istTime(f.captured_at)}
                      </td>
                      <td><StatusChip status={f.prev_status} /></td>
                      <td><StatusChip status={f.status} /></td>
                      <td className="so-num bright">{fmtInt(Number(f.available_qty) || 0)}</td>
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
