// Derive a plaintext fallback from compiled email HTML. Pure string ops (no DOM).
const BLOCK = /<\/(p|div|h[1-6]|tr|table|li|ul|ol|section|header|footer)\s*>|<br\s*\/?>/gi;
export function htmlToPlain(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');          // drop <head> (title, MSO <o:PixelsPerInch>96</o:…>, etc.)
  s = s.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '');  // drop MSO/IE conditional blocks (ghost tables)
  s = s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(BLOCK, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
  return s.trim();
}
