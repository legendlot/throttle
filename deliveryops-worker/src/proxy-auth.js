// Shopify App Proxy signature check. Message = params (minus `signature`) sorted by key,
// each `key=value` (multi-values joined by ","), concatenated with NO separator; HMAC-SHA256
// keyed by the app's client secret; lowercase hex; compared to the `signature` param.
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAppProxySignature(secret, url) {
  if (!secret) return false;
  const sig = url.searchParams.get('signature');
  if (!sig) return false;
  const groups = new Map();
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'signature') continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const message = [...groups.keys()].sort()
    .map(k => `${k}=${groups.get(k).join(',')}`).join('');
  const expected = await hmacHex(secret, message);
  return timingSafeEqual(expected, sig.toLowerCase());
}
