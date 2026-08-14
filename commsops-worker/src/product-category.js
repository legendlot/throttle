// Product-category resolution for event enrichment (S232) — stamps `primary_category`
// ("L.O.T Cars" | "L.O.T Build") onto cart/browse events so journeys can branch voice by
// category (RULE-TAXONOMY-001: category lives on public.product_master).
//
// Matching is by PRODUCT NAME against the event's title(s): Shopify titles embed the
// product string ("L.O.T Cars Shadow - RC Drift Car" ⊃ "Shadow"). Deliberately NOT a
// title-prefix hack — "L.O.T Aviation Wisp" and add-ons like "Gift Wrapping" would defeat
// any prefix rule; unmatched titles resolve to null and the condition node routes them to
// its default branch. Mixed carts: any Build item wins (Build is the rarer, more deliberate
// purchase — a mixed cart reads better with the Build voice; revisit if data disagrees).
const A = require('./auth.js');

const sbPublic = A.sbProfile('public');

// Per-isolate taxonomy cache. Small (~160 rows), changes rarely (new-product registration),
// 1h TTL keeps a fresh isolate correct without a per-event DB read.
let _tax = null, _taxExp = 0;
const TAX_TTL_MS = 3600_000;

async function loadTaxonomy(env) {
  const now = Date.now();
  if (_tax && now < _taxExp) return _tax;
  const r = await sbPublic('/rest/v1/product_master?category=not.is.null&select=product,category', env);
  if (!r.ok || !Array.isArray(r.data)) return _tax || [];   // stale-if-error: keep last good
  const seen = new Set();
  _tax = r.data.filter((x) => x.product && x.category && !seen.has(x.product) && seen.add(x.product))
               .map((x) => ({ product: String(x.product).toLowerCase(), category: x.category }));
  _taxExp = now + TAX_TTL_MS;
  return _tax;
}

// Mixed-cart precedence, most-specific first. `L.O.T Build` winning is the S232 decision
// (the rarer, more deliberate purchase reads better in the Build voice); `L.O.T DIY` sits
// above `L.O.T Cars` for the same reason — Cars is the default, dominant voice, so in a
// mixed cart the rarer category leads.
//
// ⚠️ This list is a PREFERENCE ORDER, not an allow-list. A category missing from it is
// still returned (see below). That distinction is the whole bug this replaced: the original
// classifier was hard-coded binary — Build, else anything-that-matched → Cars — so when
// `L.O.T DIY` was added to product_master on 2026-08-04 (RULE-TAXONOMY-001, S260) every DIY
// product was silently stamped `L.O.T Cars`. Adding a 4th category to product_master must
// stay a no-op here; add it to this list only to give it a mixed-cart rank.
const CATEGORY_PRECEDENCE = ['L.O.T Build', 'L.O.T DIY', 'L.O.T Cars'];

// Pure classifier — titles: string (comma-list) or array. Returns a category or null.
//
// TWO stages, in this order — the second only runs for a title the first could not place:
//
//  ① PRODUCT NAME in the title. The primary bridge, and exact when it hits.
//  ② CATEGORY NAME in the title (2026-08-14). The storefront states the category in the title
//     itself — "L.O.T Build - Garage" — so when the ERP product name is absent we can still read
//     the category the shop already declared, from product_master's own category strings.
//
// ⚠️ Why ② had to exist: stage ① assumes the storefront title CONTAINS the ERP product name, and
// for the whole L.O.T Build catalogue it does not. The shop sells "L.O.T Build - Garage"; the ERP
// product is "Wooden Garage". Colosseum worked only because the two names happen to coincide. So
// five Build products classified as null — and null routes to the journey's DEFAULT branch, which
// is the Cars voice: Pruthvi got the Cars Browse-Abandonment template for a wooden garage
// (#bugs 1786646144.038279). Measured 2026-08-14 over 30 days: Garage 330 events, Harry Potter 48,
// Albus Dumbledore 18, Hermione Granger 12, Rubeus Hagrid 10 — every one 100% unclassified, and
// every one L.O.T Build. Renaming the ERP product to match the shop was the alternative and is far
// worse: a product rename has to sweep material_master, bom_register, stock_ledger and three line
// tables (RULE-TAXONOMY-001, the S231 HP-rename miss), and "Garage" is too generic a name to match on.
//
// ⚠️ This is NOT the title-prefix hack the header rejects, for two reasons that must both hold if
// anyone extends this: it runs ONLY as a fallback (a title stage ① placed is never re-examined, so
// no currently-correct answer can change), and the tokens come from product_master.category, not
// from a hardcoded list. Verified against all 30 days of distinct titles: it newly resolves exactly
// the five Build products above and changes nothing else. "Gift Wrapping" and "House Crest Edition"
// stay null, which is correct — the first is an add-on, the second is genuinely unregistered.
function classifyTitles(titles, taxonomy) {
  const list = (Array.isArray(titles) ? titles : String(titles || '').split(','))
    .map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
  if (!list.length || !Array.isArray(taxonomy) || !taxonomy.length) return null;
  // Distinct categories, longest first: "L.O.T Build" must be tested before a hypothetical
  // "L.O.T B", or the shorter token would claim the title. Derived from the taxonomy already
  // loaded — no second read, and a new category value is picked up for free.
  const catTokens = [...new Set(taxonomy.map((t) => t.category))]
    .map((category) => ({ category, token: String(category).toLowerCase() }))
    .filter((c) => c.token.length >= 3)
    .sort((a, b) => b.token.length - a.token.length);
  const matched = new Set();
  for (const title of list) {
    let hit = false;
    for (const { product, category } of taxonomy) {
      if (product.length >= 3 && title.includes(product)) {
        matched.add(category);
        hit = true;
        break;   // this title is classified; next title
      }
    }
    if (hit) continue;
    // ② fallback — the shop named the category even though it did not name our product.
    for (const { category, token } of catTokens) {
      if (title.includes(token)) { matched.add(category); break; }
    }
  }
  if (!matched.size) return null;                                  // unmatched → null, never a guess
  for (const c of CATEGORY_PRECEDENCE) if (matched.has(c)) return c;
  // Only unranked categories matched. Return one rather than coercing to a default — a
  // wrong-but-plausible category is worse than an unfamiliar one, because it looks correct.
  // Sorted so the answer never depends on taxonomy row order.
  return [...matched].sort()[0];
}

// Best-effort enrichment — a category miss must never fail the webhook/event.
async function resolveCategory(env, titles) {
  try { return classifyTitles(titles, await loadTaxonomy(env)); }
  catch { return null; }
}

module.exports = { classifyTitles, resolveCategory, loadTaxonomy };
