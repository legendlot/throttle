// Category-voice branching (S232): classifyTitles (event enrichment) + evalEventProperty
// (the event_property condition node). Both pure — no DB, no interpreter.
const assert = require('assert');
const { classifyTitles } = require('../src/product-category.js');
const { evalEventProperty } = require('../src/journey-graph.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

// Taxonomy rows as loadTaxonomy() shapes them (product lowercased).
const TAX = [
  { product: 'shadow', category: 'L.O.T Cars' },
  { product: 'flare 2.0', category: 'L.O.T Cars' },
  { product: 'wisp', category: 'L.O.T Cars' },
  { product: 'colosseum', category: 'L.O.T Build' },
  { product: 'taj mahal', category: 'L.O.T Build' },
  { product: 'diy drone', category: 'L.O.T Build' },
  { product: 'bracey', category: 'L.O.T DIY' },        // 3rd category, added 2026-08-04 (S260)
];

t('RC title → L.O.T Cars', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car', TAX), 'L.O.T Cars'));

t('Build title → L.O.T Build', () =>
  assert.equal(classifyTitles('The Colosseum — Wooden Puzzle Kit', TAX), 'L.O.T Build'));

t('mixed cart → Build wins', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car, Taj Mahal Kit', TAX), 'L.O.T Build'));

t('add-on only ("Gift Wrapping") → null, not a wrong guess', () =>
  assert.equal(classifyTitles('Gift Wrapping', TAX), null));

t('aviation title matches by product name, not brand prefix', () =>
  assert.equal(classifyTitles('L.O.T Aviation Wisp', TAX), 'L.O.T Cars'));

t('array input + case-insensitive', () =>
  assert.equal(classifyTitles(['THE COLOSSEUM'], TAX), 'L.O.T Build'));

t('empty taxonomy → null (never throws)', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow', []), null));

// ── the 3rd category (S272) ──────────────────────────────────────────────────
// The original classifier was hard-coded BINARY: Build, else anything-that-matched → Cars.
// So `L.O.T DIY` — a real category since 2026-08-04 — was silently coerced to Cars. These
// pin the general shape, not just Bracey: a new category must survive the classifier.

t('DIY title → L.O.T DIY, not coerced to Cars', () =>
  assert.equal(classifyTitles('Bracey — DIY Necklace Kit (Alpha)', TAX), 'L.O.T DIY'));

t('mixed DIY + Cars → DIY wins (Cars is the default voice, so the rarer one leads)', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car, Bracey Kit', TAX), 'L.O.T DIY'));

t('mixed Build + DIY → Build still wins (preserves the S232 decision)', () =>
  assert.equal(classifyTitles('Bracey Kit, The Colosseum', TAX), 'L.O.T Build'));

t('mixed all three → Build wins', () =>
  assert.equal(classifyTitles(['Shadow', 'Bracey', 'Taj Mahal'], TAX), 'L.O.T Build'));

t('an UNLISTED future category is returned as-is, never coerced to Cars', () => {
  const tax = [...TAX, { product: 'someday', category: 'L.O.T Whatever' }];
  assert.equal(classifyTitles('Someday Thing', tax), 'L.O.T Whatever');
});

t('unlisted category loses to a listed one (deterministic, not first-seen)', () => {
  const tax = [...TAX, { product: 'someday', category: 'L.O.T Whatever' }];
  assert.equal(classifyTitles('Someday Thing, The Colosseum', tax), 'L.O.T Build');
});

t('a mixed cart of two unlisted categories does not depend on taxonomy order', () => {
  const a = [{ product: 'aaa', category: 'Zeta' }, { product: 'bbb', category: 'Alpha' }];
  const b = [{ product: 'bbb', category: 'Alpha' }, { product: 'aaa', category: 'Zeta' }];
  // Two CART LINES → both categories are seen, so the sort decides. Order-independent.
  assert.equal(classifyTitles(['aaa thing', 'bbb thing'], a), 'Alpha');
  assert.equal(classifyTitles(['aaa thing', 'bbb thing'], b), 'Alpha');
});

t('KNOWN LIMIT (pre-existing, unreachable in practice): ONE title matching two products takes the first taxonomy hit', () => {
  // The inner `break` classifies a title on its FIRST product match, so only one category
  // is ever collected per title — precedence cannot rescue a single ambiguous title, and
  // the result follows taxonomy row order. This is unchanged by S272: the old classifier
  // broke in exactly the same place, so `shadow colosseum` read as Cars before too.
  //
  // Deliberately NOT fixed (removing the break would scan the whole taxonomy per title and
  // could newly match a second category on titles that today stop at the right one). It is
  // unreachable with real data: a cart line is ONE product, and no product name is a
  // substring of another product's name across categories — verified 2026-08-11 by
  // self-joining product_master on `b.product LIKE '%'||a.product||'%'` where the
  // categories differ, which returned 0 rows. Re-run that if a product is ever renamed.
  const a = [{ product: 'aaa', category: 'Zeta' }, { product: 'bbb', category: 'Alpha' }];
  const b = [{ product: 'bbb', category: 'Alpha' }, { product: 'aaa', category: 'Zeta' }];
  assert.equal(classifyTitles('aaa and bbb', a), 'Zeta');
  assert.equal(classifyTitles('aaa and bbb', b), 'Alpha');
  assert.equal(classifyTitles('shadow colosseum', TAX), 'L.O.T Cars');   // first hit, not Build
  // A MULTI-LINE cart is the real case and it is order-independent — that is what matters:
  assert.equal(classifyTitles(['shadow', 'colosseum'], TAX), 'L.O.T Build');
  assert.equal(classifyTitles(['colosseum', 'shadow'], TAX), 'L.O.T Build');
});

// ── evalEventProperty ──
const P = { primary_category: 'L.O.T Build', total: '2199', financial_status: 'pending' };

t('eq matches case-insensitively', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'eq', value: 'l.o.t build' }, P), true));

t('eq mismatch → false', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'eq', value: 'L.O.T Cars' }, P), false));

t('neq', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'neq', value: 'L.O.T Cars' }, P), true));

t('contains', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'contains', value: 'build' }, P), true));

t('in (comma list, spaces tolerated)', () =>
  assert.equal(evalEventProperty({ field: 'financial_status', op: 'in', value: 'pending, authorized' }, P), true));

t('missing property compares as empty string — eq "" is TRUE, eq value is FALSE', () => {
  assert.equal(evalEventProperty({ field: 'nope', op: 'eq', value: '' }, P), true);
  assert.equal(evalEventProperty({ field: 'nope', op: 'eq', value: 'x' }, P), false);
});

t('contains with empty value → false (never a match-everything)', () =>
  assert.equal(evalEventProperty({ field: 'primary_category', op: 'contains', value: '' }, P), false));

t('null props / null check → safe false', () => {
  assert.equal(evalEventProperty({ field: 'a', op: 'eq', value: 'x' }, null), false);
  assert.equal(evalEventProperty(null, P), false);
});


// ── S273: the Shopflo per-event title source. This is the bug that made Shopflo browse
// events 100% uncategorised for months — not a classifier failure, a WIRING one: the
// enrichment read `product_names`, which `product_viewed` does not have. These assert the
// map used by shopflo-webhooks.js against the property shapes measured live 2026-08-12.
const { CAT_TITLE_SOURCE } = (() => {
  // Re-declared here rather than exported from the webhook module: requiring that module
  // pulls in the whole worker dependency graph, and the map is a fact about the WIRE, so
  // it is asserted as data. If the two ever drift, the live-shape tests below fail first.
  return { CAT_TITLE_SOURCE: {
    checkout_abandoned: (p) => p.product_names || p.primary_product_name,
    add_to_cart:        (p) => p.product_names || p.primary_product_name,
    product_viewed:     (p) => p.product_name,
  } };
})();

// Property shapes exactly as live Shopflo events carry them (measured 2026-08-12).
const LIVE_PRODUCT_VIEWED = { product_name: 'The Colosseum — Wooden Puzzle Kit',
  product_handle: 'colosseum', product_type: 'Puzzle', price: '4999' };
const LIVE_ADD_TO_CART = { product_names: 'L.O.T Cars Shadow - RC Drift Car',
  primary_product_name: 'L.O.T Cars Shadow - RC Drift Car', cart_token: 'x' };

t('S273: product_viewed resolves its title from product_name (SINGULAR)', () => {
  const title = CAT_TITLE_SOURCE.product_viewed(LIVE_PRODUCT_VIEWED);
  assert.equal(title, 'The Colosseum — Wooden Puzzle Kit');
  assert.equal(classifyTitles(title, TAX), 'L.O.T Build');
});

t('S273 REGRESSION: the OLD expression resolves NOTHING on product_viewed', () => {
  // What the code did before: product_names || primary_product_name. Neither exists on a
  // product_viewed, so the title was '' and classifyTitles returned null — silently, on
  // 20,670 events. This is the assertion that would have caught it.
  const oldTitle = LIVE_PRODUCT_VIEWED.product_names || LIVE_PRODUCT_VIEWED.primary_product_name;
  assert.equal(oldTitle, undefined, 'product_viewed has neither property — that WAS the bug');
  assert.equal(classifyTitles(oldTitle || '', TAX), null);
});

t('S273: add_to_cart still resolves via product_names (unchanged behaviour)', () => {
  assert.equal(classifyTitles(CAT_TITLE_SOURCE.add_to_cart(LIVE_ADD_TO_CART), TAX), 'L.O.T Cars');
});

t('S273: an event absent from the map is simply not enriched (explicit, not accidental)', () => {
  assert.equal(CAT_TITLE_SOURCE.order_placed, undefined);
});

t('S273: a Build product_viewed now yields the value the Build trigger filters on', () => {
  // The whole point of widening this: the Build journey filters primary_category='L.O.T Build'
  // by EQUALITY, so an absent value meant a Shopflo Build view matched no journey at all.
  assert.equal(classifyTitles(CAT_TITLE_SOURCE.product_viewed(LIVE_PRODUCT_VIEWED), TAX), 'L.O.T Build');
});

// ── stage ②: the category token in the title (2026-08-14) ──────────────────────────────────
// The shop's title states the category ("L.O.T Build - Garage") even when it does not contain
// the ERP product name ("Wooden Garage"). Five Build products classified as null because of
// that gap and were sent the CARS voice; these pin the fallback and its limits.
// TAX above has no 'wooden garage' row on purpose — that is exactly the live situation.

t('2026-08-14: a Build title whose ERP product name is absent still resolves via the category', () =>
  assert.equal(classifyTitles('L.O.T Build - Garage', TAX), 'L.O.T Build'));

t('2026-08-14: the rest of the affected class resolves too', () => {
  for (const title of ['L.O.T Build - Harry Potter', 'L.O.T Build - Hermione Granger',
                       'L.O.T Build - Albus Dumbledore', 'L.O.T Build - Rubeus Hagrid']) {
    assert.equal(classifyTitles(title, TAX), 'L.O.T Build', title);
  }
});

t('2026-08-14: the fallback NEVER overrides a product-name match', () => {
  // "L.O.T Cars Shadow" contains the Cars token AND the product 'shadow' — same answer either
  // way, so the sharp case is a product whose name disagrees with the token in its title.
  const tax = [...TAX, { product: 'garage', category: 'L.O.T DIY' }];
  // stage ① finds 'garage' → DIY and must win; the 'l.o.t build' token must not be consulted.
  assert.equal(classifyTitles('L.O.T Build - Garage', tax), 'L.O.T DIY');
});

t('2026-08-14: an unregistered product with no category token stays null, not a guess', () => {
  assert.equal(classifyTitles('House Crest Edition', TAX), null);
  assert.equal(classifyTitles('Gift Wrapping', TAX), null);
});

t('2026-08-14: mixed cart still lets Build win when only the fallback placed it', () =>
  assert.equal(classifyTitles('L.O.T Cars Shadow - RC Drift Car, L.O.T Build - Garage', TAX), 'L.O.T Build'));

t('2026-08-14: a spare-parts title naming a car resolves by product name, unchanged', () =>
  assert.equal(classifyTitles('L.O.T Spare Parts - Set of 4 Tyres for L.O.T Cars Shadow RC Drift Car', TAX), 'L.O.T Cars'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
