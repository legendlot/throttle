// Outpost vendor auth — PURE helpers (no I/O). Every function here is unit-tested in
// test/auth.test.mjs; the I/O that uses them lives in src/index.js.
//
// Model (OUTPOST_PLAN §3.2): a bench laptop holds a non-extractable ECDSA P-256 key and signs every
// request; an operator logs in on it with op code + PIN → a device-bound floor session; a supervisor
// can mint a single-use step-up token; the supervisor dashboard uses a hand-shared login code.
// Vendor credentials never touch Supabase Auth.

const enc = new TextEncoder();

export const SIG_VERSION = 'OUTPOST-V1';
export const MAX_CLOCK_SKEW_MS = 150_000;      // nonces are kept 15 min (auth_housekeeping) > 2 × skew
export const PIN_DIGITS = 6;
export const CODE_DIGITS = 8;
export const PBKDF2_ITERATIONS = 100_000;      // Cloudflare Workers refuse > 100k
export const FLOOR_IDLE_MINS = 60;
export const FLOOR_MAX_HOURS = 12;
export const STEPUP_SECONDS = 120;
export const STEPUP_PURPOSES = ['unpack', 'carton_remove', 'void'];
export const CODE_TTL_HOURS = 24;

// ── encoding ────────────────────────────────────────────────────────────────
export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  let bin;
  try { bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── random secrets ──────────────────────────────────────────────────────────
// Rejection sampling: a plain `% 10^n` on a Uint32 is biased toward low values.
export function mintDigits(n, rand = () => crypto.getRandomValues(new Uint32Array(1))[0]) {
  let out = '';
  while (out.length < n) {
    const v = rand();
    if (v >= 4_294_967_290) continue;           // largest multiple of 10 below 2^32
    out += String(v % 10);
  }
  return out;
}

export function mintToken() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

// Codes and tokens are stored as hashes only. Codes are short (8 digits), so they are keyed with the
// worker pepper — a DB-only leak cannot brute-force them offline. Tokens are 256-bit random: plain
// SHA-256 is enough.
export const codeHash  = (pepper, kind, code) => hmacHex(pepper, `${kind}:${code}`);
export const tokenHash = token => sha256Hex(`outpost-token:${token}`);

export const isDigits = (s, n) => typeof s === 'string' && new RegExp(`^[0-9]{${n}}$`).test(s);

// ── PIN hashing: PBKDF2-SHA256 over HMAC(pepper, pin) ───────────────────────
// A 6-digit PIN is 10^6 guesses — trivial offline without the pepper, so the pepper is mixed in
// before the KDF. Format: pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url>.
async function pbkdf2(pinKeyed, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pinKeyed), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPin(pin, pepper, { iterations = PBKDF2_ITERATIONS, salt } = {}) {
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  const keyed = await hmacHex(pepper, `pin:${pin}`);
  const h = await pbkdf2(keyed, s, iterations);
  return `pbkdf2_sha256$${iterations}$${b64urlEncode(s)}$${b64urlEncode(h)}`;
}

export async function verifyPin(pin, pepper, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const salt = b64urlDecode(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS || !salt) return false;
  const again = await hashPin(pin, pepper, { iterations, salt });
  return timingSafeEqual(again, stored);
}

// ── device keys ─────────────────────────────────────────────────────────────
// Accept ONLY a public P-256 JWK; strip everything but the four members (a JWK carrying `d` is a
// private key — refuse it outright rather than store it).
export function normaliseJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  if ('d' in jwk) return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  const x = b64urlDecode(jwk.x), y = b64urlDecode(jwk.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  // Re-encoded from the bytes: base64url has spare bits in the last character, so one key has several
  // spellings — and therefore several thumbprints — unless it is canonicalised here.
  return { crv: 'P-256', kty: 'EC', x: b64urlEncode(x), y: b64urlEncode(y) };
}

// RFC 7638: SHA-256 over the required members in lexicographic order, no whitespace.
export async function jwkThumbprint(jwk) {
  const canon = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(canon)));
}

export function importVerifyKey(jwk) {
  return crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['verify']);
}

// ── request signing ─────────────────────────────────────────────────────────
// The device signs: version, method, path+query, timestamp, nonce and the body hash, newline-joined.
// The session token is NOT in the string — it is a bearer secret on top of the device key, and an
// attacker without the device key cannot produce a signature whatever the token.
export function canonicalString({ method, path, ts, nonce, bodyHash }) {
  return [SIG_VERSION, String(method).toUpperCase(), path, String(ts), nonce, bodyHash].join('\n');
}

export const nonceOk = n => typeof n === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(n);

export function clockOk(ts, now = Date.now(), maxSkew = MAX_CLOCK_SKEW_MS) {
  const t = Number(ts);
  return Number.isSafeInteger(t) && Math.abs(now - t) <= maxSkew;
}

// WebCrypto ECDSA signatures are IEEE P1363 (r‖s, 64 bytes for P-256) — the browser's
// `crypto.subtle.sign` output, unchanged.
export async function verifySignature(key, sigB64url, canonical) {
  const sig = b64urlDecode(sigB64url);
  if (!sig || sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, enc.encode(canonical));
  } catch { return false; }
}

// ── sessions + kill switches ────────────────────────────────────────────────
export function sessionLive(s, now = Date.now()) {
  if (!s || s.revoked_at || s.used_at) return false;
  if (!(Date.parse(s.expires_at) > now)) return false;
  const idleMs = Number(s.idle_mins) * 60_000;
  if (!(idleMs > 0)) return false;
  return Date.parse(s.last_seen_at) + idleMs > now;
}

// FAIL CLOSED: anything not positively "on and not killed" refuses. `killAll` is the raw
// outpost.settings value; `cfg` the vendor_config row (undefined when unread / absent).
export function killVerdict({ killAll, cfg }) {
  if (killAll !== 'off') return 'outpost_paused';
  if (!cfg) return 'vendor_unknown';
  if (cfg.killed === true) return 'vendor_paused';
  if (cfg.active !== true) return 'vendor_inactive';
  return null;
}

// ── CORS ────────────────────────────────────────────────────────────────────
export const ALLOWED_ORIGINS = ['https://outpost.legendoftoys.com', 'https://depot.legendoftoys.com'];

export function corsHeaders(origin, allowed = ALLOWED_ORIGINS) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Outpost-Device, X-Outpost-Ts, X-Outpost-Nonce, X-Outpost-Sig, X-Outpost-Session, X-Idempotency-Key',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// Next zero-padded 3-digit op code for a vendor, given the codes already used.
export function nextOpCode(existing) {
  const used = new Set((existing || []).map(String));
  for (let i = 1; i <= 999; i++) {
    const c = String(i).padStart(3, '0');
    if (!used.has(c)) return c;
  }
  return null;
}

// Rate-limit bucket for a caller IP. IPv6 hosts get a whole /64 each, so one caller rotating addresses
// inside its prefix stays in one bucket. Unknown → 'noip' (one shared, limited bucket — never unlimited).
export function ipBucket(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'noip';
  if (!s.includes(':')) return s;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map(g => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
