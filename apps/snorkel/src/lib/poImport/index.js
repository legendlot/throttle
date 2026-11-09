// Channel PO → neutral shape: detect the buyer, run its parser. Pure; the browser-only file
// reading lives in extract.js. Phase 1 = Zepto PDF, Swiggy Instamart (Scootsy) PDF, Flipkart xlsx.
// Peeko and Blinkit are NOT here yet (plan P2) — they come back as `unsupported`, never guessed.
import { parseZepto } from './zepto.js';
import { parseInstamart } from './instamart.js';
import { parseFlipkart } from './flipkart.js';

// Buyer fingerprints: the name AND the GSTIN's PAN core (chars 3–12), so a PO whose letterhead
// text renders oddly is still recognised by the GSTINs printed on it.
const BUYERS = [
  { id: 'zepto',     kinds: ['pdf'],  re: /\bZEPTO\b|KIRANAKART|AAICK4821A/i },
  { id: 'instamart', kinds: ['pdf'],  re: /\bSCOOTSY\b|AAVCS1691R/i },
  { id: 'flipkart',  kinds: ['xlsx'], re: /FLIPKART INDIA|AABCF8078M/i },
];

// extracted = { kind: 'pdf', lines: string[] } | { kind: 'xlsx', rows: any[][] }
export function detectBuyer(extracted) {
  if (!extracted) return null;
  const text = extracted.kind === 'pdf'
    ? (extracted.lines || []).join('\n')
    : (extracted.rows || []).map(r => (r || []).map(v => (v == null ? '' : String(v))).join(' ')).join('\n');
  const hit = BUYERS.find(b => b.kinds.includes(extracted.kind) && b.re.test(text));
  return hit ? hit.id : null;
}

export function parsePurchaseOrder(extracted) {
  const buyer = detectBuyer(extracted);
  if (!buyer) return { error: 'This PO is not from a buyer Snorkel can read yet (Zepto PDF, Instamart PDF, Flipkart xlsx). Enter the order by hand.', unsupported: true };
  const po = buyer === 'zepto' ? parseZepto(extracted.lines)
    : buyer === 'instamart' ? parseInstamart(extracted.lines)
    : parseFlipkart(extracted.rows);
  if (po.error) return po;
  if (!po.lines.length) return { ...po, error: 'No item lines could be read from this PO.' };
  if (!po.po_no) po.warnings.push('The PO number could not be read — type it into Partner PO ref.');
  const bad = po.lines.filter(l => !(l.qty > 0) || !(l.unit_cost_ex_gst > 0));
  if (bad.length) po.warnings.push(`${bad.length} line(s) have no readable quantity or price — check them before saving.`);
  return po;
}
