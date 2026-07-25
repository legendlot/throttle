'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { RefreshCw } from 'lucide-react';
import { salesGet, inr } from '../../../../lib/api.js';
import { Kpi, SegmentedToggle } from '../../../../components/kit.js';
import { PageHead, PanelHead } from '../../../../components/prism.js';
import { HUE } from '../../../../lib/hues.js';
import { DynoTabs } from '../tabs.js';

// Dyno — Matrix (coverage) view. Strategic altitude on the SAME data the board reads: a
// per-product angle × segment bingo card showing what's alive, dead, or never tried. Pure
// client-side pivot over getDynoBoard — no new pipeline (brief §2). V1 = read-only render.
//
// Deliberately does NOT carry the board's operational chrome — no spend split, no committed/
// ceiling budget bar, no win/kill counters. The board owns that altitude; this view owns coverage.

const RECENT_DAYS = 3;
const GATE_INR = 6500;               // "competent execution" spend gate (mirror of the board)
const SEGMENTS = ['Kidult', 'Parent', 'Family', 'Gifter'];   // fixed 4 columns, never expand

const N = (v) => Number(v || 0);
const nn = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };   // null-safe number
const norm = (s) => String(s || '').trim().toLowerCase();
// Tint helper — the STATE colours are CSS custom properties as often as hexes, so string-concat
// alpha (`var(--green)10`) produced invalid CSS. color-mix accepts both forms.
const alpha = (c, a) => `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;

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
  const [filter, setFilter] = useState('all');               // All | Active — coverage view defaults to All (show the full explored grid incl. paused/dead/won)
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

  if (!data && !err) return <div style={{ padding: 60, textAlign: 'center' }}><Spinner /></div>;
  const coveragePct = stats.cells > 0 ? Math.round((stats.covered / stats.cells) * 100) : 0;

  return (
    <div className="so-page" style={{ gap: 14 }}>
      <PageHead
        title="Dyno · Matrix"
        sub={<>Coverage matrix — angle × segment per product. What&apos;s alive, dead, or never tried. ROAS shown <b>{win === 'recent' ? `recent ${RECENT_DAYS}d` : 'lifetime'}</b>.</>}
        right={<button className="so-btn ghost" onClick={() => load()} title="Refresh"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '8px 10px' }}>
          <RefreshCw size={15} strokeWidth={1.75} />
        </button>}
      />

      {/* Coverage strip — this view's own read (how much of the grid has been explored). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12 }}>
        <Kpi dense hue={HUE.count} lbl="Products" val={stats.products} sub="in this view" />
        <Kpi dense hue={HUE.derived} lbl="Angles" val={stats.angles.size} sub="product × angle" />
        <Kpi dense hue={HUE.primary} lbl="Coverage" val={`${coveragePct}%`} sub={`${stats.covered} / ${stats.cells} cells`} />
        <Kpi dense hue={HUE.units} lbl="Winners" val={stats.winners} sub="winner-track cells" />
        <Kpi dense hue={HUE.neutral} lbl="Dead" val={stats.dead} sub="two competent kills" />
      </div>

      <DynoTabs />

      {/* Controls — this view's own: product · window · filter · legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {products.length > 1 && (
          <SegmentedToggle value={product} onChange={setProduct}
            options={[{ key: 'all', label: 'All products' }, ...products.map(p => ({ key: p, label: p }))]} />
        )}
        <SegmentedToggle value={win} onChange={setWin}
          options={[{ key: 'recent', label: `Recent ${RECENT_DAYS}d` }, { key: 'life', label: 'Lifetime' }]} />
        <SegmentedToggle value={filter} onChange={setFilter}
          options={[{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }]} />
        <Legend />
      </div>

      {err && <div className="so-card" style={{ background: alpha('var(--red)', 0.08), border: '1px solid ' + alpha('var(--red)', 0.34),
        color: 'var(--red)', padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 12 }}>{err}</div>}

      {/* Data-hygiene banner — variants that can't be placed on the matrix. */}
      {unplaceable.total > 0 && (
        <div className="so-card" style={{ background: 'linear-gradient(150deg,rgba(232,163,61,.11),rgba(20,21,26,.7) 62%)',
          border: '1px solid rgba(232,163,61,.32)', padding: '11px 15px', fontSize: 12, color: 'var(--t2)' }}>
          <b style={{ color: 'var(--t1)' }}>⚠ {unplaceable.total} variant{unplaceable.total > 1 ? 's' : ''} not on the matrix.</b>{' '}
          {unplaceable.untaggedAngle > 0 && <span>{unplaceable.untaggedAngle} with no angle tagged. </span>}
          {Object.keys(unplaceable.unmappedSegs).length > 0 && (
            <span>Unmapped segment{Object.keys(unplaceable.unmappedSegs).length > 1 ? 's' : ''}:{' '}
              {Object.entries(unplaceable.unmappedSegs).map(([k, v]) => `${k} (${v})`).join(', ')}. </span>
          )}
          <span>Tag the ad&apos;s angle/segment or add the string to <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>sales.lab_segment_map</code>.</span>
        </div>
      )}

      {visible.length === 0 && <div className="so-sub" style={{ padding: 30, textAlign: 'center' }}>No variants in this view.</div>}

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

  const TH = { padding: '9px 14px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 400, letterSpacing: '0.1em',
    textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border-table)', whiteSpace: 'nowrap', cursor: 'default' };

  return (
    <div className="so-card flush" style={{ overflow: 'hidden' }}>
      <PanelHead title={product} qual={`· ${angles.length} angle${angles.length !== 1 ? 's' : ''} tracked`}
        style={{ marginBottom: 0 }} />

      {angles.length === 0 ? (
        <div className="so-sub" style={{ padding: 26, textAlign: 'center', fontSize: 12.5 }}>No angle × segment-tagged variants yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table" style={{ minWidth: 620, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 210 }} />
              {SEGMENTS.map((s) => <col key={s} style={{ width: 130 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th style={TH}>Angle</th>
                {SEGMENTS.map(s => <th key={s} style={{ ...TH, textAlign: 'center' }}>{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {angles.map(a => (
                <tr key={a}>
                  <td style={{ padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t1)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a}</td>
                  {SEGMENTS.map(seg => <Cell key={seg} variants={cellMap[a][seg]} win={win} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="so-qual" style={{ padding: '13px 18px', lineHeight: 1.6 }}>
        A pure client-side pivot over the same board data — no separate pipeline. Winner beats everything;
        two competent kills (each past the {inr(GATE_INR)} spend gate) mark a cell dead; otherwise the
        latest at-bat&apos;s ROAS colours it. Read-only.
      </p>
    </div>
  );
}

// One cell of the coverage grid (§6.9): state dot + ROAS + at-bat count on an rgba(hue,.09) wash.
function Cell({ variants, win }) {
  const st = cellStat(variants, win);
  const meta = STATE[st.state];
  const TD = { padding: '9px 14px', textAlign: 'center' };
  if (st.state === 'untested') {
    return <td style={{ ...TD, color: 'var(--t5)', fontSize: 16, lineHeight: 1 }}>{STATE.untested.dot}</td>;
  }
  // native tooltip listing every at-bat (creative · window ROAS · verdict) — cheap; rich hover is V2.
  const title = variants.map(v => {
    const roas = win === 'recent' ? nn(v.roas_recent) : nn(v.roas_life);
    return `${v.headline || v.ad_name || v.meta_id} · ROAS ${roas == null ? '—' : roas.toFixed(2)} · ${v.verdict || v.computed_status || '—'} · ${inr(v.spend_life)}`;
  }).join('\n');
  return (
    <td title={title} style={{ ...TD, background: alpha(meta.color, 0.09) }}>
      <div style={{ fontSize: 13, lineHeight: 1.2 }}>{meta.dot}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: meta.color, marginTop: 3 }}>
        {st.roas == null ? '—' : st.roas.toFixed(2)}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--t5)', marginTop: 2 }}>
        {st.atbats} at-bat{st.atbats === 1 ? '' : 's'}
      </div>
    </td>
  );
}

function Legend() {
  return (
    <div style={{ display: 'inline-flex', gap: 12, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap',
      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.04em', color: 'var(--t3)' }}>
      {['winner', 'inconclusive', 'kill', 'dead'].map(k => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 12 }}>{STATE[k].dot}</span>{STATE[k].label}
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ fontSize: 13 }}>{STATE.untested.dot}</span>{STATE.untested.label}</span>
    </div>
  );
}
