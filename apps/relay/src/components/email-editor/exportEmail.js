import mjml2html from 'mjml-browser';
import { htmlToPlain } from './htmlToPlain.js';
import { EMAIL_FONTS } from './fonts.js';

// GrapesJS parses MJML with an HTML parser, and an HTML parser does not honour the XML
// self-closing slash on unknown elements. So a perfectly good head like
//     <mj-attributes>
//       <mj-all font-family="…" />
//       <mj-text color="#A8A8A8" font-size="15px" line-height="25px" />
//       <mj-section background-color="#080808" padding="0px" />
//     </mj-attributes>
// comes back out of the canvas NESTED — mj-text inside mj-all, mj-section inside mj-text —
// and MJML then applies NONE of those defaults. With validationLevel 'soft' it compiles
// anyway and only console.warns, so nothing surfaces.
//
// Measured 2026-08-21 (Kirti, #bugs): every one of the 7 saved email templates carried the
// nested head, including the "BASE (editable, copy me)" starter everything is cloned from.
// Effect on the live HP Crest send — 17 text blocks rendered at MJML's built-in 13px fallback
// instead of the intended 15px, with the default colour and 25px line-height lost too, which
// is exactly the "text is of different font size" that was reported.
//
// Flattening on export fixes every future save regardless of how the canvas parsed it, and is
// idempotent — an already-correct head round-trips byte-identical.
export function normaliseMjAttributes(mjml) {
  return String(mjml).replace(/<mj-attributes>([\s\S]*?)<\/mj-attributes>/gi, (full, inner) => {
    const tags = [];
    const re = /<(mj-[a-z0-9-]+)((?:\s[^>]*?)?)\s*\/?>/gi;
    let m;
    while ((m = re.exec(inner)) !== null) {
      const attrs = (m[2] || '').trim();
      tags.push(`<${m[1]}${attrs ? ' ' + attrs : ''} />`);
    }
    return tags.length ? `<mj-attributes>${tags.join('')}</mj-attributes>` : full;
  });
}

// Style Manager rules on elements INSIDE a block (FFS_sale_launch_emailer_28oct, 2026-10-31: a
// pasted `<p class="font-claude-response-body break-words whitespace-normal">` styled to
// `line-height:15px; margin:0`). Select such an element and style it, and GrapesJS stores a
// CssComposer RULE on its classes (or #id), not an attribute. The canvas frame applies the rule;
// getHtml() never contains it — so the mail drew that paragraph at its mj-text's `line-height:0px`
// with MJML's `p{margin:13px 0}`, every line on top of the last. Carried over as an
// `<mj-style inline="inline">` (mjml-browser bundles juice): each declaration lands in the
// element's own style attribute, BEFORE what is already there, so an inline style still beats the
// rule exactly as it does on the canvas.
// Which rules: only author rules — built on selectors, with no `selectorsAdd`, media, state or
// at-rule. The rest of CssComposer is MJML's own compiled head (`p`, `body`, `#outlook a`,
// `.mj-column-per-100` …), picked up from the canvas compiles; the mail already has that head, and
// inlining it would push MJML's `p{margin:13px 0}` into every paragraph. An `#id` rule only
// matches an inner element: a block's id is stripped from the MJML (attrsForMjml), and the plugin
// writes a block's own styles to its attributes, so a rule can never apply to a block twice.
// (With this config GrapesJS writes an element's id only when it also has an inline style, so an
// id rule on an unstyled element still cannot ship — none is saved today; class rules are the case.)
// And only rules some element in the MJML actually carries: GrapesJS keeps a rule after its element
// is deleted, and juice re-serialises the whole document (tags joined onto one line, `<img/>` →
// `<img>`) — harmless, but no reason to rewrite a mail whose rules style nothing.
// A rule whose CSS is not one well-formed block (a `}` typed into a Style Manager field) is
// skipped: in one shared stylesheet it would swallow every rule after it (hostile review 2026-10-31).
const ONE_BLOCK = /^[^{}]+\{[^{}]*\}$/;
export function authorCss(rules, mjml) {
  const elements = [...String(mjml || '').matchAll(/<[a-z][^>]*>/gi)].map(([tag]) => ({
    classes: new Set(((tag.match(/\sclass\s*=\s*"([^"]*)"/i) || [])[1] || '').split(/\s+/).filter(Boolean)),
    id: (tag.match(/\sid\s*=\s*"([^"]*)"/i) || [])[1] || null,
  }));
  const carried = (sels) => elements.some((el) => sels.every((s) => (s.get('type') === 2
    ? el.id === s.get('name') : el.classes.has(s.get('name')))));
  return (rules || []).filter((r) => {
    const sels = r.get('selectors');
    return sels && sels.length && !r.get('selectorsAdd') && !r.get('mediaText') && !r.get('state')
      && !r.get('atRuleType') && !r.get('singleAtRule') && !sels.some((s) => /^mj-/.test(s.get('name') || ''))
      && carried(sels.models || sels);
  }).map((r) => String(r.toCSS() || '').trim()).filter((css) => ONE_BLOCK.test(css)).join('\n');
}

export function withAuthorCss(mjml, css) {
  if (!css) return mjml;
  const style = `<mj-style inline="inline">${css}</mj-style>`;
  const s = String(mjml);
  if (/<\/mj-head>/i.test(s)) return s.replace(/<\/mj-head>/i, `${style}</mj-head>`);
  return s.replace(/<mjml(\s[^>]*)?>/i, (m) => `${m}<mj-head>${style}</mj-head>`);
}

// ⚠️ `validationLevel: 'soft'` means MJML COMPILES A BROKEN TEMPLATE AND ONLY WARNS. That is the
// right setting — a hard failure would block a save over something cosmetic — but it means the
// warnings are the ONLY signal an author ever gets, and until 2026-09-01 (S327) they went to
// `console.warn`, i.e. nowhere. That is precisely how the nested-head bug above survived across
// all 7 saved templates and reached a live customer send: MJML noticed, said so, and no human was
// listening. So the warnings are now RETURNED and surfaced in the editor.
// The console.warn stays — it costs nothing and is still the fastest thing to read while debugging.
export function exportEmail(editor) {
  const body = normaliseMjAttributes(editor.getHtml());
  const mjml = withAuthorCss(body, authorCss(editor.Css.getRules(), body));
  const compile = mjml2html.default || mjml2html;
  // `fonts` restates MJML's defaults plus the builder's added faces (fonts.js): MJML emits the
  // <link>/@import only for a font some font-family in the compiled mail actually names.
  // A copy per call: mjml2html writes any <mj-font> it meets into the object it is given.
  const { html, errors } = compile(mjml, { validationLevel: 'soft', minify: false, fonts: { ...EMAIL_FONTS } });
  const warnings = Array.isArray(errors) ? errors : [];
  if (warnings.length) console.warn('[email-editor] MJML warnings', warnings);
  return {
    mjml, html: html || '', text: htmlToPlain(html || ''), design: editor.getProjectData(),
    // Shape is MJML's own: { line, message, tagName, formattedMessage }. Normalised to a string
    // here so no caller has to know that, and so a future MJML version changing the field names
    // degrades to a readable line instead of rendering "[object Object]".
    warnings: warnings.map((e) => ({
      line: e?.line ?? null,
      tag: e?.tagName || null,
      message: e?.formattedMessage || e?.message || String(e),
    })),
  };
}
