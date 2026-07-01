// Channel families — the single source of truth for how every is_sale channel rolls up.
// Used by the cockpit (/) stacked chart + chips AND the Channels section per-family pages.
// Order = nav order + stack order (bottom→top).

export const FAMILY_ORDER = ['website', 'amazon', 'flipkart', 'quickcom', 'gtmt', 'longtail', 'other'];

export const FAMILIES = {
  website:  { key: 'website',  label: 'Website',        color: '#F2CD1A', match: /website|shopify|web/i,
              emptyReason: 'No website sales in this range.' },
  amazon:   { key: 'amazon',   label: 'Amazon',         color: '#4C63F0', match: /amazon/i,
              emptyReason: 'No Amazon sales in this range.' },
  flipkart: { key: 'flipkart', label: 'Flipkart',       color: '#2DA8F0', match: /flipkart/i,
              emptyReason: 'No Flipkart sales in this range. Fed via the Uniware aggregator (Flipkart has no direct API) — widen the range if you expect data.' },
  quickcom: { key: 'quickcom', label: 'Quick-comm',     color: '#34D27B', match: /blinkit|zepto|instamart|swiggy|quick/i,
              emptyReason: 'No quick-commerce sales in this range.' },
  gtmt:     { key: 'gtmt',     label: 'GT / MT',        color: '#F59E0B', match: /^(gt|mt)$|general trade|modern trade/i,
              emptyReason: 'No confirmed Snorkel sales order (GT/MT) in this range.' },
  longtail: { key: 'longtail', label: 'Long-tail',      color: '#A78BFA', match: /cred|firstcry|peeko/i,
              emptyReason: 'Not yet wired — these come via the Uniware connector or a report upload.' },
  other:    { key: 'other',    label: 'Other / Internal', color: '#8A8C95', match: /events|export|sold from wh|warehouse/i,
              emptyReason: 'Not yet wired — internal / non-marketplace channels.' },
};

// channel display name → family key (falls back to 'other').
export function familyOf(name) {
  const n = name || '';
  for (const k of FAMILY_ORDER) {
    if (k === 'other') continue;            // 'other' is the fallback, checked last
    if (FAMILIES[k].match.test(n)) return k;
  }
  return 'other';
}

// distinct colour per sub-channel inside a family page (cycled).
export const SUBCHANNEL_PALETTE = ['#4C63F0', '#34D27B', '#F2CD1A', '#F59E0B', '#2DA8F0', '#A78BFA', '#EC6A5E', '#8A8C95'];
