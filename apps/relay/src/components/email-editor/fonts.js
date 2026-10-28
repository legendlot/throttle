// Fonts the email builder offers beyond the browser defaults (Mishica, #bugs 1793107833.850699, 2026-10-27).
//
// Three places have to agree, or a font shows in the picker but not in the mail:
//   1. EMAIL_FONTS → mjml2html's `fonts` option (export AND the plugin's per-component canvas
//      conversion). MJML emits the <link> + @import for every font in this map that a
//      font-family in the compiled mail actually names. ⚠️ Passing `fonts` REPLACES MJML's
//      built-in map, so its five defaults are restated here or Open Sans et al. stop importing.
//   2. FONT_CSS_URL → the canvas iframe, so the author sees the real face while editing.
//   3. FONT_OPTIONS → the Typography › Font select, whose value is the full stack. The stack
//      carries a system fallback because Gmail and Outlook ignore web fonts entirely; only
//      Apple Mail, iOS Mail and a few others render the Google face.
//
// Speed and Sakana (also asked for) are not on Google Fonts — they need licensed files hosted
// in the relay-email-assets bucket and an @font-face CSS; left out until Mishica sends them.

const GF = 'https://fonts.googleapis.com/css2?family=';

export const EMAIL_FONTS = {
  // MJML defaults (mjml-core/src/index.js) — see note 1.
  'Open Sans': 'https://fonts.googleapis.com/css?family=Open+Sans:300,400,500,700',
  'Droid Sans': 'https://fonts.googleapis.com/css?family=Droid+Sans:300,400,500,700',
  Lato: 'https://fonts.googleapis.com/css?family=Lato:300,400,500,700',
  Roboto: 'https://fonts.googleapis.com/css?family=Roboto:300,400,500,700',
  Ubuntu: 'https://fonts.googleapis.com/css?family=Ubuntu:300,400,500,700',
  // Added 2026-10-28.
  'Exo 2': `${GF}Exo+2:wght@400;500;600;700;800&display=swap`,
  Chivo: `${GF}Chivo:wght@400;500;700;900&display=swap`,
  Anton: `${GF}Anton&display=swap`,
  Tomorrow: `${GF}Tomorrow:wght@400;500;600;700&display=swap`,
};

// One stylesheet for the canvas: every added face at the weights above.
export const FONT_CSS_URL = `${GF}${[
  'Exo+2:wght@400;500;600;700;800',
  'Chivo:wght@400;500;700;900',
  'Anton',
  'Tomorrow:wght@400;500;600;700',
].join('&family=')}&display=swap`;

export const FONT_OPTIONS = [
  { id: "'Exo 2', Arial, Helvetica, sans-serif", label: 'Exo 2' },
  { id: 'Chivo, Arial, Helvetica, sans-serif', label: 'Chivo' },
  { id: "Anton, 'Arial Narrow', Impact, sans-serif", label: 'Anton' },
  { id: 'Tomorrow, Arial, Helvetica, sans-serif', label: 'Tomorrow' },
];

// Append FONT_OPTIONS to the Typography › Font select the MJML plugin builds (grapesjs-mjml
// style.ts: `buildProps: ['font-family', …]`, i.e. GrapesJS's stock select). Found by property
// name rather than sector id so a plugin rename of the sector does not silently drop the fonts.
export function addFontOptions(editor) {
  const sm = editor.StyleManager;
  let prop = null;
  sm.getSectors().forEach((sector) => {
    if (prop) return;
    const p = sector.getProperties().find((x) => x.getName?.() === 'font-family' || x.get('property') === 'font-family');
    if (p) prop = p;
  });
  if (!prop) { console.warn('[email-editor] font-family property not found; custom fonts not offered'); return; }
  const have = new Set((prop.getOptions?.() || []).map((o) => prop.getOptionId?.(o) ?? o.id ?? o.value));
  const add = FONT_OPTIONS.filter((o) => !have.has(o.id));
  if (!add.length) return;
  if (typeof prop.setOptions === 'function') prop.setOptions([...(prop.getOptions?.() || []), ...add]);
  else prop.set('options', [...(prop.get('options') || []), ...add]);
}
