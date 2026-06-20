'use client';
// Part Coverage — "are we covered?" planning panel (spec 2026-06-20-part-coverage-design.md).
// For a product × qty, asks the worker getPartCoverage which parts will block the run and
// whether each blocker is being acted on (ordered / in transit / landed / mis-coded / ignored).
// Lead with blockers; collapse what's fine. Manual trigger (button) — not on every keystroke.
import { useState } from 'react';
import { garageFetch } from '@throttle/db';
import { Icon } from '../kit/index.js';

const VERDICT = {
  unordered:     { label: 'Not ordered',  dot: '#dc2626', bg: '#fef2f2', bd: '#fecaca' },
  mis_coded:     { label: 'Mis-coded',    dot: '#d97706', bg: '#fffbeb', bd: '#fde68a' },
  partial:       { label: 'Partial',      dot: '#ea580c', bg: '#fff7ed', bd: '#fed7aa' },
  fully_inbound: { label: 'Inbound',      dot: '#ca8a04', bg: '#fefce8', bd: '#fef08a' },
  covered:       { label: 'Covered',      dot: '#16a34a', bg: '#f0fdf4', bd: '#bbf7d0' },
};
const RANK = ['unordered', 'mis_coded', 'partial', 'fully_inbound', 'covered'];
const num = (n) => Number(n).toLocaleString('en-IN');

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
    <div style={{ marginBottom: 18, border: '1px solid var(--line, #e5e7eb)', borderRadius: 10, padding: 14, background: 'var(--surface-2, #fafafa)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span className="eyebrow" style={{ fontSize: 11, letterSpacing: '.06em', opacity: .65 }}>Coverage check · {product || '—'}{qty ? ` × ${num(qty)}` : ''}</span>
        <button onClick={check} disabled={!canCheck || busy}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8,
                   border: '1px solid var(--line, #d1d5db)', background: '#fff', cursor: canCheck && !busy ? 'pointer' : 'not-allowed', opacity: canCheck ? 1 : .5 }}>
          <Icon name="search" size={13} />{busy ? 'Checking…' : cov ? 'Re-check' : 'Check coverage'}
        </button>
      </div>

      {err && <div style={{ marginTop: 10, fontSize: 12, color: '#dc2626' }}>{err}</div>}

      {cov && !err && (
        <div style={{ marginTop: 12 }}>
          {/* Headline */}
          {s.blockers === 0 && s.fully_inbound === 0
            ? <div style={{ fontSize: 13, fontWeight: 600, color: '#16a34a' }}>✓ All {num(s.total)} tracked parts covered</div>
            : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, fontWeight: 600 }}>
                {s.blockers > 0 && <span style={{ color: '#b91c1c' }}>{s.blockers} blocker{s.blockers !== 1 ? 's' : ''}</span>}
                {s.unordered > 0 && <Chip c="#dc2626">{s.unordered} unordered</Chip>}
                {s.mis_coded > 0 && <Chip c="#d97706">{s.mis_coded} mis-coded</Chip>}
                {s.partial > 0 && <Chip c="#ea580c">{s.partial} partial</Chip>}
                {s.fully_inbound > 0 && <Chip c="#ca8a04">{s.fully_inbound} inbound</Chip>}
                <Chip c="#16a34a">{s.covered} covered</Chip>
              </div>}

          {/* Rows */}
          {visible?.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visible.map(p => {
                const v = VERDICT[p.verdict] || VERDICT.covered;
                return (
                  <div key={p.part_code} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 8, background: v.bg, border: `1px solid ${v.bd}` }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: v.dot, marginTop: 5, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.part_code} <span style={{ fontWeight: 400, opacity: .7 }}>· {p.part_name}</span></div>
                      <div style={{ fontSize: 11.5, opacity: .85, marginTop: 1 }}>{p.message}</div>
                      <div style={{ fontSize: 10.5, opacity: .55, marginTop: 1 }}>need {num(p.required)} · have {num(p.net_available)}{p.stranded_stock > 0 ? ` (${num(p.stranded_stock)} stranded)` : ''}</div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, color: v.dot, whiteSpace: 'nowrap', marginTop: 2 }}>{v.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Toggle + caveats */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {covered.length > 0 && !showAll
              ? <button onClick={() => setShowAll(true)} style={linkBtn}>Show all {num(s.total)} parts</button>
              : covered.length > 0 ? <button onClick={() => setShowAll(false)} style={linkBtn}>Show blockers only</button> : <span />}
          </div>
          <div style={{ marginTop: 8, fontSize: 10, opacity: .5, lineHeight: 1.5 }}>
            Order quantities are approximate. China orders not yet on a PO and primary packaging are excluded.
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ c, children }) {
  return <span style={{ color: c, background: c + '14', borderRadius: 6, padding: '2px 7px', fontSize: 11 }}>{children}</span>;
}
const linkBtn = { background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 };
