// Pure helpers for WhatsApp template authoring. No React, no I/O — unit-testable.
//
// Local WA `content` shape (consumed by commsops render.js renderWhatsapp + wa-templates.js):
//   { meta_name, language, category, header?, body, footer?, buttons?, mapping? }
// Body/header carry Meta's POSITIONAL {{1}}, {{2}} … placeholders. `mapping` binds each
// positional slot to one of our declared {token} variables + an example value for submission.

export const WA_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
export const WA_COMPONENTS = ['header', 'body', 'button'];

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

  for (const [field, cap] of [['header', WA_LIMITS.header], ['body', WA_LIMITS.body], ['footer', WA_LIMITS.footer]]) {
    if (c[field] && c[field].length > cap) errs.push(`${field[0].toUpperCase() + field.slice(1)} exceeds ${cap} characters (${c[field].length}).`);
  }
  if (Array.isArray(c.buttons) && c.buttons.length > WA_LIMITS.buttons) {
    errs.push(`At most ${WA_LIMITS.buttons} buttons (${c.buttons.length}).`);
  }
  // Footer takes no parameters in Meta's model.
  if (placeholdersIn(c.footer).length) errs.push('Footer cannot contain {{n}} placeholders.');

  for (const comp of ['header', 'body']) {
    const nums = placeholdersIn(c[comp]);
    const seqErr = sequenceError(comp, nums);
    if (seqErr) errs.push(seqErr);
    // Header supports exactly one text parameter.
    if (comp === 'header' && nums.length > 1) errs.push('Header supports at most one {{1}} placeholder.');

    const slots = mapping.filter((m) => (m.component || 'body') === comp);
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
