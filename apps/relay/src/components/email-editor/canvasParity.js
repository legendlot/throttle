import { normaliseMjAttributes } from './exportEmail.js';

// The canvas and the sent email must compile the SAME attributes against the SAME head
// (Mishica, #bugs 1793025099.434369, 2026-10-26: "all padding removed" in the builder, yet the
// sent mail had extra gaps and the banner sat narrower inside the dark container).
//
// grapesjs-mjml 1.0.8 compiles each block twice, two different ways:
//   - CANVAS: `getMjmlAttributes()` = every attribute, including the plugin's `style-default`
//     values that `init()` copies in for anything not set (section padding-left/right 0px,
//     text/image/button padding 10px 25px, text font-size 13px …). Each block is compiled in
//     isolation, with NO <mj-head>, so the template's <mj-attributes> never reach the canvas.
//   - EXPORT: `getAttrToHTML()` = the same set MINUS any value equal to its default, compiled
//     with the head.
// Two ways that diverges:
//   1. A shorthand plus default-valued longhands. The BASE starter ships
//      `<mj-section padding="34px 44px 10px">`; `init()` adds padding-left/right 0px, the canvas
//      honours them (MJML: a longhand beats the shorthand), the Style Manager shows them, and
//      the export DROPS them as defaults — so the sent mail gets the 44px the author never saw.
//      Same with a text's `padding="0 0 14px"`: 10px 25px on the canvas, 0 0 14px in the mail.
//   2. Any default the head overrides (`<mj-section padding="0px">`, `<mj-text font-size="15px">`):
//      the canvas shows MJML's default, the mail shows the head's.
// The fix makes one attribute set serve both, and gives the canvas the head:
//   - a default-valued `padding-*` is KEPT when the block also carries `padding` — the Style
//     Manager edits longhands (style.ts `detached: true`), so the longhand is what the author set;
//   - on LOAD, every side whose longhand is still the plugin default takes its value FROM the
//     shorthand (seedLonghands); a side someone changed keeps theirs. So NO saved template sends
//     differently after this fix — the canvas and Style Manager now show what it sends (for
//     Mishica's sections: the starter's 44px sides, which she can now see and set to 0).
//     Per side, not per block: a per-block rule (hostile review, 2026-10-30) took HP Crest's
//     sections — top/bottom set to 0, sides never touched — to 0px sides on re-save, a layout
//     neither the old canvas nor the old mail ever showed;
//   - on SAVE, the shorthand is rewritten from the four sides (syncPaddingShorthands), so a side
//     set to a value that happens to equal the default (text left 25px) is not undone by the
//     stale shorthand at the next load;
//   - the canvas compiles with the same attribute set (getMjmlAttributes → getAttrToHTML);
//   - every canvas compile gets the template's <mj-attributes> injected (withHead).
// Blocks INSIDE <mj-attributes> are never seeded or synced and keep the old stripping: there a
// kept longhand would override the head rule's own shorthand for every block in the mail.
//
// Measured in a browser harness 2026-10-30 (canvas vs export, block by block): BASE and both of
// Mishica's FFS/Upshift templates open with canvas = mail, and re-saving one unedited moves 0
// blocks of its send. ⚠️ Still unmatched: templates whose dividers were loaded from SELF-CLOSING
// MJML (`<mj-divider … />` — BASE, HP Crest, Roxie) carry the following blocks NESTED inside the
// divider in their saved design_json; that is a separate, older defect.

const SIDES = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const LENGTH = /^-?[\d.]+(px|%|em|rem)?$/;

// CSS 1–4 value order; null for anything that is not plain lengths (`!important`, calc()).
export function expandPadding(value) {
  const p = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length || p.length > 4 || !p.every((x) => LENGTH.test(x))) return null;
  const [t, r = t, b = t, l = r] = p;
  return { 'padding-top': t, 'padding-right': r, 'padding-bottom': b, 'padding-left': l };
}

// Longhands to set on load: each side still at its default takes the shorthand's value; null when
// nothing changes. Only for types whose style-default carries all four sides — the ones init()
// filled in; a column (no padding defaults) already obeys its shorthand.
export function seedLonghands(attributes, styleDefault) {
  const a = attributes || {};
  const defs = styleDefault || {};
  if (!a.padding || !SIDES.every((k) => defs[k] != null)) return null;
  const exp = expandPadding(a.padding);
  if (!exp) return null;
  const set = {};
  SIDES.forEach((k) => {
    const untouched = a[k] == null || a[k] === '' || a[k] === defs[k];
    if (untouched && a[k] !== exp[k]) set[k] = exp[k];
  });
  return Object.keys(set).length ? set : null;
}

// The shorthand rewritten from the four sides; null when it already agrees or a side is missing.
export function syncedShorthand(attributes) {
  const a = attributes || {};
  if (!a.padding || !SIDES.every((k) => a[k] != null && a[k] !== '')) return null;
  const joined = SIDES.map((k) => a[k]).join(' ');
  return joined === a.padding ? null : joined;
}

// Walk project data, calling fn(node) on every BODY mj-* node with attributes. Deep copy returned.
const mapBody = (design, fn) => {
  if (!design || typeof design !== 'object') return design;
  const copy = JSON.parse(JSON.stringify(design));
  const walk = (node, inHead) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, inHead)); return; }
    const head = inHead || node.tagName === 'mj-head' || node.tagName === 'mj-attributes';
    if (!head && /^mj-/.test(node.type || '') && node.attributes && typeof node.attributes === 'object') fn(node);
    Object.keys(node).forEach((k) => { if (k !== 'attributes' && k !== 'style') walk(node[k], head); });
  };
  walk(copy, false);
  return copy;
};

const assign = (node, set) => {
  Object.assign(node.attributes, set);
  if (node.style && typeof node.style === 'object') Object.assign(node.style, set);
};

// On SAVE (EmailEditor's export): every body block's shorthand made to agree with its sides.
export function syncPaddingShorthands(design) {
  return mapBody(design, (node) => {
    const padding = syncedShorthand(node.attributes);
    if (padding) assign(node, { padding });
  });
}

// Prepare project data (design_json) for LOAD; returns a deep copy, the caller's object is left
// alone. Done on the JSON, not the live components: an addAttributes made right after
// loadProjectData is silently undone by the plugin's style<->attribute sync (measured in the
// harness 2026-10-30), so the components are born right instead.
//   - mj-table retype: saved design_json stores every mj-table as `{type:'text',
//     tagName:'mj-table'}` (parsed before loadMjTable existed), and GrapesJS trusts a stored
//     `type` — isComponent never runs. (Retyped wherever it sits; it only ever sits in a column.)
//   - seedLonghands on every body block, then the shorthand synced to the result.
// `defaultsFor(type)` → that type's `style-default` (EmailEditor reads it off the registry).
export function prepareDesign(design, defaultsFor) {
  const retyped = JSON.parse(JSON.stringify(design || {}));
  const retype = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(retype); return; }
    if (node.tagName === 'mj-table' && node.type !== 'mj-table') node.type = 'mj-table';
    Object.values(node).forEach(retype);
  };
  if (!design || typeof design !== 'object') return design;
  retype(retyped);
  return mapBody(retyped, (node) => {
    const set = seedLonghands(node.attributes, defaultsFor(node.type));
    if (set) assign(node, set);
    const padding = syncedShorthand(node.attributes);
    if (padding) assign(node, { padding });
  });
}

// The registry half of prepareDesign: a type's `style-default`, or {} when it has none.
export function styleDefaultsFrom(editor) {
  return (type) => {
    const proto = editor.Components.getType(type)?.model?.prototype;
    const d = proto && (typeof proto.defaults === 'function' ? proto.defaults() : proto.defaults);
    return (d && d['style-default']) || {};
  };
}

const isInHead = (cmp) => {
  for (let p = cmp.parent && cmp.parent(); p; p = p.parent && p.parent()) {
    const tag = p.get('tagName');
    if (tag === 'mj-attributes' || tag === 'mj-head') return true;
  }
  return false;
};

export function attrsForMjml(attributes, styleDefault, inHead) {
  const attr = { ...(attributes || {}) };
  const defs = styleDefault || {};
  delete attr.style;
  delete attr.id;
  for (const prop of Object.keys(attr)) {
    const val = attr[prop];
    if (!val || val !== defs[prop]) continue;
    if (!inHead && prop.startsWith('padding-') && attr.padding) continue;
    delete attr[prop];
  }
  return attr;
}

// The template's <mj-attributes>, as the export compiles it — '' when there is none.
export function headAttributes(editor) {
  // findType, not find(): find() is a CSS-selector match and returns [] for these tags.
  const head = editor.getWrapper()?.findType('mj-head')[0];
  if (!head) return '';
  const blocks = head.components().filter((c) => c.get('tagName') === 'mj-attributes');
  return blocks.map((c) => normaliseMjAttributes(c.toHTML())).join('');
}

// Inject the head into one canvas compile. A compile that already has a head (mj-style's own
// render, a full-document compile) is left alone.
export function withHead(mjml, headAttrs) {
  if (!headAttrs || /<mj-head[\s>]/i.test(mjml)) return mjml;
  return String(mjml).replace(/<mjml(\s[^>]*)?>/i, (m) => `${m}<mj-head>${headAttrs}</mj-head>`);
}

// grapesjs-mjml 1.0.8 has NO mj-table type, so the canvas showed an <mj-table> as an inert
// unknown tag — its padding, width and rule never rendered, while the mail had them. The BASE
// starter's yellow "rule" (`<mj-table padding="0 0 18px" width="44px">`) is copied into every
// template: 18px of gap in the mail that the canvas never showed. Registered through the
// plugin's `customComponents` hook, built like its mj-text (compile in a column, keep the row).
// `style-default` is deliberately EMPTY: a default would be copied into the attributes on load
// and, with the shorthand rule above, override the authored `padding="0 0 18px"` in the mail.
export function loadMjTable(editor, { coreMjmlModel, coreMjmlView }) {
  editor.Components.addType('mj-table', {
    isComponent: (el) => (el.tagName || '').toLowerCase() === 'mj-table',
    model: {
      ...coreMjmlModel,
      defaults: {
        name: 'Table',
        draggable: '[data-gjs-type="mj-column"], [data-gjs-type="mj-hero"]',
        stylable: ['width', 'padding', 'padding-top', 'padding-left', 'padding-right', 'padding-bottom', 'align', 'container-background-color'],
        'style-default': {},
      },
    },
    view: {
      ...coreMjmlView,
      tagName: 'tr',
      attributes: { style: 'pointer-events: all; display: table; width: 100%' },
      getMjmlTemplate() {
        return { start: '<mjml><mj-body><mj-column>', end: '</mj-column></mj-body></mjml>' };
      },
      // The canvas compiles the tag EMPTY, and MJML fills an empty table with `&nbsp;` — a 22px
      // line the mail never has — so it is cleared here.
      getTemplateFromEl(sandboxEl) {
        const row = sandboxEl.querySelector('tr');
        const table = row.querySelector('td > table');
        if (table) table.innerHTML = '';
        return row.innerHTML;
      },
      // Children go in the CELL, not the table. They are only ever text: the HTML parser drops
      // `<tr>`/`<td>` met outside a table, so the starter's `<tr><td>&nbsp;</td></tr>` loads as a
      // bare `&nbsp;`. In the mail that text is foster-parented out of the <table> into the
      // `font-size:0px` cell (0px tall); inside the table, as a DOM insert puts it, it is a 22px line.
      getChildrenSelector() {
        return 'td';
      },
      // As mj-text/mj-button do: the core rerender re-appends the cell's old nodes (including the
      // old compiled <table>) into the new cell, one stale table per edit.
      rerender() {
        this.render();
      },
    },
  });
}

// `columnsPadding: ''` (EmailEditor) removes the 20px the plugin gave EVERY column, which was the
// only thing keeping an emptied column droppable. Give height to EMPTY columns only — canvas CSS,
// so the mail is untouched and a column with content measures exactly as it sends. Passed as
// GrapesJS's `canvasCss` editor option (EmailEditor), which lands in the frame's base <style>.
export const EMPTY_COLUMN_CSS = '[data-gjs-type="mj-column"]:not(:has([data-gjs-type])){min-height:40px;outline:1px dashed #9aa0a6;}';

// GrapesJS plugin — must run AFTER grapesjs-mjml has registered its types.
export function canvasParity(editor) {
  const { Components } = editor;
  Components.getTypes().forEach((t) => {
    if (!/^mj-/.test(t.id)) return;
    const proto = t.model && t.model.prototype;
    // Only the plugin's MJML models (coreMjmlModel) — mj-head has GrapesJS's base model.
    if (!proto || typeof proto.getMjmlAttributes !== 'function') return;
    proto.getAttrToHTML = function getAttrToHTML() {
      return attrsForMjml(this.get('attributes'), this.get('style-default'), isInHead(this));
    };
    proto.getMjmlAttributes = function getMjmlAttributes() {
      const attr = this.getAttrToHTML();
      const src = this.get('src');
      if (src) attr.src = src;
      return attr;
    };
  });
}
