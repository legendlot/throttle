// Pure helpers for WhatsApp template authoring. No React, no I/O — unit-testable.
//
// Local WA `content` shape (consumed by commsops render.js renderWhatsapp + wa-templates.js):
//   { meta_name, language, category, header?, body, footer?, buttons?, mapping? }
// Body/header carry Meta's POSITIONAL {{1}}, {{2}} … placeholders. `mapping` binds each
// positional slot to one of our declared {token} variables + an example value for submission.

export const WA_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
export const WA_COMPONENTS = ['header', 'body', 'button'];

// WA templates are WABA-scoped and NON-transferable: one approved on the marketing account
// simply does not exist on the transactional or support one. LOT's three live numbers each
// sit on their own WABA, so the target has to be chosen at authoring time — picking wrong
// means re-authoring and re-queuing for Meta review at cutover.
// Canonical ids: reference/bitespeed.md §1.
// ⚠️ STATIC FALLBACK ONLY — the editor now feeds this list from live sender_identities
// (templates page → getSenderIdentities → wabas prop), because a hardcoded id GOES STALE
// when a number migrates WABAs: after the 2026-07-22 marketing migration this list still
// pointed at the dead WABA and every UI-authored template pinned there (4 templates,
// no_sender_on_waba at test send — S232). If you edit this list, you are probably doing
// the wrong thing; fix the sender_identities metadata instead.
export const WA_WABAS = [
  { id: '1829828347997765', label: 'Marketing — 9035697508', hint: 'Promotions, abandonment, winback' },
  { id: '717043791430518', label: 'Transactional — 7022142666', hint: 'Order lifecycle, COD confirmation' },
  { id: '2257035788468620', label: 'Support — 9880212323', hint: 'Pitstop CS / inbound conversations' },
  { id: '1752135339132947', label: 'Sandbox — +1 555 174 8518', hint: 'Test number only; not reusable on live numbers' },
];

// Meta's own constraints (v21.0). Enforced client-side so authors see them before submitting
// into a review queue that takes ~minutes-to-hours to reject.
export const WA_LIMITS = { header: 60, body: 1024, footer: 60, buttons: 10 };

// Meta requires: lowercase alphanumeric + underscores only.
export function normalizeMetaName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// The positional placeholders actually present in a string, in ascending order: "{{2}} {{1}}" → [1,2]
export function placeholdersIn(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(/\{\{(\d+)\}\}/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

// Meta rejects a template whose placeholders aren't a 1-based contiguous run.
function sequenceError(comp, nums) {
  if (!nums.length) return null;
  const expected = nums.map((_, i) => i + 1);
  if (nums.join(',') !== expected.join(',')) {
    return `${comp} placeholders must run 1..N with no gaps — found {{${nums.join('}}, {{')}}}`;
  }
  return null;
}

// validateWaTemplate(content, declaredTokens[]) → string[] of blocking problems.
// Mirrors what Meta will reject, plus the local binding rules renderWhatsapp needs at send.
export function validateWaTemplate(content, declaredTokens = []) {
  const errs = [];
  const c = content || {};
  const known = new Set((declaredTokens || []).filter(Boolean));
  const mapping = Array.isArray(c.mapping) ? c.mapping : [];

  if (!c.meta_name) errs.push('Meta template name is required.');
  else if (normalizeMetaName(c.meta_name) !== c.meta_name) errs.push('Meta template name must be lowercase letters, numbers and underscores only.');
  if (!c.body || !c.body.trim()) errs.push('Body is required.');

  // Image header: Meta headers carry EITHER text OR one media asset, never both. The UI
  // enforces this in state (selecting Image clears any header text), but a saved/loaded
  // template could still disagree, so check it here too.
  const headerFormat = String(c.header_format || 'TEXT').toUpperCase();
  if (headerFormat === 'IMAGE') {
    if (!c.header_media_url) errs.push('Upload the header image before submitting.');
    if (c.header) errs.push('An image header cannot also have header text — remove one.');
  }

  for (const [field, cap] of [['header', WA_LIMITS.header], ['body', WA_LIMITS.body], ['footer', WA_LIMITS.footer]]) {
    if (c[field] && c[field].length > cap) errs.push(`${field[0].toUpperCase() + field.slice(1)} exceeds ${cap} characters (${c[field].length}).`);
  }
  if (Array.isArray(c.buttons) && c.buttons.length > WA_LIMITS.buttons) {
    errs.push(`At most ${WA_LIMITS.buttons} buttons (${c.buttons.length}).`);
  }
  // Footer takes no parameters in Meta's model.
  if (placeholdersIn(c.footer).length) errs.push('Footer cannot contain {{n}} placeholders.');

  // Meta rejects a body that ENDS with a placeholder — it reads as a truncated message.
  // Verified empirically 2026-07-20: lot_checkout_abandoned_02 was refused with a bare
  // "Invalid parameter" until a closing line was added after the final {{4}}.
  if (/\{\{\d+\}\}\s*$/.test(c.body || '')) {
    errs.push('Body cannot end with a {{n}} placeholder — add a closing line after it (Meta rejects this).');
  }
  if (!c.waba_id) errs.push('Pick the WhatsApp Business Account to author on — templates cannot be moved between accounts later.');

  const mediaHeader = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat);
  for (const comp of ['header', 'body']) {
    const slots = mapping.filter((m) => (m.component || 'body') === comp);
    // A MEDIA header carries no text and no {{n}} — its (optional, single) mapping slot
    // supplies the per-message asset LINK at send time (render.js takes the slot's value,
    // falling back to the template's static header_media_url). The text↔slot cross-check
    // below therefore does not apply; cap it at one slot instead.
    if (comp === 'header' && mediaHeader) {
      if (slots.length > 1) errs.push('A media header takes at most one mapped slot (the per-message asset link).');
      continue;
    }
    const nums = placeholdersIn(c[comp]);
    const seqErr = sequenceError(comp, nums);
    if (seqErr) errs.push(seqErr);
    // Header supports exactly one text parameter.
    if (comp === 'header' && nums.length > 1) errs.push('Header supports at most one {{1}} placeholder.');

    const slotPos = [...new Set(slots.map((s) => Number(s.pos)))].sort((a, b) => a - b);
    for (const n of nums) if (!slotPos.includes(n)) errs.push(`${comp} {{${n}}} has no mapped variable.`);
    for (const n of slotPos) if (!nums.includes(n)) errs.push(`${comp} mapping has slot ${n} but the text has no {{${n}}}.`);
  }

  for (const m of mapping) {
    if (!m.token) errs.push('Every mapping slot needs a variable token.');
    else if (!known.has(m.token)) errs.push(`Mapping slot {{${m.pos}}} uses {${m.token}}, which isn't declared under Variables.`);
    if (!m.example || !String(m.example).trim()) errs.push(`Mapping slot {{${m.pos}}} needs an example value (Meta requires one to approve).`);
  }
  return errs;
}

// Substitute example values into the positional text, for the preview bubble.
export function previewText(text, mapping, comp) {
  const slots = (Array.isArray(mapping) ? mapping : []).filter((m) => (m.component || 'body') === comp);
  return String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const slot = slots.find((s) => Number(s.pos) === Number(n));
    return slot && slot.example ? String(slot.example) : m;
  });
}
