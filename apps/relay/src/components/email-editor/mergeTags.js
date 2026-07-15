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
