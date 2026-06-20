'use client';
/* Production History & Totals — daily PKG-OUT output by product, segregated
   Fresh (RTE/RTR) vs Returns (RTD_RETURN), with a running total for the chosen
   period. Reads getProductionHistory (→ get_production_history RPC). Cars only.
   Search a product to drill into its day-by-day history by variant + colour.
   Spec: docs/superpowers/specs/2026-06-15-redline-production-history-design.md */
import { useState, useEffect, useMemo } from 'react';
import { Download, Search, X } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, KpiTile, FilterChip, fmt } from '../../../components/kit/index.js';
import ProductionTrendChart from '../../../components/ProductionTrendChart.js';

const N = (v) => Number(v) || 0;
const variantLabel = (r) => [r.model, r.color].filter(Boolean).join(' ') || '—';

// ── date helpers ──────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function fmtISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtDay(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
}
// Preset → { from, to } ISO. Week starts Monday; FY starts Apr 1.
function presetRange(p) {
  const today = new Date();
  const to = fmtISO(today);
  if (p === 'today') return { from: to, to };
  if (p === 'thisweek') {
    const d = new Date(today);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    return { from: fmtISO(d), to };
  }
  if (p === 'thismonth') return { from: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`, to };
  if (p === 'thisfy') {
    const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    return { from: `${y}-04-01`, to };
  }
  return { from: to, to };
}

// ── chart bucketing ───────────────────────────────────────────
// Granularity follows the active date filter: Today → hourly, Week/Month → daily,
// FY → weekly, Custom → auto by span (1 day hourly, ≤~2 months daily, else weekly).
function daysInclusive(from, to) {
  const a = new Date(from + 'T00:00:00'), b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000) + 1;
}
function chartGranularity(preset, from, to) {
  if (preset === 'today') return 'hour';
  if (preset === 'thisweek' || preset === 'thismonth') return 'day';
  if (preset === 'thisfy') return 'week';
  const n = daysInclusive(from, to);
  if (n <= 1) return 'hour';
  if (n <= 62) return 'day';
  return 'week';
}
function weekStartISO(s) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return fmtISO(d);
}
function dayShort(s) {
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function hourLabel(h) {
  const ap = h < 12 ? 'a' : 'p';
  let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}${ap}`;
}

// ── CSV ───────────────────────────────────────────────────────
function downloadCsv(filename, rows, headers) {
  if (!rows || !rows.length) return false;
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ── styles (match /reporting) ─────────────────────────────────
const dateInputStyle = { background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border-2)', padding: '6px 10px', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 12.5, outline: 'none', colorScheme: 'dark' };
const thStyle = { padding: '9px 14px', fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tdStyle = { padding: '9px 14px', fontFamily: 'var(--font-ui)', fontSize: 13, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', color: 'var(--t1)' };
const numTd = { ...tdStyle, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const numTh = { ...thStyle, textAlign: 'right' };
const dlBtn = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 'var(--r-sm)', cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--t1)', border: '1px solid var(--border-2)', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' };

export default function ProductionHistoryPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const { setRefreshing, setLastRefreshed } = useRefreshState();

  const [preset, setPreset] = useState('thisweek');
  const [{ from, to }, setRange] = useState(() => presetRange('thisweek'));
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  function applyPreset(p) {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  }

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setRefreshing(true);
    (async () => {
      try {
        const data = await garageFetch('getProductionHistory', { from, to }, session);
        if (!cancelled) { setRows(Array.isArray(data) ? data : []); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load production history');
      } finally {
        if (!cancelled) { setLoading(false); setRefreshing(false); setLastRefreshed(new Date()); }
      }
    })();
    return () => { cancelled = true; };
  }, [session, from, to, setRefreshing, setLastRefreshed]);

  const products = useMemo(() => [...new Set(rows.map(r => r.product))].sort(), [rows]);

  // Filter + group. Empty/multi-match → product-level rows. Exactly one product
  // matched → that product's days broken down by variant + colour.
  const view = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? products.filter(p => p.toLowerCase().includes(q)) : products;
    const single = (q && matched.length === 1) ? matched[0] : null;
    const inScope = q ? rows.filter(r => matched.includes(r.product)) : rows;

    const totals = { fresh: 0, returns: 0, total: 0 };
    const byDay = {};
    for (const r of inScope) {
      const fresh = N(r.fresh_qty), ret = N(r.return_qty), tot = N(r.total_qty);
      totals.fresh += fresh; totals.returns += ret; totals.total += tot;
      const label = single ? variantLabel(r) : r.product;
      if (!byDay[r.day]) byDay[r.day] = { day: r.day, items: {}, fresh: 0, returns: 0, total: 0 };
      const d = byDay[r.day];
      if (!d.items[label]) d.items[label] = { label, fresh: 0, returns: 0, total: 0 };
      d.items[label].fresh += fresh; d.items[label].returns += ret; d.items[label].total += tot;
      d.fresh += fresh; d.returns += ret; d.total += tot;
    }
    const days = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1));
    days.forEach(d => { d.items = Object.values(d.items).sort((a, b) => b.total - a.total); });
    return { matched, single, noMatch: q && matched.length === 0, totals, days, inScope };
  }, [rows, products, search]);

  // ── trend chart: granularity from the filter; daily/weekly from rows, hourly from RPC ──
  const granularity = useMemo(() => chartGranularity(preset, from, to), [preset, from, to]);
  const [hourly, setHourly] = useState([]);
  useEffect(() => {
    if (!session || granularity !== 'hour') { setHourly([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const params = { day: from };
        if (view.single) params.product = view.single;
        const data = await garageFetch('getProductionHistoryHourly', params, session);
        if (!cancelled) setHourly(Array.isArray(data) ? data : []);
      } catch { if (!cancelled) setHourly([]); }
    })();
    return () => { cancelled = true; };
  }, [session, granularity, from, view.single]);

  const chartData = useMemo(() => {
    if (granularity === 'hour') {
      return hourly.slice().sort((a, b) => a.hour - b.hour)
        .map(h => ({ label: hourLabel(h.hour), fresh: N(h.fresh_qty), returns: N(h.return_qty) }));
    }
    const buckets = {};
    for (const r of view.inScope) {
      const key = granularity === 'week' ? weekStartISO(r.day) : r.day;
      if (!buckets[key]) buckets[key] = { key, fresh: 0, returns: 0 };
      buckets[key].fresh += N(r.fresh_qty);
      buckets[key].returns += N(r.return_qty);
    }
    return Object.values(buckets).sort((a, b) => (a.key < b.key ? -1 : 1))
      .map(b => ({ label: dayShort(b.key), fresh: b.fresh, returns: b.returns }));
  }, [granularity, hourly, view.inScope]);

  const granLabel = granularity === 'hour' ? 'hourly' : granularity === 'week' ? 'weekly' : 'daily';

  function exportCsv() {
    const flat = view.inScope.map(r => ({
      date: r.day, product: r.product, variant: r.model || '', colour: r.color || '',
      fresh: N(r.fresh_qty), returns: N(r.return_qty), total: N(r.total_qty),
    })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.total - a.total));
    const tag = view.single ? view.single.toLowerCase().replace(/\s+/g, '-') + '-' : '';
    const ok = downloadCsv(`production-history-${tag}${from}-to-${to}.csv`, flat, ['date', 'product', 'variant', 'colour', 'fresh', 'returns', 'total']);
    showToast(ok ? `Downloaded ${flat.length} rows` : 'Nothing to download', ok ? 'success' : 'warning');
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;

  const labelHeader = view.single ? 'Variant + Colour' : 'Product';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <FilterChip active={preset === 'today'}     onClick={() => applyPreset('today')}>Today</FilterChip>
        <FilterChip active={preset === 'thisweek'}  onClick={() => applyPreset('thisweek')}>This Week</FilterChip>
        <FilterChip active={preset === 'thismonth'} onClick={() => applyPreset('thismonth')}>This Month</FilterChip>
        <FilterChip active={preset === 'thisfy'}    onClick={() => applyPreset('thisfy')}>This FY</FilterChip>
        <FilterChip active={preset === 'custom'}    onClick={() => applyPreset('custom')}>Custom</FilterChip>
        {preset === 'custom' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="date" style={dateInputStyle} value={from} max={to} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
            <span style={{ color: 'var(--t3)', fontSize: 12 }}>→</span>
            <input type="date" style={dateInputStyle} value={to} min={from} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
          </span>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <button style={dlBtn} onClick={exportCsv} disabled={!view.inScope.length}><Download size={14} />Download CSV</button>
        </div>
      </div>

      {/* product search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--t3)', pointerEvents: 'none' }} />
          <input
            list="ph-products" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search a product…"
            style={{ ...dateInputStyle, fontFamily: 'var(--font-ui)', width: 240, padding: '7px 30px 7px 30px' }} />
          {search && (
            <button onClick={() => setSearch('')} title="Clear"
              style={{ position: 'absolute', right: 6, display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)' }}>
              <X size={14} />
            </button>
          )}
          <datalist id="ph-products">{products.map(p => <option key={p} value={p} />)}</datalist>
        </div>
        {view.single && (
          <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
            Showing <strong style={{ color: 'var(--t1)' }}>{view.single}</strong> by variant + colour · {from} → {to}
          </span>
        )}
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)', padding: '12px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 18 }}>{error}</div>
      )}

      {/* running totals for the period (reflect the active filter) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiTile label="Produced (fresh)" value={fmt(view.totals.fresh)}   tone="brand" />
        <KpiTile label="Re-dispatched"    value={fmt(view.totals.returns)} tone="warn" />
        <KpiTile label="Total packed out" value={fmt(view.totals.total)}   tone="ok" />
      </div>

      {/* trend chart — bucket granularity follows the active filter */}
      {view.inScope.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <Panel pad={16}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)' }}>
                Packed out · {granLabel}{view.single ? ` · ${view.single}` : ''}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t2)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#f2cd1a' }} />Fresh</span>
                {chartData.some(d => d.returns > 0) && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: '#60a5fa' }} />Returns</span>
                )}
              </span>
            </div>
            <ProductionTrendChart data={chartData} />
          </Panel>
        </div>
      )}

      {/* daily breakdown, newest first */}
      {view.days.length === 0 ? (
        <Panel pad={36}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--t3)' }}>
            <Icon name="package" size={22} />
            <span style={{ fontSize: 13 }}>{view.noMatch ? `No product matches "${search}".` : 'Nothing produced in this period.'}</span>
          </div>
        </Panel>
      ) : (
        <Panel pad={0}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>{labelHeader}</th>
                <th style={numTh}>Fresh</th>
                <th style={numTh}>Returns</th>
                <th style={numTh}>Total</th>
              </tr>
            </thead>
            <tbody>
              {view.days.map(d => [
                <tr key={d.day + '-h'} style={{ background: 'var(--surface-2)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.03em', color: 'var(--t1)' }}>{fmtDay(d.day)}</td>
                  <td style={{ ...numTd, color: 'var(--t2)', fontWeight: 700 }}>{fmt(d.fresh)}</td>
                  <td style={{ ...numTd, color: 'var(--t2)', fontWeight: 700 }}>{fmt(d.returns)}</td>
                  <td style={{ ...numTd, color: 'var(--t1)', fontWeight: 700 }}>{fmt(d.total)}</td>
                </tr>,
                ...d.items.map((it, i) => (
                  <tr key={d.day + '-' + it.label + i}>
                    <td style={{ ...tdStyle, paddingLeft: 28, color: 'var(--t2)' }}>{it.label}</td>
                    <td style={numTd}>{it.fresh ? fmt(it.fresh) : '—'}</td>
                    <td style={{ ...numTd, color: it.returns ? 'var(--warn-fg)' : 'var(--t3)' }}>{it.returns ? fmt(it.returns) : '—'}</td>
                    <td style={{ ...numTd, fontWeight: 600 }}>{fmt(it.total)}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
