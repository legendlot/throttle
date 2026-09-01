import mjml2html from 'mjml-browser';
import { htmlToPlain } from './htmlToPlain.js';

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

// ⚠️ `validationLevel: 'soft'` means MJML COMPILES A BROKEN TEMPLATE AND ONLY WARNS. That is the
// right setting — a hard failure would block a save over something cosmetic — but it means the
// warnings are the ONLY signal an author ever gets, and until 2026-09-01 (S327) they went to
// `console.warn`, i.e. nowhere. That is precisely how the nested-head bug above survived across
// all 7 saved templates and reached a live customer send: MJML noticed, said so, and no human was
// listening. So the warnings are now RETURNED and surfaced in the editor.
// The console.warn stays — it costs nothing and is still the fastest thing to read while debugging.
export function exportEmail(editor) {
  const mjml = normaliseMjAttributes(editor.getHtml());
  const compile = mjml2html.default || mjml2html;
  const { html, errors } = compile(mjml, { validationLevel: 'soft', minify: false });
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
