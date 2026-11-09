// Pieces both PDF layouts (Zepto, Swiggy Instamart / Scootsy) share. Pure.
import { GSTIN_RE, pincodeOf } from './common.js';

const LABEL_ONLY = /^(address|contact|gstin|pan)\s*:?\s*$/i;

// The Billing | Shipping block prints two columns side by side, so each text line is
// "<bill cell>  <ship cell>". Returns the SHIP side: the right half of an even split, the whole
// line when the split is odd (a cell with an inner gap — both columns kept, harmless for the
// partner match, and the last PIN on the line is still the ship-side one).
export function shipColumn(line) {
  const segs = line.split(/\s{2,}/).map(s => s.replace(/^address\s*:\s*/i, '').trim()).filter(s => s && !LABEL_ONLY.test(s));
  if (segs.length >= 2 && segs.length % 2 === 0) return segs.slice(segs.length / 2).join(' ');
  return segs.join(' ');
}

// Ship-to block = lines after the "Billing Address … Shipping Address" heading up to and
// including the first line carrying a GSTIN. Emails and "Contact :" lines are skipped (they
// are personal data and say nothing about which FC this is).
export function shipBlock(lines) {
  const h = lines.findIndex(l => /billing address/i.test(l) && /shipping address/i.test(l));
  if (h < 0) return { address: null, pincode: null, bill_to_gstin: null, ship_to_gstin: null, end: -1 };
  const parts = [];
  let gstins = [], end = -1;
  for (let i = h + 1; i < Math.min(lines.length, h + 15); i++) {
    const l = lines[i];
    const g = l.match(GSTIN_RE);
    if (g) { gstins = g; end = i; break; }
    if (/@/.test(l) || /^\s*contact\s*:/i.test(l)) continue;
    const s = shipColumn(l);
    if (s) parts.push(s);
  }
  const address = parts.join(', ').replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim() || null;
  return {
    address, pincode: pincodeOf(address), end,
    bill_to_gstin: gstins[0] || null, ship_to_gstin: gstins[gstins.length - 1] || null,
  };
}

export const isMoney = t => /^-?\d+(?:\.\d+)?%?$/.test(t);
