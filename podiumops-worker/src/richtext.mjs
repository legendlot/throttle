// Review boxes are rich text (S396, Afshaan): stored as HTML sanitized to a tag whitelist with every
// attribute dropped; text outside tags has < > escaped. Mirrored client-side in
// apps/podium/src/lib/richText.js — keep the two tag lists identical.
export const RICH_TAGS = new Set(['p', 'br', 'div', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u']);
export function sanitizeRich(s) {
  const stripped = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  return stripped.split(/(<[^<>]*>)/).map(part => {
    // A tag has its name straight after < (or </), as browsers parse it; anything else is text.
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)[\s\S]*>$/.exec(part);
    if (m) {
      const tag = m[2].toLowerCase();
      if (!RICH_TAGS.has(tag)) return '';
      return tag === 'br' ? '<br>' : `<${m[1]}${tag}>`;
    }
    return part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }).join('');
}
