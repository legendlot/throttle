// Request signing for an enrolled Outpost bench. The signed string MUST stay identical to the worker's
// canonicalString (outpostops-worker/src/auth.js); test/sign.test.mjs checks it against the worker's own verifier.
// Pure WebCrypto: runs in the browser and under `node --test`.

export const SIG_VERSION = 'OUTPOST-V1';
const enc = new TextEncoder();

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const canonicalString = ({ method, path, ts, nonce, bodyHash }) =>
  [SIG_VERSION, String(method).toUpperCase(), path, String(ts), nonce, bodyHash].join('\n');

export const ALG = { name: 'ECDSA', namedCurve: 'P-256' };

// The private half never leaves the browser: generated non-extractable and kept as a CryptoKey in IndexedDB.
export async function newDeviceKey() {
  const kp = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

// Headers for one request. `path` is pathname + search exactly as sent; `raw` the exact body string ('' for GET).
export async function signedHeaders({ deviceId, key, method, path, raw, ts }) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const canon = canonicalString({ method, path, ts, nonce, bodyHash: await sha256Hex(raw) });
  const sig = b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(canon)));
  return { 'X-Outpost-Device': String(deviceId), 'X-Outpost-Ts': String(ts), 'X-Outpost-Nonce': nonce, 'X-Outpost-Sig': sig };
}
