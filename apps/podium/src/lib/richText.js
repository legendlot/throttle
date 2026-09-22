// Review-box rich text (S396). The worker stores HTML sanitized to this same whitelist
// (podiumops-worker/src/richtext.mjs — keep the two tag lists identical); we sanitize again before
// every innerHTML as defence in depth. Reviews written before rich text are plain text and render
// as text (isRich false).
export const RICH_TAGS = new Set(['p', 'br', 'div', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u']);

export function sanitizeRich(s) {
  if (typeof s !== 'string') return '';
  const stripped = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  return stripped.split(/(<[^<>]*>)/).map(part => {
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[\s\S]*>$/.exec(part);
    if (m) {
      const tag = m[2].toLowerCase();
      if (!RICH_TAGS.has(tag)) return '';
      return tag === 'br' ? '<br>' : `<${m[1]}${tag}>`;
    }
    return part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('');
}

// Saved by the rich editor (always starts with a whitelisted tag) vs a legacy plain-text review.
export function isRich(v) {
  return typeof v === 'string' && /^\s*<(p|div|ul|ol|br|strong|b|em|i|u)\b/i.test(v);
}

function escapeHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Any stored value → HTML the editor can load (legacy text becomes one <p> per line).
export function toEditorHtml(v) {
  if (!v) return '';
  if (isRich(v)) return sanitizeRich(v);
  return v.split(/\r?\n/).map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
}

// Plain text of a value, for length checks and previews.
export function richToText(v) {
  if (!v) return '';
  if (!isRich(v)) return v;
  return sanitizeRich(v).replace(/<\/(p|div|li)>|<br>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}
