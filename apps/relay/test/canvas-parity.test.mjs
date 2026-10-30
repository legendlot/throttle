// Email builder: the canvas and the sent mail compile one attribute set. Run:
//   node apps/relay/test/canvas-parity.test.mjs
// Mishica, #bugs 1793025099.434369 — see src/components/email-editor/canvasParity.js.
// The pixel-level check (canvas vs export, block by block) was run in a browser harness against
// the BASE starter and the FFS/Upshift templates; this suite pins the pure rules it rests on.
import assert from 'node:assert';

globalThis.window = globalThis; // mjml-browser's UMD wrapper reads `window` at import
const { attrsForMjml, withHead, expandPadding, seedLonghands, prepareDesign, syncedShorthand, syncPaddingShorthands } =
  await import('../src/components/email-editor/canvasParity.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
  catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const SECTION_DEFAULTS = { 'padding-left': '0px', 'padding-right': '0px', 'padding-top': '20px', 'padding-bottom': '20px', 'text-align': 'center' };

t('the reported section: shorthand 44px sides + loaded 0px longhands -> 0px longhands are KEPT', () => {
  const a = attrsForMjml({ padding: '34px 44px 10px', 'padding-top': '0px', 'padding-bottom': '0px',
    'padding-left': '0px', 'padding-right': '0px', 'text-align': 'center', 'background-color': '#1c1c1c' }, SECTION_DEFAULTS, false);
  assert.deepStrictEqual(a, { padding: '34px 44px 10px', 'padding-top': '0px', 'padding-bottom': '0px',
    'padding-left': '0px', 'padding-right': '0px', 'background-color': '#1c1c1c' });
});

t('no shorthand -> default-valued longhands still stripped, so the head can set them', () => {
  const a = attrsForMjml({ 'padding-left': '0px', 'padding-right': '0px', 'padding-top': '20px', 'padding-bottom': '20px', 'text-align': 'center' }, SECTION_DEFAULTS, false);
  assert.deepStrictEqual(a, {});
});

t('a non-default value is always kept', () => {
  assert.deepStrictEqual(attrsForMjml({ 'padding-top': '5px' }, SECTION_DEFAULTS, false), { 'padding-top': '5px' });
});

t('inside <mj-attributes> the old stripping holds — a kept longhand would override the rule', () => {
  const a = attrsForMjml({ padding: '0px', 'padding-left': '0px', 'padding-top': '20px' }, SECTION_DEFAULTS, true);
  assert.deepStrictEqual(a, { padding: '0px' });
});

t('style and id never reach MJML', () => {
  assert.deepStrictEqual(attrsForMjml({ style: 'x', id: 'i1', color: 'red' }, {}, false), { color: 'red' });
});

t('withHead injects the head into a canvas compile', () => {
  assert.strictEqual(withHead('<mjml><mj-body></mj-body></mjml>', '<mj-attributes><mj-all padding="0" /></mj-attributes>'),
    '<mjml><mj-head><mj-attributes><mj-all padding="0" /></mj-attributes></mj-head><mj-body></mj-body></mjml>');
});

t('withHead leaves a compile that already has a head, and a template with none, alone', () => {
  const withOwn = '<mjml><mj-head><mj-style>.a{}</mj-style></mj-head><mj-body></mj-body></mjml>';
  assert.strictEqual(withHead(withOwn, '<mj-attributes />'), withOwn);
  assert.strictEqual(withHead('<mjml><mj-body></mj-body></mjml>', ''), '<mjml><mj-body></mj-body></mjml>');
});

t('expandPadding follows CSS 1-4 value order', () => {
  assert.deepStrictEqual(expandPadding('28px 44px 18px'), { 'padding-top': '28px', 'padding-right': '44px', 'padding-bottom': '18px', 'padding-left': '44px' });
  assert.deepStrictEqual(expandPadding('0'), { 'padding-top': '0', 'padding-right': '0', 'padding-bottom': '0', 'padding-left': '0' });
  assert.deepStrictEqual(expandPadding('1px 2px'), { 'padding-top': '1px', 'padding-right': '2px', 'padding-bottom': '1px', 'padding-left': '2px' });
  assert.strictEqual(expandPadding(''), null);
  assert.strictEqual(expandPadding('1 2 3 4 5'), null);
});

// Real block shapes from HP_Crest_v1.3 / FFS_sale_launch_emailer_28oct design_json (2026-10-30).
t('UNTOUCHED shorthand block (all longhands = defaults) is seeded from its shorthand — sends as today', () => {
  const a = { padding: '28px 44px 18px', 'padding-top': '20px', 'padding-right': '0px', 'padding-bottom': '20px', 'padding-left': '0px' };
  assert.deepStrictEqual(seedLonghands(a, SECTION_DEFAULTS), { 'padding-top': '28px', 'padding-right': '44px', 'padding-bottom': '18px', 'padding-left': '44px' });
});

t('PER SIDE: sides someone set (top/bottom 0) are kept, untouched sides take the shorthand — HP Crest / Mishica sections', () => {
  const a = { padding: '34px 44px 10px', 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px' };
  assert.deepStrictEqual(seedLonghands(a, SECTION_DEFAULTS), { 'padding-right': '44px', 'padding-left': '44px' });
});

t('expandPadding refuses anything that is not plain lengths', () => {
  assert.strictEqual(expandPadding('0 0 14px !important'), null);
  assert.strictEqual(expandPadding('calc(10px + 2px)'), null);
  assert.strictEqual(seedLonghands({ padding: '0 !important' }, SECTION_DEFAULTS), null);
});

t('syncedShorthand rewrites the shorthand from the four sides, or says nothing', () => {
  assert.strictEqual(syncedShorthand({ padding: '0 0 14px', 'padding-top': '0', 'padding-right': '25px', 'padding-bottom': '14px', 'padding-left': '25px' }), '0 25px 14px 25px');
  assert.strictEqual(syncedShorthand({ padding: '1px 2px 3px 4px', 'padding-top': '1px', 'padding-right': '2px', 'padding-bottom': '3px', 'padding-left': '4px' }), null);
  assert.strictEqual(syncedShorthand({ padding: '1px', 'padding-top': '1px' }), null, 'a missing side');
  assert.strictEqual(syncedShorthand({ 'padding-top': '1px' }), null, 'no shorthand');
});

t('a side set to a DEFAULT value survives save -> reload (text left 25px under "0 0 14px")', () => {
  const TEXT_DEFAULTS = { 'padding-top': '10px', 'padding-bottom': '10px', 'padding-right': '25px', 'padding-left': '25px' };
  const node = (attributes) => ({ pages: [{ frames: [{ component: { type: 'wrapper', components: [{ type: 'mj-body', tagName: 'mj-body', components: [{ type: 'mj-text', tagName: 'mj-text', attributes }] }] } }] }] });
  // loaded: seeded from the shorthand -> 0/0/14/0; the author then sets left to 25px (= default)
  const edited = node({ padding: '0 0 14px', 'padding-top': '0', 'padding-right': '0', 'padding-bottom': '14px', 'padding-left': '25px' });
  const saved = syncPaddingShorthands(edited);
  const reloaded = prepareDesign(saved, () => TEXT_DEFAULTS);
  const a = reloaded.pages[0].frames[0].component.components[0].components[0].attributes;
  assert.strictEqual(a['padding-left'], '25px');
  assert.strictEqual(a.padding, '0 0 14px 25px');
});

t('syncPaddingShorthands never touches a head <mj-attributes> rule', () => {
  const d = { tagName: 'mj-head', components: [{ tagName: 'mj-attributes', components: [{ type: 'mj-section', tagName: 'mj-section',
    attributes: { padding: '0px', 'padding-top': '20px', 'padding-right': '0px', 'padding-bottom': '20px', 'padding-left': '0px' } }] }] };
  assert.strictEqual(syncPaddingShorthands(d).components[0].components[0].attributes.padding, '0px');
});

t('a type with no padding defaults (column) is never seeded', () => {
  assert.strictEqual(seedLonghands({ padding: '30px 28px' }, { 'vertical-align': 'top' }), null);
});

t('prepareDesign: retypes mj-table, seeds body blocks, skips the head, leaves the input alone', () => {
  const design = { pages: [{ frames: [{ component: { type: 'wrapper', components: [{ type: 'mjml', tagName: 'mjml', components: [
    { type: 'mj-head', tagName: 'mj-head', components: [{ tagName: 'mj-attributes', components: [
      { type: 'mj-section', tagName: 'mj-section', attributes: { padding: '0px', 'padding-top': '20px', 'padding-right': '0px', 'padding-bottom': '20px', 'padding-left': '0px' } }] }] },
    { type: 'mj-body', tagName: 'mj-body', components: [
      { type: 'mj-section', tagName: 'mj-section', attributes: { padding: '28px 44px 18px', 'padding-top': '20px', 'padding-right': '0px', 'padding-bottom': '20px', 'padding-left': '0px' },
        style: { padding: '28px 44px 18px', 'padding-top': '20px' },
        components: [{ type: 'mj-column', tagName: 'mj-column', components: [
          { type: 'text', tagName: 'mj-table', attributes: { width: '44px', padding: '0 0 18px', 'css-class': 'rule' } }] }] }] }] }] } }] }] };
  const before = JSON.stringify(design);
  const out = prepareDesign(design, (type) => (type === 'mj-section' ? SECTION_DEFAULTS : {}));
  assert.strictEqual(JSON.stringify(design), before, 'input mutated');
  const mjml = out.pages[0].frames[0].component.components[0];
  const headRule = mjml.components[0].components[0].components[0];
  const sec = mjml.components[1].components[0];
  const table = sec.components[0].components[0];
  assert.strictEqual(headRule.attributes['padding-top'], '20px', 'head rule was seeded');
  assert.deepStrictEqual([sec.attributes['padding-top'], sec.attributes['padding-left'], sec.style['padding-top']], ['28px', '44px', '28px']);
  assert.strictEqual(table.type, 'mj-table');
  assert.strictEqual(table.attributes.padding, '0 0 18px', 'mj-table has no padding defaults, must stay as authored');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
