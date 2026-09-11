// Bare http(s) URLs in bot/agent text → text + link parts (S372, Pruthvi: "links in the flow
// bots are not clickable"). SAME RULE as the storefront widget's linkify in
// commsops-worker/src/bot-widget.js — keep the two in step.
//
// - Scheme is case-insensitive, and only an http(s) match ever becomes a link.
// - The URL body is ASCII-only, so an emoji or unicode punctuation (… ” 。 ।) right after a URL
//   never rides into the href. (Cost: a URL typed with raw unicode in its path is linked only up
//   to that character — rare in hand-written bot copy, and it degrades to text, never unsafe.)
// - Trailing punctuation is trimmed in ONE backward pass. A trim regex was quadratic on a long
//   punctuation run (S372 hostile review: 4 s at 100k chars). A `)` is kept while it closes a `(`
//   inside the URL, so Wikipedia-style `…/Foo_(bar)` survives.
const URL_RE = /https?:\/\/[^\s<>"'\u0080-\uFFFF]+/gi;
const TRAIL = '.,;:!?]*_~';

export function trimUrl(u) {
  let opens = 0;
  let closes = 0;
  for (const c of u) { if (c === '(') opens += 1; else if (c === ')') closes += 1; }
  let end = u.length;
  while (end > 0) {
    const c = u[end - 1];
    if (c === ')') {
      if (closes > opens) { closes -= 1; end -= 1; continue; }
      break;
    }
    if (TRAIL.includes(c)) { end -= 1; continue; }
    break;
  }
  return u.slice(0, end);
}

// → [{ text }, { url }, …] in order. Anything that is not a usable http(s) URL stays text.
export function splitLinks(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  const re = new RegExp(URL_RE.source, 'gi');
  let m;
  while ((m = re.exec(s))) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/]/i.test(url)) continue;   // nothing after the scheme — leave it as text
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
