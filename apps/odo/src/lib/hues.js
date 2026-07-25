// Metric hues — the "not monotone" fix. Every KPI tile, swatch, bar and chip derives
// ALL of its colour from one hue, so adding a metric needs no new tokens.
//
// The palette itself is NOT new: FAMILIES + SUBCHANNEL_PALETTE in families.js are
// byte-unchanged. What changed is REACH — family colour now appears on every row,
// column header, tab, legend and tile that refers to a channel.
//
// Semantic status NEVER borrows a family hue (see STATUS below).

// hex → "r,g,b" for the rgba() interpolation the .so-stat recipe does in CSS.
export function rgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const v = parseInt(n, 16);
  if (!Number.isFinite(v)) return '138,140,149';
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

// Style object for a hue-tinted KPI tile. Spread onto the .so-stat element.
export const hueStyle = (hex) => ({ '--stat-hue': rgb(hex) });

// KPI hue assignments, in Dashboard → Performance order (handoff §3.4).
export const HUE = {
  primary:  '#F2CD1A',   // revenue / the headline metric
  gross:    '#4C63F0',
  units:    '#34D27B',   // units / net
  derived:  '#A78BFA',   // ASP + other derived ratios
  count:    '#2DA8F0',   // counts (channels, orders, clicks)
  cancel:   '#F59E0B',
  returns:  '#EC6A5E',
  neutral:  '#8A8C95',   // discounts / neutral
};
// Ordered cycle for an N-up tile row that has no natural metric mapping.
export const HUE_CYCLE = [HUE.primary, HUE.gross, HUE.units, HUE.derived, HUE.count, HUE.cancel, HUE.returns, HUE.neutral];

// Semantic status — bright tokens on dark. Never a family hue.
export const STATUS = {
  good: '#34d399',
  bad: '#f87171',
  warn: '#F59E0B',
  none: 'var(--t5)',
};

// Tinted chip/tab surface derived from one hue: fg = hue, bg = 14%, bd = 34%.
export const tint = (hex, { bg = 0.14, bd = 0.34 } = {}) => ({
  color: 'var(--t1)',
  background: `rgba(${rgb(hex)},${bg})`,
  border: `1px solid rgba(${rgb(hex)},${bd})`,
});
