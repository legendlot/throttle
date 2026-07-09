'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, inr } from '../../../../lib/api.js';
import { SegmentedToggle } from '../../../../components/kit.js';
import { DynoTabs } from '../tabs.js';

// Dyno — Matrix (coverage) view. Strategic altitude on the SAME data the board reads: a
// per-product angle × segment bingo card showing what's alive, dead, or never tried. Pure
// client-side pivot over getDynoBoard — no new pipeline (brief §2). V1 = read-only render.

const RECENT_DAYS = 3;
const GATE_INR = 6500;               // "competent execution" spend gate (mirror of the board)
const SEGMENTS = ['Kidult', 'Parent', 'Family', 'Gifter'];   // fixed 4 columns, never expand

const N = (v) => Number(v || 0);
const nn = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };   // null-safe number
const norm = (s) => String(s || '').trim().toLowerCase();

// Cell state → dot + colour (maps to the verdict vocabulary, brief §3C/§4).
const STATE = {
  winner:       { dot: '🟢', color: 'var(--green)', label: 'Winner-track' },
  inconclusive: { dot: '🟡', color: '#E8A33D',      label: 'Inconclusive' },
  kill:         { dot: '🔴', color: 'var(--red)',   label: 'Kill-leaning' },
  dead:         { dot: '⚫', color: 'var(--t3)',     label: 'Dead' },
  untested:     { dot: '·',  color: 'var(--t3)',     label: 'Untested' },
};

// For a set of at-bats (variants in one product×angle×segment cell), compute the cell state +
// representative ROAS in the active window. Precedence (brief §4): winner > 2 competent kills >
// colour by latest at-bat's ROAS.
function cellStat(variants, win) {
  if (!variants || !variants.length) return { state: 'untested', roas: null, atbats: 0, variants: [] };
  const roasOf = (v) => (win === 'recent' ? nn(v.roas_recent) : nn(v.roas_life));
  const winner = variants.find(v => norm(v.verdict) === 'winner');
  const competentKills = variants.filter(v => norm(v.verdict) === 'killed' && N(v.spend_life) >= GATE_INR);
  const rep = winner || variants[variants.length - 1];       // latest = last in board order (V1 proxy)
  const roas = roasOf(rep);
  const atbats = variants.length;
  let state;
  if (winner) state = 'winner';
  else if (competentKills.length >= 2) state = 'dead';
  else if (roas != null && roas >= 4) state = 'winner';
  else if (roas != null && roas < 2 && atbats === 1) state = 'kill';
  else state = 'inconclusive';                               // ROAS 2–4, or thin / unresolved / no data
  return { state, roas, atbats, variants };
}

export default function DynoMatrixPage() {
  const { session } = useAuth();
  const [filter, setFilter] = useState('active');            // Active | All (board filter)
  const [win, setWin] = useState('recent');                  // recent 3d | lifetime
  const [product, setProduct] = useState('all');
  const [data, setData] = useState(null);                    // { rows }
  const [segMap, setSegMap] = useState(null);                // { raw→canonical }
  const [err, setErr] = useState('');

  const load = useCallback(async (quiet) => {
    if (!session) return;
    if (!quiet) { setData(null); setErr(''); }
    try {
      const [b, m] = await Promise.all([
        salesGet('getDynoBoard', { filter, recent_days: RECENT_DAYS }, session),
        salesGet('getSegmentMap', {}, session),
      ]);
      setData(b || { rows: [] });
      const map = {}; for (const e of (m?.map || [])) map[norm(e.raw)] = e.canonical;
      setSegMap(map);
    } catch (e) { setErr(String(e?.message || e)); }
  }, [session, filter]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const canon = useCallback((r) => segMap ? (segMap[norm(r.audience_segment)] || null) : null, [segMap]);

  // Distinct products (in board order — newest experiment first).
  const products = useMemo(() => {
    const seen = new Set(), out = [];
    for (const r of rows) if (r.product && !seen.has(r.product)) { seen.add(r.product); out.push(r.product); }
    return out;
  }, [rows]);

  const visible = product === 'all' ? products : products.filter(p => p === product);

  // Placeable = has an angle AND a mappable canonical segment. The rest feed the hygiene banner.
  const unplaceable = useMemo(() => {
    if (!segMap) return { total: 0, untaggedAngle: 0, unmappedSegs: {} };
    let untaggedAngle = 0; const unmappedSegs = {}; let total = 0;
    for (const r of rows) {
      const hasAngle = !!r.angle, seg = canon(r);
      if (hasAngle && seg) continue;
      total += 1;
      if (!hasAngle) untaggedAngle += 1;
      if (hasAngle && !seg) { const k = r.audience_segment || '(untagged)'; unmappedSegs[k] = (unmappedSegs[k] || 0) + 1; }
    }
    return { total, untaggedAngle, unmappedSegs };
  }, [rows, segMap, canon]);

  // Coverage stats across the VISIBLE products (the strategic KPI strip — coverage, not the
  // board's operational committed/ceiling; the board owns that altitude).
  const stats = useMemo(() => {
    const s = { products: visible.length, angles: new Set(), covered: 0, cells: 0, winners: 0, dead: 0 };
    for (const p of visible) {
      const angles = new Set();
      for (const r of rows) if (r.product === p && r.angle && canon(r)) angles.add(r.angle);
      s.cells += angles.size * SEGMENTS.length;
      for (const a of angles) {
        s.angles.add(`${p}::${a}`);
        for (const seg of SEGMENTS) {
          const vs = rows.filter(r => r.product === p && r.angle === a && canon(r) === seg);
          if (!vs.length) continue;
          s.covered += 1;
          const st = cellStat(vs, win).state;
          if (st === 'winner') s.winners += 1;
          if (st === 'dead') s.dead += 1;
        }
      }
    }
    return s;
  }, [visible, rows, canon, win]);

  if (!data && !err) return <div style={{ padding: 40 }}><Spinner /></div>;
  const coveragePct = stats.cells > 0 ? Math.round((stats.covered / stats.cells) * 100) : 0;

  return (
    <div style={{ padding: '20px 28px 60px', maxWidth: 1400 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.03em', margin: 0 }}>Dyno</h1>
          <div style={{ color: 'var(--t2)', fontSize: 12.5, marginTop: 2 }}>
            Coverage matrix — angle × segment per product. What's alive, dead, or never tried. ROAS shown <b>{win === 'recent' ? `recent ${RECENT_DAYS}d` : 'lifetime'}</b>.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
          <Stat lbl="Products" val={stats.products} />
          <Stat lbl="Angles" val={stats.angles.size} />
          <Stat lbl="Coverage" val={`${coveragePct}%`} sub={`${stats.covered}/${stats.cells}`} />
          <Stat lbl="Winners" val={stats.winners} tone="var(--green)" />
          <Stat lbl="Dead" val={stats.dead} tone="var(--t2)" />
          <button className="so-btn ghost" onClick={() => load()} title="Refresh">↻</button>
        </div>
      </div>

      <DynoTabs />

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        {products.length > 1 && (
          <SegmentedToggle value={product} onChange={setProduct}
            options={[{ key: 'all', label: 'All products' }, ...products.map(p => ({ key: p, label: p }))]} />
        )}
        <SegmentedToggle value={win} onChange={setWin}
          options={[{ key: 'recent', label: `Recent ${RECENT_DAYS}d` }, { key: 'life', label: 'Lifetime' }]} />
        <SegmentedToggle value={filter} onChange={setFilter}
          options={[{ key: 'active', label: 'Active' }, { key: 'all', label: 'All' }]} />
        <Legend />
      </div>

      {err && <div style={{ background: 'var(--red)15', border: '1px solid var(--red)55', color: 'var(--red)', padding: '9px 13px', borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

      {/* Data-hygiene banner — variants that can't be placed on the matrix. */}
      {unplaceable.total > 0 && (
        <div style={{ background: '#E8A33D14', border: '1px solid #E8A33D55', color: 'var(--t1)', padding: '9px 13px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
          <b>⚠ {unplaceable.total} variant{unplaceable.total > 1 ? 's' : ''} not on the matrix.</b>{' '}
          {unplaceable.untaggedAngle > 0 && <span>{unplaceable.untaggedAngle} with no angle tagged. </span>}
          {Object.keys(unplaceable.unmappedSegs).length > 0 && (
            <span>Unmapped segment{Object.keys(unplaceable.unmappedSegs).length > 1 ? 's' : ''}:{' '}
              {Object.entries(unplaceable.unmappedSegs).map(([k, v]) => `${k} (${v})`).join(', ')}. </span>
          )}
          <span style={{ color: 'var(--t2)' }}>Tag the ad's angle/segment or add the string to <code style={{ fontFamily: 'var(--mono)' }}>sales.lab_segment_map</code>.</span>
        </div>
      )}

      {visible.length === 0 && <div style={{ color: 'var(--t2)', padding: 30, textAlign: 'center' }}>No variants in this view.</div>}

      {visible.map(p => <ProductMatrix key={p} product={p} rows={rows} canon={canon} win={win} />)}
    </div>
  );
}

function ProductMatrix({ product, rows, canon, win }) {
  const angles = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.product === product && r.angle && canon(r)) set.add(r.angle);
    return [...set].sort((a, b) => a.localeCompare(b));      // alpha (reuse-tier ordering needs a tier field — future)
  }, [rows, product, canon]);

  // cellMap[angle][seg] = variants
  const cellMap = useMemo(() => {
    const m = {};
    for (const a of angles) { m[a] = {}; for (const seg of SEGMENTS) m[a][seg] = []; }
    for (const r of rows) {
      if (r.product !== product || !r.angle) continue;
      const seg = canon(r); if (!seg || !m[r.angle]) continue;
      m[r.angle][seg].push(r);
    }
    return m;
  }, [rows, product, angles, canon]);

  return (
    <div className="so-card" style={{ marginBottom: 18, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', background: 'var(--t3)0c', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 15 }}>{product}</span>
        <span style={{ fontSize: 11.5, color: 'var(--t2)' }}>{angles.length} angle{angles.length !== 1 ? 's' : ''} tracked</span>
      </div>

      {angles.length === 0 ? (
        <div style={{ padding: 26, textAlign: 'center', color: 'var(--t2)', fontSize: 12.5 }}>No angle × segment-tagged variants yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 210 }} />
              {SEGMENTS.map((s) => <col key={s} style={{ width: 130 }} />)}
            </colgroup>
            <thead>
              <tr style={{ color: 'var(--t2)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left' }}>Angle</th>
                {SEGMENTS.map(s => <th key={s} style={{ padding: '8px', textAlign: 'center' }}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {angles.map(a => (
                <tr key={a} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--t1)' }}>{a}</td>
                  {SEGMENTS.map(seg => <Cell key={seg} variants={cellMap[a][seg]} win={win} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Cell({ variants, win }) {
  const st = cellStat(variants, win);
  const meta = STATE[st.state];
  if (st.state === 'untested') {
    return <td style={{ padding: '10px 8px', textAlign: 'center', color: 'var(--t3)', fontSize: 16 }}>·</td>;
  }
  // native tooltip listing every at-bat (creative · window ROAS · verdict) — cheap; rich hover is V2.
  const title = variants.map(v => {
    const roas = win === 'recent' ? nn(v.roas_recent) : nn(v.roas_life);
    return `${v.headline || v.ad_name || v.meta_id} · ROAS ${roas == null ? '—' : roas.toFixed(2)} · ${v.verdict || v.computed_status || '—'} · ${inr(v.spend_life)}`;
  }).join('\n');
  return (
    <td title={title} style={{ padding: '8px', textAlign: 'center', background: meta.color + '10' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: 13 }}>{meta.dot}</span>
        <b style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: meta.color }}>
          {st.roas == null ? '—' : st.roas.toFixed(2)}
        </b>
        {st.atbats > 1 && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '0 5px', borderRadius: 20, background: 'var(--t3)26', color: 'var(--t2)' }}>×{st.atbats}</span>
        )}
      </div>
    </td>
  );
}

function Legend() {
  return (
    <div style={{ display: 'inline-flex', gap: 12, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap', fontSize: 10.5, color: 'var(--t2)' }}>
      {['winner', 'inconclusive', 'kill', 'dead'].map(k => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12 }}>{STATE[k].dot}</span>{STATE[k].label}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ fontSize: 13 }}>·</span>Untested</span>
    </div>
  );
}

function Stat({ lbl, val, sub, tone = 'var(--t1)' }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: tone, lineHeight: 1 }}>{val}</div>
      <div style={{ fontSize: 10.5, color: 'var(--t2)', marginTop: 2 }}>{lbl}{sub ? <span style={{ color: 'var(--t3)' }}> · {sub}</span> : ''}</div>
    </div>
  );
}
