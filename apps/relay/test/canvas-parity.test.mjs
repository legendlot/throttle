// Email builder: the canvas and the sent mail compile one attribute set. Run:
//   node apps/relay/test/canvas-parity.test.mjs
// Mishica, #bugs 1793025099.434369 — see src/components/email-editor/canvasParity.js.
// The pixel-level check (canvas vs export, block by block) was run in a browser harness against
// the BASE starter and the FFS/Upshift templates; this suite pins the pure rules it rests on.
import assert from 'node:assert';

globalThis.window = globalThis; // mjml-browser's UMD wrapper reads `window` at import
const { attrsForMjml, withHead, expandPadding, seedLonghands, prepareDesign, syncedShorthand, syncPaddingShorthands,
  expandSelfClosingMj, dropSwallowedBlocks, canvasParity } = await import('../src/components/email-editor/canvasParity.js');
const { authorCss, withAuthorCss } = await import('../src/components/email-editor/exportEmail.js');
const mjmlMod = (await import('mjml-browser')).default;
const mjml2html = mjmlMod.default || mjmlMod;

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

// ── Style Manager rules on inner elements (FFS_sale_launch_emailer_28oct, 2026-10-31) ──
// A stand-in for GrapesJS's CssRule/Selector models: just the fields authorCss reads.
const sel = (name, type = 1) => ({ get: (k) => ({ name, type }[k]) });
const rule = (fields, css) => ({ get: (k) => fields[k], toCSS: () => css });
const P_RULE = rule({ selectors: [sel('font-claude-response-body'), sel('break-words'), sel('whitespace-normal')] },
  '.font-claude-response-body.break-words.whitespace-normal{margin:0px 0px 0px 0px;line-height:15px;}');
const FFS_BODY = '<mjml><mj-head><mj-attributes><mj-all font-family="Arial" /></mj-attributes></mj-head><mj-body><mj-section><mj-column>'
  + '<mj-text font-size="11px" line-height="0px"><p dir="ltr" class="font-claude-response-body break-words whitespace-normal" style="color:red">This Diwali</p><p>plain</p></mj-text>'
  + '</mj-column></mj-section></mj-body></mjml>';

t('authorCss keeps the author rule and skips MJML\'s own compiled head (selectorsAdd, media, mj-*)', () => {
  const rules = [P_RULE,
    rule({ selectors: [], selectorsAdd: 'p' }, 'p{margin:13px 0}'),
    rule({ selectors: [], selectorsAdd: '#outlook a' }, '#outlook a{padding:0}'),
    rule({ selectors: [sel('mj-column-per-100')], mediaText: 'only screen and (min-width: 480px)', atRuleType: 'media' }, '@media{}'),
    rule({ selectors: [sel('mj-outlook-group-fix')] }, '.mj-outlook-group-fix{width:100% !important}'),
    rule({ selectors: [sel('font-claude-response-body')], state: 'hover' }, '.x:hover{}')];
  assert.strictEqual(authorCss(rules, FFS_BODY), P_RULE.toCSS());
});

t('authorCss drops a rule no element carries (its element was deleted) — the mail is not re-serialised for nothing', () => {
  assert.strictEqual(authorCss([P_RULE], FFS_BODY.replace(' break-words', '')), '');
  assert.strictEqual(authorCss([rule({ selectors: [sel('i9x', 2)] }, '#i9x{color:red}')], '<mj-text><span id="i9x">a</span></mj-text>'), '#i9x{color:red}');
  assert.strictEqual(authorCss([rule({ selectors: [sel('i9x', 2)] }, '#i9x{color:red}')], '<mj-text><span class="i9x">a</span></mj-text>'), '');
});

t('withAuthorCss adds an inline mj-style to the head (or makes one), and nothing when there is no CSS', () => {
  assert.strictEqual(withAuthorCss('<mjml><mj-head><mj-title>x</mj-title></mj-head><mj-body></mj-body></mjml>', '.a{}'),
    '<mjml><mj-head><mj-title>x</mj-title><mj-style inline="inline">.a{}</mj-style></mj-head><mj-body></mj-body></mjml>');
  assert.strictEqual(withAuthorCss('<mjml><mj-body></mj-body></mjml>', '.a{}'), '<mjml><mj-head><mj-style inline="inline">.a{}</mj-style></mj-head><mj-body></mj-body></mjml>');
  assert.strictEqual(withAuthorCss('<mjml><mj-body></mj-body></mjml>', ''), '<mjml><mj-body></mj-body></mjml>');
});

t('the reported paragraph: the rule reaches the sent HTML inline, the element\'s own style still wins, other <p> untouched', () => {
  const { html, errors } = mjml2html(withAuthorCss(FFS_BODY, authorCss([P_RULE], FFS_BODY)), { validationLevel: 'soft' });
  assert.deepStrictEqual(errors, []);
  const p = html.match(/<p dir="ltr"[^>]*>/)[0];
  assert.match(p, /style="margin: 0px 0px 0px 0px; line-height: 15px; color: red;"/);
  assert.match(html, /<p>plain<\/p>/);
  assert.doesNotMatch(html, /font-claude-response-body\.break-words/, 'the rule must not linger in a <style> block');
});

t('no author rule -> the export is byte-identical to before', () => {
  const plain = FFS_BODY.replace(' break-words', '');
  const before = mjml2html(plain, { validationLevel: 'soft' }).html;
  assert.strictEqual(mjml2html(withAuthorCss(plain, authorCss([P_RULE], plain)), { validationLevel: 'soft' }).html, before);
});

t('authorCss works on GrapesJS\'s real shape: selectors as a Backbone-like collection, !important kept', () => {
  const coll = (arr) => ({ models: arr, length: arr.length, some: (f) => arr.some(f) });
  const r = rule({ selectors: coll([sel('font-claude-response-body'), sel('break-words'), sel('whitespace-normal')]) },
    '.font-claude-response-body.break-words.whitespace-normal{line-height:15px !important;}');
  assert.strictEqual(authorCss([r], FFS_BODY), r.toCSS());
  assert.strictEqual(authorCss([rule({ selectors: coll([sel('break-words')]), singleAtRule: true }, '@x;')], FFS_BODY), '');
});

t('a malformed rule (a "}" typed into a field) is skipped and cannot swallow the rules after it', () => {
  const bad = rule({ selectors: [sel('break-words')] }, '.break-words{font-family:Arial};}');
  const unclosed = rule({ selectors: [sel('break-words')] }, '.break-words{color:red');
  assert.strictEqual(authorCss([bad, unclosed, P_RULE], FFS_BODY), P_RULE.toCSS());
});

t('canvasParity installs the self-closing preParser, chained after any earlier one', () => {
  const optionsHtml = { preParser: (s) => s.replace('X', '<mj-spacer />') };
  canvasParity({ Parser: { getConfig: () => ({ optionsHtml }) }, Components: { getTypes: () => [] } });
  assert.strictEqual(optionsHtml.preParser('<mj-column>X</mj-column>', {}), '<mj-column><mj-spacer></mj-spacer></mj-column>');
  const bare = {};
  canvasParity({ Parser: { getConfig: () => ({ optionsHtml: bare }) }, Components: { getTypes: () => [] } });
  assert.strictEqual(bare.preParser('<mj-divider/>'), '<mj-divider></mj-divider>');
});

// ── Self-closing <mj-image/> / <mj-divider/> swallowing the blocks after it ──
t('expandSelfClosingMj writes self-closing mj-* tags as open+close, attributes intact; leaves the rest alone', () => {
  assert.strictEqual(expandSelfClosingMj('<mj-divider border-width="1px" border-color="#232323" padding="0 0 18px" />'),
    '<mj-divider border-width="1px" border-color="#232323" padding="0 0 18px"></mj-divider>');
  assert.strictEqual(expandSelfClosingMj('<mj-image src="https://x/y.png?a=1&b=2" alt=\'a > b\'/>'), '<mj-image src="https://x/y.png?a=1&b=2" alt=\'a > b\'></mj-image>');
  assert.strictEqual(expandSelfClosingMj('<mj-all font-family="\'Helvetica Neue\', Arial" />'), '<mj-all font-family="\'Helvetica Neue\', Arial"></mj-all>');
  assert.strictEqual(expandSelfClosingMj('<mj-spacer/>'), '<mj-spacer></mj-spacer>');
  const untouched = '<br /><img src="a.png" /><mj-text>a<br/>b</mj-text><mj-image src="a"></mj-image>';
  assert.strictEqual(expandSelfClosingMj(untouched), untouched);
});

t('the starter (self-closing dividers) parses flat once expanded — no divider has a child', () => {
  // The DOMParser is what GrapesJS uses; Node has none, so assert on the string the parser gets.
  const src = '<mj-column><mj-text>a</mj-text><mj-divider border-width="1px" /><mj-text>b</mj-text><mj-divider /><mj-text>c</mj-text></mj-column>';
  assert.strictEqual(expandSelfClosingMj(src),
    '<mj-column><mj-text>a</mj-text><mj-divider border-width="1px"></mj-divider><mj-text>b</mj-text><mj-divider></mj-divider><mj-text>c</mj-text></mj-column>');
});

// The saved shape (BASE / Roxie Final / HP Crest design_json, 2026-10-31): an image holding the
// two caption texts that followed it in the starter.
const swallowed = () => ({ pages: [{ frames: [{ component: { type: 'wrapper', components: [{ type: 'mjml', tagName: 'mjml', components: [
  { type: 'mj-head', tagName: 'mj-head', components: [{ tagName: 'mj-attributes', components: [{ tagName: 'mj-all', components: [{ type: 'mj-text', tagName: 'mj-text' }] }] }] },
  { type: 'mj-body', tagName: 'mj-body', components: [{ type: 'mj-section', tagName: 'mj-section', components: [{ type: 'mj-column', tagName: 'mj-column', components: [
    { type: 'mj-image', tagName: 'mj-image', attributes: { src: 'hp.png' }, components: [
      { type: 'textnode', content: '\n  ' },
      { type: 'mj-text', tagName: 'mj-text', components: [{ type: 'textnode', content: 'Navigate Blue' }] },
      { type: 'mj-text', tagName: 'mj-text', components: [{ type: 'textnode', content: 'Hardtop wagon' }] }] },
    { type: 'mj-text', tagName: 'mj-text', components: [{ type: 'mj-image', tagName: 'mj-image' }] },
    { type: 'mj-button', tagName: 'mj-button', components: [{ type: 'textnode', content: 'Shop' }] }] }] }] }] }] } }] }] });

t('dropSwallowedBlocks: blocks inside an image go (MJML never sent them); whitespace, siblings, head stay; input untouched', () => {
  const design = swallowed();
  const before = JSON.stringify(design);
  const out = dropSwallowedBlocks(design);
  assert.strictEqual(JSON.stringify(design), before, 'input mutated');
  const mjml = out.pages[0].frames[0].component.components[0];
  const col = mjml.components[1].components[0].components[0];
  assert.deepStrictEqual(col.components.map((c) => c.type), ['mj-image', 'mj-text', 'mj-button'], 'siblings kept, nothing hoisted');
  assert.deepStrictEqual(col.components[0].components, [{ type: 'textnode', content: '\n  ' }]);
  assert.strictEqual(col.components[1].components[0].type, 'mj-image', 'an mj-text body reaches the mail as HTML — never touched');
  assert.strictEqual(mjml.components[0].components[0].components[0].components.length, 1, 'head left to normaliseMjAttributes');
});

t('prepareDesign runs dropSwallowedBlocks', () => {
  const out = prepareDesign(swallowed(), () => ({}));
  const img = out.pages[0].frames[0].component.components[0].components[1].components[0].components[0].components[0];
  assert.strictEqual(img.components.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
