// Tokens the send path injects itself, so they need no declaration (send.js `sys`).
const SYSTEM_TOKENS = ['unsubscribe_url'];

// Find {token}s used in the content but not declared as variables. render.js leaves an
// undeclared token UNTOUCHED (applyTokens returns the match), so it ships to the customer
// as literal "{frist}" text rather than failing loudly — hence the lint.
// Regex must stay identical to render.js applyTokens.
export function findUndeclaredTokens(strings, declaredTokens) {
  const known = new Set([...(declaredTokens || []).filter(Boolean), ...SYSTEM_TOKENS]);
  const found = new Set();
  for (const s of strings) {
    for (const m of String(s || '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
      if (!known.has(m[1])) found.add(m[1]);
    }
  }
  return [...found];
}

// Insert {token} into the editor. Preferred: append to selected text component's content.
// Fallback: copy to clipboard. Returns 'inserted' | 'copied' | 'noop'.
export async function insertMergeTag(editor, token) {
  if (!editor || !token) return 'noop';
  const tag = `{${token}}`;
  const sel = editor.getSelected();
  if (sel && sel.is && (sel.is('mj-text') || sel.is('mj-button') || sel.is('text'))) {
    const cur = sel.get('content') || '';
    sel.set('content', `${cur}${tag}`);
    return 'inserted';
  }
  try { await navigator.clipboard.writeText(tag); return 'copied'; }
  catch { return 'noop'; }
}
