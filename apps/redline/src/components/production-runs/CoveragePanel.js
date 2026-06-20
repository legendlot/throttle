'use client';
// Part Coverage — "are we covered?" planning panel (spec 2026-06-20-part-coverage-design.md).
// For a product × qty, asks the worker getPartCoverage which parts will block the run and
// whether each blocker is being acted on (ordered / in transit / landed / mis-coded / ignored).
// Lead with blockers; collapse what's fine. Manual trigger (button) — not on every keystroke.
// Themed via Redline's dark tokens (--t*, --surface-*, --border-*, accent colours) — row tints
// use color-mix so they read on the dark surface (no hardcoded light pastels).
import { useState } from 'react';
import { garageFetch } from '@throttle/db';
import { Icon } from '../kit/index.js';

const VERDICT = {
  unordered:     { label: 'Not ordered', c: 'var(--red)' },
  mis_coded:     { label: 'Mis-coded',   c: 'var(--amber)' },
  partial:       { label: 'Partial',     c: 'var(--orange)' },
  fully_inbound: { label: 'Inbound',     c: 'var(--yellow)' },
  covered:       { label: 'Covered',     c: 'var(--green)' },
};
const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const num  = (n) => Number(n).toLocaleString('en-IN');

export function CoveragePanel({ product, qty, variant = '', colour = '', session }) {
  const [cov, setCov] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showAll, setShowAll] = useState(false);

  async function check() {
    if (!product || !qty) return;
    setBusy(true); setErr(null);
    try {
      const r = await garageFetch('getPartCoverage', { product, qty, variant, colour }, session);
      setCov(r); setShowAll(false);
    } catch (e) { setErr(e.message || 'Coverage check failed'); }
    finally { setBusy(false); }
  }

  const canCheck = product && qty > 0;
  const s = cov?.summary;
  const blockers = cov?.parts?.filter(p => p.verdict !== 'covered') || [];
  const covered  = cov?.parts?.filter(p => p.verdict === 'covered') || [];
  const visible  = showAll ? cov?.parts : blockers;

  return (
    <div style={{ marginBottom: 18, border: '1px solid var(--border)', borderRadius: 10, padding: 14, background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="eyebrow" style={{ fontSize: 11, letterSpacing: '.06em', color: 'var(--t4)' }}>Coverage check · {product || '—'}{qty ? ` × ${num(qty)}` : ''}</span>
        <button onClick={check} disabled={!canCheck || busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
                   border: '1px solid var(--border-2)', background: 'var(--surface-3)', color: 'var(--t1)',
                   cursor: canCheck && !busy ? 'pointer' : 'not-allowed', opacity: canCheck ? 1 : .5 }}>
          <Icon name="search" size={13} />{busy ? 'Checking…' : cov ? 'Re-check' : 'Check coverage'}
        </button>
      </div>

      {err && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--bad-fg, var(--red))' }}>{err}</div>}

      {cov && !err && (
        <div style={{ marginTop: 12 }}>
          {/* Headline */}
          {s.blockers === 0 && s.fully_inbound === 0
            ? <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>✓ All {num(s.total)} tracked parts covered</div>
            : <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 }}>
                {s.blockers > 0 && <span style={{ color: 'var(--red)' }}>{s.blockers} blocker{s.blockers !== 1 ? 's' : ''}</span>}
                {s.unordered > 0 && <Chip c="var(--red)">{s.unordered} unordered</Chip>}
                {s.mis_coded > 0 && <Chip c="var(--amber)">{s.mis_coded} mis-coded</Chip>}
                {s.partial > 0 && <Chip c="var(--orange)">{s.partial} partial</Chip>}
                {s.fully_inbound > 0 && <Chip c="var(--yellow)">{s.fully_inbound} inbound</Chip>}
                <Chip c="var(--green)">{s.covered} covered</Chip>
              </div>}

          {/* Rows */}
          {visible?.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visible.map(p => {
                const v = VERDICT[p.verdict] || VERDICT.covered;
                return (
                  <div key={p.part_code} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: tint(v.c, 9), border: `1px solid ${tint(v.c, 38)}` }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: v.c, marginTop: 5, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)' }}>{p.part_code} <span style={{ fontWeight: 400, color: 'var(--t3)' }}>· {p.part_name}</span></div>
                      <div style={{ fontSize: 11.5, color: 'var(--t2)', marginTop: 1 }}>{p.message}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 1 }}>need {num(p.required)} · have {num(p.net_available)}{p.stranded_stock > 0 ? ` (${num(p.stranded_stock)} stranded)` : ''}</div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: v.c, whiteSpace: 'nowrap', marginTop: 2 }}>{v.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Toggle + caveats */}
          {covered.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button onClick={() => setShowAll(a => !a)} style={linkBtn}>{showAll ? 'Show blockers only' : `Show all ${num(s.total)} parts`}</button>
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--t4)', lineHeight: 1.5 }}>
            Order quantities are approximate. China orders not yet on a PO and primary packaging are excluded.
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ c, children }) {
  return <span style={{ color: c, background: tint(c, 14), borderRadius: 6, padding: '2px 7px', fontSize: 11 }}>{children}</span>;
}
const linkBtn = { background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 };
