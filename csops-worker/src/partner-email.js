// Ignition's one-to-one contract mail from partners@ (Reann #1, #bugs 1793690997.941679). Pure, so
// the header rules are tested in partner-email.test.mjs. The sender is a constant: the bridge caller
// supplies the recipient and the words, never who it comes from.
export const PARTNER_MAILBOX = 'partners@legendoftoys.com';
const PARTNER_FROM = `Legend of Toys <${PARTNER_MAILBOX}>`;

const stripCrLf = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// RFC 2047. An encoded-word may be at most 75 characters, so a long subject folds into several,
// split on whole characters so no multi-byte character is cut in half.
export function encodeSubject(subject) {
  const clean = stripCrLf(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const enc = new TextEncoder();
  const words = [];
  let cur = '';
  for (const ch of clean) {
    if (enc.encode(cur + ch).length > 42) { words.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${bytesToB64(enc.encode(w))}?=`).join('\r\n ');
}

/** Returns { error } or { raw }. `boundary` is injectable for the tests. */
export function buildPartnerMime({ to, subject, text, html }, boundary = `alt_${crypto.randomUUID().replace(/-/g, '')}`) {
  const toClean = stripCrLf(to);
  // One bare address. A comma or angle bracket would add recipients the person who checked it never saw.
  if (!/^[^\s@,;:<>()"'*\\]+@[^\s@,;:<>()"'*\\]+\.[a-z]{2,}$/i.test(toClean)) return { error: 'A valid recipient address is required.' };
  const subj = stripCrLf(subject);
  if (!subj) return { error: 'A subject is required.' };
  if (!text || !html) return { error: 'Both the text and html bodies are required.' };
  const part = (type, content) =>
    `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n`
    + `${bytesToB64(new TextEncoder().encode(String(content))).replace(/(.{76})/g, '$1\r\n')}\r\n`;
  const raw = [
    `To: ${toClean}`,
    `From: ${PARTNER_FROM}`,
    `Subject: ${encodeSubject(subj)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n') + '\r\n\r\n' + part('text/plain', text) + part('text/html', html) + `--${boundary}--`;
  return { raw };
}
