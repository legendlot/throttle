// Product-category resolution for event enrichment (S232) — stamps `primary_category`
// ("L.O.T Cars" | "L.O.T Build") onto cart/browse events so journeys can branch voice by
// category (RULE-TAXONOMY-001: category lives on public.product_master).
//
// Matching is by PRODUCT NAME against the event's title(s): Shopify titles embed the
// product string ("L.O.T Cars Shadow - RC Drift Car" ⊃ "Shadow"). Deliberately NOT a
// title-prefix hack — "L.O.T Aviation Wisp" and add-ons like "Gift Wrapping" would defeat
// any prefix rule; unmatched titles resolve to null and the condition node routes them to
// its default branch. Mixed carts: any CARS item wins (S400, 2026-09-25 — reversed from S232's
// "Build wins"; see CATEGORY_PRECEDENCE for the data).
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

// Mixed-cart precedence. ⭐ CARS FIRST since S400 (Afshaan, 2026-09-25) — the Build journeys
// are for Build-ONLY carts. S232 had `L.O.T Build` first ("the rarer, more deliberate purchase
// reads better in the Build voice; revisit if data disagrees") and the data disagreed: in the
// 7 days to 2026-09-25, 2,666 of 2,864 Build-stamped Shopflo add_to_cart events (93%) held an
// RC car too — mostly a Shadow/Zipp/Fang with a Grandstand Garage — so the Build cart journey
// would have told car buyers "A Masterpiece is waiting… Unbuilt. No glue, no tools".
// Build then outranks DIY (DIY = the discontinued Bracey kits, sell-through only).
//
// ⚠️ This list is a PREFERENCE ORDER, not an allow-list. A category missing from it is
// still returned (see below). That distinction is the whole bug this replaced: the original
// classifier was hard-coded binary — Build, else anything-that-matched → Cars — so when
// `L.O.T DIY` was added to product_master on 2026-08-04 (RULE-TAXONOMY-001, S260) every DIY
// product was silently stamped `L.O.T Cars`. Adding a 4th category to product_master must
// stay a no-op here; add it to this list only to give it a mixed-cart rank.
const CATEGORY_PRECEDENCE = ['L.O.T Cars', 'L.O.T Build', 'L.O.T DIY'];

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
// ③ HANDLE (2026-08-14). The storefront handle, mapped explicitly in public.product_handle_map.
//
// ⚠️ Why a third stage was needed: ① and ② both read the TITLE. ① needs the ERP product name in
// it, ② needs the category string in it. `house-crest-edition` has NEITHER — its title is
// "Hogwarts House Crest 3D Wooden Puzzle" — so it resolved null, and null routes to the journey's
// DEFAULT branch, which is the Cars voice. A customer browsing a wooden puzzle received "Stalled
// mid-race… 🏎️💨". Reported twice by Pruthvi (#bugs 1786646144.038279, 13:56 and 14:56) after ②
// had already been shipped and described as fixing the problem — it fixed four of six products.
//
// This stage runs FIRST and is the only one that cannot be broken by a storefront rename. It is
// purely additive: a handle that is not mapped contributes nothing and the title stages run
// exactly as before, so no answer that is correct today can change.
function classifyTitles(titles, taxonomy, opts) {
  const matched = new Set();

  const handles = (Array.isArray(opts && opts.handles)
    ? opts.handles
    : String((opts && opts.handles) || '').split(','))
    .map((h) => String(h || '').toLowerCase().trim()).filter(Boolean);
  const handleCategories = (opts && opts.handleCategories) || null;
  const titleAliases = (Array.isArray(opts && opts.titleAliases) ? opts.titleAliases : [])
    .map((a) => ({ token: String(a.token || '').toLowerCase().trim(), category: a.category }))
    .filter((a) => a.token.length >= 3 && a.category);
  if (handleCategories && handles.length) {
    for (const h of handles) {
      const c = handleCategories[h];
      if (c) matched.add(c);
    }
  }

  const list = (Array.isArray(titles) ? titles : String(titles || '').split(','))
    .map((t) => String(t || '').toLowerCase().trim()).filter(Boolean);
  // A handle alone is enough — an event with a mapped handle but no usable title still classifies.
  if (!list.length) return matched.size ? pickCategory(matched) : null;
  // An empty/unreadable taxonomy only disables stages ① and ②; the title aliases (④) are loaded
  // independently and must still run (Codex review S400 #4).
  if (!Array.isArray(taxonomy)) taxonomy = [];
  // Distinct categories, longest first: "L.O.T Build" must be tested before a hypothetical
  // "L.O.T B", or the shorter token would claim the title. Derived from the taxonomy already
  // loaded — no second read, and a new category value is picked up for free.
  const catTokens = [...new Set(taxonomy.map((t) => t.category))]
    .map((category) => ({ category, token: String(category).toLowerCase() }))
    .filter((c) => c.token.length >= 3)
    .sort((a, b) => b.token.length - a.token.length);
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
      if (title.includes(token)) { matched.add(category); hit = true; break; }
    }
    if (hit) continue;
    // ④ TITLE ALIAS (S400) — a storefront title that names neither our product nor the
    // category, pinned explicitly on its product_handle_map row (`title_match`). Exists for
    // events that carry a TITLE but no handle: Shopflo add_to_cart / checkout_abandoned and the
    // pixel's add_to_cart. ③ fixed `house-crest-edition` only where a handle rides along, so
    // "Hogwarts House Crest 3D Wooden Puzzle" still resolved null on 942 events in the 14 days
    // to 2026-09-25 (98 of them checkout drop-offs) and fell into the Cars journeys. Last
    // stage, so — like ③ — no title that classifies today can change.
    for (const { token, category } of titleAliases) {
      if (title.includes(token)) { matched.add(category); break; }
    }
  }
  if (!matched.size) return null;                                  // unmatched → null, never a guess
  return pickCategory(matched);
}

// Mixed-set resolution, shared by every stage: ranked precedence first, then a stable
// alphabetical pick so the answer never depends on taxonomy row order.
function pickCategory(matched) {
  for (const c of CATEGORY_PRECEDENCE) if (matched.has(c)) return c;
  // Only unranked categories matched. Return one rather than coercing to a default — a
  // wrong-but-plausible category is worse than an unfamiliar one, because it looks correct.
  return [...matched].sort()[0];
}

// handle → category, joined in JS because public.product_master has no unique constraint on
// product_code, so there is no FK for PostgREST to embed on. Two small reads, same 1h TTL as
// the taxonomy: one DB round per isolate per hour, not one per event.
let _hmap = null, _hmapExp = 0, _aliases = [];
async function loadHandleCategories(env) {
  const now = Date.now();
  if (_hmap && now < _hmapExp) return _hmap;
  // ⚠️ title_match (S400) is fetched in the SAME read as the handles. If that column ever 400s
  // (dropped/renamed, stale PostgREST cache) retry without it, so ④ degrades alone and ③ — which
  // classifies every handle-carrying House Crest view — keeps working (hostile review S400 #2).
  let aliasReadOk = true;
  const mapRead = async () => {
    const r = await sbPublic('/rest/v1/product_handle_map?select=handle,product_code,title_match', env);
    if (r.ok) return r;
    aliasReadOk = false;
    return sbPublic('/rest/v1/product_handle_map?select=handle,product_code', env);
  };
  const [mapR, pmR] = await Promise.all([
    mapRead(),
    sbPublic('/rest/v1/product_master?category=not.is.null&select=product_code,category', env),
  ]);
  if (!mapR.ok || !Array.isArray(mapR.data) || !pmR.ok || !Array.isArray(pmR.data)) {
    return _hmap || {};                                            // stale-if-error, same as taxonomy
  }
  const byCode = new Map();
  for (const r of pmR.data) if (r.product_code && r.category) byCode.set(String(r.product_code), r.category);
  const out = {};
  const aliases = [];
  for (const r of mapR.data) {
    const cat = byCode.get(String(r.product_code));
    if (r.handle && cat) out[String(r.handle).toLowerCase()] = cat;
    if (r.title_match && cat) aliases.push({ token: String(r.title_match), category: cat });
  }
  // On the handle-only fallback the rows carry no title_match — keep the last good aliases rather
  // than caching "no aliases" for an hour (Codex review S400 #5), and retry the full read in 5 min.
  _hmap = out;
  if (aliasReadOk) _aliases = aliases;
  _hmapExp = now + (aliasReadOk ? TAX_TTL_MS : 300_000);
  return out;
}

// Best-effort enrichment — a category miss must never fail the webhook/event.
async function resolveCategory(env, titles, handles) {
  try {
    const [taxonomy, handleCategories] = await Promise.all([
      loadTaxonomy(env), loadHandleCategories(env),
    ]);
    return classifyTitles(titles, taxonomy, { handles, handleCategories, titleAliases: _aliases });
  } catch { return null; }
}

module.exports = { classifyTitles, resolveCategory, loadTaxonomy, loadHandleCategories };
