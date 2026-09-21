'use client';
/* ════════════════════════════════════════════════════════════
   KPI DRILL-DOWN (S392) — what sits behind an Overview tile.
   Tap "Packed" → the units packed in the selected range: totals by
   channel, a product · model · colour breakdown, and (single day)
   the unit list itself with time, line, operator and batch label.
   Same shape for QC Pass / QC Fail. Data: getActivityBreakdown +
   getActivityUnits (lotopsproxy) — the population rule mirrors
   get_executive_dashboard, so the drawer total equals the tile.
   Renders in the kit Drawer; full-width on phones (.rl-drawer).
   ════════════════════════════════════════════════════════════ */
import { useEffect, useMemo, useState } from 'react';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { X, Search } from 'lucide-react';
import { Icon, Drawer, lineColor, lineRgb, fmt } from './kit/index.js';

export const DRILLS = {
  packed: {
    // RTE,RTR only — the Today tile is today_rtr + today_rte (no RTX; zero RTX scans exist).
    label: 'Packed', tone: 'ok', activities: 'RTE,RTR', channels: true,
    note: 'PKG-OUT scans of cars and drones. Channel is the packaging channel the unit was packed under.',
  },
  qcPass: { label: 'QC Pass', tone: 'brand', activities: 'QC_PASS', note: 'QC_PASS scans of cars and drones (remotes excluded).' },
  qcFail: { label: 'QC Fail', tone: 'bad', activities: 'QC_FAIL', note: 'QC_FAIL scans of cars and drones (remotes excluded).' },
  // stock snapshot, not a day range — the population get_executive_dashboard.dispatch_stock counts
  pkgOut: { label: 'Pkg Out', tone: 'blue', stock: true, note: 'Cars currently at RTD — packed and awaiting dispatch. A live snapshot, not a day range.' },
};

const TONE_FG = { ok: 'var(--ok-fg)', brand: 'var(--yellow)', bad: 'var(--bad-fg)', warn: 'var(--warn-fg)', blue: 'var(--blue-bright)' };
const CHANNELS = ['ecom', 'retail', 'export'];
const CH_LABEL = { ecom: 'Ecom', retail: 'Retail', export: 'Export' };
const CH_COLOR = { ecom: 'var(--blue-bright)', retail: 'var(--yellow)', export: 'var(--green-bright)' };

const timeIST = (ts) => ts
  ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
  : '—';
const dayIST = (ts) => ts
  ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
  : '';

function ChannelPill({ ch }) {
  if (!ch) return <span style={{ color: 'var(--t4)' }}>—</span>;
  return (
    <span className="label" style={{ fontSize: 9.5, padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap',
      color: CH_COLOR[ch] || 'var(--t2)', background: 'var(--surface-3)', border: '1px solid var(--border-2)' }}>
      {CH_LABEL[ch] || ch}
    </span>
  );
}

function LinePill({ line }) {
  if (!line) return <span style={{ color: 'var(--t4)' }}>—</span>;
  return (
    <span className="num" style={{ fontSize: 10, fontWeight: 700, color: lineColor(line),
      background: `rgba(${lineRgb(line)},0.14)`, padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap' }}>{line}</span>
  );
}

export default function KpiDrilldown({ drill, from, to, session, onClose, refreshKey, tileValue }) {
  const spec = drill ? DRILLS[drill] : null;
  const singleDay = from === to;
  const [rows, setRows] = useState(null);      // breakdown rows
  const [units, setUnits] = useState(null);    // { units, truncated } — single day only
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('products');  // products | units

  // reset the view only when a DIFFERENT tile is opened — a refetch (refreshKey, token refresh)
  // must not wipe a typed filter or the chosen tab
  useEffect(() => { setQ(''); setTab('products'); }, [drill]);

  useEffect(() => {
    if (!spec || !session) return;
    let live = true;
    setError(null);
    (async () => {
      try {
        if (spec.stock) {
          const b = await garageFetch('getRtdStockBreakdown', {}, session);
          if (!live) return;
          setRows(Array.isArray(b) ? b : []);
          return;
        }
        const p = { from, to, activities: spec.activities };
        const [b, u] = await Promise.all([
          garageFetch('getActivityBreakdown', p, session),
          singleDay ? garageFetch('getActivityUnits', { ...p, limit: 3000 }, session) : Promise.resolve(null),
        ]);
        if (!live) return;
        setRows(Array.isArray(b) ? b : []);
        setUnits(u && Array.isArray(u.units) ? u : null);
      } catch (e) { if (live) setError(e.message || 'Failed to load'); }
    })();
    return () => { live = false; };
  }, [drill, from, to, session, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* breakdown → one row per product·model·colour with per-channel counts */
  const groups = useMemo(() => {
    if (!rows) return [];
    const m = new Map();
    for (const r of rows) {
      const key = `${r.product || ''}|${r.model || ''}|${r.color || ''}`;
      const g = m.get(key) || { product: r.product, model: r.model, color: r.color, total: 0, ch: {} };
      const n = Number(r.cnt) || 0;
      g.total += n;
      if (r.channel) g.ch[r.channel] = (g.ch[r.channel] || 0) + n;
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [rows]);
  const total = groups.reduce((a, g) => a + g.total, 0);
  const chTotals = CHANNELS.map(c => [c, groups.reduce((a, g) => a + (g.ch[c] || 0), 0)]).filter(([, n]) => n > 0);
  const products = new Set(groups.map(g => g.product || '?')).size;

  const filteredUnits = useMemo(() => {
    const list = units?.units || [];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter(u => [u.upc, u.product, u.model, u.color, u.operator_name, u.batch_label, u.line, u.channel]
      .some(v => v && String(v).toLowerCase().includes(s)));
  }, [units, q]);

  if (!spec) return null;
  const fg = TONE_FG[spec.tone] || 'var(--t1)';
  const rangeLabel = spec.stock ? 'Right now' : singleDay ? from : `${from} → ${to}`;

  const tabBtn = (key, label, n) => (
    <button key={key} onClick={() => setTab(key)} style={{ border: 'none', cursor: 'pointer', borderRadius: 'var(--r-xs)',
      padding: '6px 11px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
      textTransform: 'uppercase', background: tab === key ? 'var(--yellow)' : 'transparent',
      color: tab === key ? '#1a1a1a' : 'var(--t3)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      {label}{n != null && <span className="num" style={{ opacity: 0.75 }}>{fmt(n)}</span>}
    </button>
  );

  return (
    <Drawer open onClose={onClose} width={520}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ width: 34, height: 34, borderRadius: 'var(--r-sm)', display: 'grid', placeItems: 'center', flexShrink: 0,
          background: 'var(--surface-2)', color: fg, border: '1px solid var(--border-2)' }}><Icon name="scan" size={17} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{spec.label}</span>
            <span className="num" style={{ fontSize: 22, fontWeight: 700, color: fg, lineHeight: 1 }}>{rows ? fmt(total) : '…'}</span>
          </div>
          <div className="num" style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{rangeLabel}</div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: '1px solid var(--border-2)', borderRadius: 'var(--r-xs)',
          width: 30, height: 30, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <X size={15} strokeWidth={1.75} /></button>
      </div>

      {/* summary strip */}
      {rows && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          {spec.channels && chTotals.map(([c, n]) => (
            <div key={c} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', padding: '7px 11px', minWidth: 78 }}>
              <div className="eyebrow" style={{ color: CH_COLOR[c] }}>{CH_LABEL[c]}</div>
              <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginTop: 2 }}>{fmt(n)}</div>
            </div>
          ))}
          <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', padding: '7px 11px', minWidth: 78 }}>
            <div className="eyebrow">Products</div>
            <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginTop: 2 }}>{products}</div>
          </div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-xs)', padding: '7px 11px', minWidth: 78 }}>
            <div className="eyebrow">Variants</div>
            <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginTop: 2 }}>{groups.length}</div>
          </div>
        </div>
      )}

      {/* week/month: the tile is plan-vs-actual (scans matched to PLANNED runs, remotes included);
          this drawer counts every unit scanned in the range. Say so instead of pretending they agree. */}
      {rows && !singleDay && !spec.stock && tileValue != null && (
        <div style={{ margin: '10px 18px 0', padding: '8px 11px', borderRadius: 'var(--r-xs)', background: 'var(--surface-2)',
          border: '1px solid var(--border)', fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.45 }}>
          The tile shows <b className="num" style={{ color: 'var(--t1)' }}>{tileValue}</b> — units matched to <b>planned runs</b> over this range.
          This list counts <b className="num" style={{ color: 'var(--t1)' }}>{fmt(total)}</b>: every car/drone {spec.label.toLowerCase()} scan in the range, run or no run.
        </div>
      )}

      {/* tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
        {tabBtn('products', 'By product', rows ? groups.length : null)}
        {!spec.stock && tabBtn('units', 'Units', units ? units.units.length : null)}
      </div>

      <div style={{ overflowY: 'auto', flex: 1, WebkitOverflowScrolling: 'touch' }}>
        {error && <div style={{ padding: 18, color: 'var(--bad-fg)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>{error}</div>}
        {!rows && !error && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>}

        {rows && tab === 'products' && (
          groups.length === 0 ? (
            <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              Nothing {spec.label.toLowerCase()} in this range.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={{ textAlign: 'left', padding: '10px 18px 8px' }}>Product</th>
                  {spec.channels && chTotals.map(([c]) => (
                    <th key={c} className="eyebrow" style={{ textAlign: 'right', padding: '10px 8px 8px', color: CH_COLOR[c] }}>{CH_LABEL[c]}</th>
                  ))}
                  <th className="eyebrow" style={{ textAlign: 'right', padding: '10px 18px 8px' }}>Units</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={i}>
                    <td style={{ padding: '9px 18px', borderTop: '1px solid var(--border)', minWidth: 0 }}>
                      <div style={{ color: 'var(--t1)', fontWeight: 600 }}>{g.product || <span style={{ color: 'var(--t4)' }}>Unknown UPC</span>}</div>
                      {(g.model || g.color) && (
                        <div style={{ color: 'var(--t3)', fontSize: 11.5, marginTop: 1 }}>{[g.model, g.color].filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                    {spec.channels && chTotals.map(([c]) => (
                      <td key={c} className="num" style={{ padding: '9px 8px', borderTop: '1px solid var(--border)', textAlign: 'right',
                        color: g.ch[c] ? 'var(--t2)' : 'var(--t4)' }}>{g.ch[c] ? fmt(g.ch[c]) : '·'}</td>
                    ))}
                    <td className="num" style={{ padding: '9px 18px', borderTop: '1px solid var(--border)', textAlign: 'right',
                      color: 'var(--t1)', fontWeight: 700 }}>{fmt(g.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {rows && tab === 'units' && (
          !singleDay ? (
            <div style={{ padding: '40px 18px', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13, lineHeight: 1.5 }}>
              The unit list is per day. Switch the Overview to <b style={{ color: 'var(--t1)' }}>Today</b> to see individual units.
            </div>
          ) : !units ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
          ) : (
            <>
              <div style={{ padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7, background: 'var(--surface-2)',
                  border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 10px' }}>
                  <Search size={14} style={{ color: 'var(--t4)', flexShrink: 0 }} />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by UPC, product, operator, batch…"
                    style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)',
                      fontFamily: 'var(--font-ui)', fontSize: 13 }} />
                  {q && <button onClick={() => setQ('')} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', display: 'flex' }}><X size={13} /></button>}
                </div>
                <span className="num" style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{fmt(filteredUnits.length)}</span>
              </div>
              {units.truncated && (
                <div style={{ margin: '0 14px 6px', padding: '6px 10px', borderRadius: 'var(--r-xs)', background: 'var(--warn-bg)',
                  border: '1px solid var(--warn-bd)', color: 'var(--warn-fg)', fontFamily: 'var(--font-ui)', fontSize: 11.5 }}>
                  Showing the newest {fmt(units.limit)} units — the day has more.
                </div>
              )}
              {filteredUnits.length === 0 ? (
                <div style={{ padding: '30px 18px', textAlign: 'center', color: 'var(--t3)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>No units match.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {filteredUnits.map((u, i) => (
                    <div key={u.upc + u.scanned_at + i} style={{ display: 'grid', gridTemplateColumns: '58px 1fr auto', gap: '2px 10px',
                      padding: '9px 18px', borderTop: '1px solid var(--border)', alignItems: 'center', fontFamily: 'var(--font-ui)' }}>
                      <div>
                        <div className="num" style={{ fontSize: 12, color: 'var(--t1)', fontWeight: 600 }}>{timeIST(u.scanned_at)}</div>
                        <div className="num" style={{ fontSize: 10, color: 'var(--t4)' }}>{dayIST(u.scanned_at)}</div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {u.product || 'Unknown UPC'}{(u.model || u.color) && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> · {[u.model, u.color].filter(Boolean).join(' · ')}</span>}
                          </span>
                        </div>
                        <div className="num" style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ color: 'var(--t2)' }}>{u.upc}</span>
                          {u.operator_name && <span>{u.operator_name}</span>}
                          {u.batch_label && <span style={{ color: 'var(--t4)' }}>{u.batch_label}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <LinePill line={u.line} />
                        {spec.channels && <ChannelPill ch={u.channel} />}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 18px', fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--t4)', lineHeight: 1.45 }}>
        {spec.note}
      </div>
    </Drawer>
  );
}
