'use client';
import { Banner } from './ui/index.js';

// TDS on products (section 194R), Reann #bugs 1794284934.757279: the product value a creator has
// received this financial year, from ignitionops (getInfluencer / getEngagement `tds`). Over
// ₹20,000 → red; ₹15,000 and up → amber. `quiet` (the creator page) also shows the figure when
// it is clear; the deal page stays silent until there is something to act on.
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

export function TdsBanner({ tds, quiet = false }) {
  if (!tds) return null;
  if (tds.error) return <Banner tone="info" lead="TDS check unavailable.">{tds.error}</Banner>;

  const deals = `${tds.deals} ${tds.deals === 1 ? 'deal' : 'deals'}`;
  const unpriced = tds.unpriced_lines > 0
    ? ` ${tds.unpriced_lines} product ${tds.unpriced_lines === 1 ? 'line has' : 'lines have'} no price on file, so the real figure may be higher.`
    : '';
  const earlier = (tds.earlier_over || []).length
    ? ` Also over in ${tds.earlier_over.map(r => `${r.fy_label} (${inr(r.value)})`).join(', ')}.`
    : '';
  const basis = `${inr(tds.value)} of products received in ${tds.fy_label}, across ${deals}, at today's selling price.`;

  if (tds.status === 'over') {
    return (
      <Banner tone="error" lead={`Over ${inr(tds.threshold)} in products this year: TDS applies.`}>
        {basis} TDS under section 194R applies above {inr(tds.threshold)} a financial year. Check with accounts before sending more.{unpriced}{earlier}
      </Banner>
    );
  }
  if (tds.status === 'near') {
    return (
      <Banner tone="warning" lead={`Close to the ${inr(tds.threshold)} TDS limit.`}>
        {basis} Above {inr(tds.threshold)} in a financial year, TDS applies.{unpriced}{earlier}
      </Banner>
    );
  }
  if (!quiet && !earlier) return null;
  return (
    <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
      Products this year (TDS): {inr(tds.value)} of {inr(tds.threshold)}, {tds.fy_label}, {deals}.{unpriced}{earlier}
    </div>
  );
}
