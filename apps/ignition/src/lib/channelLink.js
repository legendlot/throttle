// Channel-link validation, at the source form.
//
// The influencer master has been accumulating browser TAB TITLES in `channel_link` — "(9)
// Instagram", "Instagram", "@handle • Instagram photos and videos" — because the field takes any
// text and people paste whatever the clipboard holds. 32 rows as of 2026-08-25, up from 29 in
// July: it grows roughly one a month and it breaks link-keyed matching and falsely groups
// influencers as duplicates.
//
// This is deliberately a FORM guard, not backend tolerance: the fix belongs where the mistake is
// made, while the person still has the real URL in front of them. Nothing here rewrites stored
// history — the existing rows need the team to re-enter them.

// A pasted tab title has spaces and no dot-domain; a URL has a host. That is the whole test —
// anything stricter starts rejecting legitimate links from platforms nobody has thought of yet.
const HOST_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$|\?)/i;

/**
 * Normalise a typed channel link. Trims, and supplies the scheme people leave off
 * ("instagram.com/x" → "https://instagram.com/x"). Returns '' for empty input.
 */
export function normalizeChannelLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // A bare host/path is what someone gets copying from the address bar on mobile.
  if (HOST_RE.test(s)) return `https://${s}`;
  return s;
}

/**
 * null when the value is acceptable (including empty — the field is optional), otherwise a
 * message to show under the input. Validate the NORMALISED value.
 */
export function channelLinkError(raw) {
  const s = normalizeChannelLink(raw);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return 'That is not a link — paste the profile URL, e.g. https://instagram.com/handle'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http and https links are accepted';
  if (!HOST_RE.test(u.host + '/')) return 'That does not look like a web address — paste the profile URL';
  return null;
}
