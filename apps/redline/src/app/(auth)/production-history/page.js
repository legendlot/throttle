'use client';
/* Production History & Totals — daily PKG-OUT output by product, segregated
   Fresh (RTE/RTR) vs Returns (RTD_RETURN), with a running total for the chosen
   period. Reads getProductionHistory (→ get_production_history RPC). Cars only.
   Spec: docs/superpowers/specs/2026-06-15-redline-production-history-design.md */
import { useState, useEffect, useMemo } from 'react';
import { Download } from 'lucide-react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { useRefreshState } from '../layout.js';
import { Icon, Panel, KpiTile, FilterChip, fmt } from '../../../components/kit/index.js';

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
    const back = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    d.setDate(d.getDate() - back);
    return { from: fmtISO(d), to };
  }
  if (p === 'thismonth') return { from: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`, to };
  if (p === 'thisfy') {
    const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    return { from: `${y}-04-01`, to };
  }
  return { from: to, to };
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

  // period totals + day grouping (newest day first; products by total desc)
  const { totals, days } = useMemo(() => {
    const t = { fresh: 0, returns: 0, total: 0 };
    const byDay = {};
    for (const r of rows) {
      const fresh = Number(r.fresh_qty) || 0, ret = Number(r.return_qty) || 0, tot = Number(r.total_qty) || 0;
      t.fresh += fresh; t.returns += ret; t.total += tot;
      if (!byDay[r.day]) byDay[r.day] = { day: r.day, products: [], fresh: 0, returns: 0, total: 0 };
      byDay[r.day].products.push({ product: r.product, fresh, returns: ret, total: tot });
      byDay[r.day].fresh += fresh; byDay[r.day].returns += ret; byDay[r.day].total += tot;
    }
    const days = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1));
    days.forEach(d => d.products.sort((a, b) => b.total - a.total));
    return { totals: t, days };
  }, [rows]);

  function exportCsv() {
    const flat = rows.map(r => ({
      date: r.day, product: r.product,
      fresh: Number(r.fresh_qty) || 0, returns: Number(r.return_qty) || 0, total: Number(r.total_qty) || 0,
    })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.total - a.total));
    const ok = downloadCsv(`production-history-${from}-to-${to}.csv`, flat, ['date', 'product', 'fresh', 'returns', 'total']);
    showToast(ok ? `Downloaded ${flat.length} rows` : 'Nothing to download', ok ? 'success' : 'warning');
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', fontFamily: 'var(--font-ui)' }}>
      {/* filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
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
          <button style={dlBtn} onClick={exportCsv} disabled={!rows.length}><Download size={14} />Download CSV</button>
        </div>
      </div>

      {error && (
        <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-bd)', borderRadius: 'var(--r-sm)', padding: '12px 14px', fontSize: 13, color: 'var(--bad-fg)', marginBottom: 18 }}>{error}</div>
      )}

      {/* running totals for the period */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiTile label="Produced (fresh)" value={fmt(totals.fresh)}   tone="brand" />
        <KpiTile label="Re-dispatched"    value={fmt(totals.returns)} tone="warn" />
        <KpiTile label="Total packed out" value={fmt(totals.total)}   tone="ok" />
      </div>

      {/* daily breakdown, newest first */}
      {days.length === 0 ? (
        <Panel pad={36}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--t3)' }}>
            <Icon name="package" size={22} />
            <span style={{ fontSize: 13 }}>Nothing produced in this period.</span>
          </div>
        </Panel>
      ) : (
        <Panel pad={0}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Product</th>
                <th style={numTh}>Fresh</th>
                <th style={numTh}>Returns</th>
                <th style={numTh}>Total</th>
              </tr>
            </thead>
            <tbody>
              {days.map(d => [
                <tr key={d.day + '-h'} style={{ background: 'var(--surface-2)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-display)', fontWeight: 700, letterSpacing: '0.03em', color: 'var(--t1)' }}>{fmtDay(d.day)}</td>
                  <td style={{ ...numTd, color: 'var(--t2)', fontWeight: 700 }}>{fmt(d.fresh)}</td>
                  <td style={{ ...numTd, color: 'var(--t2)', fontWeight: 700 }}>{fmt(d.returns)}</td>
                  <td style={{ ...numTd, color: 'var(--t1)', fontWeight: 700 }}>{fmt(d.total)}</td>
                </tr>,
                ...d.products.map((p, i) => (
                  <tr key={d.day + '-' + p.product + i}>
                    <td style={{ ...tdStyle, paddingLeft: 28, color: 'var(--t2)' }}>{p.product}</td>
                    <td style={numTd}>{p.fresh ? fmt(p.fresh) : '—'}</td>
                    <td style={{ ...numTd, color: p.returns ? 'var(--warn-fg)' : 'var(--t3)' }}>{p.returns ? fmt(p.returns) : '—'}</td>
                    <td style={{ ...numTd, fontWeight: 600 }}>{fmt(p.total)}</td>
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
